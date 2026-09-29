import test from "node:test";
import assert from "node:assert/strict";
import {
  makeActionResult,
  makeExecutionOutcome,
  makeExecutionSnapshot,
  makeObservation,
  makePlannedAction,
  makeRuntimeCheckpoint,
  makeRuntimeCycle,
  makeWakeupRequest,
  RUNTIME_ACTIONS,
} from "../src/core/runtime-contracts.js";
import { ActionPlanner, stateActionVocabulary } from "../src/core/action-planner.js";
import { computeState } from "../src/core/state-engine.js";

const NOW = "2026-09-28T10:00:00.000Z";
const computed = computeState({ now: NOW });

test("runtime action vocabulary is closed and contains state mappings", () => {
  assert.ok(RUNTIME_ACTIONS.includes("RUN_VALIDATION"));
  assert.equal(stateActionVocabulary().VALIDATING, "RUN_VALIDATION");
  assert.throws(() => makePlannedAction({
    actionId: "a", actionType: "CALL_AGENT", taskId: null, candidateRevision: null,
    preconditions: {}, inputFingerprint: "fp", attempt: 1, createdAt: NOW,
    executionId: "exec", repository: "repo", cycleId: "cycle",
  }), /must be one of/);
});

test("runtime records enforce structured identity, attempts, outcomes and retry wakeups", () => {
  const snapshot = makeExecutionSnapshot({ executionId: "exec", repository: "repo", taskId: "TASK-001", computed, observedAt: NOW });
  const observation = makeObservation({ executionId: "exec", repository: "repo", cycleId: "cycle-1", computed, snapshot, observedAt: NOW });
  const action = makePlannedAction({
    actionId: "exec:action:1", actionType: "LOAD_TASK", taskId: "TASK-001", candidateRevision: null,
    preconditions: { state: "DISCOVER" }, inputFingerprint: "sha256-fingerprint", attempt: 1,
    createdAt: NOW, executionId: "exec", repository: "repo", cycleId: "cycle-1",
  });
  const result = makeActionResult({
    actionId: action.actionId, executionId: "exec", cycleId: "cycle-1", taskId: "TASK-001",
    result: "SUCCEEDED", startedAt: NOW, finishedAt: NOW, provider: "fixture", retryable: false,
  });
  const checkpoint = makeRuntimeCheckpoint({
    runtimeVersion: "loop-runtime/1", executionId: "exec", repository: "repo", cycleId: "cycle-1",
    taskId: "TASK-001", observedHead: null, computedState: "DISCOVER", plannedAction: "LOAD_TASK",
    actionId: action.actionId, lastEvidenceSequence: 3, timestamp: NOW, inputFingerprint: "snapshot-fingerprint",
  });
  const wakeup = makeWakeupRequest({ executionId: "exec", reason: "retry provider", earliestRetryAt: NOW, taskId: "TASK-001", state: "WAIT_RETRYABLE" });
  const cycle = makeRuntimeCycle({
    executionId: "exec", repository: "repo", cycleId: "cycle-1", observation, plannedAction: action,
    actionResult: result, nextComputed: computed, outcome: "CONTINUE", evidenceEventIds: ["ev-1"], checkpoint,
  });
  const outcome = makeExecutionOutcome({ executionId: "exec", repository: "repo", taskId: "TASK-001", state: "DISCOVER", outcome: "CONTINUE", cycles: 1, lastCycle: cycle, retry: wakeup });
  assert.equal(outcome.lastCycle.checkpoint.lastEvidenceSequence, 3);
  assert.equal(result.actionId, action.actionId);
  assert.throws(() => makeActionResult({ ...result, errorClass: "MYSTERY" }), /must be one of/);
});

test("planner output is computed-state driven and deterministically precondition bound", () => {
  const observation = makeObservation({
    executionId: "exec", repository: "repo", cycleId: "cycle-1", observedAt: NOW,
    computed: computeState({ retryableWait: true, now: NOW }), recovery: { facts: { specDigest: "spec-a" } },
  });
  const planner = new ActionPlanner();
  const first = planner.plan(observation, { repository: "repo", now: NOW });
  const second = planner.plan(observation, { repository: "repo", now: NOW });
  assert.equal(first.actionType, "WAIT");
  assert.equal(first.actionId, second.actionId);
  assert.equal(first.preconditions.recoveryInputFingerprint, second.preconditions.recoveryInputFingerprint);
});

test("planner creates one PR only when provider truth says absent and waits on unknown or stale PR facts", () => {
  const planner = new ActionPlanner();
  const makeTestingObservation = (pullRequest) => makeObservation({
    executionId: "exec", repository: "owner/sandbox", cycleId: "cycle-1", observedAt: NOW,
    computed: { state: "TESTING", derivedState: "TESTING", taskId: "TASK-001", candidateHead: "a".repeat(40), blockers: [], nextTaskId: null },
    recovery: { facts: { pullRequest } },
  });
  const absent = { status: "ABSENT", candidateHead: "a".repeat(40) };
  const unknown = { status: "UNKNOWN", candidateHead: "a".repeat(40) };
  const stale = { status: "OPEN", candidateHead: "a".repeat(40), headSha: "b".repeat(40) };
  assert.equal(planner.plan(makeTestingObservation(absent), { now: NOW }).actionType, "CREATE_PULL_REQUEST");
  assert.equal(planner.plan(makeTestingObservation(unknown), { now: NOW }).actionType, "WAIT");
  assert.equal(planner.plan(makeTestingObservation(stale), { now: NOW }).actionType, "WAIT");
});
