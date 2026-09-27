import test from "node:test";
import assert from "node:assert/strict";
import {
  CIProvider,
  LOOP_STATES,
  ReviewProvider,
  makeAcceptanceCriterion,
  makeCIResult,
  makeComputedState,
  makeDependency,
  makeEvidenceEvent,
  makeMergeFact,
  makeReviewResult,
  makeRevision,
  makeTask,
  makeValidationResult,
} from "../src/core/contracts.js";

test("approved state vocabulary is closed and computed states reject unknown strings", () => {
  assert.deepEqual(LOOP_STATES, [
    "DISCOVER", "SPEC_REQUIRED", "SPEC_REVIEW", "READY_TO_IMPLEMENT", "IMPLEMENTING", "TESTING",
    "VALIDATING", "REVIEWING", "READY_TO_MERGE", "MERGING", "POST_MERGE_VALIDATION", "DONE",
    "WAIT_RETRYABLE", "BLOCKED_OWNER", "BLOCKED_EXTERNAL", "INCONSISTENT_STATE",
  ]);
  assert.throws(() => makeComputedState({ state: "AGENT_SAYS_DONE", computedAt: "2026-09-27T00:00:00Z" }), /must be one of/);
});

test("canonical task, criterion, and dependency structures validate and freeze", () => {
  const criterion = makeAcceptanceCriterion({ id: "AC-01", description: "Prove the path" });
  const dependency = makeDependency({ taskId: "TASK-001" });
  const task = makeTask({ id: "TASK-002", title: "Next", acceptanceCriteria: [criterion], dependencies: [dependency] });
  assert.equal(task.acceptanceCriteria[0].id, "AC-01");
  assert.equal(task.dependencies[0].requiresDone, true);
  assert.ok(Object.isFrozen(task) && Object.isFrozen(task.acceptanceCriteria));
  assert.throws(() => makeTask({ id: "T", title: "Bad", acceptanceCriteria: [criterion, criterion], dependencies: [] }), /must be unique/);
});

test("revision, CI, review, validation, merge, event and computed-state contracts validate", () => {
  assert.equal(makeRevision({ head: "abcdef0", base: "1234567", dirty: false }).head, "abcdef0");
  assert.equal(makeCIResult({ head: "abcdef0", status: "UNKNOWN" }).status, "UNKNOWN");
  assert.equal(makeReviewResult({ head: "abcdef0", verdict: "CLEAN", independent: true, unresolvedFindings: 0 }).verdict, "CLEAN");
  assert.equal(makeValidationResult({
    head: "abcdef0", baseline: "1234567", specDigest: "sha256", result: "PASS", acProof: { total: 2, proved: 2 }, independent: true,
  }).acProof.proved, 2);
  assert.equal(makeMergeFact({ merged: true, candidateHead: "abcdef0", mergeCommit: "7654321" }).merged, true);
  assert.equal(makeEvidenceEvent({ eventId: "event-1", eventType: "CI_RECORDED", occurredAt: "2026-09-27T00:00:00Z" }).schemaVersion, 1);
  assert.equal(makeComputedState({ state: "REVIEWING", computedAt: "2026-09-27T00:00:00Z" }).state, "REVIEWING");
  assert.throws(() => makeCIResult({ head: "abcdef0", status: "GREEN" }), /must be one of/);
  assert.throws(() => makeMergeFact({ merged: true, candidateHead: "abcdef0" }), /required when merged/);
  assert.throws(() => makeValidationResult({ head: "abcdef0", baseline: "1234567", specDigest: "s", result: "PASS", acProof: { total: 1, proved: 2 } }), /valid non-negative/);
});

test("provider contracts are provider-neutral extension points", () => {
  class FixtureCI extends CIProvider {
    getCIResult(head) { return makeCIResult({ head, status: "PASS" }); }
  }
  assert.equal(new FixtureCI().getCIResult("abcdef0").status, "PASS");
  assert.throws(() => new ReviewProvider().getReviewResult(), /not implemented/);
});
