import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createScenario } from "./helpers/execution-crash-harness.js";

/** CP-06 crash tests A, B, C with REAL processes and a REAL Git repository. SYNTHETIC agent (zero model calls). */
let s;
beforeEach(async () => { s = await createScenario(); });
afterEach(() => s.cleanup());

const EXIT_OK = { exitOnCompleted: true };

test("TEST A: PREPARED persisted, process dies before the agent -> restart executes the agent exactly once", async () => {
  const first = await s.spawn("A1", { crashAt: { point: "after_attempt_prepared" } }).exited;
  assert.ok(s.died(first), "process 1 died uncleanly");
  const prepared = s.attempt();
  assert.deepEqual([prepared.status, prepared.agentInvocations, prepared.agentResult], ["PREPARED", 0, null]);
  assert.ok(prepared.workspacePath && prepared.branch && prepared.baseSha, "workspace identity was persisted BEFORE any agent call");
  assert.equal(s.agentCalls().length, 0);

  const second = await s.spawn("A2", EXIT_OK).exited;
  assert.equal(second.code, 0, `${JSON.stringify(second.lines.slice(-3))} ${second.stderr}`);
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute"], "the agent ran exactly once");
  const done = s.attempt();
  assert.deepEqual([done.status, done.agentInvocations, done.resultSource], ["AGENT_RESULT_RECORDED", 1, "AGENT"]);
  assert.equal(s.commitsOnBranch(done.branch), 1);
  await s.assertCompletedOnce(assert);
});

test("TEST B: agent starts, makes NO repository change, dies -> restart classifies NO_IMPLEMENTATION_PRESENT and retries safely: one successful implementation", async () => {
  const first = await s.spawn("B1", { agentCrashAt: "before_write" }).exited;
  assert.ok(s.died(first));
  const running = s.attempt();
  assert.deepEqual([running.status, running.agentInvocations], ["AGENT_RUNNING", 1]);
  assert.equal(s.commitsOnBranch(running.branch), 0, "nothing was committed");
  assert.equal(s.repo.run(["status", "--porcelain=v1", "-uall"], s.workspacePath()), "", "the workspace is untouched");

  const second = await s.spawn("B2", EXIT_OK).exited;
  assert.equal(second.code, 0, `${JSON.stringify(second.lines.slice(-3))} ${second.stderr}`);
  const done = s.attempt();
  assert.deepEqual([done.status, done.classification, done.agentInvocations, done.resultSource], ["AGENT_RESULT_RECORDED", "NO_IMPLEMENTATION_PRESENT", 2, "AGENT"]);
  assert.deepEqual(s.agentCalls().map((c) => c.mode), ["execute", "execute"], "the first invocation died, the retry succeeded");
  assert.equal(s.commitsOnBranch(done.branch), 1, "exactly one implementation exists");
  await s.assertCompletedOnce(assert);
});

test("TEST C: agent modifies the repository, dies before a durable result -> changes preserved, NO clean-baseline reimplementation, the recoverable executor resumes and completes", async () => {
  const first = await s.spawn("C1", { agentCrashAt: "after_write" }).exited;
  assert.ok(s.died(first));
  const interrupted = s.attempt();
  assert.deepEqual([interrupted.status, interrupted.agentResult], ["AGENT_RUNNING", null]);
  const workFile = join(s.workspacePath(), "impl", "TASK-001.txt");
  const original = readFileSync(workFile, "utf8");
  assert.match(original, /^implementation of TASK-001: Only task/);
  assert.equal(s.commitsOnBranch(interrupted.branch), 0, "the work is uncommitted");
  assert.equal(s.repo.run(["status", "--porcelain=v1", "-uall"], s.workspacePath()), "?? impl/TASK-001.txt");

  const second = await s.spawn("C2", EXIT_OK).exited;
  assert.equal(second.code, 0, `${JSON.stringify(second.lines.slice(-3))} ${second.stderr}`);
  const done = s.attempt();
  assert.deepEqual([done.status, done.classification, done.resultSource], ["AGENT_RESULT_RECORDED", "IMPLEMENTATION_PRESENT_UNVERIFIED", "AGENT_RESUME"]);
  const modes = s.agentCalls().map((c) => c.mode);
  assert.deepEqual(modes, ["execute", "resume"], "recovery went through the resume boundary, not a second fresh execute");
  assert.equal(s.agentCalls()[1].preservedBytes, Buffer.byteLength(original));
  assert.equal(s.commitsOnBranch(done.branch), 1);
  const committed = s.repo.run(["show", `${done.branch}:impl/TASK-001.txt`]);
  assert.ok(committed.startsWith(original.trim()), "the pre-crash work is part of the final implementation");
  await s.assertCompletedOnce(assert);
});
