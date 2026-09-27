import test from "node:test";
import assert from "node:assert/strict";
import { makeCIResult, makeMergeFact, makeReviewResult, makeTask, makeValidationResult, makeRevision } from "../src/core/contracts.js";
import { ComputedStateEngine, computeState } from "../src/core/state-engine.js";

const NOW = "2026-09-27T10:00:00.000Z";
const TASK = makeTask({
  id: "TASK-001", title: "Prove the lifecycle", specPresent: true, specReviewed: true,
  acceptanceCriteria: [{ id: "AC-01", description: "Expected behavior is proven" }, { id: "AC-02", description: "Failure path is proven" }],
  dependencies: [],
});
const REVISION = makeRevision({ head: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", base: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch: "feature/task-1" });
const SPEC_REVISION = makeRevision({ head: "1111111111111111111111111111111111111111", base: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", branch: "docs/task-1-spec" });
const DIGEST = "spec-sha256-1";
const AC_DIGEST = TASK.acceptanceCriteriaDigest;

function facts(overrides = {}) {
  return {
    task: TASK,
    specRevision: SPEC_REVISION,
    specReview: makeReviewResult({
      head: SPEC_REVISION.head, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
      publishedAt: "2026-09-27T08:00:00.000Z", reviewerId: "independent-spec-reviewer",
    }),
    specDigest: DIGEST,
    revision: REVISION,
    ci: makeCIResult({ head: REVISION.head, status: "PASS", checkedAt: NOW }),
    validation: makeValidationResult({
      head: REVISION.head, baseline: REVISION.base, specDigest: DIGEST, result: "PASS",
      acceptanceCriteriaDigest: AC_DIGEST, acProof: { total: 2, proved: 2 }, checkedAt: NOW, independent: true,
    }),
    review: makeReviewResult({
      head: REVISION.head, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
      publishedAt: "2026-09-27T09:00:00.000Z", reviewerId: "independent-reviewer",
    }),
    merge: null,
    postMergeValidation: null,
    completedTaskIds: [],
    now: NOW,
    ...overrides,
  };
}

test("computed state follows the first unproved stage and fails closed", () => {
  assert.equal(computeState({ now: NOW }).state, "DISCOVER");
  assert.equal(computeState({ task: makeTask({ id: "TASK-1", title: "No spec", acceptanceCriteria: [{ id: "AC-01", description: "x" }], dependencies: [] }), now: NOW }).state, "SPEC_REQUIRED");
  assert.equal(computeState({ task: makeTask({ id: "TASK-2", title: "Unreviewed spec", specPresent: true, acceptanceCriteria: [{ id: "AC-01", description: "x" }], dependencies: [] }), now: NOW }).state, "SPEC_REVIEW");
  assert.equal(computeState(facts({ specReview: null })).state, "SPEC_REVIEW");
  assert.equal(computeState(facts({ specRevision: makeRevision({ head: "2222222222222222222222222222222222222222" }) })).state, "SPEC_REVIEW");
  assert.equal(computeState({ ...facts(), revision: null }).state, "READY_TO_IMPLEMENT");
  assert.equal(computeState(facts({ revision: makeRevision({ ...REVISION, dirty: true }) })).state, "IMPLEMENTING");
  assert.equal(computeState(facts({ ci: null })).state, "TESTING");
  assert.equal(computeState(facts({ ci: { head: REVISION.head, status: "GREEN" } })).state, "TESTING");
  assert.equal(computeState(facts({ ci: makeCIResult({ head: REVISION.head, status: "PENDING" }) })).state, "WAIT_RETRYABLE");
  assert.equal(computeState(facts({ ci: makeCIResult({ head: "ccccccc", status: "PASS" }) })).state, "TESTING");
  assert.equal(computeState(facts({ validation: null })).state, "VALIDATING");
  assert.equal(computeState(facts({ validation: makeValidationResult({ head: "ccccccc", baseline: REVISION.base, specDigest: DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS", acProof: { total: 2, proved: 2 }, independent: true }) })).state, "VALIDATING");
  assert.equal(computeState(facts({ validation: makeValidationResult({ head: REVISION.head, baseline: REVISION.base, specDigest: DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS", acProof: { total: 2, proved: 1 }, independent: true }) })).state, "VALIDATING");
  assert.equal(computeState(facts({ review: null })).state, "REVIEWING");
  assert.equal(computeState(facts({ review: makeReviewResult({ head: REVISION.head, verdict: "CLEAN", independent: false, unresolvedFindings: 0, publishedAt: NOW }) })).state, "REVIEWING");
  assert.equal(computeState(facts({ review: makeReviewResult({ head: REVISION.head, verdict: "CLEAN", independent: true, unresolvedFindings: 1, publishedAt: NOW }) })).state, "REVIEWING");
  assert.equal(computeState(facts()).state, "READY_TO_MERGE");
  assert.equal(computeState(facts({ merge: makeMergeFact({ candidateHead: REVISION.head, status: "PENDING" }) })).state, "MERGING");
});

test("DONE requires pre-merge exact-head review, complete validation and post-merge proof", () => {
  const merge = makeMergeFact({
    candidateHead: REVISION.head, status: "MERGED", mergeCommit: "dddddddddddddddddddddddddddddddddddddddd",
    mergedAt: "2026-09-27T09:30:00.000Z",
  });
  const postMergeValidation = makeValidationResult({
    head: merge.mergeCommit, baseline: REVISION.head, specDigest: DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS",
    acProof: { total: 2, proved: 2 }, checkedAt: NOW, independent: true,
  });
  assert.equal(computeState(facts({ merge })).state, "POST_MERGE_VALIDATION");
  assert.equal(computeState(facts({ merge, postMergeValidation })).state, "DONE");
  assert.equal(computeState(facts({ merge, postMergeValidation: makeValidationResult({ ...postMergeValidation, head: "eeeeeee" }) })).state, "POST_MERGE_VALIDATION");
  const lateReview = makeReviewResult({
    head: REVISION.head, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
    publishedAt: "2026-09-27T09:40:00.000Z",
  });
  const rejected = computeState(facts({ merge, review: lateReview, postMergeValidation }));
  assert.equal(rejected.state, "INCONSISTENT_STATE");
  assert.match(rejected.blockers.join(" "), /not published before merge/);
  const simultaneousReview = makeReviewResult({
    head: REVISION.head, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
    publishedAt: merge.mergedAt,
  });
  const equalityRejected = computeState(facts({ merge, review: simultaneousReview, postMergeValidation }));
  assert.equal(equalityRejected.state, "INCONSISTENT_STATE");
  assert.match(equalityRejected.blockers.join(" "), /not published before merge/);
  const noReview = computeState(facts({ merge, review: null, postMergeValidation }));
  assert.equal(noReview.state, "INCONSISTENT_STATE");
});

test("equal STATE and HANDOFF claims cannot override computed REVIEWING", () => {
  const projections = { state: "DONE", taskId: TASK.id, candidateHead: REVISION.head };
  const computed = computeState(facts({ review: null, stateProjection: projections, handoffProjection: projections }));
  assert.equal(computed.state, "INCONSISTENT_STATE");
  assert.equal(computed.derivedState, "REVIEWING");
});

test("agent narrative claims are ignored and roadmap completion cannot replace evidence", () => {
  const narrative = computeState(facts({ review: null, narrativeClaim: "DONE" }));
  assert.equal(narrative.state, "REVIEWING");
  const checked = makeTask({ ...TASK, completed: true });
  const checkbox = computeState(facts({ task: checked, review: null }));
  assert.equal(checkbox.state, "INCONSISTENT_STATE");
  assert.equal(checkbox.derivedState, "REVIEWING");
});

test("owner and external blocks remain distinct, and the class implements StateEngine", () => {
  const engine = new ComputedStateEngine();
  assert.equal(engine.compute({ ownerBlocked: true, now: NOW }).state, "BLOCKED_OWNER");
  assert.equal(engine.compute({ externalBlocked: true, now: NOW }).state, "BLOCKED_EXTERNAL");
  assert.equal(engine.compute({ retryableWait: true, now: NOW }).state, "WAIT_RETRYABLE");
});
