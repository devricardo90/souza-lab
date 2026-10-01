import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { createScenario } from "./helpers/execution-crash-harness.js";

/** CP-06 crash tests D and E (plus a no-duplicate full-process check) with REAL processes and a REAL Git repository. */
let s;
beforeEach(async () => { s = await createScenario(); });
afterEach(() => s.cleanup());

const EXIT_OK = { exitOnCompleted: true };

test("TEST D (critical): agent completes, durable result persisted, Controller dies before consuming it -> restart recovers the result, ZERO second agent calls", async () => {
  const first = await s.spawn("D1", { crashAt: { point: "after_agent_result_recorded" } }).exited;
  assert.ok(s.died(first));
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"]);
  const stored = s.attempt();
  assert.equal(stored.status, "AGENT_RESULT_RECORDED", "the result was durable before the Controller could depend on it");
  assert.deepEqual([stored.resultSource, Boolean(stored.agentResult?.head)], ["AGENT", true]);

  const second = await s.spawn("D2", EXIT_OK).exited;
  assert.equal(second.code, 0, `${JSON.stringify(second.lines.slice(-2))} ${second.stderr}`);
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "no second agent call after the restart");
  const done = s.attempt();
  assert.deepEqual([done.agentInvocations, done.agentResult.head], [1, stored.agentResult.head], "the recovered result is the persisted one");
  assert.equal(s.commitsOnBranch(done.branch), 1);
  await s.assertCompletedOnce(assert);
});

test("TEST E: agent commits the implementation, Controller dies before recording completion -> Git reconciliation discovers the finished execution, no second implementation", async () => {
  const first = await s.spawn("E1", { agentCrashAt: "after_commit" }).exited;
  assert.ok(s.died(first));
  const interrupted = s.attempt();
  assert.deepEqual([interrupted.status, interrupted.agentResult], ["AGENT_RUNNING", null], "the agent's result never became durable");
  assert.equal(s.commitsOnBranch(interrupted.branch), 1, "but the commit exists in the execution branch");
  const commitBefore = s.repo.run(["rev-parse", interrupted.branch]);

  const second = await s.spawn("E2", EXIT_OK).exited;
  assert.equal(second.code, 0, `${JSON.stringify(second.lines.slice(-2))} ${second.stderr}`);
  const done = s.attempt();
  assert.deepEqual([done.status, done.classification, done.resultSource], ["AGENT_RESULT_RECORDED", "COMMITTED_IMPLEMENTATION_PRESENT", "GIT_RECONCILIATION"]);
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "no second implementation was started");
  assert.equal(done.agentResult.head, commitBefore, "the result was derived from Git, not from an agent narrative");
  assert.equal(s.repo.run(["rev-parse", done.branch]), commitBefore, "history was not rewritten");
  assert.equal(s.commitsOnBranch(done.branch), 1);
  await s.assertCompletedOnce(assert);
});

test("a Controller killed mid-run and restarted several times never produces a second implementation or a second Jira completion", async () => {
  const kills = ["after_attempt_prepared", "after_agent_running_persisted", "after_agent_result_recorded"];
  for (const [i, point] of kills.entries()) {
    const r = await s.spawn(`M${i}`, { crashAt: { point } }).exited;
    assert.ok(s.died(r), point);
  }
  const final = await s.spawn("M-final", EXIT_OK).exited;
  assert.equal(final.code, 0, `${JSON.stringify(final.lines.slice(-2))} ${final.stderr}`);
  const done = s.attempt();
  assert.equal(done.status, "AGENT_RESULT_RECORDED");
  assert.equal(s.commitsOnBranch(done.branch), 1);
  assert.ok(s.agentCalls().filter((c) => c.mode === "execute").length <= 2, "at most the one interrupted invocation plus one retry");
  await s.assertCompletedOnce(assert);
});
