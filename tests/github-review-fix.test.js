import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { drive } from "./helpers/controller-harness.js";
import { createGitHubScenario } from "./helpers/github-scenario.js";

/**
 * CP-07 review/fix loop through the whole Controller: implementation head H1 -> validation PASS H1 -> review FINDINGS H1 ->
 * correction produces H2 -> H1 evidence is stale -> CI/validation/review run for H2 -> review CLEAN H2 -> merge H2 only.
 */
let s; let handle;
beforeEach(async () => { s = await createGitHubScenario(); });
afterEach(() => { if (handle) { try { handle.close(); } catch {} handle = null; } s.cleanup(); });

test("REVIEW/FIX/REVALIDATE: FINDINGS at H1 are corrected into H2; only H2 (re-validated and re-reviewed CLEAN) is merged; no stale H1 evidence authorizes H2", async () => {
  handle = s.inProcess({ github: { findingsOnReviews: 1 } });
  await handle.controller.start();
  const { last } = await drive(handle, { maxCycles: 220 });
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));

  const attempt = s.attempt();
  const h1 = attempt.agentResult.head;
  const [pr] = s.fake.prs();
  const h2 = pr.mergedHeadSha;
  assert.notEqual(h2, h1, "the merged head is the corrected commit");
  assert.equal(s.repo.run(["rev-list", "--count", `${h1}..${h2}`, ], attempt.workspacePath), "1", "H2 is exactly one correction commit on top of H1");
  assert.equal(s.fake.prs().length, 1, "one change object followed the branch");
  assert.equal(s.mainCommits(), 2, "one squash merge");

  // the order and the evidence
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute", "correct"]);
  assert.deepEqual(s.reviewCalls().filter((c) => c.kind === "implementation").map((c) => c.head), [h1, h2], "H1 reviewed (FINDINGS), then H2");
  assert.deepEqual(s.validationCalls().filter((c) => c.kind === "validate").map((c) => c.head), [h1, h2], "validation ran again for the new head");
  s.gate((g) => {
    assert.equal(g.getReview(attempt.executionId, h1).verdict, "FINDINGS");
    assert.equal(g.getReview(attempt.executionId, h2).verdict, "CLEAN");
    assert.equal(g.getValidation(attempt.executionId, "TASK-001", h1).result, "PASS");
    assert.equal(g.getValidation(attempt.executionId, "TASK-001", h2).result, "PASS");
    assert.equal(g.findingsCount(attempt.executionId), 1);
    assert.equal(g.postMergeValidated(attempt.executionId, "TASK-001"), true);
  });
  assert.equal(s.remoteHead(attempt.branch), h2, "the remote branch carries the corrected head");
  assert.deepEqual(s.controllerRows(), [["TASK-001", "REMOTE_DONE_CONFIRMED"]]);
  assert.equal(handle.agent.modelCalls, 0);
});
