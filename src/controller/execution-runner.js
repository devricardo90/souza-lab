import { resolve } from "node:path";
import { classifyExecution, ensureWorkspace, inspectWorkspace, resolveSha, resultFromGit } from "../adapters/git-workspace.js";
import { validateAgentResult } from "./ports.js";

/**
 * Crash-safe execution recovery around the AgentExecutor (CP-06). Deterministic: every decision comes from the durable
 * execution-attempt record and real Git facts; no model participates.
 *
 * Protocol for one execution (identity = the WorkPackage's stable execution id):
 *   1. persist the attempt, including its workspace identity (path, branch, base SHA), BEFORE anything else   [PREPARED]
 *   2. create/attach the isolated worktree, persist AGENT_RUNNING, THEN call the agent
 *   3. persist the structured result durably BEFORE anyone depends on it                                      [AGENT_RESULT_RECORDED]
 * After any crash, ensureImplementation() consults the record first:
 *   AGENT_RESULT_RECORDED      return the stored result: the agent is NOT called again
 *   PREPARED                   the agent never ran: run it
 *   AGENT_RUNNING / RECOVERY_REQUIRED / IMPLEMENTATION_PRESENT
 *                              inspect the exact workspace with real Git and classify:
 *     NO_IMPLEMENTATION_PRESENT          retry the SAME execution in the SAME workspace
 *     COMMITTED_IMPLEMENTATION_PRESENT   adopt the commit(s) as the result (GIT_RECONCILIATION): no agent call
 *     IMPLEMENTATION_PRESENT_UNVERIFIED  preserve the uncommitted work; hand it to agent.resume() if the executor is
 *                                        recoverable, otherwise OWNER_DECISION_REQUIRED
 *     AMBIGUOUS_EXECUTION_STATE          OWNER_DECISION_REQUIRED
 * Recovery never resets, cleans, checks out over, or deletes anything.
 */

export function ownerRequired(message, details = {}) {
  return Object.assign(new Error(message), { code: "EXECUTION_OWNER_DECISION_REQUIRED", classification: "OWNER_REQUIRED", retryable: false, ...details });
}

/**
 * Agent-agnostic empty-diff guard. "Success" needs a task-relevant change: the files the branch's commits touch, as OBSERVED in Git (never the
 * agent's own changedFiles claim), must be non-empty. An empty implementation is refused before it is recorded as a result.
 */
export const observedChangedFiles = (facts) => [...new Set((facts?.commits ?? []).flatMap((commit) => commit.files ?? []))];

export class ExecutionRunner {
  /** faultPoints: test-only hooks {after_attempt_prepared, after_agent_running_persisted, after_agent_result_recorded}. */
  constructor({ attemptStore, agent, repoPath, workspacesDir, faultPoints = {} } = {}) {
    for (const [name, value] of Object.entries({ attemptStore, agent, repoPath, workspacesDir })) if (!value) throw new TypeError(`ExecutionRunner requires ${name}`);
    Object.assign(this, { attemptStore, agent, repoPath, workspacesDir: resolve(workspacesDir), faultPoints });
  }

  async fault(name, payload = {}) { if (typeof this.faultPoints[name] === "function") await this.faultPoints[name](payload); }

  async ensureImplementation(workPackage) {
    const executionId = workPackage.executionId;
    let attempt = this.attemptStore.get(executionId);
    if (!attempt) {
      const branch = `loop/${workPackage.taskId}/${executionId}`;
      attempt = this.attemptStore.prepare({
        executionId, taskId: workPackage.taskId, workPackageId: workPackage.workPackageId, planBinding: workPackage.planBinding,
        repositoryIdentity: workPackage.repository.identity, baseSha: resolveSha(this.repoPath, workPackage.repository.baseRef),
        workspacePath: resolve(this.workspacesDir, executionId), branch,
      }).attempt;
      await this.fault("after_attempt_prepared", { executionId });
    }
    switch (attempt.status) {
      case "AGENT_RESULT_RECORDED": return validateAgentResult(attempt.agentResult);
      case "FAILED": throw ownerRequired(`execution ${executionId} is FAILED: ${attempt.failureReason ?? "owner decision required"}`);
      case "PREPARED": return this.invoke(workPackage, attempt, "PREPARED");
      default: return this.recover(workPackage, attempt);
    }
  }

  workspaceOf(attempt) { return { path: attempt.workspacePath, branch: attempt.branch, baseSha: attempt.baseSha }; }

  facts(attempt) {
    return inspectWorkspace({ workspacePath: attempt.workspacePath, baseSha: attempt.baseSha, branch: attempt.branch, executionId: attempt.executionId, taskId: attempt.taskId });
  }

  async invoke(workPackage, attempt, from, { resumeFacts = null } = {}) {
    ensureWorkspace({ repoPath: this.repoPath, workspacesDir: this.workspacesDir, executionId: attempt.executionId, taskId: attempt.taskId, baseSha: attempt.baseSha, branch: attempt.branch });
    this.attemptStore.transition(attempt.executionId, from, "AGENT_RUNNING"); // durable BEFORE the agent is called
    await this.fault("after_agent_running_persisted", { executionId: attempt.executionId });
    const context = { workspace: this.workspaceOf(attempt), facts: resumeFacts };
    const raw = resumeFacts ? await this.agent.resume(workPackage, context) : await this.agent.execute(workPackage, context);
    const result = validateAgentResult(raw);
    // The agent's narrative is never trusted: its claimed head must be what Git says the workspace is at.
    const observed = this.facts(attempt);
    if (observed.head !== result.head) {
      this.attemptStore.transition(attempt.executionId, "AGENT_RUNNING", "RECOVERY_REQUIRED", { observedGitState: observed, classification: "AMBIGUOUS_EXECUTION_STATE" });
      throw ownerRequired(`agent reported head ${result.head} but the workspace is at ${observed.head}`);
    }
    this.rejectEmptyDiff(attempt, "AGENT_RUNNING", result, observed);
    this.attemptStore.recordResult(attempt.executionId, "AGENT_RUNNING", result, resumeFacts ? "AGENT_RESUME" : "AGENT", observed); // durable BEFORE it is consumed
    await this.fault("after_agent_result_recorded", { executionId: attempt.executionId });
    return result;
  }

  /** An implementation whose commits change no file is not an implementation: FAILED (terminal, nothing discarded), owner decision required. */
  rejectEmptyDiff(attempt, from, result, observed) {
    if (observedChangedFiles(observed).length > 0) return;
    const reason = `the agent's commit ${result.head} changes no file relative to ${attempt.baseSha}; an empty diff cannot satisfy the acceptance criteria`;
    this.attemptStore.transition(attempt.executionId, from, "FAILED", { observedGitState: observed, classification: "EMPTY_IMPLEMENTATION_DIFF", failureReason: reason });
    throw ownerRequired(reason, { code: "EXECUTION_EMPTY_DIFF" });
  }

  async recover(workPackage, attempt) {
    const facts = this.facts(attempt);
    const { classification, reasons } = classifyExecution(facts, { executionId: attempt.executionId, taskId: attempt.taskId });
    let status = attempt.status;
    const move = (to, extra = {}) => { this.attemptStore.transition(attempt.executionId, status, to, { observedGitState: facts, classification, ...extra }); status = to; };
    if (status === "AGENT_RUNNING") move("RECOVERY_REQUIRED");
    else this.attemptStore.transition(attempt.executionId, status, status, { observedGitState: facts, classification });

    if (classification === "NO_IMPLEMENTATION_PRESENT") return this.invoke(workPackage, { ...attempt, status }, status);
    if (classification === "COMMITTED_IMPLEMENTATION_PRESENT") {
      const result = validateAgentResult(resultFromGit(facts));
      this.rejectEmptyDiff(attempt, status, result, facts);
      this.attemptStore.recordResult(attempt.executionId, status, result, "GIT_RECONCILIATION", facts);
      await this.fault("after_agent_result_recorded", { executionId: attempt.executionId });
      return result;
    }
    if (classification === "IMPLEMENTATION_PRESENT_UNVERIFIED") {
      if (status !== "IMPLEMENTATION_PRESENT") move("IMPLEMENTATION_PRESENT");
      if (typeof this.agent.resume !== "function") throw ownerRequired(`uncommitted work exists in ${attempt.workspacePath} and the executor cannot resume it; nothing was discarded`);
      return this.invoke(workPackage, { ...attempt, status }, status, { resumeFacts: facts });
    }
    throw ownerRequired(`execution state is ambiguous (${reasons.join(", ")}); the workspace ${attempt.workspacePath} was left untouched`, { reasons });
  }
}
