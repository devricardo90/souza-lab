import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { makeWorkPackage } from "../src/controller/work-package.js";
import { ExecutionRunner } from "../src/controller/execution-runner.js";
import { GitHubLifecycle } from "../src/controller/github-lifecycle.js";
import { GitHubSCMProvider } from "../src/adapters/github-scm-provider.js";
import { GitHubCIProvider } from "../src/adapters/github-ci-provider.js";
import { SqliteExecutionAttemptStore } from "../src/adapters/sqlite-execution-attempt-store.js";
import { SqliteGateFactStore } from "../src/adapters/sqlite-gate-fact-store.js";
import { SyntheticGitAgent } from "../src/testing/synthetic-git-agent.js";
import { DeterministicReviewer, DeterministicValidator, readCalls } from "../src/testing/deterministic-gates.js";
import { createFakeGitHub, initFakeRemote } from "../src/testing/fake-github.js";
import { computeState } from "../src/core/state-engine.js";
import { makeTask } from "../src/core/contracts.js";
import { makeRepo } from "./helpers/git-repo.js";

/** Lifecycle-level composition tests: real local Git + the REAL GitHub providers over a fake `gh api` backed by a bare repo. */
const STAMP = "2026-10-02T12:00:00.000Z";
const OWNER = "o"; const REPO = "r"; const WORKFLOW = ".github/workflows/validate.yml";
const snapshot = makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan("LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\nTASK_ID: TASK-001\nTITLE: Only task\nAC:\n- AC-001: it works\n- AC-002: it is verified\nEND_LOOP_EXECUTION_PLAN\n"), fetchedAt: STAMP, compiledAt: STAMP });
const WP = makeWorkPackage({ snapshot, taskId: "TASK-001", repository: { identity: "synthetic/repo", baseRef: "main" } });
const leaseOk = { assertLeaseCurrent: async () => true };

async function fixture(t, { findingsOnReviews = 0, maxCorrections = 3 } = {}) {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "gh-units-"));
  const barePath = join(repo.root, "remote.git");
  initFakeRemote({ barePath, seedPath: repo.path });
  repo.run(["remote", "add", "origin", barePath]);
  const fake = createFakeGitHub({ barePath, stateFile: join(dir, "gh.json"), owner: OWNER, repo: REPO, workflowPath: WORKFLOW });
  const stores = [];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); repo.cleanup(); });
  const attemptStore = new SqliteExecutionAttemptStore({ path: join(dir, "attempts.sqlite") });
  const gateStore = new SqliteGateFactStore({ path: join(dir, "gates.sqlite") });
  stores.push(attemptStore, gateStore);
  const agent = new SyntheticGitAgent({ recordPath: join(dir, "agent.jsonl"), crashMarkerDir: dir });
  const reviewer = new DeterministicReviewer({ recordPath: join(dir, "review.jsonl"), findingsOnReviews });
  const validator = new DeterministicValidator({ recordPath: join(dir, "validation.jsonl") });
  const scm = new GitHubSCMProvider({ owner: OWNER, repo: REPO, baseBranch: "main", run: fake.run });
  const ci = new GitHubCIProvider({ owner: OWNER, repo: REPO, workflowIdentity: WORKFLOW, run: fake.run });
  const lifecycle = new GitHubLifecycle({ scm, ci, attemptStore, gateStore, repoPath: repo.path, baseBranch: "main", reviewer, validator, agent, maxCorrections });
  const runner = new ExecutionRunner({ attemptStore, agent, repoPath: repo.path, workspacesDir: join(dir, "ws") });
  const scope = lifecycle.scope(WP);
  const h1 = (await runner.ensureImplementation(WP)).head;
  const workspace = attemptStore.get(WP.executionId).workspacePath;
  const commitMore = (name) => {
    mkdirSync(join(workspace, "impl"), { recursive: true });
    writeFileSync(join(workspace, "impl", name), `${name}\n`);
    repo.run(["add", "-A"], workspace);
    repo.run(["-c", "user.name=A", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", `more ${name}`], workspace);
    return repo.run(["rev-parse", "HEAD"], workspace);
  };
  const facts = () => {
    const revision = scope.gitProvider.getRevision();
    return {
      task: makeTask({ id: "TASK-001", title: WP.title, specPresent: true, specReviewed: true, acceptanceCriteria: WP.acceptanceCriteria.map((a) => ({ id: a.id, description: a.text })), dependencies: [] }),
      completedTaskIds: [], revision, specRevision: { head: scope.baseHead }, specReview: scope.reviewProvider.getReviewResult(scope.baseHead), specDigest: scope.specDigest,
      ci: scope.ciProvider.getCIResult(revision.head), validation: scope.validationProvider.getValidationResult("TASK-001", revision.head),
      review: scope.reviewProvider.getReviewResult(revision.head), merge: scope.scmProvider.getMergeFact("TASK-001", revision.head), now: STAMP,
    };
  };
  return { repo, dir, fake, scm, ci, scope, lifecycle, gateStore, attemptStore, agent, reviewer, validator, h1, workspace, commitMore, facts, review: () => readCalls(join(dir, "review.jsonl")), agentCalls: () => readCalls(join(dir, "agent.jsonl")), validations: () => readCalls(join(dir, "validation.jsonl")) };
}

test("a candidate exists only once the agent result is durable; the revision comes from real Git on the isolated worktree", async (t) => {
  const f = await fixture(t);
  const rev = f.scope.gitProvider.getRevision();
  assert.deepEqual([rev.head, rev.base, rev.dirty, rev.branch], [f.h1, f.attemptStore.get(WP.executionId).baseSha, false, f.attemptStore.get(WP.executionId).branch]);
  assert.equal(rev.authorId, "synthetic-agent@example.invalid");
  assert.deepEqual(rev.changedFiles, ["impl/TASK-001.txt"]);
});

test("EXACT REVISION: CI PASS for H1 never validates H2, validation for H1 is not found for H2, and the merge refuses H1 evidence for H2", async (t) => {
  const f = await fixture(t);
  await f.scope.actions.requestSpecReview();
  f.fake.setCI(f.h1, { status: "completed", conclusion: "success" });
  assert.equal(f.scope.ciProvider.getCIResult(f.h1).status, "PASS");
  await f.scope.actions.runValidation(false);
  const validation1 = f.scope.validationProvider.getValidationResult("TASK-001", f.h1);
  assert.equal(validation1.result, "PASS");
  const h2 = f.commitMore("second.txt");
  assert.notEqual(h2, f.h1);
  assert.equal(f.scope.ciProvider.getCIResult(h2).status, "UNKNOWN", "no CI evidence exists for the new head");
  assert.equal(f.scope.validationProvider.getValidationResult("TASK-001", h2), null, "H1 validation is invisible for H2");
  await assert.rejects(f.scope.actions.runTests(), (e) => e.code === "CI_NOT_PASSED_YET" && e.retryable === true);
  f.fake.setCI(h2, { status: "completed", conclusion: "failure" });
  await assert.rejects(f.scope.actions.runTests(), (e) => e.code === "CI_FAILED" && e.classification === "PERMANENT");
  // the state engine, fed only with facts that came from the real providers, refuses every stale gate for H2
  f.fake.setCI(h2, { status: "completed", conclusion: "success" });
  assert.equal(computeState(f.facts()).state, "VALIDATING", "CI is exact for H2 but validation must run again");
  // merge authorization built from H1 evidence cannot merge H2
  await f.scope.actions.requestReview();                              // reviews H2 (CLEAN)
  await f.scope.actions.createPullRequest(leaseOk);                   // publishes H2
  const [pr] = f.fake.prs();
  const review2 = f.scope.reviewProvider.getReviewResult(h2);
  const common = { number: pr.number, expectedBase: f.attemptStore.get(WP.executionId).baseSha, expectedSpecDigest: f.scope.specDigest, expectedAcceptanceCriteriaDigest: f.facts().task.acceptanceCriteriaDigest, criterionCount: 2, taskId: "TASK-001", implementationAuthorId: "synthetic-agent@example.invalid", requiredCIIdentity: WORKFLOW, computedState: "READY_TO_MERGE", attemptedAt: new Date(Date.now() + 5000).toISOString() };
  await assert.rejects(f.scm.mergePullRequest({ ...common, expectedHead: h2, ci: f.ci.getCIResult(h2), validation: validation1, review: review2 }, leaseOk), { code: "GITHUB_MERGE_GATES_FAILED" });
  await assert.rejects(f.scm.mergePullRequest({ ...common, expectedHead: f.h1, ci: f.ci.getCIResult(f.h1), validation: validation1, review: review2 }, leaseOk), (e) => ["GITHUB_MERGE_GATES_FAILED", "GITHUB_PR_HEAD_MISMATCH"].includes(e.code));
  assert.equal(f.fake.prs()[0].state, "open", "nothing was merged");
});

test("review evidence is exact: CLEAN for H1 is rejected for H2, a stale review keeps the state at REVIEWING", async (t) => {
  const f = await fixture(t);
  f.fake.setCI(f.h1, { status: "completed", conclusion: "success" });
  await f.scope.actions.runValidation(false);
  await f.scope.actions.requestSpecReview();
  await f.scope.actions.requestReview();
  assert.equal(f.scope.reviewProvider.getReviewResult(f.h1).verdict, "CLEAN");
  assert.equal(computeState(f.facts()).state, "READY_TO_MERGE");
  const h2 = f.commitMore("late.txt");
  f.fake.setCI(h2, { status: "completed", conclusion: "success" });
  assert.equal(f.scope.reviewProvider.getReviewResult(h2), null);
  const stale = { ...f.facts(), review: f.scope.reviewProvider.getReviewResult(f.h1), validation: f.scope.validationProvider.getValidationResult("TASK-001", f.h1) };
  const computed = computeState(stale);
  assert.equal(computed.state, "VALIDATING");
  assert.ok(computed.blockers.some((b) => /stale for the candidate HEAD/.test(b)), computed.blockers.join("; "));
  await f.scope.actions.runValidation(false);
  const reviewStale = computeState({ ...f.facts(), review: f.scope.reviewProvider.getReviewResult(f.h1) });
  assert.equal(reviewStale.state, "REVIEWING");
  assert.ok(reviewStale.blockers.some((b) => /review is stale for the candidate HEAD/.test(b)), reviewStale.blockers.join("; "));
});

test("PUBLISH: ABSENT until the exact head is on the remote; publish is idempotent (one PR, no duplicate push); a new head is ABSENT again until published", async (t) => {
  const f = await fixture(t);
  const fact = (head) => f.scope.scmProvider.getPullRequestFact("TASK-001", head, WP.executionId);
  assert.equal(fact(f.h1).status, "ABSENT");
  assert.equal(f.fake.branchHead(f.attemptStore.get(WP.executionId).branch), null);
  const first = await f.scope.actions.createPullRequest(leaseOk);
  assert.equal(f.fake.branchHead(f.attemptStore.get(WP.executionId).branch), f.h1, "the exact head was pushed and read back");
  assert.equal(fact(f.h1).status, "OPEN");
  assert.equal(fact(f.h1).mergeable, null, "the volatile mergeable flag is not part of the fingerprinted fact");
  const second = await f.scope.actions.createPullRequest(leaseOk);
  assert.equal(second, first, "the same PR was rediscovered");
  assert.equal(f.fake.prs().length, 1);
  assert.equal(f.scope.reconcilers.CREATE_PULL_REQUEST({ candidateRevision: f.h1 }).status, "COMPLETED");
  const h2 = f.commitMore("fix.txt");
  assert.equal(fact(h2).status, "ABSENT", "the new head is not published yet");
  assert.equal(f.scope.reconcilers.CREATE_PULL_REQUEST({ candidateRevision: h2 }).status, "NOT_STARTED");
  await f.scope.actions.createPullRequest(leaseOk);
  assert.equal(fact(h2).status, "OPEN");
  assert.equal(f.fake.prs().length, 1, "the same change object followed the branch");
  assert.equal(f.fake.prs()[0].head, f.attemptStore.get(WP.executionId).branch);
});

test("REVIEW/FIX LOOP: review FINDINGS at H1 -> bounded correction (new commit H2) -> H1 evidence is stale -> H2 reviewed CLEAN; durable history keeps both", async (t) => {
  const f = await fixture(t, { findingsOnReviews: 1 });
  f.fake.setCI(f.h1, { status: "completed", conclusion: "success" });
  await f.scope.actions.requestSpecReview();
  await f.scope.actions.runValidation(false);                         // validation PASS for H1
  const out = await f.scope.actions.requestReview();                  // FINDINGS at H1, correction produces H2
  assert.match(out, new RegExp(`^correction:${f.h1}->`));
  const h2 = f.scope.gitProvider.getRevision().head;
  assert.notEqual(h2, f.h1);
  assert.equal(f.repo.run(["rev-list", "--count", `${f.h1}..${h2}`], f.workspace), "1", "the correction is a new commit on top of H1 (history not rewritten)");
  assert.deepEqual(f.agentCalls().map((c) => c.mode), ["execute", "correct"]);
  assert.deepEqual(f.agentCalls()[1].findings, ["F-1"]);
  f.gateStore && assert.deepEqual([f.gateStore.getReview(WP.executionId, f.h1).verdict, f.gateStore.getReview(WP.executionId, f.h1).unresolvedFindings], ["FINDINGS", 1]);
  // H1 evidence cannot authorize H2
  assert.equal(f.scope.reviewProvider.getReviewResult(h2), null);
  assert.equal(f.scope.validationProvider.getValidationResult("TASK-001", h2), null);
  f.fake.setCI(h2, { status: "completed", conclusion: "success" });
  await f.scope.actions.runValidation(false);                         // H2 validated
  assert.deepEqual(f.validations().filter((v) => v.kind === "validate").map((v) => v.head), [f.h1, h2]);
  assert.equal(await f.scope.actions.requestReview(), `review:${h2}`);
  assert.deepEqual([f.gateStore.getReview(WP.executionId, h2).verdict, f.review().filter((r) => r.kind === "implementation").map((r) => r.head)], ["CLEAN", [f.h1, h2]]);
  assert.equal(computeState(f.facts()).state, "READY_TO_MERGE", "only now is H2 mergeable");
});

test("the correction loop is bounded: persistent FINDINGS end in OWNER_DECISION_REQUIRED, never an endless loop", async (t) => {
  const f = await fixture(t, { findingsOnReviews: 99, maxCorrections: 2 });
  const heads = [f.h1];
  for (let round = 0; round < 2; round += 1) { await f.scope.actions.requestReview(); heads.push(f.scope.gitProvider.getRevision().head); }
  assert.equal(new Set(heads).size, 3);
  await assert.rejects(f.scope.actions.requestReview(), (e) => e.code === "EXECUTION_OWNER_DECISION_REQUIRED" && /persist after 2 correction rounds/.test(e.message));
});

test("an unavailable reviewer is a transient wait, never a verdict; findings with a non-recoverable executor need the owner", async (t) => {
  const f = await fixture(t);
  f.lifecycle.reviewer = { reviewImplementation: async () => ({ verdict: "UNAVAILABLE", reviewerId: "r", findings: [] }), reviewSpec: async () => ({ verdict: "UNAVAILABLE", reviewerId: "r", findings: [] }) };
  await assert.rejects(f.scope.actions.requestReview(), (e) => e.code === "REVIEW_UNAVAILABLE" && e.retryable === true);
  assert.equal(f.gateStore.getReview(WP.executionId, f.h1), null, "UNAVAILABLE is not recorded as evidence");
  f.lifecycle.reviewer = { reviewImplementation: async () => ({ verdict: "FINDINGS", reviewerId: "r", findings: [{ id: "F", summary: "x" }] }) };
  f.lifecycle.agent = { execute: async () => { throw new Error("n/a"); } };
  await assert.rejects(f.scope.actions.requestReview(), (e) => e.code === "EXECUTION_OWNER_DECISION_REQUIRED" && /cannot perform a correction/.test(e.message));
});

test("MERGE + POST-MERGE: merge is confirmed by reading GitHub back; a lost merge response is reconciled; LOCAL_DONE needs post-merge proof", async (t) => {
  const f = await fixture(t);
  f.fake.setCI(f.h1, { status: "completed", conclusion: "success" });
  await f.scope.actions.requestSpecReview();
  await f.scope.actions.runValidation(false);
  await f.scope.actions.requestReview();
  await f.scope.actions.createPullRequest(leaseOk);
  const ctx = () => ({ ...leaseOk, observation: { computed: { state: "READY_TO_MERGE" }, recovery: { facts: { ...f.facts(), pullRequest: f.scope.scmProvider.getPullRequestFact("TASK-001", f.h1, WP.executionId) } } } });
  assert.equal(f.scope.reconcilers.PREPARE_MERGE({ candidateRevision: f.h1 }).status, "NOT_STARTED");
  f.fake.setFault("mergeResponseLostOnce");
  await assert.rejects(f.scope.actions.prepareMerge(ctx(), { candidateRevision: f.h1 }), /merge response|GitHub SCM request failed/i); // merged remotely, response lost
  const [pr] = f.fake.prs();
  assert.equal(pr.state, "closed", "the merge DID happen on the remote");
  const reconciled = f.scope.reconcilers.PREPARE_MERGE({ candidateRevision: f.h1 });
  assert.deepEqual([reconciled.status, reconciled.output], ["COMPLETED", pr.mergeSha], "restart reconciliation rediscovers the merge; it is not repeated");
  assert.equal(f.fake.prs().length, 1);
  // real GitHub reports an unstable `mergeable` for merged PRs; the runtime fingerprints PR facts, so the composition must stabilize it
  f.fake.setFault("flappingMergedMergeable");
  const raw1 = f.scm.getPullRequestFact("TASK-001", f.h1, WP.executionId);
  const raw2 = f.scm.getPullRequestFact("TASK-001", f.h1, WP.executionId);
  assert.notEqual(raw1.mergeable, raw2.mergeable, "the raw provider fact flaps between reads");
  const view1 = f.scope.scmProvider.getPullRequestFact("TASK-001", f.h1, WP.executionId);
  const view2 = f.scope.scmProvider.getPullRequestFact("TASK-001", f.h1, WP.executionId);
  assert.deepEqual(view1, view2, "the composed fact is stable across reads");
  assert.deepEqual([view1.status, view1.mergeable], ["MERGED", null]);
  assert.equal(f.scope.isCompleted(), false, "a merge alone is not LOCAL_DONE");
  assert.equal(await f.scope.actions.runValidation(true), `post-merge-validation:${pr.mergeSha}`);
  assert.equal(f.scope.isCompleted(), true);
  assert.deepEqual(f.validations().filter((v) => v.kind === "post-merge").map((v) => [v.mergeSha === pr.mergeSha, v.actual === pr.mergeSha]), [[true, true]]);
  assert.equal(f.gateStore.getValidation(WP.executionId, "TASK-001", pr.mergeSha).baseline, f.h1);
});

test("control logic source is deterministic: lifecycle, push, gate store and ports reference no model", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/controller/github-lifecycle.js", "../src/adapters/git-push.js", "../src/adapters/sqlite-gate-fact-store.js", "../src/controller/gate-ports.js", "../src/adapters/workspace-command-validator.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/anthropic|openai|\bllm\b|claude|codex|hermes|Math\.random/i.test(text), file);
  }
  void execFileSync;
});
