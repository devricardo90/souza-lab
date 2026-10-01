import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraTaskSystemAdapter } from "../src/adapters/jira-task-adapter.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";
import { RecoveryCoordinator } from "../src/core/recovery-coordinator.js";
import { RuntimeObserver } from "../src/core/runtime-observer.js";
import { LoopRuntime } from "../src/core/loop-runtime.js";
import { FakeCapabilityExecutor } from "../src/core/capability-executor.js";
import { LocalEvidenceCheckpointProvider } from "../src/adapters/local-evidence-checkpoint-provider.js";
import { LocalExecutionLeaseProvider } from "../src/adapters/local-execution-lease-provider.js";
import { JsonRuntimeCheckpointStore } from "../src/adapters/json-runtime-checkpoint-store.js";
import { MarkdownProjectionStore } from "../src/adapters/markdown-projection-store.js";
import { FakeEvidenceStore } from "../src/testing/fake-providers.js";

/**
 * Proves the Phase 7 primary objective end to end WITHOUT real Jira
 * credentials: a real LoopRuntime, State Engine, ActionPlanner, and the
 * existing resolveNextTask resolver drive a synthetic lifecycle whose task
 * source is JiraTaskSystemAdapter instead of MarkdownTaskAdapter/Markdown.
 * The GitHub SCM/CI legs are the deterministic controlled capabilities
 * already used by Microtest 002 (this file does not touch real GitHub;
 * that remains gated on real credentials, see Microtest 003/PHASE-6).
 * Nothing here manually sets computed state — every transition is produced
 * by runtime.runCycle/runUntilStop.
 */

const SITE = "loop-experiment.atlassian.net";
const PROJECT = "LOOP";
const STATUS_MAPPING = Object.freeze({ "To Do": "OPEN", "In Progress": "OPEN", "Done": "DONE" });
const AC_1 = "Acceptance Criteria\n\n- AC-001: runtime proves a Jira-sourced lifecycle\n";
const AC_2 = "Acceptance Criteria\n\n- AC-001: the Jira-dependent task becomes eligible\n";

const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE_HEAD = "dddddddddddddddddddddddddddddddddddddddd";
const SPEC_DIGEST = "sha256-synthetic-jira-spec";
const REVIEW_TIME = "2026-09-30T08:00:00.000Z";

class JiraFixture {
  constructor() {
    this.status1 = "To Do";
    this.links1 = [];
    this.searchCalls = 0;
  }
  issues() {
    return [
      { key: "LOOP-1", fields: { summary: "First Jira task", status: { name: this.status1 }, description: AC_1, issuelinks: this.links1 } },
      { key: "LOOP-2", fields: { summary: "Second Jira task", status: { name: "To Do" }, description: AC_2, issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "LOOP-1" } }] } },
    ];
  }
  transport = () => {
    this.searchCalls += 1;
    const issues = this.issues();
    return JSON.stringify({ issues, total: issues.length, startAt: 0, maxResults: 100 });
  };
}

function buildRuntime(root, jiraFixture) {
  const jira = new JiraTaskSystemAdapter({
    site: SITE, email: "loop@example.invalid", apiToken: "token", projectKey: PROJECT,
    statusMapping: STATUS_MAPPING, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP, transport: jiraFixture.transport,
  });
  const state = { revision: null, ci: null, validation: null, review: null, merge: null, postMergeValidation: null, completed: false, calls: [] };
  const gitProvider = { getRevision: () => state.revision };
  const ciProvider = { getCIResult: (head) => (state.ci?.head === head ? state.ci : null) };
  const reviewProvider = {
    getReviewResult: (head) => {
      if (head === BASE) return { head, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: REVIEW_TIME, reviewerId: "spec-reviewer@example.invalid" };
      return state.review?.head === head ? state.review : null;
    },
  };
  const validationProvider = {
    getValidationResult: (taskId, head) => {
      if (state.validation?.head === head) return state.validation;
      if (state.postMergeValidation?.head === head) return state.postMergeValidation;
      return null;
    },
  };
  const scmProvider = { getMergeFact: (_taskId, head) => (state.merge?.candidateHead === head ? state.merge : null) };
  const recoveryCoordinator = new RecoveryCoordinator({ taskSystem: jira, gitProvider, scmProvider, ciProvider, reviewProvider, validationProvider });
  const evidenceStore = new FakeEvidenceStore();
  const evidenceCheckpointProvider = new LocalEvidenceCheckpointProvider({ path: join(root, "evidence-root.json") });
  const projectionStore = new MarkdownProjectionStore({ directory: join(root, "projections") });
  const observer = new RuntimeObserver({
    recoveryCoordinator, evidenceStore, evidenceCheckpointProvider, projectionStore,
    contextProvider: () => ({ specRevision: { head: BASE }, specDigest: SPEC_DIGEST }),
  });
  const activeTask = () => jira.listTasks().find((task) => task.id === "LOOP-1");
  const capabilities = {
    WRITE_PROJECTIONS: (_action, ctx) => projectionStore.write({ executionId: ctx.executionId, computed: ctx.observation.computed }),
    REQUEST_SPEC_REVIEW: () => ({ outputReference: "spec-review-satisfied-by-base" }),
    PREPARE_IMPLEMENTATION: () => { state.calls.push("implement"); state.revision = { head: HEAD, base: BASE, branch: "loop/LOOP-1/exec", authorId: "coder@example.invalid", dirty: false, changedFiles: [] }; return { outputReference: HEAD }; },
    RUN_TESTS: () => { state.calls.push("tests"); state.ci = { head: HEAD, status: "PASS", checkedAt: REVIEW_TIME, runId: "ci-jira-001" }; return { outputReference: "ci-jira-001" }; },
    RUN_VALIDATION: (_action, ctx) => {
      const task = activeTask();
      const isPost = Boolean(state.merge?.merged && ctx.observation.computed.state === "POST_MERGE_VALIDATION");
      state.calls.push(isPost ? "post-validation" : "validation");
      const record = { head: isPost ? MERGE_HEAD : HEAD, baseline: isPost ? HEAD : BASE, specDigest: SPEC_DIGEST, acceptanceCriteriaDigest: task.acceptanceCriteriaDigest, result: "PASS", independent: true, acProof: { total: task.acceptanceCriteria.length, proved: task.acceptanceCriteria.length } };
      state[isPost ? "postMergeValidation" : "validation"] = record;
      if (isPost) state.completed = true;
      return { outputReference: isPost ? "post-validation" : "validation" };
    },
    RUN_POST_MERGE_VALIDATION: (a, c) => capabilities.RUN_VALIDATION(a, c),
    REQUEST_REVIEW: () => { state.calls.push("review"); state.review = { head: HEAD, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: "2026-09-30T09:00:00.000Z", reviewerId: "reviewer@example.invalid" }; return { outputReference: "review" }; },
    PREPARE_MERGE: () => { state.calls.push("merge"); state.merge = { candidateHead: HEAD, status: "MERGED", merged: true, mergeCommit: MERGE_HEAD, mergedAt: "2026-09-30T09:30:00.000Z" }; return { outputReference: MERGE_HEAD }; },
    COMPLETE: () => ({ outputReference: "completed" }),
    LOAD_TASK: () => ({ outputReference: "task-loaded" }),
    WAIT: () => ({ outputReference: "waiting" }),
    ESCALATE_OWNER: () => ({ outputReference: "owner-block" }),
    ESCALATE_EXTERNAL: () => ({ outputReference: "external-block" }),
  };
  const executor = new FakeCapabilityExecutor({ capabilities, provider: "jira-runtime-substitution" });
  const checkpointStore = new JsonRuntimeCheckpointStore({ path: join(root, "runtime-checkpoint.json") });
  const leaseProvider = new LocalExecutionLeaseProvider({ directory: join(root, "leases") });
  const runtime = new LoopRuntime({ observer, executor, evidenceStore, evidenceCheckpointProvider, checkpointStore, leaseProvider, timeoutMs: 5000, leaseTtlMs: 120000 });
  return { runtime, jira, state };
}

test("Microtest 004 (synthetic) — a real Jira-sourced task drives the real Runtime end to end to DONE, and the Jira-dependent task becomes eligible", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "jira-runtime-substitution-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = new JiraFixture();
  const { runtime, state } = buildRuntime(root, fixture);
  const result = await runtime.runUntilStop({ executionId: "jira-exec:LOOP-1:run-001", repository: "loop-experiment/sandbox", maxCycles: 40 });
  assert.equal(result.outcome, "DONE", JSON.stringify({ state: result.state, calls: state.calls, last: result.lastCycle }));
  assert.equal(result.state, "DONE");
  assert.equal(result.nextTaskId, "LOOP-2", "the Jira-dependent task must become eligible once LOOP-1 computes DONE");
  assert.deepEqual(state.calls, ["implement", "tests", "validation", "review", "merge", "post-validation"]);
  assert.ok(fixture.searchCalls > result.cycles / 2, "the Jira adapter must be read fresh across cycles, not cached once and reused");
});

test("J16 a Jira dependency added after planning is reconciled: the stale merge action is blocked instead of executed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "jira-runtime-drift-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const fixture = new JiraFixture();
  const { runtime, state } = buildRuntime(root, fixture);
  const executionId = "jira-exec:LOOP-1:drift";
  let cycle;
  let readyCycles = 0;
  for (let index = 0; index < 40; index += 1) {
    cycle = await runtime.runCycle({ executionId, repository: "loop-experiment/sandbox" });
    if (cycle.nextComputed.state === "READY_TO_MERGE" && !cycle.nextComputed.projectionMismatch) { readyCycles += 1; if (readyCycles === 1) break; }
  }
  assert.equal(cycle.nextComputed.state, "READY_TO_MERGE");
  // Jira changes mid-flight: LOOP-1 unexpectedly gains a new blocking dependency
  // between planning and the runtime re-observing before merge.
  fixture.links1 = [{ type: { name: "Blocks" }, inwardIssue: { key: "LOOPX-1" } }];
  fixture.issues = function patched() {
    return [
      { key: "LOOP-1", fields: { summary: "First Jira task", status: { name: this.status1 }, description: AC_1, issuelinks: this.links1 } },
      { key: "LOOP-2", fields: { summary: "Second Jira task", status: { name: "To Do" }, description: AC_2, issuelinks: [] } },
      { key: "LOOPX-1", fields: { summary: "Newly introduced blocker", status: { name: "To Do" }, description: AC_1, issuelinks: [] } },
    ];
  };
  const mergesBefore = state.calls.filter((call) => call === "merge").length;
  const next = await runtime.runCycle({ executionId, repository: "loop-experiment/sandbox" });
  const mergesAfter = state.calls.filter((call) => call === "merge").length;
  assert.equal(mergesAfter, mergesBefore, "the runtime must not have merged against a task whose dependency facts changed after planning");
  assert.notEqual(next.nextComputed.state, "READY_TO_MERGE", JSON.stringify({ state: next.nextComputed.state, blockers: next.nextComputed.blockers }));
});
