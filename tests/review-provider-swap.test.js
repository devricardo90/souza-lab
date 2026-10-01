import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { drive } from "./helpers/controller-harness.js";
import { createGitHubScenario } from "./helpers/github-scenario.js";
import { IndependentReviewer } from "../src/controller/gate-ports.js";

/**
 * CP-07 closure, audit E: REVIEW_PROVIDER_SWAP_READY. A reviewer that has NOTHING to do with src/testing/deterministic-gates.js,
 * implementing only the IndependentReviewer port, replaces the deterministic one through the existing `overrides.reviewer` seam.
 * The whole lifecycle (push, PR, CI, exact-SHA gate persistence, review/fix loop, merge eligibility) is unchanged.
 */
class ThirdPartyReviewer extends IndependentReviewer {
  calls = [];
  async reviewSpec() { return { verdict: "CLEAN", findings: [], reviewerId: "third-party-reviewer@example.invalid" }; }
  async reviewImplementation({ head }) {
    this.calls.push(head);
    return this.calls.length === 1
      ? { verdict: "FINDINGS", findings: [{ id: "TP-1", summary: "needs a correction" }], reviewerId: "third-party-reviewer@example.invalid" }
      : { verdict: "CLEAN", findings: [], reviewerId: "third-party-reviewer@example.invalid" };
  }
}

let s; let handle;
beforeEach(async () => { s = await createGitHubScenario(); });
afterEach(() => { if (handle) { try { handle.close(); } catch {} handle = null; } s.cleanup(); });

test("a third-party IndependentReviewer drives the unchanged lifecycle: FINDINGS -> correction -> exact-head CLEAN -> merge of the corrected head only", async () => {
  const reviewer = new ThirdPartyReviewer();
  handle = s.inProcess({ overrides: { reviewer } });
  await handle.controller.start();
  const { last } = await drive(handle, { maxCycles: 220 });
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));
  const attempt = s.attempt();
  const h1 = attempt.agentResult.head;
  const [pr] = s.fake.prs();
  const h2 = pr.mergedHeadSha;
  assert.notEqual(h1, h2);
  assert.deepEqual(reviewer.calls, [h1, h2], "the swapped reviewer was asked about each exact head");
  s.gate((g) => {
    assert.equal(g.getReview(attempt.executionId, h1).verdict, "FINDINGS");
    assert.equal(g.getReview(attempt.executionId, h2).verdict, "CLEAN");
    assert.equal(g.getReview(attempt.executionId, h2).reviewerId, "third-party-reviewer@example.invalid");
  });
  assert.equal(s.fake.prs().length, 1);
  assert.equal(s.mainCommits(), 2);
  assert.equal(handle.agent.modelCalls, 0);
});
