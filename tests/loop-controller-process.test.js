import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN, DOC, ENV, TWO_TASKS, baseConfig, runProcess, startMock, workspace } from "./helpers/controller-harness.js";
import { SqliteControllerStore } from "../src/adapters/sqlite-controller-store.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";

/**
 * CP-05: the Controller as a REAL standalone process (bin/loop-controller.js). Crash = abrupt process death
 * (SIGKILL / TerminateProcess) at a controlled point; recovery = a brand new process on the same durable state.
 * Local Jira mock, fake Google (a file), fake agent, synthetic lifecycle. SYNTHETIC evidence only.
 * Note: on Windows a child "SIGTERM" is a hard kill, so the SIGTERM handler itself is exercised in-process via the abort
 * path (see loop-controller-scenarios.test.js); here every termination is intentionally unclean.
 */
let mock; let ws; const children = [];
before(async () => { mock = await startMock(); });
after(() => { for (const c of children) { try { c.kill(); } catch {} } mock.stop(); });
const cleanup = () => { for (const c of children.splice(0)) { try { c.kill(); } catch {} } if (ws) ws.cleanup(); };
beforeEach(async () => { cleanup(); await mock.reset(); ws = workspace(); });
after(cleanup);

// The instance lease TTL must exceed the longest blocking step of one cycle (a Jira create is several sequential curl calls).
const FAST = { instanceLeaseTtlMs: 15000, defaultWaitMs: 200, standbyPollMs: 300, idlePollMs: 500, blockedPollMs: 500 };
const writeConfig = (name, extra = {}) => {
  const path = join(ws.dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(baseConfig({ ws, port: mock.port, extra: { timings: FAST, ownerId: name, ...extra } })), "utf8");
  return path;
};
const spawnController = (name, extra, options) => {
  const handle = runProcess(writeConfig(name, extra), options);
  children.push(handle.child);
  return handle;
};
const agentLines = () => readFileSync(join(ws.dir, "agent-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const waitFor = async (predicate, { timeoutMs = 20000, stepMs = 100 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await predicate()) return true; await new Promise((r) => setTimeout(r, stepMs)); }
  throw new Error("condition not reached in time");
};
const readStores = () => {
  const controller = new SqliteControllerStore({ path: join(ws.dir, "controller.sqlite") });
  const outbox = new SqliteOutboxStore({ path: join(ws.dir, "outbox.sqlite") });
  const snapshot = { rows: controller.list().map((r) => [r.taskId, r.status]), ops: outbox.list().map((o) => [o.action, o.taskId, o.status]) };
  controller.close(); outbox.close();
  return snapshot;
};

test("PROCESS RESTART (real processes): killed mid-execution, then killed after LOCAL_DONE, then a third process completes -> TASK-001 implemented once, TASK-002 completes, zero duplicates", async () => {
  ws.setPlan(TWO_TASKS());

  // process 1: dies abruptly in the middle of TASK-001's runtime cycles
  const p1 = spawnController("proc-1", { crashAt: { point: "after_runtime_cycle", count: 5 } });
  const r1 = await p1.exited;
  assert.ok(r1.signal !== null || r1.code !== 0, "process 1 must have died uncleanly");
  assert.ok(!r1.lines.some((l) => l.event === "exit"), "no graceful exit happened");
  let state = readStores();
  assert.deepEqual(state.rows, [["TASK-001", "EXECUTING"]], "work package persisted and still executing");
  assert.equal(agentLines().length, 1, "TASK-001 was implemented once before the crash");
  assert.equal((await mock.issues()).length, 2, "both tasks were already materialized");

  // process 2: takes over after the dead instance's lease expires, resumes TASK-001 (does NOT re-implement), dies right after LOCAL_DONE
  const p2 = spawnController("proc-2", { crashAt: { point: "after_local_done", count: 1 } });
  const r2 = await p2.exited;
  assert.ok(r2.signal !== null || r2.code !== 0);
  assert.ok(r2.lines.some((l) => l.event === "cycle" && l.phase === "STARTED") || r2.lines.some((l) => l.phase === "STARTED"), "process 2 became the active owner");
  state = readStores();
  assert.deepEqual(state.rows, [["TASK-001", "LOCAL_DONE"]]);
  assert.equal(agentLines().length, 1, "resuming did not duplicate the implementation");
  assert.equal(await mock.posts(/\/transitions$/), 0, "Jira has not been told yet: LOCAL_DONE alone releases nothing");
  assert.ok((await mock.issues()).every((i) => i.fields.status.name !== "Done"));

  // process 3: completes the remote sync, advances to TASK-002, finishes, exits 0
  const p3 = spawnController("proc-3", { exitOnCompleted: true });
  const r3 = await p3.exited;
  assert.equal(r3.code, 0, `stderr=${r3.stderr}`);
  assert.deepEqual(r3.lines.at(-1), { event: "exit", exit: "COMPLETED", cycles: r3.lines.at(-1).cycles });
  assert.ok(!r3.lines.some((l) => l.phase === "BUILD_WORK_PACKAGE" && l.taskId === "TASK-001"), "TASK-001 was not rebuilt");
  assert.ok(r3.lines.some((l) => l.phase === "REMOTE_DONE_CONFIRMED" && l.taskId === "TASK-001"));
  assert.ok(r3.lines.some((l) => l.phase === "BUILD_WORK_PACKAGE" && l.taskId === "TASK-002"));

  state = readStores();
  assert.deepEqual(state.rows, [["TASK-001", "REMOTE_DONE_CONFIRMED"], ["TASK-002", "REMOTE_DONE_CONFIRMED"]]);
  assert.deepEqual(state.ops.map((o) => o.join(":")).sort(), ["JIRA_CREATE:TASK-001:CONFIRMED", "JIRA_CREATE:TASK-002:CONFIRMED", "JIRA_TRANSITION:TASK-001:CONFIRMED", "JIRA_TRANSITION:TASK-002:CONFIRMED"]);
  assert.deepEqual(agentLines().map((l) => l.taskId), ["TASK-001", "TASK-002"], "exactly one implementation per task across three processes");
  assert.equal(await mock.posts(/\/rest\/api\/3\/issue$/), 2, "one Jira issue per task");
  assert.equal(await mock.posts(/\/transitions$/), 2, "one completion per task");
  assert.ok((await mock.issues()).every((i) => i.fields.status.name === "Done"));
  assert.ok(!JSON.stringify([...children.map((c) => c.spawnargs)]).includes(ENV.LOOP_JIRA_API_TOKEN), "no secret in argv");
});

test("SINGLE INSTANCE (real processes): a second controller stays in standby while the first runs, and takes over only after the first dies and its lease expires", async () => {
  ws.setPlan(TWO_TASKS());
  const a = spawnController("proc-A");
  await waitFor(() => a.lines.some((l) => l.phase === "STARTED"));
  const b = spawnController("proc-B");
  await new Promise((resolve) => setTimeout(resolve, 17000)); // longer than the 15s lease TTL: B would have taken over if A were not renewing
  assert.ok(!b.lines.some((l) => l.phase === "STARTED"), "B must not become active while A owns the workspace");
  assert.ok(!b.lines.some((l) => l.event === "cycle" && l.phase !== "STARTED"), "B ran no cycles");

  a.child.kill(); // abrupt: no graceful lease release
  await a.exited;
  await waitFor(() => b.lines.some((l) => l.phase === "STARTED"), { timeoutMs: 40000 });
  b.child.kill();
  await b.exited;
});

test("process configuration errors exit 78 without leaking secrets", async () => {
  const bad = join(ws.dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ profile: "production-google-jira" }), "utf8");
  const unsupported = await runProcess(bad).exited;
  assert.equal(unsupported.code, 78);
  assert.equal(unsupported.lines.at(-1).event, "fatal");
  assert.equal(unsupported.lines.at(-1).code, "CONFIG_INVALID");

  const noCreds = await runProcess(writeConfig("nocreds"), { env: {}, extraEnv: { LOOP_JIRA_EMAIL: "", LOOP_JIRA_API_TOKEN: "" } }).exited;
  assert.equal(noCreds.code, 78);
  assert.ok(!JSON.stringify(noCreds.lines).includes(ENV.LOOP_JIRA_API_TOKEN));

  const noArgs = await new Promise((resolve) => {
    const { child, exited } = runProcess("");
    exited.then(resolve);
    void child;
  });
  assert.equal(noArgs.code, 78, "a missing/unreadable config file is a configuration error");
  assert.ok(BIN.endsWith("loop-controller.js") && DOC);
});
