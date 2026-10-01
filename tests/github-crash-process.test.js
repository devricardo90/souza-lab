import assert from "node:assert/strict";
import test from "node:test";
import { createGitHubScenario } from "./helpers/github-scenario.js";

/**
 * CP-07 crash gauntlet with REAL processes (bin/loop-controller.js), a REAL local git repo with a REAL bare remote, the REAL
 * GitHub SCM/CI providers over the fake `gh api`, and zero model calls. ONE continuous execution is killed abruptly at six
 * different points; each new process must recover from durable state and remote facts alone and never repeat an action.
 *
 *   A  implementation durable           -> killed BEFORE push           -> restart pushes once
 *   B  push confirmed on the remote     -> killed BEFORE the PR         -> restart reconciles the remote head, no second push
 *   C  PR / change object created       -> killed                       -> restart rediscovers the SAME PR
 *   D  CI pending                       -> process stopped while waiting-> restart keeps waiting; no agent re-execution
 *   F  merge happened on the remote     -> killed BEFORE local confirm  -> restart rediscovers the merge, no 2nd PR/merge, post-merge, done
 */
const dump = (r) => JSON.stringify({ code: r.code, signal: r.signal, tail: r.lines.slice(-5), stderr: String(r.stderr ?? "").slice(0, 400) });
const FAST = { timings: { instanceLeaseTtlMs: 6000, defaultWaitMs: 200, standbyPollMs: 300, idlePollMs: 500, blockedPollMs: 500 } };

test("CRASH GAUNTLET A/B/C/D/F: one execution, six processes, every restart recovers without repeating push, PR, agent run or merge", async () => {
  const s = await createGitHubScenario();
  try {
    // ---- A: killed after the implementation became durable, before the push
    const p1 = await s.spawn("G1", { ...FAST, crashAt: { point: "after_runtime_cycle", count: 4 } }).exited;
    assert.ok(s.died(p1), `G1 died uncleanly ${dump(p1)}`);
    const a = s.attempt();
    assert.equal(a.status, "AGENT_RESULT_RECORDED", "the implementation result was durable");
    const h1 = a.agentResult.head;
    assert.equal(s.remoteHead(a.branch), null, "A: nothing was pushed yet");
    assert.equal(s.fake.prs().length, 0);
    assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"]);

    // ---- B: killed after the push was confirmed on the remote, before the PR was created
    const p2 = await s.spawn("G2", { ...FAST, crashAt: { point: "after_push_confirmed" } }).exited;
    assert.ok(s.died(p2), dump(p2));
    assert.equal(s.remoteHead(a.branch), h1, "B: the exact HEAD is on the remote");
    assert.equal(s.fake.prs().length, 0, "B: but no change object exists yet");
    assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "no second implementation");

    // ---- C: killed right after the PR was created
    const p3 = await s.spawn("G3", { ...FAST, crashAt: { point: "after_pr_created" } }).exited;
    assert.ok(s.died(p3), dump(p3));
    assert.equal(s.remoteHead(a.branch), h1, "the restart did not push again or change the remote head");
    assert.equal(s.fake.prs().length, 1, "C: exactly one PR");
    const pr1 = s.fake.prs()[0];
    assert.deepEqual([pr1.head, pr1.base, pr1.state], [a.branch, "main", "open"]);

    // ---- D: CI stays pending; a process waits (WAIT_CI), is stopped, and a new process keeps waiting
    s.fake.setAutoCI({ pendingPolls: 100000, outcome: "success" });
    const p4 = s.spawn("G4", FAST);
    await waitFor(() => p4.lines.filter((l) => l.outcome === "WAIT_CI").length >= 2, 600000);
    p4.child.kill();
    await p4.exited;
    assert.equal(s.fake.prs().length, 1, "D: no second PR while waiting");
    assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "D: waiting never re-runs the agent");
    const p5 = s.spawn("G5", FAST);
    await waitFor(() => p5.lines.some((l) => l.outcome === "WAIT_CI"), 600000);
    p5.child.kill();
    await p5.exited;
    assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"]);
    assert.equal(s.mock && (await s.mock.posts(/\/transitions$/)), 0, "nothing was reported to Jira before the work finished");

    // ---- F: CI passes; the process is killed right after the remote merge, before it can record it
    s.fake.setAutoCI({ pendingPolls: 0, outcome: "success" });
    const p6 = await s.spawn("G6", { ...FAST, crashAt: { point: "after_remote_merge" } }).exited;
    assert.ok(s.died(p6), dump(p6));
    const merged = s.fake.prs()[0];
    assert.equal(merged.state, "closed", `F: the merge happened on the remote. G6: ${dump(p6)}`);
    assert.equal(merged.mergedHeadSha, h1, "the merged head is the exact validated and reviewed head");
    assert.equal(s.mainCommits(), 2, "baseline + exactly one squash merge");
    assert.deepEqual(s.controllerRows(), [["TASK-001", "EXECUTING"]], "locally the merge was never confirmed");
    s.gate((g) => assert.equal(g.postMergeValidated(a.executionId, "TASK-001"), false));

    // ---- recovery: the merge is rediscovered; post-merge proof; LOCAL_DONE -> Jira -> COMPLETED
    const last = await s.spawn("G7", { ...FAST, exitOnCompleted: true }).exited;
    assert.equal(last.code, 0, dump(last));
    assert.equal(last.lines.at(-1).exit, "COMPLETED");
    assert.equal(s.fake.prs().length, 1, "no second PR, ever");
    assert.equal(s.mainCommits(), 2, "no second merge");
    assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "exactly one implementation across seven processes");
    assert.equal(s.reviewCalls().filter((c) => c.kind === "implementation").length, 1, "the head was reviewed once");
    assert.equal(s.validationCalls().filter((c) => c.kind === "validate").length, 1, "the head was validated once");
    assert.deepEqual(s.validationCalls().filter((c) => c.kind === "post-merge").map((c) => c.mergeSha), [merged.mergeSha], "post-merge validation ran on the rediscovered merge commit");
    s.gate((g) => assert.equal(g.postMergeValidated(a.executionId, "TASK-001"), true));
    assert.deepEqual(s.controllerRows(), [["TASK-001", "REMOTE_DONE_CONFIRMED"]]);
    assert.equal(await s.mock.posts(/\/transitions$/), 1, "one Jira completion");
    assert.ok((await s.mock.issues()).every((i) => i.fields.status.name === "Done"));
  } finally { s.cleanup(); }
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (predicate()) return; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error("condition not reached in time");
}
