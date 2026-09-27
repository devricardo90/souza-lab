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

const HEAD_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const HEAD_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

test("fake task and Git providers return deterministic canonical fixtures", () => {
  const tasks = new FakeTaskSystemAdapter({ tasks: [
    { id: "TASK-001", title: "Done", completed: true, acceptanceCriteria: [{ id: "AC-01", description: "x" }], dependencies: [] },
    { id: "TASK-002", title: "Next", acceptanceCriteria: [{ id: "AC-01", description: "y" }], dependencies: [{ taskId: "TASK-001" }] },
  ] });
  assert.equal(tasks.resolveNextTask().taskId, "TASK-002");
  assert.equal(tasks.listTasks(), tasks.listTasks());
  const git = new FakeGitProvider({ revision: { head: HEAD_A, base: HEAD_B, branch: "fake/branch", dirty: false } });
  assert.deepEqual(git.getRevision(), git.getRevision());
});

test("SCM, CI, review, and validation fakes return only exact matching facts", () => {
  const scm = new FakeSCMProvider({ mergeFacts: [{ candidateHead: HEAD_A, status: "PENDING" }] });
  assert.equal(scm.getMergeFact("TASK-001", HEAD_A).status, "PENDING");
  assert.equal(scm.getMergeFact("TASK-001", HEAD_B), null);

  const ci = new FakeCIProvider({ results: [{ head: HEAD_A, status: "PASS" }] });
  assert.equal(ci.getCIResult(HEAD_A).status, "PASS");
  assert.equal(ci.getCIResult(HEAD_B), null);

  const review = new FakeReviewProvider({ results: [{ head: HEAD_A, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: "2026-09-27T00:00:00Z" }] });
  assert.equal(review.getReviewResult(HEAD_A).verdict, "CLEAN");
  assert.equal(review.getReviewResult(HEAD_B), null);

  const validation = new FakeValidationProvider({ results: [{
    taskId: "TASK-001", head: HEAD_A, baseline: HEAD_B, specDigest: "spec-a", result: "PASS",
    acProof: { total: 1, proved: 1 }, independent: true,
  }] });
  assert.equal(validation.getValidationResult("TASK-001", HEAD_A).result, "PASS");
  assert.equal(validation.getValidationResult("TASK-001", HEAD_B), null);
  assert.equal(validation.getValidationResult("TASK-002", HEAD_A), null);
});

test("fake evidence provider validates, appends and queries immutable event records", () => {
  const store = new FakeEvidenceStore();
  const input = {
    eventId: "evt-1", eventType: "CI_RECORDED", occurredAt: "2026-09-27T00:00:00Z",
    taskId: "TASK-001", revisionHead: HEAD_A, payload: { facts: { status: "PASS" } },
  };
  const event = store.append(input);
  input.payload.facts.status = "FAIL";
  assert.equal(event.payload.facts.status, "PASS");
  assert.equal(Object.isFrozen(event.payload.facts), true);
  assert.equal(store.listByTask("TASK-001")[0], event);
  assert.equal(store.listByTask("TASK-002").length, 0);
  assert.equal("events" in store, false);
  assert.equal("update" in store, false);
  assert.equal("delete" in store, false);
  assert.throws(() => store.append({ eventId: "evt-1", eventType: "CI_RECORDED", occurredAt: "2026-09-27T00:00:00Z" }), /duplicate event id/);
});
