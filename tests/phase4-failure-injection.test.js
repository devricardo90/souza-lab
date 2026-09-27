import test from "node:test";
import assert from "node:assert/strict";
import {
  FakeCIProvider,
  FakeEvidenceStore,
  FakeGitProvider,
  FakeReviewProvider,
  FakeSCMProvider,
  FakeTaskSystemAdapter,
  FakeValidationProvider,
} from "../src/testing/fake-providers.js";
import { makeReviewResult, makeTask } from "../src/core/contracts.js";
import { RecoveryCoordinator, RecoveryError } from "../src/core/recovery-coordinator.js";
import { computeState } from "../src/core/state-engine.js";
import { MarkdownTaskAdapter, parseTasksMarkdown } from "../src/adapters/markdown-task-adapter.js";

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const BASE = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const SPEC_HEAD = "cccccccccccccccccccccccccccccccccccccccc";
const MERGE_HEAD = "dddddddddddddddddddddddddddddddddddddddd";
const SPEC_DIGEST = "sha256-spec-v1";
const NOW = "2026-09-27T15:00:00.000Z";
const AC_DIGEST = task().acceptanceCriteriaDigest;

function task(description = "criterion v1") {
  return makeTask({
    id: "TASK-001", title: "Injected task", specPresent: true,
    acceptanceCriteria: [{ id: "AC-01", description }], dependencies: [],
  });
}

function cleanReview(head = HEAD_A, reviewerId = "reviewer-1", publishedAt = "2026-09-27T14:00:00.000Z") {
  return makeReviewResult({
    head, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt, reviewerId,
  });
}

function facts(overrides = {}) {
  return {
    task: task(), completedTaskIds: [],
    specRevision: { head: SPEC_HEAD }, specDigest: SPEC_DIGEST,
    specReview: cleanReview(SPEC_HEAD, "spec-reviewer", "2026-09-27T10:00:00.000Z"),
    revision: { head: HEAD_A, base: BASE, branch: "feature/task", dirty: false, changedFiles: [] },
    ci: { head: HEAD_A, status: "PASS" },
    validation: {
      head: HEAD_A, baseline: BASE, specDigest: SPEC_DIGEST, result: "PASS",
      acceptanceCriteriaDigest: AC_DIGEST, acProof: { total: 1, proved: 1 }, independent: true,
    },
    review: cleanReview(), merge: null, postMergeValidation: null, now: NOW,
    ...overrides,
  };
}

function coordinator({ taskSystem, gitProvider, ciProvider, reviewProvider, validationProvider, scmProvider, evidenceStore = null } = {}) {
  return new RecoveryCoordinator({
    taskSystem: taskSystem ?? new FakeTaskSystemAdapter({ tasks: [task()] }),
    gitProvider: gitProvider ?? new FakeGitProvider({ revision: facts().revision }),
    scmProvider: scmProvider ?? new FakeSCMProvider(),
    ciProvider: ciProvider ?? new FakeCIProvider({ results: [{ head: HEAD_A, status: "PASS" }] }),
    reviewProvider: reviewProvider ?? new FakeReviewProvider({ results: [
      { head: SPEC_HEAD, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: "2026-09-27T10:00:00.000Z", reviewerId: "spec-reviewer" },
      { head: HEAD_A, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: "2026-09-27T14:00:00.000Z", reviewerId: "reviewer-1" },
    ] }),
    validationProvider: validationProvider ?? new FakeValidationProvider({ results: [{
      taskId: "TASK-001", head: HEAD_A, baseline: BASE, specDigest: SPEC_DIGEST, result: "PASS",
      acceptanceCriteriaDigest: AC_DIGEST, acProof: { total: 1, proved: 1 }, independent: true,
    }] }),
    evidenceStore,
  });
}

function recoverContext(overrides = {}) {
  return {
    activeTaskId: "TASK-001", specRevision: { head: SPEC_HEAD }, specDigest: SPEC_DIGEST,
    now: NOW, ...overrides,
  };
}

test("F13 — a review by the implementation actor is not independent", () => {
  const result = computeState(facts({
    revision: { ...facts().revision, authorId: "actor@example.invalid" },
    review: cleanReview(HEAD_A, "actor@example.invalid"),
  }));
  assert.equal(result.state, "REVIEWING");
});

test("F20 — Git provider failure blocks recovery without manufacturing progress", () => {
  class UnavailableGit extends FakeGitProvider {
    getRevision() { throw new Error("repository unavailable"); }
  }
  const result = coordinator({ gitProvider: new UnavailableGit() }).recover(recoverContext());
  assert.equal(result.computed.state, "BLOCKED_EXTERNAL");
});

for (const [id, Provider, method, providerKey, expected] of [
  ["F21", FakeCIProvider, "getCIResult", "ciProvider", "WAIT_RETRYABLE"],
  ["F22", FakeReviewProvider, "getReviewResult", "reviewProvider", "WAIT_RETRYABLE"],
  ["F23", FakeValidationProvider, "getValidationResult", "validationProvider", "WAIT_RETRYABLE"],
]) {
  test(`${id} — transient provider outage becomes a retryable wait`, () => {
    class TemporarilyUnavailable extends Provider {
      [method]() { const error = new Error("temporary provider outage"); error.retryable = true; throw error; }
    }
    const result = coordinator({ [providerKey]: new TemporarilyUnavailable() }).recover(recoverContext());
    assert.equal(result.computed.state, expected);
  });
}

test("F25 — recovery after an evidence-write crash is idempotent by event ID", () => {
  const evidenceStore = new FakeEvidenceStore();
  const recovering = coordinator({ evidenceStore });
  const context = recoverContext({ eventId: "phase4-recovery-f25" });
  assert.equal(recovering.recover(context).computed.state, "READY_TO_MERGE");
  assert.equal(recovering.recover(context).computed.state, "READY_TO_MERGE");
  assert.equal(evidenceStore.listByTask("TASK-001").length, 1);
});

test("F28 — recovery derives DONE and emits fresh projections when persisted projections lag", () => {
  const merge = {
    candidateHead: HEAD_A, status: "MERGED", merged: true,
    mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T14:30:00.000Z",
  };
  const projection = { state: "READY_TO_MERGE", taskId: "TASK-001", candidateHead: HEAD_A };
  const recovered = coordinator({
    scmProvider: new FakeSCMProvider({ mergeFacts: [merge] }),
    validationProvider: new FakeValidationProvider({ results: [
      { taskId: "TASK-001", head: HEAD_A, baseline: BASE, specDigest: SPEC_DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS", acProof: { total: 1, proved: 1 }, independent: true },
      { taskId: "TASK-001", head: MERGE_HEAD, baseline: HEAD_A, specDigest: SPEC_DIGEST, acceptanceCriteriaDigest: AC_DIGEST, result: "PASS", acProof: { total: 1, proved: 1 }, independent: true },
    ] }),
  }).recover(recoverContext({ stateProjection: projection, handoffProjection: projection }));
  assert.equal(recovered.computed.derivedState, "DONE");
  assert.equal(recovered.computed.state, "DONE");
  assert.equal(recovered.projections.state.state, "DONE");
  assert.equal(recovered.projections.handoff.state, "DONE");
});

test("F32 — changing an AC description invalidates validation even when the count is unchanged", () => {
  const before = computeState(facts());
  const changed = computeState(facts({ task: task("criterion v2") }));
  assert.equal(before.state, "READY_TO_MERGE");
  assert.equal(changed.state, "VALIDATING");
});

test("F06/F07 — moving from HEAD A to B invalidates both review and validation for A", () => {
  const moved = facts({
    revision: { head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", base: BASE, dirty: false },
    ci: { head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", status: "PASS" },
  });
  const state = computeState(moved);
  assert.equal(state.state, "VALIDATING");
  assert.match(state.blockers.join(" "), /validation is stale/);
  assert.notEqual(state.state, "READY_TO_MERGE");
  assert.notEqual(state.state, "DONE");
  const validationOnly = computeState(facts({
    revision: { head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", base: BASE, dirty: false },
    ci: { head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", status: "PASS" },
    review: null,
  }));
  assert.equal(validationOnly.state, "VALIDATING");
  const validationForB = {
    ...facts().validation,
    head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  };
  const staleReview = computeState(facts({
    revision: { head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", base: BASE, dirty: false },
    ci: { head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", status: "PASS" },
    validation: validationForB,
  }));
  assert.equal(staleReview.state, "REVIEWING");
  assert.match(staleReview.blockers.join(" "), /review is stale/);
});

test("F08 — only canonical CI PASS satisfies the test gate", () => {
  for (const status of ["GREEN", "SUCCESSFUL", "OK", "UNKNOWN_CUSTOM_STATE"]) {
    assert.equal(computeState(facts({ ci: { head: HEAD_A, status } })).state, "TESTING", status);
  }
  assert.equal(computeState(facts({ ci: { head: HEAD_A, status: "PASS" } })).state, "READY_TO_MERGE");
});

test("F09 — noncanonical review verdicts cannot satisfy the independent review gate", () => {
  for (const verdict of ["APPROVED", "GOOD", "LGTM", "SUCCESS"]) {
    assert.equal(computeState(facts({ review: { ...cleanReview(), verdict } })).state, "REVIEWING", verdict);
  }
});

test("F10 — noncanonical validation results cannot satisfy authoritative validation", () => {
  for (const result of ["SUCCESS", "GREEN", "VALID", "UNKNOWN_CUSTOM_STATE"]) {
    assert.equal(computeState(facts({ validation: { ...facts().validation, result } })).state, "VALIDATING", result);
  }
});

test("F11/F12 — review at or after merge time cannot authorize merge", () => {
  const merge = { candidateHead: HEAD_A, status: "MERGED", mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T14:00:00.000Z" };
  for (const publishedAt of [merge.mergedAt, "2026-09-27T14:00:00.001Z"]) {
    const result = computeState(facts({ merge, review: cleanReview(HEAD_A, "reviewer-1", publishedAt) }));
    assert.equal(result.state, "INCONSISTENT_STATE", publishedAt);
  }
});

test("F14 — CLEAN verdict with an unresolved finding remains review-blocked", () => {
  assert.equal(computeState(facts({ review: { ...cleanReview(), unresolvedFindings: 1 } })).state, "REVIEWING");
});

test("F15/F16 — false DONE and contradictory STATE/HANDOFF are surfaced", () => {
  const falseDone = computeState(facts({
    review: null,
    stateProjection: { state: "DONE" }, handoffProjection: { state: "DONE" },
    narrativeClaim: "complete",
  }));
  assert.equal(falseDone.state, "INCONSISTENT_STATE");
  assert.equal(falseDone.derivedState, "REVIEWING");
  const disagree = computeState(facts({
    review: null,
    stateProjection: { state: "READY_TO_MERGE" }, handoffProjection: { state: "VALIDATING" },
  }));
  assert.equal(disagree.state, "INCONSISTENT_STATE");
  assert.equal(disagree.derivedState, "REVIEWING");
  assert.equal(disagree.projectionMismatch, true);
});

test("F17 — an active task that disappears from its source is rejected", () => {
  class DisappearedTaskSource extends FakeTaskSystemAdapter {
    listTasks() { return []; }
    resolveNextTask() { return { taskId: null, reason: "ROADMAP_COMPLETE", skipped: [] }; }
  }
  assert.throws(() => coordinator({ taskSystem: new DisappearedTaskSource() })
    .recover(recoverContext()), (error) => error instanceof RecoveryError && error.code === "ACTIVE_TASK_MISSING");
});

test("F18 — dependency regression blocks the active dependent task", () => {
  const tasks = new FakeTaskSystemAdapter({ tasks: [
    makeTask({ id: "TASK-A", title: "Dependency", completed: false, specPresent: true, acceptanceCriteria: [{ id: "AC-01", description: "A" }], dependencies: [] }),
    makeTask({ id: "TASK-B", title: "Dependent", specPresent: true, acceptanceCriteria: [{ id: "AC-01", description: "B" }], dependencies: [{ taskId: "TASK-A" }] }),
  ] });
  const recovered = coordinator({ taskSystem: tasks }).recover(recoverContext({ activeTaskId: "TASK-B" }));
  assert.equal(recovered.computed.state, "DISCOVER");
  assert.match(recovered.computed.blockers.join(" "), /dependency is not complete/);
  assert.notEqual(recovered.computed.state, "READY_TO_MERGE");
});

test("F19 — dirty worktree is never merge-ready", () => {
  const result = computeState(facts({ revision: { ...facts().revision, dirty: true } }));
  assert.equal(result.state, "IMPLEMENTING");
  assert.notEqual(result.state, "READY_TO_MERGE");
  assert.notEqual(result.state, "DONE");
});

test("F24 — crash before evidence append is reconstructed from providers and durably recorded on restart", () => {
  const inner = new FakeEvidenceStore();
  const failingStore = {
    append() { throw new Error("crash before durable append"); },
    getById: (id) => inner.getById(id),
    listByTask: (id) => inner.listByTask(id),
  };
  const context = recoverContext({ eventId: "phase4-f24" });
  assert.throws(() => coordinator({ evidenceStore: failingStore }).recover(context), /crash before durable append/);
  assert.equal(inner.listByTask("TASK-001").length, 0);
  const merge = {
    candidateHead: HEAD_A, status: "MERGED", merged: true,
    mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T14:30:00.000Z",
  };
  const restarted = coordinator({
    evidenceStore: inner,
    scmProvider: new FakeSCMProvider({ mergeFacts: [merge] }),
  }).recover(context);
  assert.equal(restarted.computed.state, "POST_MERGE_VALIDATION");
  assert.equal(restarted.evidenceReused, false);
  assert.equal(inner.listByTask("TASK-001").length, 1);
});

test("F25 — append-then-crash recovery restart reuses the durable event", () => {
  const inner = new FakeEvidenceStore();
  let crash = true;
  const failingStore = {
    append(event) {
      const saved = inner.append(event);
      if (crash) { crash = false; throw new Error("crash after durable append"); }
      return saved;
    },
    getById: (id) => inner.getById(id),
    listByTask: (id) => inner.listByTask(id),
  };
  const context = recoverContext({ eventId: "phase4-f25-crash" });
  assert.throws(() => coordinator({ evidenceStore: failingStore }).recover(context), /crash after durable append/);
  const restarted = coordinator({ evidenceStore: inner }).recover(context);
  assert.equal(restarted.evidenceReused, true);
  assert.equal(inner.listByTask("TASK-001").length, 1);
});

test("F26 — clean exact-head review survives restart as READY_TO_MERGE", () => {
  const recovered = coordinator().recover(recoverContext());
  assert.equal(recovered.computed.state, "READY_TO_MERGE");
  assert.equal(recovered.firstUnprovedStep, "MERGE");
});

test("F27 — merged work without post-merge proof resumes at validation", () => {
  const merge = { candidateHead: HEAD_A, status: "MERGED", merged: true, mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T14:30:00.000Z" };
  const recovered = coordinator({ scmProvider: new FakeSCMProvider({ mergeFacts: [merge] }) })
    .recover(recoverContext());
  assert.equal(recovered.computed.state, "POST_MERGE_VALIDATION");
  assert.equal(recovered.firstUnprovedStep, "VALIDATE_MERGE");
});

test("F29 — repeated recovery with stable facts and event ID is idempotent", () => {
  const store = new FakeEvidenceStore();
  const recovering = coordinator({ evidenceStore: store });
  const context = recoverContext({ eventId: "phase4-f29" });
  const first = recovering.recover(context);
  const second = recovering.recover(context);
  assert.equal(first.computed.state, second.computed.state);
  assert.equal(second.evidenceReused, true);
  assert.equal(store.listByTask("TASK-001").length, 1);
});

test("F30 — malformed task-source variants are rejected deterministically", () => {
  const cases = [
    "- [ ] TASK-A — duplicate\n  - acceptance_criteria:\n    - AC-01 — x\n- [ ] TASK-A — duplicate\n  - acceptance_criteria:\n    - AC-01 — y",
    "- [ ] TASK-A — duplicate criterion\n  - acceptance_criteria:\n    - AC-01 — x\n    - AC-01 — y",
    "- [ ] TASK-A — broken dependency\n  - depends_on: TASK-MISSING\n  - acceptance_criteria:\n    - AC-01 — x",
    "- [ ] TASK-A — self dependency\n  - depends_on: TASK-A\n  - acceptance_criteria:\n    - AC-01 — x",
    "- [ ] TASK-A — cycle\n  - depends_on: TASK-B\n  - acceptance_criteria:\n    - AC-01 — x\n- [ ] TASK-B — cycle\n  - depends_on: TASK-A\n  - acceptance_criteria:\n    - AC-01 — y",
    "```markdown\n- [ ] TASK-A — unclosed",
    "<!-- - [ ] TASK-A — partially commented -->\n  - spec: reviewed\n  - acceptance_criteria:\n    - AC-01 — orphaned",
  ];
  for (const source of cases) assert.throws(() => parseTasksMarkdown(source));
});

test("F31 — changing the specification digest invalidates prior validation", () => {
  const result = computeState(facts({ specDigest: "sha256-spec-v2" }));
  assert.equal(result.state, "VALIDATING");
  assert.match(result.blockers.join(" "), /different or unknown spec/);
});

test("F33 — SCM merge candidate contradicting Git HEAD is inconsistent", () => {
  class ContradictorySCM extends FakeSCMProvider {
    getMergeFact() { return { candidateHead: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", status: "MERGED", merged: true, mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T14:30:00.000Z" }; }
  }
  const result = coordinator({ scmProvider: new ContradictorySCM() }).recover(recoverContext());
  assert.equal(result.computed.state, "INCONSISTENT_STATE");
  assert.match(result.computed.blockers.join(" "), /different candidate HEAD/);
});

test("F34 — ambiguous multiple revision facts cannot select a candidate or progress", () => {
  class MultipleRevisions extends FakeGitProvider {
    getRevision() { return [facts().revision, { ...facts().revision, head: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" }]; }
  }
  const result = coordinator({ gitProvider: new MultipleRevisions() }).recover(recoverContext());
  assert.notEqual(result.computed.state, "DONE");
  assert.notEqual(result.computed.state, "READY_TO_MERGE");
  assert.equal(result.computed.state, "TESTING");
});
