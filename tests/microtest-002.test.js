import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTask } from "../src/core/contracts.js";
import { RecoveryCoordinator } from "../src/core/recovery-coordinator.js";
import { LoopRuntime } from "../src/core/loop-runtime.js";
import { RuntimeObserver } from "../src/core/runtime-observer.js";
import { RuntimeRetryPolicy } from "../src/core/retry-policy.js";
import { FakeCapabilityExecutor } from "../src/core/capability-executor.js";
import { FakeEvidenceStore } from "../src/testing/fake-providers.js";
import { LocalEvidenceCheckpointProvider } from "../src/adapters/local-evidence-checkpoint-provider.js";
import { LocalExecutionLeaseProvider } from "../src/adapters/local-execution-lease-provider.js";
import { JsonRuntimeCheckpointStore } from "../src/adapters/json-runtime-checkpoint-store.js";
import { MarkdownProjectionStore } from "../src/adapters/markdown-projection-store.js";
import { resolveNextTask } from "../src/adapters/markdown-task-adapter.js";
import { makePlannedAction } from "../src/core/runtime-contracts.js";
import { verifyEvidenceCheckpoint } from "../src/adapters/local-evidence-checkpoint-provider.js";
import { JsonlEvidenceStore } from "../src/adapters/jsonl-evidence-store.js";

const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPEC_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const HEAD = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MERGE_HEAD = "dddddddddddddddddddddddddddddddddddddddd";
const SPEC_DIGEST = "sha256-synthetic-spec";
const REVIEW_TIME = "2026-09-28T08:00:00.000Z";

class LifecycleFacts {
  constructor() {
    this.specPresent = false;
    this.specReviewed = false;
    this.specDigest = SPEC_DIGEST;
    this.specHead = SPEC_HEAD;
    this.revision = null;
    this.ci = null;
    this.validation = null;
    this.review = null;
    this.merge = null;
    this.postMergeValidation = null;
    this.completed = false;
    this.calls = [];
  }
  tasks() {
    return [
      makeTask({ id: "TASK-001", title: "Runtime lifecycle", completed: this.completed, specPresent: this.specPresent, acceptanceCriteria: [{ id: "AC-01", description: "runtime proves lifecycle" }], dependencies: [] }),
      makeTask({ id: "TASK-002", title: "Next task", acceptanceCriteria: [{ id: "AC-01", description: "dependency follows" }], dependencies: [{ taskId: "TASK-001" }] }),
    ];
  }
}

class DynamicTaskProvider {
  constructor(facts) { this.facts = facts; }
  listTasks() { return this.facts.tasks(); }
  resolveNextTask({ additionalCompletedIds = [] } = {}) {
    const done = new Set(additionalCompletedIds);
    return resolveNextTask(this.listTasks().map((task) => done.has(task.id) ? makeTask({ ...task, completed: true }) : task));
  }
}

class DynamicGitProvider {
  constructor(facts) { this.facts = facts; }
  getRevision() { return this.facts.revision; }
}
class DynamicCIProvider { constructor(f) { this.f = f; } getCIResult(head) { return this.f.ci?.head === head ? this.f.ci : null; } }
class DynamicReviewProvider {
  constructor(f) { this.f = f; }
  getReviewResult(head) {
    if (head === this.f.specHead) return this.f.specReviewed ? { head, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: REVIEW_TIME, reviewerId: "spec-reviewer" } : null;
    return this.f.review?.head === head ? this.f.review : null;
  }
}
class DynamicValidationProvider {
  constructor(f) { this.f = f; }
  getValidationResult(taskId, head) {
    if (taskId !== "TASK-001") return null;
    if (this.f.validation?.head === head) return this.f.validation;
    if (this.f.postMergeValidation?.head === head) return this.f.postMergeValidation;
    return null;
  }
}
class DynamicSCMProvider { constructor(f) { this.f = f; } getMergeFact(_taskId, head) { return this.f.merge?.candidateHead === head ? this.f.merge : null; } }

function makeRuntime(root, facts, { faultInjector = () => {}, executorOverride = null, timeoutMs = 1000, shared = null, wakeupProvider = null, retryPolicy = null, clock = () => new Date().toISOString() } = {}) {
  const taskSystem = new DynamicTaskProvider(facts);
  const recoveryCoordinator = new RecoveryCoordinator({
    taskSystem,
    gitProvider: new DynamicGitProvider(facts),
    scmProvider: new DynamicSCMProvider(facts),
    ciProvider: new DynamicCIProvider(facts),
    reviewProvider: new DynamicReviewProvider(facts),
    validationProvider: new DynamicValidationProvider(facts),
  });
  const evidenceStore = shared?.evidenceStore ?? new FakeEvidenceStore();
  const evidenceCheckpointProvider = shared?.evidenceCheckpointProvider ?? new LocalEvidenceCheckpointProvider({ path: join(root, "trusted", "evidence-root.json") });
  const projectionStore = shared?.projectionStore ?? new MarkdownProjectionStore({ directory: join(root, "docs", "state") });
  const observer = new RuntimeObserver({
    recoveryCoordinator, evidenceStore, evidenceCheckpointProvider, projectionStore,
    contextProvider: () => facts.specPresent ? { specRevision: { head: facts.specHead }, specDigest: facts.specDigest } : {},
  });
  const capabilities = {
    WRITE_PROJECTIONS: (_action, ctx) => projectionStore.write({ executionId: ctx.executionId, computed: ctx.observation.computed }),
    PREPARE_SPEC: () => { facts.calls.push("spec"); facts.specPresent = true; return { outputReference: "spec-v1" }; },
    REQUEST_SPEC_REVIEW: () => { facts.calls.push("spec-review"); facts.specReviewed = true; return { outputReference: "spec-review-v1" }; },
    PREPARE_IMPLEMENTATION: () => { facts.calls.push("implement"); facts.revision = { head: HEAD, base: BASE, branch: "feature/TASK-001", authorId: "coder@example.invalid", dirty: false, changedFiles: [] }; return { outputReference: HEAD }; },
    RUN_TESTS: () => { facts.calls.push("tests"); facts.ci = { head: HEAD, status: "PASS", checkedAt: REVIEW_TIME, runId: "ci-001" }; return { outputReference: "ci-001" }; },
    RUN_VALIDATION: (_action, ctx) => {
      facts.calls.push(ctx.observation.computed.state === "POST_MERGE_VALIDATION" ? "post-validation" : "validation");
      const isPost = Boolean(facts.merge?.merged && ctx.observation.computed.state === "POST_MERGE_VALIDATION");
      const base = isPost ? HEAD : BASE;
      facts[isPost ? "postMergeValidation" : "validation"] = {
        head: isPost ? MERGE_HEAD : HEAD, baseline: base, specDigest: SPEC_DIGEST,
        acceptanceCriteriaDigest: facts.tasks()[0].acceptanceCriteriaDigest,
        result: "PASS", independent: true, acProof: { total: 1, proved: 1 },
      };
      if (isPost) facts.completed = true;
      return { outputReference: isPost ? "post-validation-001" : "validation-001" };
    },
    RUN_POST_MERGE_VALIDATION: (_action, ctx) => capabilities.RUN_VALIDATION(_action, ctx),
    REQUEST_REVIEW: () => { facts.calls.push("review"); facts.review = { head: HEAD, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: "2026-09-28T09:00:00.000Z", reviewerId: "reviewer@example.invalid" }; return { outputReference: "review-001" }; },
    PREPARE_MERGE: () => { facts.calls.push("merge"); facts.merge = { candidateHead: HEAD, status: "MERGED", merged: true, mergeCommit: MERGE_HEAD, mergedAt: "2026-09-28T09:30:00.000Z" }; return { outputReference: MERGE_HEAD }; },
    COMPLETE: () => ({ outputReference: "completed" }),
    LOAD_TASK: () => ({ outputReference: "task-loaded" }),
    WAIT: () => ({ outputReference: "waiting" }),
    ESCALATE_OWNER: () => ({ outputReference: "owner-block" }),
    ESCALATE_EXTERNAL: () => ({ outputReference: "external-block" }),
  };
  const executor = executorOverride ?? shared?.executor ?? new FakeCapabilityExecutor({ capabilities, provider: "microtest-002" });
  const checkpointStore = new JsonRuntimeCheckpointStore({ path: join(root, "runtime-checkpoint.json") });
  const leaseProvider = new LocalExecutionLeaseProvider({ directory: join(root, "execution-leases"), clock });
  const runtime = new LoopRuntime({
    observer, executor, evidenceStore, evidenceCheckpointProvider,
    checkpointStore,
    leaseProvider,
    retryPolicy: retryPolicy ?? new RuntimeRetryPolicy({ maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1000 }),
    timeoutMs, faultInjector, wakeupProvider, clock,
  });
  const persistence = { evidenceStore, evidenceCheckpointProvider, projectionStore, executor };
  return { runtime, facts, evidenceStore, evidenceCheckpointProvider, projectionStore, checkpointStore, executor, makeRuntime: (opts = {}) => makeRuntime(root, facts, { ...opts, shared: persistence }) };
}

test("Microtest 002 — Runtime Lifecycle autonomously executes and reconciles the full synthetic flow", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-microtest-002-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts());
  const result = await system.runtime.runUntilStop({ executionId: "repo-synthetic:TASK-001:run-001", repository: "repo-synthetic", maxCycles: 40 });
  assert.equal(result.outcome, "DONE", JSON.stringify({ state: result.state, cycles: result.cycles, calls: system.facts.calls, last: result.lastCycle }));
  assert.equal(result.state, "DONE");
  assert.equal(result.nextTaskId, "TASK-002");
  assert.deepEqual(system.facts.calls, ["spec", "spec-review", "implement", "tests", "validation", "review", "merge", "post-validation"]);
  assert.ok(result.cycles <= 40);
  assert.ok(system.evidenceStore.listAll().some((event) => event.eventType === "ACTION_RESULT" && event.payload.result === "SUCCEEDED"));
  assert.equal(system.projectionStore.read("repo-synthetic:TASK-001:run-001").drift, false);
  assert.ok(system.evidenceStore.listAll().some((event) => event.eventType === "RUNTIME_CYCLE"));
});

test("P5-02/P5-03 — one cycle invokes no more than one capability and planner IDs are deterministic", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-runtime-one-action-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts());
  const first = await system.runtime.runCycle({ executionId: "repo:TASK-001:one", repository: "repo" });
  assert.ok(system.executor.calls.length <= 1);
  const observation = first.observation;
  const { ActionPlanner } = await import("../src/core/action-planner.js");
  const planner = new ActionPlanner();
  const plannedA = planner.plan(observation, { now: REVIEW_TIME });
  const plannedB = planner.plan(observation, { now: REVIEW_TIME });
  assert.equal(plannedA.actionId, plannedB.actionId);
  assert.equal(plannedA.actionType, plannedB.actionType);
});

async function runUntilCrash(system, executionId, actionType, faultPoint) {
  for (let index = 0; index < 40; index += 1) {
    try {
      const cycle = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
      if (cycle.plannedAction.actionType === actionType && faultPoint === "after_provider_success_before_evidence") {
        throw new Error(`fault point ${faultPoint} was not triggered`);
      }
    } catch (error) {
      if (error.message === `injected ${faultPoint}`) return;
      throw error;
    }
  }
  throw new Error(`did not reach ${actionType}`);
}

test("R01 — crash after planning reuses the deterministic action without duplicate execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-r01-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let crashed = false;
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts, { faultInjector: (point) => {
    if (!crashed && point === "after_planning_before_execution") { crashed = true; throw new Error("injected after_planning_before_execution"); }
  } });
  await assert.rejects(system.runtime.runCycle({ executionId: "repo:TASK-001:R01", repository: "repo-synthetic" }), /injected/);
  const restarted = system.makeRuntime();
  await restarted.runtime.runCycle({ executionId: "repo:TASK-001:R01", repository: "repo-synthetic" });
  assert.equal(system.executor.calls.filter((name) => name === "WRITE_PROJECTIONS").length, 1);
  assert.equal(system.evidenceStore.listAll().filter((event) => event.eventType === "ACTION_PLANNED").length, 1);
});

test("R02/R03 — provider success before durable result is reconciled instead of repeated", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-r02-r03-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts);
  await system.runtime.runCycle({ executionId: "repo:TASK-001:R02", repository: "repo-synthetic" });
  let calls = 0;
  system.runtime.executor = {
    reconcile: async () => ({ status: "NOT_STARTED" }),
    execute: async (action) => {
      if (action.actionType === "PREPARE_SPEC") { calls += 1; facts.specPresent = true; }
      throw Object.assign(new Error("executor crashed during action before result write"), { classification: "TRANSIENT", retryable: true });
    },
  };
  const failed = await system.runtime.runCycle({ executionId: "repo:TASK-001:R02", repository: "repo-synthetic" });
  assert.equal(failed.outcome, "WAIT_RETRYABLE");
  const restarted = system.makeRuntime();
  const resumed = await restarted.runtime.runCycle({ executionId: "repo:TASK-001:R02", repository: "repo-synthetic" });
  assert.equal(calls, 1);
  assert.equal(resumed.observation.computed.state, "SPEC_REVIEW");

  const root3 = mkdtempSync(join(tmpdir(), "loop-r03-"));
  t.after(() => rmSync(root3, { recursive: true, force: true }));
  const facts3 = new LifecycleFacts();
  let crash = true;
  const system3 = makeRuntime(root3, facts3, { faultInjector: (point, { plannedAction } = {}) => {
    if (crash && point === "after_provider_success_before_evidence" && plannedAction?.actionType === "PREPARE_SPEC") {
      crash = false;
      throw new Error("injected after_provider_success_before_evidence");
    }
  } });
  const exec3 = "repo:TASK-001:R03";
  await runUntilCrash(system3, exec3, "PREPARE_SPEC", "after_provider_success_before_evidence");
  const restart3 = system3.makeRuntime();
  const after = await restart3.runtime.runCycle({ executionId: exec3, repository: "repo-synthetic" });
  assert.equal(after.observation.computed.state, "SPEC_REVIEW");
  assert.equal(facts3.calls.filter((value) => value === "spec").length, 1);
});

test("R04/R05 — recovery uses durable result evidence/checkpoint and does not repeat work", async (t) => {
  for (const [id, point] of [["R04", "after_evidence_append_before_checkpoint"], ["R05", "after_checkpoint_before_next_observation"]]) {
    const root = mkdtempSync(join(tmpdir(), `loop-${id.toLowerCase()}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const facts = new LifecycleFacts();
    let crash = true;
    const system = makeRuntime(root, facts, { faultInjector: (where, data = {}) => {
      const actionType = data.plannedAction?.actionType ?? data.checkpoint?.plannedAction ?? data.event?.payload?.actionType;
      if (!crash || actionType !== "PREPARE_SPEC") return;
      if (where === point && (where !== "after_evidence_append_before_checkpoint" || data.event?.eventType === "ACTION_RESULT")) {
        crash = false;
        throw new Error(`injected ${point}`);
      }
    } });
    const executionId = `repo:TASK-001:${id}`;
    await runUntilCrash(system, executionId, "PREPARE_SPEC", point);
    const restarted = system.makeRuntime();
    const cycle = await restarted.runtime.runCycle({ executionId, repository: "repo-synthetic" });
    assert.notEqual(cycle.plannedAction.actionType, "PREPARE_SPEC");
    assert.equal(facts.calls.filter((value) => value === "spec").length, 1);
  }
});

test("R06/R07 — crash before and after merge rechecks gates and never merges twice", async (t) => {
  for (const [id, point] of [["R06", "after_planning_before_execution"], ["R07", "after_provider_success_before_evidence"]]) {
    const root = mkdtempSync(join(tmpdir(), `loop-${id.toLowerCase()}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const facts = new LifecycleFacts();
    let crash = true;
    const system = makeRuntime(root, facts, { faultInjector: (where, data = {}) => {
      if (!crash || data.plannedAction?.actionType !== "PREPARE_MERGE") return;
      if (where === point) { crash = false; throw new Error(`injected ${point}`); }
    } });
    const executionId = `repo:TASK-001:${id}`;
    await runUntilCrash(system, executionId, "PREPARE_MERGE", point);
    const beforeRestart = facts.calls.filter((value) => value === "merge").length;
    const restarted = system.makeRuntime();
    const recovered = await restarted.runtime.runCycle({ executionId, repository: "repo-synthetic" });
    if (id === "R06") assert.equal(recovered.nextComputed.state, "POST_MERGE_VALIDATION");
    else assert.ok(["POST_MERGE_VALIDATION", "POST_MERGE_VALIDATION"].includes(recovered.nextComputed.state));
    assert.equal(facts.calls.filter((value) => value === "merge").length, 1);
    assert.ok(beforeRestart <= 1);
  }
});

test("R08 — crash after final validation regenerates stale projections and computes DONE", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-r08-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  let crash = true;
  const system = makeRuntime(root, facts, { faultInjector: (point, { plannedAction } = {}) => {
    if (crash && point === "after_provider_success_before_evidence" && plannedAction?.actionType === "RUN_POST_MERGE_VALIDATION") {
      crash = false;
      throw new Error("injected after_provider_success_before_evidence");
    }
  } });
  const executionId = "repo:TASK-001:R08";
  await runUntilCrash(system, executionId, "RUN_POST_MERGE_VALIDATION", "after_provider_success_before_evidence");
  const restarted = system.makeRuntime();
  const outcome = await restarted.runtime.runUntilStop({ executionId, repository: "repo-synthetic", maxCycles: 5 });
  assert.equal(outcome.outcome, "DONE");
  assert.equal(facts.calls.filter((value) => value === "post-validation").length, 1);
  assert.equal(system.projectionStore.read(executionId).drift, false);
});

test("P5-04/P5-05 — candidate HEAD and spec changes after planning abort the stale action", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-stale-preconditions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts);
  const executionId = "repo:TASK-001:stale-head";
  let changedHead = false;
  system.runtime.faultInjector = (point, { plannedAction } = {}) => {
    if (!changedHead && point === "after_planning_before_execution" && plannedAction?.actionType === "RUN_TESTS") {
      changedHead = true;
      facts.revision = { ...facts.revision, head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };
    }
  };
  let cycle;
  for (let index = 0; index < 20 && !cycle; index += 1) {
    const next = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
    if (next.plannedAction.actionType === "RUN_TESTS") cycle = next;
  }
  assert.equal(changedHead, true);
  assert.equal(cycle.actionResult.result, "BLOCKED");
  assert.equal(facts.calls.includes("tests"), false);

  const root2 = mkdtempSync(join(tmpdir(), "loop-stale-spec-"));
  t.after(() => rmSync(root2, { recursive: true, force: true }));
  const facts2 = new LifecycleFacts();
  const system2 = makeRuntime(root2, facts2);
  const execution2 = "repo:TASK-001:stale-spec";
  let changedSpec = false;
  system2.runtime.faultInjector = (point, { plannedAction } = {}) => {
    if (!changedSpec && point === "after_planning_before_execution" && plannedAction?.actionType === "RUN_VALIDATION") {
      changedSpec = true;
      facts2.specDigest = "sha256-spec-mutated";
      facts2.specHead = "ffffffffffffffffffffffffffffffffffffffff";
    }
  };
  let stale;
  for (let index = 0; index < 25 && !stale; index += 1) {
    const next = await system2.runtime.runCycle({ executionId: execution2, repository: "repo-synthetic" });
    if (next.plannedAction.actionType === "RUN_VALIDATION") stale = next;
  }
  assert.equal(changedSpec, true);
  assert.equal(stale.actionResult.result, "BLOCKED");
  assert.equal(facts2.calls.includes("validation"), false);
});

test("P5-06 — capability executor deduplicates validation/review/merge/post-validation action IDs", async () => {
  const calls = new Map();
  const executor = new FakeCapabilityExecutor({ capabilities: Object.fromEntries([
    "RUN_VALIDATION", "REQUEST_REVIEW", "PREPARE_MERGE", "RUN_POST_MERGE_VALIDATION",
  ].map((name) => [name, () => { calls.set(name, (calls.get(name) ?? 0) + 1); return { outputReference: name }; }])) });
  for (const [index, actionType] of ["RUN_VALIDATION", "REQUEST_REVIEW", "PREPARE_MERGE", "RUN_POST_MERGE_VALIDATION"].entries()) {
    const action = makePlannedAction({
      actionId: `exec:TASK-001:${actionType}:${index}`, actionType, taskId: "TASK-001",
      candidateRevision: HEAD, preconditions: {}, inputFingerprint: `fp-${index}`, attempt: 1,
      createdAt: REVIEW_TIME, executionId: "exec", repository: "repo", cycleId: `cycle:${index}`,
    });
    await executor.execute(action, {});
    await executor.execute(action, {});
    assert.equal(calls.get(actionType), 1);
  }
});

test("P5-06 — durable success without provider-state advancement blocks instead of executing again", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-no-duplicate-success-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts);
  const executionId = "repo:TASK-001:unadvanced-success";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  let calls = 0;
  system.runtime.executor = new FakeCapabilityExecutor({ capabilities: {
    PREPARE_SPEC: () => { calls += 1; return { outputReference: "fake-success-without-provider-change" }; },
  } });
  const success = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(success.actionResult.result, "SUCCEEDED");
  const duplicate = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(duplicate.outcome, "BLOCKED_EXTERNAL");
  assert.equal(calls, 1);
  assert.equal(system.evidenceStore.listAll().filter((event) => event.eventType === "ACTION_RESULT" && event.payload.actionType === "PREPARE_SPEC").length, 1);
});

test("P5-13 audit — overlapping cycles for one execution cannot issue duplicate merges", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-concurrent-merge-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts);
  const executionId = "repo:TASK-001:concurrent-merge";
  let ready = false;
  for (let index = 0; index < 30 && !ready; index += 1) {
    const cycle = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
    ready = cycle.nextComputed.state === "READY_TO_MERGE" && !cycle.nextComputed.projectionMismatch;
  }
  assert.equal(ready, true);
  const underlyingExecutor = system.executor;
  let enteredReconcile = 0;
  let releaseReconcile;
  const bothReconciled = new Promise((resolve) => { releaseReconcile = resolve; });
  system.runtime.executor = {
    reconcile: async () => {
      enteredReconcile += 1;
      if (enteredReconcile === 2) releaseReconcile();
      await Promise.race([bothReconciled, new Promise((resolve) => setTimeout(resolve, 50))]);
      return { status: "NOT_STARTED" };
    },
    execute: (action, context) => underlyingExecutor.execute(action, context),
  };
  const results = await Promise.allSettled([
    system.runtime.runCycle({ executionId, repository: "repo-synthetic" }),
    system.runtime.runCycle({ executionId, repository: "repo-synthetic" }),
  ]);
  assert.equal(facts.calls.filter((value) => value === "merge").length, 1);
  assert.equal(results.filter((value) => value.status === "fulfilled").length, 2);
});

test("P6-A — independent runtimes contend on the durable lease before merge", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-two-runtime-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const first = makeRuntime(root, facts);
  const executionId = "repo:TASK-001:two-runtime-lease";
  let ready = false;
  for (let index = 0; index < 30 && !ready; index += 1) {
    const cycle = await first.runtime.runCycle({ executionId, repository: "repo-synthetic" });
    ready = cycle.nextComputed.state === "READY_TO_MERGE" && !cycle.nextComputed.projectionMismatch;
  }
  assert.equal(ready, true);
  const originalExecutor = first.executor;
  let enteredMerge;
  const mergeEntered = new Promise((resolve) => { enteredMerge = resolve; });
  let releaseMerge;
  const mergeGate = new Promise((resolve) => { releaseMerge = resolve; });
  first.runtime.executor = {
    reconcile: (action, context) => originalExecutor.reconcile(action, context),
    execute: async (action, context) => {
      if (action.actionType === "PREPARE_MERGE") {
        await context.assertLeaseCurrent();
        enteredMerge();
        await mergeGate;
      }
      return originalExecutor.execute(action, context);
    },
  };
  const firstPromise = first.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  await mergeEntered;
  const second = first.makeRuntime({ executorOverride: originalExecutor });
  await assert.rejects(second.runtime.runCycle({ executionId, repository: "repo-synthetic" }), { code: "EXECUTION_LEASE_UNAVAILABLE" });
  assert.equal(facts.calls.filter((call) => call === "merge").length, 0);
  releaseMerge();
  const completed = await firstPromise;
  assert.equal(completed.actionResult.result, "SUCCEEDED");
  assert.equal(facts.calls.filter((call) => call === "merge").length, 1);
});

test("P6-A — an expired runtime cannot execute with its stale fencing token", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-stale-runtime-lease-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let nowMs = Date.parse(REVIEW_TIME);
  const clock = () => new Date(nowMs).toISOString();
  const facts = new LifecycleFacts();
  const first = makeRuntime(root, facts, { clock });
  const executionId = "repo:TASK-001:stale-runtime-lease";
  let ready = false;
  for (let index = 0; index < 30 && !ready; index += 1) {
    const cycle = await first.runtime.runCycle({ executionId, repository: "repo-synthetic" });
    ready = cycle.nextComputed.state === "READY_TO_MERGE" && !cycle.nextComputed.projectionMismatch;
  }
  assert.equal(ready, true);
  const replacementProvider = new LocalExecutionLeaseProvider({ directory: join(root, "execution-leases"), clock });
  const baseExecutor = first.executor;
  first.runtime.executor = {
    reconcile: async (action, context) => {
      if (action.actionType === "PREPARE_MERGE") {
        nowMs += first.runtime.leaseTtlMs + 1;
        const replacement = replacementProvider.acquire({
          repository: "repo-synthetic", taskId: "TASK-001", executionId,
          ownerId: "runtime-B", ttlMs: first.runtime.leaseTtlMs,
        });
        assert.equal(replacement.fencingToken > context.fencingToken, true);
      }
      return baseExecutor.reconcile(action, context);
    },
    execute: (action, context) => baseExecutor.execute(action, context),
  };
  await assert.rejects(first.runtime.runCycle({ executionId, repository: "repo-synthetic" }), { code: "STALE_EXECUTION_LEASE" });
  assert.equal(facts.calls.filter((call) => call === "merge").length, 0);
  assert.equal(facts.merge, null);
});

test("P5-06 — malformed reconciliation cannot be treated as NOT_STARTED or successful", async (t) => {
  for (const [name, reconcile] of [
    ["unknown-status", async () => ({ status: "DONE" })],
    ["wrong-completed-action", async (action) => ({
      status: "COMPLETED",
      result: {
        actionId: `${action.actionId}:different`, executionId: action.executionId,
        cycleId: action.cycleId, taskId: action.taskId, candidateRevision: action.candidateRevision,
        result: "SUCCEEDED", startedAt: REVIEW_TIME, finishedAt: REVIEW_TIME,
        provider: "contradictory-reconciler", outputReference: "untrusted",
      },
    })],
  ]) {
    const root = mkdtempSync(join(tmpdir(), `loop-reconcile-${name}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    let executions = 0;
    const executor = {
      reconcile,
      execute: async () => { executions += 1; throw new Error("must not execute after invalid reconciliation"); },
    };
    const system = makeRuntime(root, new LifecycleFacts(), { executorOverride: executor });
    const cycle = await system.runtime.runCycle({ executionId: `repo:TASK-001:${name}`, repository: "repo-synthetic" });
    assert.equal(cycle.outcome, "BLOCKED_EXTERNAL", name);
    assert.equal(cycle.actionResult.result, "BLOCKED", name);
    assert.equal(cycle.actionResult.errorClass, "INVARIANT_VIOLATION", name);
    assert.equal(executions, 0, name);
  }
});

test("P5-10/P5-11/P5-12 — retryable, permanent and owner failures are classified and bounded", async (t) => {
  for (const [classification, expected] of [["TRANSIENT", "WAIT_RETRYABLE"], ["PERMANENT", "BLOCKED_EXTERNAL"], ["OWNER_REQUIRED", "BLOCKED_OWNER"]]) {
    const root = mkdtempSync(join(tmpdir(), `loop-error-${classification.toLowerCase()}-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const wakeups = [];
    const system = makeRuntime(root, new LifecycleFacts(), { wakeupProvider: { schedule: (request) => wakeups.push(request) } });
    await system.runtime.runCycle({ executionId: `repo:TASK-001:${classification}`, repository: "repo-synthetic" });
    system.runtime.executor = {
      reconcile: async () => ({ status: "NOT_STARTED" }),
      execute: async () => { throw Object.assign(new Error(`injected ${classification}`), { classification, retryable: classification === "TRANSIENT" }); },
    };
    const cycle = await system.runtime.runCycle({ executionId: `repo:TASK-001:${classification}`, repository: "repo-synthetic" });
    assert.equal(cycle.outcome, expected);
    if (classification === "TRANSIENT") {
      assert.equal(cycle.checkpoint.retry.classification, "TRANSIENT");
      assert.ok(Number.isFinite(Date.parse(cycle.checkpoint.retry.nextEligibleAt)));
      assert.equal(wakeups.length, 1);
      assert.equal(wakeups[0].executionId, `repo:TASK-001:${classification}`);
    }
  }
});

test("P5-10 — a hung async capability is bounded and becomes a retryable wait", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts(), { timeoutMs: 30 });
  const executionId = "repo:TASK-001:timeout";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  system.runtime.executor = { reconcile: async () => ({ status: "NOT_STARTED" }), execute: async () => new Promise(() => {}) };
  const started = Date.now();
  const result = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(result.outcome, "WAIT_RETRYABLE");
  assert.ok(Date.now() - started < 2000);
  assert.equal(result.actionResult.errorClass, "TRANSIENT");
});

test("P5-06/P5-10 — a late capability completion is reconciled across retry attempts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-late-capability-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts, { timeoutMs: 20, retryPolicy: new RuntimeRetryPolicy({ maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0 }) });
  const executionId = "repo:TASK-001:late-capability";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  let specCalls = 0;
  let finishSpec;
  const specCompletion = new Promise((resolve) => { finishSpec = resolve; });
  system.runtime.executor = new FakeCapabilityExecutor({ capabilities: {
    PREPARE_SPEC: async () => {
      specCalls += 1;
      await specCompletion;
      facts.specPresent = true;
      return { outputReference: "late-spec-v1" };
    },
  } });
  const timedOut = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(timedOut.outcome, "WAIT_RETRYABLE");
  const stillRunning = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(stillRunning.outcome, "WAIT_RETRYABLE");
  assert.equal(specCalls, 1);
  finishSpec();
  await new Promise((resolve) => setImmediate(resolve));
  const reconciled = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(facts.specPresent, true);
  assert.equal(specCalls, 1);
  assert.notEqual(reconciled.plannedAction.actionType, "PREPARE_SPEC");
});

test("P5-10 — a hung reconciliation provider is bounded before capability execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-reconcile-timeout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts(), { timeoutMs: 30 });
  const executionId = "repo:TASK-001:reconcile-timeout";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  let executions = 0;
  system.runtime.executor = {
    reconcile: async () => new Promise(() => {}),
    execute: async () => { executions += 1; return { outputReference: "must-not-run" }; },
  };
  const started = Date.now();
  const result = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(result.outcome, "WAIT_RETRYABLE");
  assert.equal(result.actionResult.errorClass, "TRANSIENT");
  assert.ok(Date.now() - started < 2000);
  assert.equal(executions, 0);
});

test("P5-10 — retry waits until its durable eligibility time and increments attempts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-retry-eligibility-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let now = Date.parse(REVIEW_TIME);
  const system = makeRuntime(root, new LifecycleFacts(), { clock: () => new Date(now).toISOString() });
  const executionId = "repo:TASK-001:retry-eligibility";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  let calls = 0;
  const idempotencyKeys = [];
  system.runtime.executor = {
    reconcile: async () => ({ status: "NOT_STARTED" }),
    execute: async (_action, context) => { calls += 1; idempotencyKeys.push(context.idempotencyKey); throw Object.assign(new Error("temporary outage"), { classification: "TRANSIENT" }); },
  };
  const failed = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(failed.outcome, "WAIT_RETRYABLE");
  assert.equal(failed.plannedAction.attempt, 1);
  const waiting = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(waiting.outcome, "WAIT_RETRYABLE");
  assert.equal(calls, 1);
  assert.equal(waiting.checkpoint.retry.attempt, 1);

  now = Date.parse(failed.checkpoint.retry.nextEligibleAt);
  const retried = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(retried.plannedAction.attempt, 2);
  assert.equal(calls, 2);
  assert.equal(idempotencyKeys[0], idempotencyKeys[1]);
  assert.equal(retried.outcome, "WAIT_RETRYABLE");

  now = Date.parse(retried.checkpoint.retry.nextEligibleAt);
  const exhausted = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(exhausted.plannedAction.attempt, 3);
  assert.equal(exhausted.outcome, "BLOCKED_EXTERNAL");
  assert.notEqual(exhausted.outcome, "DONE");
  const restarted = system.makeRuntime({ clock: () => new Date(now).toISOString(), executorOverride: system.runtime.executor });
  const afterExhaustion = await restarted.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(afterExhaustion.outcome, "BLOCKED_EXTERNAL");
  assert.equal(calls, 3, "restart must not execute after the retry budget is exhausted");
});

test("P5-10 audit — permanent failure remains blocked after restart without another execution", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-permanent-restart-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts());
  const executionId = "repo:TASK-001:permanent-restart";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  let calls = 0;
  const executor = {
    reconcile: async () => ({ status: "NOT_STARTED" }),
    execute: async () => {
      calls += 1;
      throw Object.assign(new Error("invalid provider request"), { classification: "PERMANENT" });
    },
  };
  system.runtime.executor = executor;
  const failed = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(failed.outcome, "BLOCKED_EXTERNAL");
  assert.equal(calls, 1);

  const restarted = system.makeRuntime({ executorOverride: executor });
  const resumed = await restarted.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(resumed.outcome, "BLOCKED_EXTERNAL");
  assert.equal(calls, 1, "permanent failure must not execute again after restart");
});

test("P5-10 audit — crash after retry evidence cannot erase the retry deadline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-retry-crash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const now = () => REVIEW_TIME;
  const system = makeRuntime(root, new LifecycleFacts(), { clock: now });
  const executionId = "repo:TASK-001:retry-crash";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  let calls = 0;
  system.runtime.executor = {
    reconcile: async () => ({ status: "NOT_STARTED" }),
    execute: async () => { calls += 1; throw Object.assign(new Error("temporary outage"), { classification: "TRANSIENT" }); },
  };
  let crash = true;
  system.runtime.faultInjector = (point) => {
    if (crash && point === "after_action_result_before_checkpoint") {
      crash = false;
      throw new Error("injected retry checkpoint gap");
    }
  };
  await assert.rejects(system.runtime.runCycle({ executionId, repository: "repo-synthetic" }), /injected retry checkpoint gap/);
  assert.equal(system.checkpointStore.read(executionId).retry, null);
  assert.ok(system.evidenceStore.listAll().some((event) => event.eventType === "ACTION_RESULT" && event.payload.result === "WAITING"));

  const restarted = system.makeRuntime({ clock: now, executorOverride: system.runtime.executor });
  const resumed = await restarted.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(resumed.outcome, "WAIT_RETRYABLE");
  assert.equal(calls, 1);
});

test("P5-15/P5-16 — generated projections carry a marker and manual tampering is repaired", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-projection-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts());
  const executionId = "repo:TASK-001:projection";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  const statePath = join(root, "docs", "state", "STATE.md");
  assert.match(readFileSync(statePath, "utf8"), /DO NOT EDIT — GENERATED FROM COMPUTED EXECUTION STATE/);
  writeFileSync(statePath, readFileSync(statePath, "utf8").replace("- State: SPEC_REQUIRED", "- State: DONE"));
  assert.equal(system.projectionStore.read(executionId).drift, true);
  const repaired = await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(repaired.plannedAction.actionType, "WRITE_PROJECTIONS");
  assert.equal(system.projectionStore.read(executionId).drift, false);
  assert.equal(system.facts.specPresent, false);
});

function evidenceEvent(eventId) {
  return { eventId, eventType: "RUNTIME_CYCLE", occurredAt: REVIEW_TIME, taskId: "TASK-001", payload: { state: "TESTING" } };
}

test("P5-17/P5-18/P5-19 — trusted checkpoint detects suffix deletion, rejects corruption, advances stale anchor", (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-evidence-anchor-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logPath = join(root, "events.jsonl");
  const trustedPath = join(root, "trusted.json");
  const store = new JsonlEvidenceStore({ path: logPath });
  const provider = new LocalEvidenceCheckpointProvider({ path: trustedPath });
  for (const id of ["E1", "E2"]) store.append(evidenceEvent(id));
  provider.publishCheckpoint({ ...store.getIntegrityCheckpoint(), timestamp: REVIEW_TIME });
  store.append(evidenceEvent("E3"));
  assert.equal(verifyEvidenceCheckpoint(provider, store).status, "STALE");
  provider.publishCheckpoint({ ...store.getIntegrityCheckpoint(), timestamp: REVIEW_TIME });
  assert.equal(verifyEvidenceCheckpoint(provider, store).status, "VERIFIED");
  const lines = readFileSync(logPath, "utf8").trimEnd().split("\n");
  writeFileSync(logPath, `${lines.slice(0, 2).join("\n")}\n`);
  assert.equal(verifyEvidenceCheckpoint(provider, store).status, "TRUNCATED");
  writeFileSync(trustedPath, "{broken-json\n");
  assert.throws(() => provider.readTrustedCheckpoint(), (error) => error.code === "CORRUPTED_CHECKPOINT");
});

test("P5-18/P5-19 — malformed runtime checkpoint is rejected and its valid-looking state is ignored", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-runtime-checkpoint-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const facts = new LifecycleFacts();
  const system = makeRuntime(root, facts);
  const executionId = "repo:TASK-001:checkpoint-trust";
  await system.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  const checkpointPath = system.checkpointStore.pathFor(executionId);
  const checkpoint = JSON.parse(readFileSync(checkpointPath, "utf8"));
  writeFileSync(checkpointPath, JSON.stringify({ ...checkpoint, computedState: "INVALID_STATE" }));
  assert.throws(() => system.checkpointStore.read(executionId), /must be one of/);

  writeFileSync(checkpointPath, JSON.stringify({ ...checkpoint, computedState: "DONE", taskId: "TASK-002" }));
  const restarted = system.makeRuntime();
  const resumed = await restarted.runtime.runCycle({ executionId, repository: "repo-synthetic" });
  assert.equal(resumed.observation.computed.taskId, "TASK-001");
  assert.equal(resumed.observation.computed.state, "SPEC_REQUIRED");
  assert.equal(resumed.plannedAction.actionType, "PREPARE_SPEC");
  assert.notEqual(resumed.outcome, "DONE");
});

test("P5-20 — runtime completion selects the dependency-ready next task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "loop-next-task-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const system = makeRuntime(root, new LifecycleFacts());
  const result = await system.runtime.runUntilStop({ executionId: "repo:TASK-001:next", repository: "repo-synthetic", maxCycles: 40 });
  assert.equal(result.outcome, "DONE");
  assert.equal(result.nextTaskId, "TASK-002");
});
