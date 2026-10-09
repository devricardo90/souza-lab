import { execFile } from "node:child_process";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { promisify } from "node:util";
import { AgentExecutor, validateAgentResult } from "../controller/ports.js";
import { classifyExecution, git, inspectWorkspace, resultFromGit } from "./git-workspace.js";

const execFileAsync = promisify(execFile);
const NON_TERMINAL = new Set(["triage", "todo", "scheduled", "ready", "running", "review"]);

export class HermesExecutorError extends Error {
  // A retryable failure is TRANSIENT so the runtime retries it with bounded backoff (and then fails closed); a non-retryable one is an external block.
  constructor(message, { code = "HERMES_ERROR", retryable = false, classification = retryable ? "TRANSIENT" : "EXTERNAL_BLOCK" } = {}) {
    super(message); this.name = "HermesExecutorError"; Object.assign(this, { code, classification, retryable });
  }
}
const parseJson = (output, label) => { try { return JSON.parse(output); } catch { throw new HermesExecutorError(`Hermes ${label} returned malformed JSON`, { code: "HERMES_MALFORMED_OUTPUT", classification: "TASK_FAILURE" }); } };
const statusOf = (task) => { const value = task?.status ?? task?.task?.status; return typeof value === "string" ? value.toLowerCase() : null; };

/**
 * The ownership trailers are the Loop's proof that a commit belongs to this execution, and they are parsed strictly (one trailer per line).
 * Agents have been observed writing a commit message with literal backslash-n sequences, which puts the whole message on one line and makes
 * the trailers invisible, so the instruction gives the exact command shape and forbids escape sequences.
 */
export function commitInstruction(workPackage) {
  return `Commit with exactly this command shape so each trailer is its own real line: git commit -m "<short subject>" -m "Loop-Execution-Id: ${workPackage.executionId}" -m "Loop-Task-Id: ${workPackage.taskId}". Never write backslash-n or other escape sequences in a commit message.`;
}

/** Production AgentExecutor boundary. The command is injectable for deterministic tests. */
export class HermesAgentExecutor extends AgentExecutor {
  /** env (optional): the exact environment the Hermes CLI is started with. Production passes an allowlisted one so no credential reaches it. */
  constructor({ command = "hermes", board = "workflow-prod", coderAssignee = "coder", pollMs = 1000, maxPolls = 3600, run = null, env = null } = {}) {
    super(); this.command = command; this.board = board; this.coderAssignee = coderAssignee; this.pollMs = pollMs; this.maxPolls = maxPolls; this.env = env;
    this.run = run ?? ((args, options) => execFileAsync(this.command, args, { ...options, ...(this.env ? { env: this.env } : {}), windowsHide: true, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  }
  idempotencyKey(workPackage, resume) { return `loop-${workPackage.executionId}-${resume ? "resume" : "execute"}`; }
  body(workPackage, context, resume) {
    const criteria = (workPackage.acceptanceCriteria ?? []).map(({ id, text }) => `- ${id}: ${text}`).join("\n");
    return [`Loop task id: ${workPackage.taskId}`, `Execution id: ${workPackage.executionId}`, `Work package: ${workPackage.workPackageId}`, `Title: ${workPackage.title}`, "", "Acceptance Criteria:", criteria || "- (none)", "", `Repository: ${workPackage.repository.identity}`, `Base: ${context.workspace.baseSha}`, `Branch: ${context.workspace.branch}`, `Workspace: ${context.workspace.path}`, "", "Explicit scope: implement only this frozen WorkPackage in the supplied workspace. Do not modify other tasks, merge, push, or report success without a real Git commit.", `The implementation commit MUST contain these exact trailers: Loop-Execution-Id: ${workPackage.executionId} and Loop-Task-Id: ${workPackage.taskId}.`, commitInstruction(workPackage), resume ? "Recovery scope: preserve and build on all existing uncommitted work; never reset, clean, checkout over, or discard it." : ""].filter(Boolean).join("\n");
  }
  async invoke(args, options = {}, label = "command") {
    try { return await this.run(args, options); } catch (cause) { throw new HermesExecutorError(`Hermes ${label} failed`, { code: cause?.code === "ENOENT" ? "HERMES_UNAVAILABLE" : "HERMES_COMMAND_FAILED", retryable: true }); }
  }
  /** spec (optional) overrides the task key/title/body; used by the correction round. Defaults reproduce execute/resume exactly. */
  async create(workPackage, context, resume, spec = null) {
    const args = ["kanban", "--board", this.board, "create", spec?.title ?? workPackage.title, "--assignee", this.coderAssignee, "--workspace", `dir:${context.workspace.path}`, "--idempotency-key", spec?.key ?? this.idempotencyKey(workPackage, resume), "--json"];
    const path = join(tmpdir(), `hermes-body-${process.pid}-${randomBytes(16).toString("hex")}`);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(spec?.body ?? this.body(workPackage, context, resume), "utf8"); const result = await this.invoke([...args, "--body-file", path], {}, "create"); const parsed = parseJson(result.stdout ?? result, "create"); const task = parsed.task ?? parsed;
      if (!task?.id || typeof task.id !== "string") throw new HermesExecutorError("Hermes create response has no task id", { code: "HERMES_INVALID_CREATE", classification: "TASK_FAILURE" }); return task.id;
    } finally { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); }
  }
  async poll(taskId) {
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const result = await this.invoke(["kanban", "--board", this.board, "show", taskId, "--json"], {}, "status"); const task = parseJson(result.stdout ?? result, "status"); const status = statusOf(task);
      if (status === "done") return task;
      if (status === "blocked") throw new HermesExecutorError("Hermes task is blocked", { code: "HERMES_BLOCKED", classification: "TASK_FAILURE" });
      if (!NON_TERMINAL.has(status)) throw new HermesExecutorError("Hermes task has unknown status", { code: "HERMES_UNKNOWN_STATUS", classification: "TASK_FAILURE" });
      if (attempt + 1 < this.maxPolls && this.pollMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    throw new HermesExecutorError(`Hermes task ${taskId} did not reach a terminal state`, { code: "HERMES_POLL_TIMEOUT", retryable: true });
  }
  /** One correction round's body: the findings are DATA for the coder, delivered through the private body file like the task text. */
  correctionBody(workPackage, context, previousHead) {
    const NL = "\n";
    const findings = context.findings.map(({ id, summary }) => `- ${id}: ${summary}`).join(NL);
    const criteria = (workPackage.acceptanceCriteria ?? []).map(({ id, text }) => `- ${id}: ${text}`).join(NL) || "- (none)";
    return [`Loop task id: ${workPackage.taskId}`, `Execution id: ${workPackage.executionId}`, `Work package: ${workPackage.workPackageId}`, `Title: ${workPackage.title}`, "",
      `Correction round ${Math.max(1, context.round)}. An independent review of commit ${previousHead} returned findings. Findings to fix:`, findings, "",
      "Acceptance Criteria (unchanged):", criteria, "",
      `Repository: ${workPackage.repository.identity}`, `Base: ${context.workspace.baseSha}`, `Branch: ${context.workspace.branch}`, `Workspace: ${context.workspace.path}`, "",
      `Explicit scope: address ONLY these findings, in the supplied workspace on the supplied branch. Add a NEW commit on top of ${previousHead}; never amend, rebase, reset, force or otherwise rewrite history. Do not push, merge, or touch other tasks, and do not report success without a real new Git commit.`,
      `The correction commit MUST contain these exact trailers: Loop-Execution-Id: ${workPackage.executionId} and Loop-Task-Id: ${workPackage.taskId}.`, commitInstruction(workPackage),
      context.facts ? "Recovery scope: a previous correction attempt was interrupted; preserve and build on all existing uncommitted work; never reset, clean, checkout over, or discard it." : ""].join(NL).trimEnd();
  }
  /**
   * Generic correction capability (see AgentExecutor in controller/ports.js). The key is bound to the round AND the head under review, so
   * a restarted Controller re-attaches to the SAME Hermes task instead of creating a second one. The result is accepted only if Git shows a
   * NEW, clean commit that fast-forwards the reviewed head and carries this execution's trailers; Hermes prose is never trusted.
   */
  async correct(workPackage, context) {
    if (!workPackage?.executionId || !context?.workspace?.path) throw new TypeError("HermesAgentExecutor requires a WorkPackage and workspace context");
    if (!Array.isArray(context.findings) || context.findings.length === 0) throw new TypeError("HermesAgentExecutor.correct requires at least one finding");
    const round = Number.isSafeInteger(context.round) && context.round >= 0 ? context.round : 0;
    const ctx = { ...context, round };
    const observe = () => inspectWorkspace({ workspacePath: context.workspace.path, baseSha: context.workspace.baseSha, branch: context.workspace.branch, executionId: workPackage.executionId, taskId: workPackage.taskId });
    const previousHead = observe().head;
    if (!previousHead) throw new HermesExecutorError("the workspace has no HEAD to correct", { code: "HERMES_GIT_INCOMPLETE", classification: "TASK_FAILURE" });
    const taskId = await this.create(workPackage, ctx, false, { key: `loop-${workPackage.executionId}-correct-${round}-${previousHead.slice(0, 12)}`, title: `Correct: ${workPackage.title}`, body: this.correctionBody(workPackage, ctx, previousHead) });
    await this.poll(taskId);
    const facts = observe();
    const { classification } = classifyExecution(facts, { executionId: workPackage.executionId, taskId: workPackage.taskId });
    const fastForward = facts.head !== previousHead && git(context.workspace.path, ["merge-base", "--is-ancestor", previousHead, facts.head], { allowFailure: true }) !== null;
    if (classification !== "COMMITTED_IMPLEMENTATION_PRESENT" || !fastForward) throw new HermesExecutorError("Hermes completed the correction without a new owned clean commit", { code: "HERMES_CORRECTION_INCOMPLETE", classification: "TASK_FAILURE" });
    return validateAgentResult(resultFromGit(facts));
  }
  async execute(workPackage, context) { return this.runTask(workPackage, context, false); }
  async resume(workPackage, context) { return this.runTask(workPackage, context, true); }
  async runTask(workPackage, context, resume) {
    if (!workPackage?.executionId || !context?.workspace?.path) throw new TypeError("HermesAgentExecutor requires a WorkPackage and workspace context");
    const taskId = await this.create(workPackage, context, resume); await this.poll(taskId);
    const facts = inspectWorkspace({ workspacePath: context.workspace.path, baseSha: context.workspace.baseSha, branch: context.workspace.branch, executionId: workPackage.executionId, taskId: workPackage.taskId });
    const { classification } = classifyExecution(facts, { executionId: workPackage.executionId, taskId: workPackage.taskId });
    if (classification !== "COMMITTED_IMPLEMENTATION_PRESENT") throw new HermesExecutorError("Hermes completed without an owned clean implementation", { code: "HERMES_GIT_INCOMPLETE", classification: "TASK_FAILURE" });
    return validateAgentResult(resultFromGit(facts));
  }
}
export default HermesAgentExecutor;
