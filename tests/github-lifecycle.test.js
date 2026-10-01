import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { drive } from "./helpers/controller-harness.js";
import { createGitHubScenario } from "./helpers/github-scenario.js";

/**
 * CP-07 in-process composition tests: Controller + LoopRuntime + REAL local Git + the REAL GitHubSCMProvider/GitHubCIProvider
 * (against the fake `gh api` backend with a real bare repo) + durable gate evidence + deterministic reviewer/validator.
 * SYNTHETIC evidence only (not real GitHub); zero model calls.
 */
let s; let handle;
beforeEach(async () => { s = await createGitHubScenario(); });
afterEach(() => { if (handle) { try { handle.close(); } catch {} handle = null; } s.cleanup(); });
const open = (opts) => { handle = s.inProcess(opts); return handle; };

test("FULL REAL-GIT LIFECYCLE: implementation -> push -> PR -> CI (waits, then PASS) -> validation -> review -> merge -> post-merge -> LOCAL_DONE -> Jira completion -> COMPLETED", async () => {
  const h = open();
  await h.controller.start();
  s.fake.setAutoCI({ pendingPolls: 100000, outcome: "success" }); // CI stays PENDING until the test releases it
  let waits = 0; let agentCallsWhileWaiting = null;
  const { last } = await drive(h, {
    maxCycles: 160,
    onCycle: (r) => {
      if (r.outcome !== "WAIT_CI") return;
      waits += 1;
      agentCallsWhileWaiting ??= h.agent.calls.length;
      if (waits === 2) s.fake.setAutoCI({ pendingPolls: 0, outcome: "success" }); // CI finishes after two full waiting cycles
    },
  });
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));
  assert.ok(waits >= 2, "CI pending produced WAIT_CI cycles");
  assert.equal(h.agent.calls.length, agentCallsWhileWaiting, "waiting for CI never re-invoked the agent");

  const attempt = s.attempt();
  assert.equal(attempt.status, "AGENT_RESULT_RECORDED");
  const head = attempt.agentResult.head;
  // push: the exact implementation head is on the remote branch
  assert.equal(s.remoteHead(attempt.branch), head);
  // PR: exactly one change object, tied to the task and execution by markers, merged
  const [pr] = s.fake.prs();
  assert.equal(s.fake.prs().length, 1);
  assert.deepEqual([pr.head, pr.base, pr.state], [attempt.branch, "main", "closed"]);
  assert.match(pr.body, /<!-- loop-task:TASK-001 -->/);
  assert.match(pr.body, new RegExp(`<!-- loop-execution:${attempt.executionId} -->`));
  assert.equal(pr.mergedHeadSha, head, "the merged head is exactly the validated/reviewed head");
  // merge is on the remote default branch and contains the implementation
  assert.equal(s.remoteHead("main"), pr.mergeSha);
  assert.equal(s.repo.run(["--git-dir", s.barePath, "show", `${pr.mergeSha}:impl/TASK-001.txt`], s.repo.root).startsWith("implementation of TASK-001"), true);
  assert.equal(s.mainCommits(), 2, "baseline + one squash merge");
  // gate evidence is bound to the exact head and durable
  s.gate((g) => {
    assert.equal(g.getValidation(attempt.executionId, "TASK-001", head).result, "PASS");
    const review = g.getReview(attempt.executionId, head);
    assert.deepEqual([review.verdict, review.reviewerId], ["CLEAN", "independent-reviewer@example.invalid"]);
    assert.equal(g.postMergeValidated(attempt.executionId, "TASK-001"), true);
    assert.equal(g.getValidation(attempt.executionId, "TASK-001", pr.mergeSha).baseline, head, "post-merge proof is bound to the merge commit and the candidate");
  });
  // the CP-05 chain still holds
  assert.deepEqual(s.controllerRows(), [["TASK-001", "REMOTE_DONE_CONFIRMED"]]);
  assert.ok((await s.mock.issues()).every((i) => i.fields.status.name === "Done"));
  // waiting on CI was deterministic and token-free
  assert.ok(h.log.some((r) => r.outcome === "WAIT_CI"), "CI pending produced WAIT_CI");
  assert.equal(h.agent.modelCalls, 0);
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "one implementation, zero corrections");
  assert.deepEqual(h.notifier.events, []);
});
