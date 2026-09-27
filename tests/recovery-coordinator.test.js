import test from "node:test";
import assert from "node:assert/strict";
import { makeRevision, makeTask } from "../src/core/contracts.js";
import { RecoveryCoordinator, RecoveryError } from "../src/core/recovery-coordinator.js";
import {
  FakeCIProvider,
  FakeEvidenceStore,
  FakeGitProvider,
  FakeReviewProvider,
  FakeSCMProvider,
  FakeTaskSystemAdapter,
  FakeValidationProvider,
} from "../src/testing/fake-providers.js";

const H = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPEC_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const MERGE_HEAD = "dddddddddddddddddddddddddddddddddddddddd";
const SPEC_DIGEST = "sha256-spec-task-1";
const NOW = "2026-09-27T15:00:00.000Z";
const SPEC_REVISION = makeRevision({ head: SPEC_HEAD, base: BASE, branch: "docs/task-1-spec" });

const TASKS = [
  { id: "TASK-001", title: "Current work", acceptanceCriteria: [{ id: "AC-01", description: "Path works" }], dependencies: [], specPresent: true },
  { id: "TASK-002", title: "Next work", acceptanceCriteria: [{ id: "AC-01", description: "Next path works" }], dependencies: [{ taskId: "TASK-001" }] },
];
const AC_DIGEST = makeTask(TASKS[0]).acceptanceCriteriaDigest;

function makeCoordinator({ head = H, ciHead = head, ciStatus = "PASS", validationHead = head, reviewHead = head, withValidation = false, withCodeReview = true, mergeStatus = "NOT_STARTED", withPostMerge = false, evidence = null } = {}) {
  const validation = {
    taskId: "TASK-001", head: validationHead, baseline: BASE, specDigest: SPEC_DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS",
    acProof: { total: 1, proved: 1 }, checkedAt: NOW, independent: true,
  };
  const reviews = [{
    head: SPEC_HEAD, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
    publishedAt: "2026-09-27T10:00:00.000Z", reviewerId: "spec-reviewer",
  }];
  if (withCodeReview) reviews.push({
    head: reviewHead, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
    publishedAt: "2026-09-27T14:00:00.000Z", reviewerId: "code-reviewer",
  });
  const mergeFacts = mergeStatus === "NOT_STARTED" ? [] : [{
    candidateHead: head, status: mergeStatus,
    ...(mergeStatus === "MERGED" ? { mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T14:30:00.000Z" } : {}),
  }];
  const validations = withValidation ? [validation] : [];
  if (withPostMerge) validations.push({
    taskId: "TASK-001", head: MERGE_HEAD, baseline: head, specDigest: SPEC_DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS",
    acProof: { total: 1, proved: 1 }, checkedAt: NOW, independent: true,
  });
  return new RecoveryCoordinator({
    taskSystem: new FakeTaskSystemAdapter({ tasks: TASKS }),
    gitProvider: new FakeGitProvider({ revision: { head, base: BASE, branch: "feature/TASK-001", dirty: false } }),
    scmProvider: new FakeSCMProvider({ mergeFacts }),
    ciProvider: new FakeCIProvider({ results: [{ head: ciHead, status: ciStatus, checkedAt: NOW }] }),
    reviewProvider: new FakeReviewProvider({ results: reviews }),
    validationProvider: new FakeValidationProvider({ results: validations }),
    evidenceStore: evidence,
  });
}

test("recovery resumes at the first unproved validation step and records evidence", () => {
  const evidence = new FakeEvidenceStore();
  const coordinator = makeCoordinator({ withValidation: false, evidence });
  const recovered = coordinator.recover({ specRevision: SPEC_REVISION, specDigest: SPEC_DIGEST, eventId: "recovery-1", now: NOW });
  assert.equal(recovered.computed.state, "VALIDATING");
  assert.equal(recovered.firstUnprovedStep, "RUN_VALIDATION");
  assert.equal(recovered.taskId, "TASK-001");
  assert.equal(recovered.computed.candidateHead, H);
  assert.equal(recovered.evidenceEvent.eventType, "RECOVERY_COMPUTED");
  assert.equal(evidence.listByTask("TASK-001").length, 1);
});

test("recovery blocks on unknown, stale, or partial exact-revision evidence", () => {
  const specFacts = { specRevision: SPEC_REVISION, specDigest: SPEC_DIGEST, now: NOW };
  assert.equal(makeCoordinator({ ciStatus: "UNKNOWN", withValidation: true }).recover(specFacts).computed.state, "TESTING");
  const candidateB = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  assert.equal(makeCoordinator({ head: candidateB, withValidation: true, reviewHead: H }).recover(specFacts).computed.state, "REVIEWING");
  assert.equal(makeCoordinator({ head: candidateB, withValidation: true, validationHead: H, reviewHead: candidateB }).recover(specFacts).computed.state, "VALIDATING");
  const missingSpecProof = makeCoordinator({ withValidation: true }).recover({ ...specFacts, specRevision: null });
  assert.equal(missingSpecProof.computed.state, "SPEC_REVIEW");
});

test("equal persisted DONE projections cannot suppress recovery of REVIEWING", () => {
  const coordinator = makeCoordinator({ withValidation: true, withCodeReview: false });
  const projection = { state: "DONE", taskId: "TASK-001", candidateHead: H };
  const recovered = coordinator.recover({
    specRevision: SPEC_REVISION, specDigest: SPEC_DIGEST,
    stateProjection: projection, handoffProjection: projection, narrativeClaim: "DONE", now: NOW,
  });
  assert.equal(recovered.computed.derivedState, "REVIEWING");
  assert.equal(recovered.computed.state, "INCONSISTENT_STATE");
  assert.equal(recovered.firstUnprovedStep, "RECONCILE_INCONSISTENCY");
});

test("valid evidence recovers DONE and computes the next task without mutating the task source", () => {
  const coordinator = makeCoordinator({ withValidation: true, mergeStatus: "MERGED", withPostMerge: true });
  const result = coordinator.recover({ activeTaskId: "TASK-001", specRevision: SPEC_REVISION, specDigest: SPEC_DIGEST, now: NOW });
  assert.equal(result.computed.state, "DONE");
  assert.equal(result.computed.nextTaskId, "TASK-002");
  assert.equal(result.firstUnprovedStep, "SELECT_NEXT_TASK");
  assert.equal(coordinator.providers.taskSystem.listTasks()[0].completed, false);
});

test("recovery rejects an absent active task and requires an evidence id when writing events", () => {
  const coordinator = makeCoordinator({ withValidation: false, evidence: new FakeEvidenceStore() });
  assert.throws(() => coordinator.recover({ activeTaskId: "TASK-999", specRevision: SPEC_REVISION, specDigest: SPEC_DIGEST }), (error) => error instanceof RecoveryError && error.code === "ACTIVE_TASK_MISSING");
  assert.throws(() => coordinator.recover({ specRevision: SPEC_REVISION, specDigest: SPEC_DIGEST }), (error) => error instanceof RecoveryError && error.code === "RECOVERY_EVENT_ID_REQUIRED");
});
