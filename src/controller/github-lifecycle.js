import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { LocalGitProvider } from "../adapters/local-git-provider.js";
import { git, resolveSha } from "../adapters/git-workspace.js";
import { pushExactHead } from "../adapters/git-push.js";
import { makePullRequestFact, makeTask } from "../core/contracts.js";
import { ownerRequired } from "./execution-runner.js";
import { validateReviewerOutput } from "./gate-ports.js";

/**
 * Production lifecycle for one WorkPackage after the agent produced an implementation: REAL local Git facts, the REAL
 * GitHub SCM and CI providers (Phase 6, reused unchanged), durable gate evidence, and the reviewer/validator ports.
 * It never asserts a pass by itself - every fact below comes from Git, GitHub, a gate port, or a durable record bound to
 * an exact head SHA.
 *
 *   revision      LocalGitProvider on the execution's isolated worktree (null until the agent result is durable)
 *   publish       verify local facts -> push exact HEAD -> read the remote head back -> find-or-create the PR (markers)
 *   CI            GitHubCIProvider, exact SHA + configured workflow: PASS / FAIL / PENDING / UNKNOWN (+ provider errors)
 *   validation    ValidationRunner, recorded per exact head (write-once)
 *   review        IndependentReviewer, recorded per exact head; FINDINGS -> bounded correction round -> new head
 *   merge         GitHubSCMProvider.mergePullRequest (all authorization gates), then read back from GitHub
 *   post-merge    containment of the merge commit in the default branch + validation of the merge commit
 *
 * Exact-revision rule: every lookup is keyed by the head SHA; a new head has no evidence, and the (unchanged) state engine
 * additionally rejects any fact whose head differs from the candidate, so stale H1 evidence can never authorize H2.
 */

const FULL_SHA = /^[0-9a-f]{40}$/;
/**
 * Git queries whose answer can never change because they depend only on immutable commit objects (a commit's author, the diff
 * between two full SHAs, the merge base of two full SHAs, the repository root). Only these are memoized; everything mutable
 * (HEAD, branch, working-tree status) is read live on every observation. This is an optimization of the runner injected into
 * the unchanged LocalGitProvider: it cuts the process spawns per observation without weakening any fact.
 */
function immutableGitQuery(args) {
  if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return true;
  if (args[0] === "show" && args.includes("-s") && FULL_SHA.test(args.at(-1))) return true;
  if (args[0] === "diff" && args.slice(-2).every((a) => FULL_SHA.test(a))) return true;
  if (args[0] === "merge-base" && args.slice(-2).every((a) => FULL_SHA.test(a))) return true;
  return false;
}
function memoizedGitRunner() {
  const cache = new Map();
  return (args, { cwd, git: gitBinary = "git", commandTimeoutMs = 15000 }) => {
    const key = `${cwd}\u0000${args.join("\u0000")}`;
    const memo = immutableGitQuery(args);
    if (memo && cache.has(key)) return cache.get(key);
    let out;
    try {
      out = execFileSync(gitBinary, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, windowsHide: true, timeout: commandTimeoutMs, killSignal: "SIGTERM" }).trimEnd();
    } catch (error) {
      const detail = String(error?.stderr ?? error?.message ?? "git command failed").trim();
      throw Object.assign(new Error(`git ${args[0]} failed in ${cwd}: ${detail}`), { code: "GIT_COMMAND_FAILED", classification: "EXTERNAL_BLOCK", retryable: false });
    }
    if (memo) cache.set(key, out);
    return out;
  };
}

const transient = (message, code) => Object.assign(new Error(message), { code, classification: "TRANSIENT", retryable: true });
const isNotFound = (error) => /404|not found/i.test(String(error?.message ?? ""));

export class GitHubLifecycle {
  constructor({ scm, ci, attemptStore, gateStore, repoPath, baseBranch, reviewer, validator, agent, clock = () => new Date().toISOString(), faultPoints = {}, maxCorrections = 3 } = {}) {
    for (const [name, value] of Object.entries({ scm, ci, attemptStore, gateStore, repoPath, baseBranch, reviewer, validator, agent })) if (!value) throw new TypeError(`GitHubLifecycle requires ${name}`);
    Object.assign(this, { scm, ci, attemptStore, gateStore, repoPath, baseBranch, reviewer, validator, agent, clock, faultPoints, maxCorrections });
    this.gitRunner = memoizedGitRunner();
  }

  async fault(name, payload = {}) { if (typeof this.faultPoints[name] === "function") await this.faultPoints[name](payload); }

  remoteHead(branch) {
    try { return this.scm.getBranchFacts(branch).headSha; }
    catch (error) { if (isNotFound(error)) return null; throw error; }
  }

  scope(workPackage) {
    const self = this;
    const exec = workPackage.executionId;
    const taskId = workPackage.taskId;
    const task = makeTask({
      id: taskId, title: workPackage.title, specPresent: true, specReviewed: true,
      acceptanceCriteria: workPackage.acceptanceCriteria.map(({ id, text }) => ({ id, description: text })), dependencies: [],
    });
    const specDigest = workPackage.planBinding.taskHash;
    const attempt = () => self.attemptStore.get(exec);
    const revision = () => {
      const a = attempt();
      if (!a?.agentResult || !existsSync(a.workspacePath)) return null; // nothing is a candidate until the agent result is durable
      return new LocalGitProvider({ cwd: a.workspacePath, baseRef: a.baseSha, execute: self.gitRunner }).getRevision();
    };
    const requireRevision = () => { const r = revision(); if (!r) throw ownerRequired(`execution ${exec} has no durable implementation to work on`); return r; };
    const validationRecord = (head, baseline, passed) => ({
      head, baseline, specDigest, acceptanceCriteriaDigest: task.acceptanceCriteriaDigest, result: passed ? "PASS" : "FAIL",
      acProof: { total: task.acceptanceCriteria.length, proved: passed ? task.acceptanceCriteria.length : 0 }, checkedAt: self.clock(), independent: true,
    });
    const workspaceOf = (a) => ({ path: a.workspacePath, branch: a.branch, baseSha: a.baseSha });

    /** "ABSENT" means: this candidate is not yet published to the remote (the publish action pushes it and finds/creates the PR). */
    const scmView = {
      getMergeFact: (task_, head) => self.scm.getMergeFact(task_, head),
      getPullRequestFact: (task_, head, executionId) => {
        const fact = self.scm.getPullRequestFact(task_, head, executionId);
        if (fact.status === "ABSENT" || fact.status === "UNKNOWN") {
          const a = attempt();
          if (a && self.remoteHead(a.branch) !== head) return makePullRequestFact({ status: "ABSENT", taskId: task_, candidateHead: head });
        }
        // `mergeable` is volatile on real GitHub (null/true/false while it recomputes, and for merged/closed PRs) and the runtime
        // fingerprints this fact: leaving it in made the precondition guard see "facts changed after planning", abort actions, and
        // then collide on a repeated action id (found in the live proof, twice). Nothing in the lifecycle consumes it from this fact:
        // the merge path re-reads the PR itself and requires mergeable === true at the moment of merging. So it is normalized away.
        return makePullRequestFact({ ...fact, mergeable: null });
      },
    };

    const defaultBranchContains = (mergeSha) => {
      const head = self.scm.getBranchFacts(self.baseBranch).headSha;
      if (head === mergeSha) return true;
      git(self.repoPath, ["fetch", "-q", "origin", self.baseBranch], { allowFailure: true });
      return git(self.repoPath, ["merge-base", "--is-ancestor", mergeSha, head], { allowFailure: true }) !== null;
    };

    const correct = async (rev, findings, resumeFacts = null) => {
      const a = attempt();
      if (typeof self.agent.correct !== "function") throw ownerRequired("the executor cannot perform a correction round; owner decision required");
      const round = self.gateStore.findingsCount(exec);
      await self.agent.correct(workPackage, { workspace: workspaceOf(a), findings, round, facts: resumeFacts });
      const after = new LocalGitProvider({ cwd: a.workspacePath, baseRef: a.baseSha, execute: self.gitRunner }).getRevision();
      if (after.head === rev.head || after.dirty) throw ownerRequired(`the correction round did not produce a clean new commit (head ${after.head}, dirty=${after.dirty})`);
      // A correction must change something: a new commit that touches no file relative to the reviewed head fixes nothing.
      if (self.gitRunner(["diff", "--name-only", `${rev.head}..${after.head}`], { cwd: a.workspacePath }).trim() === "") throw ownerRequired(`the correction round produced an empty commit (head ${after.head}); an empty diff addresses no finding`);
      await self.fault("after_correction_committed", { executionId: exec, from: rev.head, to: after.head });
      return after;
    };

    return {
      get baseHead() { return attempt()?.baseSha ?? resolveSha(self.repoPath, workPackage.repository.baseRef); },
      specDigest,
      gitProvider: { getRevision: revision },
      scmProvider: scmView,
      ciProvider: { getCIResult: (head) => self.ci.getCIResult(head) },
      reviewProvider: { getReviewResult: (head) => self.gateStore.getReview(exec, head) },
      validationProvider: { getValidationResult: (task_, head) => self.gateStore.getValidation(exec, task_, head) },
      isCompleted: () => self.gateStore.postMergeValidated(exec, taskId),
      implementationResult: () => attempt()?.agentResult ?? null,

      actions: {
        recordImplementation: () => {}, // the attempt store already holds the durable result
        async requestSpecReview() {
          const out = validateReviewerOutput(await self.reviewer.reviewSpec(workPackage));
          if (out.verdict === "UNAVAILABLE") throw transient("spec reviewer is unavailable", "REVIEW_UNAVAILABLE");
          if (out.verdict === "FINDINGS") throw ownerRequired(`spec review produced findings: ${out.findings.map((f) => f.summary).join("; ")}`);
          self.gateStore.recordReview(exec, { head: this.baseHeadValue(), verdict: out.verdict, independent: true, unresolvedFindings: out.findings.length, publishedAt: self.clock(), reviewerId: out.reviewerId });
          return `spec-review:${out.reviewerId}`;
        },
        baseHeadValue() { return attempt()?.baseSha ?? resolveSha(self.repoPath, workPackage.repository.baseRef); },

        /** Publish: verify local facts, push the exact HEAD, confirm the remote head, find-or-create the PR. Idempotent. */
        async createPullRequest(ctx) {
          const rev = requireRevision();
          const a = attempt();
          const pushed = await pushExactHead({
            workspacePath: a.workspacePath, branch: a.branch, expectedHead: rev.head,
            readRemoteHead: async (branch) => self.remoteHead(branch), assertLeaseCurrent: ctx.assertLeaseCurrent,
          });
          await self.fault("after_push_confirmed", { executionId: exec, head: rev.head, pushed: pushed.pushed });
          const pr = await self.scm.createPullRequest({
            branch: a.branch, candidateSha: rev.head, taskId, executionId: exec, title: `${taskId}: ${workPackage.title}`,
            body: `Loop execution ${exec} for ${taskId} (plan v${workPackage.planBinding.planVersion}).`, baseBranch: self.baseBranch,
          }, ctx);
          await self.fault("after_pr_created", { executionId: exec, head: rev.head, number: pr.number });
          return String(pr.number);
        },

        /** CI is only observed (never asserted): PASS proceeds, FAIL is a structured failure, PENDING/UNKNOWN is a deterministic wait. */
        async runTests() {
          const rev = requireRevision();
          const result = self.ci.getCIResult(rev.head);
          if (result.status === "PASS") return `ci:${result.runId}`;
          if (result.status === "FAIL") throw Object.assign(new Error(`CI failed for ${rev.head} (run ${result.runId})`), { code: "CI_FAILED", classification: "PERMANENT", retryable: false, runId: result.runId });
          throw transient(`CI is ${result.status} for ${rev.head}`, "CI_NOT_PASSED_YET");
        },

        async runValidation(isPostMerge) {
          const rev = requireRevision();
          const a = attempt();
          if (!isPostMerge) {
            const existing = self.gateStore.getValidation(exec, taskId, rev.head);
            if (existing?.result === "FAIL") throw ownerRequired(`validation failed at ${rev.head}`);
            if (existing) return `validation:${rev.head}`;
            const out = await self.validator.validate({ workPackage, workspacePath: a.workspacePath, head: rev.head, base: rev.base });
            const passed = out.result === "PASS";
            self.gateStore.recordValidation(exec, taskId, validationRecord(rev.head, rev.base, passed));
            if (!passed) throw ownerRequired(`validation failed at ${rev.head}: ${out.detail ?? ""}`);
            return `validation:${rev.head}`;
          }
          const merge = self.scm.getMergeFact(taskId, rev.head);
          if (merge.status !== "MERGED") throw transient("merge is not yet visible on the remote", "MERGE_NOT_VISIBLE");
          if (!defaultBranchContains(merge.mergeCommit)) throw transient(`default branch does not yet contain ${merge.mergeCommit}`, "MERGE_NOT_IN_DEFAULT_BRANCH");
          const checkoutPath = join(dirname(a.workspacePath), `${exec}-postmerge`);
          if (existsSync(checkoutPath)) git(self.repoPath, ["worktree", "remove", "--force", checkoutPath], { allowFailure: true });
          git(self.repoPath, ["fetch", "-q", "origin"], { allowFailure: true });
          git(self.repoPath, ["worktree", "add", "--detach", checkoutPath, merge.mergeCommit]);
          try {
            const out = await self.validator.validatePostMerge({ workPackage, checkoutPath, mergeSha: merge.mergeCommit, head: rev.head });
            const passed = out.result === "PASS";
            self.gateStore.recordValidation(exec, taskId, validationRecord(merge.mergeCommit, rev.head, passed), { postMerge: true });
            if (!passed) throw ownerRequired(`post-merge validation failed at ${merge.mergeCommit}: ${out.detail ?? ""}`);
          } finally { git(self.repoPath, ["worktree", "remove", "--force", checkoutPath], { allowFailure: true }); }
          return `post-merge-validation:${merge.mergeCommit}`;
        },

        /** Independent review of the exact head. FINDINGS are recorded durably, then a bounded correction round produces a new head. */
        async requestReview() {
          const rev = requireRevision();
          let review = self.gateStore.getReview(exec, rev.head);
          if (review?.verdict === "CLEAN") return `review:${rev.head}`;
          if (!review) {
            const out = validateReviewerOutput(await self.reviewer.reviewImplementation({
              workPackage, head: rev.head, base: rev.base, workspacePath: attempt().workspacePath, authorId: rev.authorId, changedFiles: rev.changedFiles,
            }));
            if (out.verdict === "UNAVAILABLE") throw transient("independent reviewer is unavailable", "REVIEW_UNAVAILABLE");
            // Independence is enforced before anything is recorded: a review by the implementer's own identity is never evidence.
            if (typeof rev.authorId === "string" && out.reviewerId.trim().toLowerCase() === rev.authorId.trim().toLowerCase()) throw ownerRequired(`reviewer ${out.reviewerId} is not independent of the implementation author`);
            review = self.gateStore.recordReview(exec, { head: rev.head, verdict: out.verdict, independent: true, unresolvedFindings: out.findings.length, publishedAt: self.clock(), reviewerId: out.reviewerId });
            if (out.verdict === "FINDINGS") self.gateStore.recordFindings(exec, rev.head, out.findings);
            await self.fault("after_review_recorded", { executionId: exec, head: rev.head, verdict: out.verdict });
            if (out.verdict === "CLEAN") return `review:${rev.head}`;
          }
          // FINDINGS at this head: the work goes back through the executor's correction boundary, unless a finding genuinely needs the owner.
          const findings = self.gateStore.getFindings(exec, rev.head) ?? [];
          const needsOwner = findings.filter((f) => f.ownerDecision === true);
          if (needsOwner.length > 0) throw ownerRequired(`review finding needs an owner decision: ${needsOwner.map((f) => `${f.id}: ${f.summary}`).join("; ")}`);
          if (self.gateStore.findingsCount(exec) > self.maxCorrections) throw ownerRequired(`review findings persist after ${self.maxCorrections} correction rounds`);
          const next = await correct(rev, findings);
          return `correction:${rev.head}->${next.head}`;
        },

        /** An interrupted correction (uncommitted work in the workspace after a durable result) is resumed, never discarded. */
        async resumeCorrection() {
          const rev = requireRevision();
          const latest = self.gateStore.latestFindings(exec);
          if (!latest) throw ownerRequired("the workspace has uncommitted changes but no correction is pending; owner decision required");
          await correct(rev, latest.findings, { dirty: true });
        },

        async prepareMerge(ctx, action) {
          const facts = ctx.observation.recovery.facts;
          const pr = facts.pullRequest;
          if (!pr?.number) throw Object.assign(new Error("the current execution pull request is not identified"), { classification: "INVARIANT_VIOLATION" });
          const reviewTime = Date.parse(facts.review?.publishedAt ?? "");
          const attemptedAt = new Date(Math.max(Date.parse(self.clock()), Number.isFinite(reviewTime) ? reviewTime + 1 : 0)).toISOString();
          await ctx.assertLeaseCurrent();
          const merged = await self.scm.mergePullRequest({
            number: pr.number, expectedHead: action.candidateRevision, expectedBase: facts.revision.base, expectedSpecDigest: specDigest,
            expectedAcceptanceCriteriaDigest: facts.task.acceptanceCriteriaDigest, criterionCount: facts.task.acceptanceCriteria.length, taskId,
            implementationAuthorId: facts.revision.authorId, requiredCIIdentity: self.ci.workflowIdentity,
            ci: facts.ci, validation: facts.validation, review: facts.review, computedState: ctx.observation.computed.state, attemptedAt,
          }, ctx);
          await self.fault("after_remote_merge", { executionId: exec, mergeSha: merged.mergeSha });
          // The merge API response is not proof: read the merge back from GitHub.
          const fact = self.scm.getMergeFact(taskId, action.candidateRevision);
          if (fact.status !== "MERGED" || fact.mergeCommit !== merged.mergeSha) throw transient("the merge could not be confirmed on the remote", "MERGE_UNCONFIRMED");
          return merged.mergeSha;
        },
      },

      /** Reconcile-before-execute for externally visible actions: an action that already happened is recognized, never repeated. */
      reconcilers: {
        CREATE_PULL_REQUEST: (action) => {
          const a = attempt();
          const found = a ? self.scm.findPullRequest({ branch: a.branch, baseBranch: self.baseBranch, candidateSha: action.candidateRevision }) : null;
          return found?.headMatches ? { status: "COMPLETED", output: String(found.number) } : { status: "NOT_STARTED" };
        },
        PREPARE_MERGE: (action) => {
          const fact = self.scm.getMergeFact(taskId, action.candidateRevision);
          return fact.status === "MERGED" ? { status: "COMPLETED", output: fact.mergeCommit } : { status: "NOT_STARTED" };
        },
      },
    };
  }
}
