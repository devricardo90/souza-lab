import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOC, TWO_TASKS, drive, inProcessController, planText, startMock, steppingClock, task, workspace } from "./helpers/controller-harness.js";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";
import { buildMaterializationOperations } from "../src/materialize/jira-materialization.js";
import { runControllerLoop } from "../src/controller/controller-process.js";

/**
 * CP-05 Controller scenarios (in-process): outage, source change, startup ordering, outcome classification,
 * single instance and graceful shutdown. Real stores / reconciler / outbox / curl transport to a local Jira mock;
 * fake Google, fake agent, synthetic lifecycle. SYNTHETIC evidence only.
 */
let mock; let ws; let handle;
before(async () => { mock = await startMock(); });
after(() => mock.stop());
const cleanup = () => { if (handle) { try { handle.close(); } catch {} handle = null; } if (ws) ws.cleanup(); };
beforeEach(async () => { cleanup(); await mock.reset(); ws = workspace(); });
after(cleanup);

const open = (opts = {}) => { handle = inProcessController({ ws, port: mock.port, ...opts }); return handle; };
const agentLines = () => readFileSync(join(ws.dir, "agent-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

// ---------------------------------------------------------------------------------------------
// Jira outage: local completion is retained, nothing re-runs, nothing new is selected, no model tokens
// ---------------------------------------------------------------------------------------------
test("JIRA OUTAGE: TASK-001 completes locally, Jira goes down before the completion sync -> WAIT_JIRA with backoff, no second implementation, TASK-002 NOT selected; Jira returns -> REMOTE_DONE_CONFIRMED -> TASK-002 runs", async () => {
  ws.setPlan(TWO_TASKS());
  const sc = steppingClock();
  const h = open({ clock: sc.clock, overrides: { faultPoints: { after_local_done: async ({ taskId }) => { if (taskId === "TASK-001") await mock.outage(503); } } } });
  await h.controller.start();
  await drive(h, { until: (r) => r.phase === "LOCAL_DONE" && r.taskId === "TASK-001" });
  assert.equal(h.stores.controllerStore.get("TASK-001").status, "LOCAL_DONE");
  const agentCallsBefore = h.agent.calls.length;
  assert.equal(agentCallsBefore, 1);

  for (let i = 0; i < 5; i += 1) {
    const result = await h.controller.cycle();
    assert.equal(result.outcome, "WAIT_JIRA", JSON.stringify(result));
    assert.equal(result.taskId, "TASK-001");
    assert.ok(result.nextWakeAt >= sc.clock(), "a deterministic wake time is provided; no polling loop is needed");
    if (i === 1) sc.advance(1500);
    if (i === 3) sc.advance(3000);
  }
  const transition = h.stores.outboxStore.list().find((o) => o.action === "JIRA_TRANSITION");
  assert.equal(transition.status, "RETRY_WAIT");
  assert.ok(transition.attemptCount >= 3, `retries back off instead of hammering (attempts=${transition.attemptCount})`);
  assert.deepEqual(h.stores.controllerStore.list().map((r) => [r.taskId, r.status]), [["TASK-001", "LOCAL_DONE"]], "TASK-002 was NOT selected");
  assert.equal(h.agent.calls.length, agentCallsBefore, "no second implementation");
  assert.equal(h.agent.modelCalls, 0, "ZERO model calls while waiting");
  assert.equal(await mock.posts(/\/transitions$/), 0, "nothing was written to Jira during the outage");
  assert.deepEqual(h.notifier.events, [], "a transient outage is not an Owner alert");

  await mock.restore();
  sc.advance(10_000);
  const { last } = await drive(h);
  assert.equal(last.outcome, "COMPLETED");
  assert.deepEqual(h.agent.calls, ["TASK-001", "TASK-002"], "each task implemented exactly once");
  assert.equal(await mock.posts(/\/transitions$/), 2);
  assert.deepEqual(h.stores.controllerStore.list().map((r) => r.status), ["REMOTE_DONE_CONFIRMED", "REMOTE_DONE_CONFIRMED"]);
  assert.ok((await mock.issues()).every((i) => i.fields.status.name === "Done"));
  assert.equal(h.agent.modelCalls, 0);
});

// ---------------------------------------------------------------------------------------------
// Source change during execution
// ---------------------------------------------------------------------------------------------
const rename = () => planText(2, task("TASK-001", "First task RENAMED"), task("TASK-002", "Second task", "DEPENDS_ON: TASK-001\n"));

test("SOURCE CHANGE: plan v2 renames the running TASK-001 -> its v1 WorkPackage is untouched and finishes; v2 is considered only at the next planning boundary and yields a deterministic conflict", async () => {
  ws.setPlan(TWO_TASKS(1));
  const h = open({ overrides: { faultPoints: { after_work_package_created: ({ taskId }) => { if (taskId === "TASK-001") ws.setPlan(rename()); } } } });
  await h.controller.start();
  const { last } = await drive(h, { until: (r) => ["OWNER_DECISION_REQUIRED", "COMPLETED"].includes(r.outcome) });
  assert.equal(last.outcome, "OWNER_DECISION_REQUIRED");
  assert.equal(last.phase, "SELECT_TASK");
  assert.match(last.detail, /TASK-001:REMOTE_DEFINITION_DRIFT/, "the renamed task changed both its title and its acceptance text: a deterministic multi-field conflict");

  const row = h.stores.controllerStore.get("TASK-001");
  assert.deepEqual([row.workPackage.planBinding.planVersion, row.workPackage.title, row.status], [1, "First task", "REMOTE_DONE_CONFIRMED"], "frozen v1 binding, completed and confirmed");
  assert.equal(agentLines()[0].title, "First task", "the agent was only ever given the v1 definition");
  assert.equal(agentLines()[0].planVersion, 1);
  assert.deepEqual(h.stores.planStore.listVersions(DOC).map((v) => v.planVersion), [1, 2], "v2 was ingested as the new last-known-good without touching the running work");
  assert.equal(h.stores.controllerStore.get("TASK-002"), null, "nothing new is started on a conflicting plan");
  assert.equal(h.agent.calls.length, 1);
  const issue = (await mock.issues()).find((i) => i.fields.summary.startsWith("First task"));
  assert.equal(issue.fields.summary, "First task", "Jira was not mutated to match v2 (no automatic UPDATE)");
  assert.deepEqual(h.notifier.events.map((e) => e.kind), ["OWNER_DECISION_REQUIRED"]);
});

test("SOURCE CHANGE: plan v2 adds TASK-003 while TASK-001 runs -> TASK-001 keeps its v1 binding; later work binds the plan that is current at the planning boundary", async () => {
  ws.setPlan(TWO_TASKS(1));
  const v2 = planText(2, task("TASK-001", "First task"), task("TASK-002", "Second task", "DEPENDS_ON: TASK-001\n"), task("TASK-003", "Third task"));
  const h = open({ overrides: { faultPoints: { after_work_package_created: ({ taskId }) => { if (taskId === "TASK-001") ws.setPlan(v2); } } } });
  await h.controller.start();
  const { last } = await drive(h, { maxCycles: 160 });
  assert.equal(last.outcome, "COMPLETED");
  assert.deepEqual(h.agent.calls, ["TASK-001", "TASK-002", "TASK-003"]);
  const rows = h.stores.controllerStore.list();
  assert.deepEqual(Object.fromEntries(rows.map((r) => [r.taskId, r.workPackage.planBinding.planVersion])), { "TASK-001": 1, "TASK-002": 2, "TASK-003": 2 });
  const latest = h.stores.planStore.latest(DOC);
  assert.equal(rows.find((r) => r.taskId === "TASK-001").workPackage.planBinding.taskHash, latest.tasks.find((t) => t.taskId === "TASK-001").taskHash, "an unchanged definition keeps the same task hash across versions");
  assert.deepEqual(h.notifier.events, []);
});

// ---------------------------------------------------------------------------------------------
// Startup ordering: pending external work is reconciled BEFORE any new work is selected
// ---------------------------------------------------------------------------------------------
const firstCreateOperation = () => {
  const stamp = "2026-10-01T10:00:00.000Z";
  const snapshot = makePlanSnapshot({ documentId: DOC, compiled: compilePlan(TWO_TASKS()), fetchedAt: stamp, compiledAt: stamp });
  const reconciliation = reconcilePlan({ snapshot, observation: normalizeJiraObservation([]), createdAt: stamp });
  return buildMaterializationOperations({ reconciliation, config: { projectKey: "LOOP", issueTypeName: "Task" } }).operations[0];
};

test("STARTUP: an unfinished outbox operation left by a previous process is recovered during start(), before any work can be selected", async () => {
  ws.setPlan(TWO_TASKS());
  const h = open();
  h.outboxExecutor.enqueueMaterialization(firstCreateOperation()); // intent persisted by a previous process, never executed
  assert.equal(h.controller.startupRecovered, false);
  assert.equal((await mock.issues()).length, 0);
  const started = await h.controller.start();
  assert.equal(h.controller.startupRecovered, true);
  assert.equal(started.report.outboxProcessed, 1);
  assert.equal((await mock.issues()).length, 1, "the pending create was executed during recovery");
  assert.deepEqual(h.stores.controllerStore.list(), [], "nothing was selected during startup");
  assert.equal(h.stores.outboxStore.list()[0].status, "CONFIRMED");
});

test("STARTUP: while a recovered external operation is still unfinished (RETRY_WAIT), no new work is selected", async () => {
  ws.setPlan(TWO_TASKS());
  const sc = steppingClock();
  const h = open({ clock: sc.clock });
  h.outboxExecutor.enqueueMaterialization(firstCreateOperation());
  await mock.outage(503);
  await h.controller.start(); // recovery meets the outage -> RETRY_WAIT
  assert.equal(h.stores.outboxStore.list()[0].status, "RETRY_WAIT");
  await mock.restore(); // Jira is back, but the operation is not yet due
  const waiting = await h.controller.cycle();
  assert.equal(waiting.outcome, "WAIT_JIRA");
  assert.deepEqual(h.stores.controllerStore.list(), []);
  assert.equal((await mock.issues()).length, 0, "nothing was written before the pending operation was due and reconciled");
  sc.advance(5000);
  const { last } = await drive(h, { until: (r) => r.phase === "BUILD_WORK_PACKAGE" });
  assert.equal(last.taskId, "TASK-001");
  assert.ok((await mock.issues()).length >= 1);
});

// ---------------------------------------------------------------------------------------------
// Outcome classification
// ---------------------------------------------------------------------------------------------
test("WAIT_SOURCE: Google unavailable and no snapshot -> wait with a wake time, no Jira call, no work", async () => {
  const h = open(); // no plan file exists -> the fake Google transport throws
  await h.controller.start();
  const result = await h.controller.cycle();
  assert.deepEqual([result.outcome, result.phase], ["WAIT_SOURCE", "SYNC_SOURCE"]);
  assert.ok(result.nextWakeAt);
  assert.equal((await mock.log()).length, 0);
});

test("SOURCE_INVALID with no last-known-good -> OWNER_DECISION_REQUIRED (nothing to fall back to)", async () => {
  ws.setPlan("A document with no executable section at all.");
  const h = open();
  await h.controller.start();
  const result = await h.controller.cycle();
  assert.deepEqual([result.outcome, result.code], ["OWNER_DECISION_REQUIRED", "NO_EXECUTABLE_SECTION"]);
});

test("Google unavailable WITH a last-known-good: work continues on the snapshot; a persistent failure notifies once", async () => {
  const flag = join(ws.dir, "google-down.flag");
  ws.setPlan(TWO_TASKS());
  const h = open({ configExtra: { unavailableFile: flag } });
  await h.controller.start();
  await h.controller.cycle(); // source ingested, first materialization
  writeFileSync(flag, "down");
  for (let i = 0; i < 4; i += 1) {
    const result = await h.controller.cycle();
    assert.notEqual(result.outcome, "WAIT_SOURCE", "the previous snapshot stays usable");
  }
  assert.ok((await mock.issues()).length >= 1, "materialization kept progressing on the snapshot");
  assert.deepEqual(h.notifier.events.map((e) => e.kind), ["PERSISTENT_SOURCE_FAILURE"], "one alert after the threshold, not one per cycle");
});

test("BLOCK_GLOBAL: Jira auth failure is a system-wide block, notified exactly once; no work is attempted", async () => {
  ws.setPlan(TWO_TASKS());
  const h = open();
  await h.controller.start();
  await mock.outage(401);
  const results = [];
  for (let i = 0; i < 3; i += 1) results.push(await h.controller.cycle());
  assert.ok(results.every((r) => r.outcome === "BLOCK_GLOBAL" && r.code === "AUTH_INVALID"), JSON.stringify(results));
  assert.deepEqual(h.notifier.events.map((e) => e.kind), ["AUTH_INVALID"]);
  assert.deepEqual(h.stores.controllerStore.list(), []);
  assert.equal(h.agent.calls.length, 0);
});

test("WAIT_JIRA: a transient Jira failure while planning waits (deterministic wake time) without an Owner alert", async () => {
  ws.setPlan(TWO_TASKS());
  const h = open();
  await h.controller.start();
  await mock.outage(503);
  const result = await h.controller.cycle();
  assert.deepEqual([result.outcome, result.phase, result.code], ["WAIT_JIRA", "RECONCILE_PLAN", "JIRA_UNAVAILABLE"]);
  assert.ok(result.nextWakeAt);
  assert.deepEqual(h.notifier.events, []);
});

test("a task that needs an Epic link cannot be materialized: OWNER_DECISION_REQUIRED, notified once; a failing notifier never changes control flow", async () => {
  ws.setPlan(planText(1, task("TASK-001", "Epic child", "EPIC_ID: TASK-E1\n")));
  const h = open();
  await h.controller.start();
  assert.equal((await h.controller.cycle()).outcome, "OWNER_DECISION_REQUIRED");
  await h.controller.cycle();
  assert.deepEqual(h.notifier.events.map((e) => e.kind), ["OWNER_DECISION_REQUIRED"]);
  assert.equal(await mock.posts(/\/rest\/api\/3\/issue$/), 0, "no Jira relationship was invented");
  h.close(); handle = null;

  const throwing = { notify: async () => { throw new Error("notifier is down"); } };
  const second = open({ overrides: { notifier: throwing }, configExtra: { workspaceId: "other" } });
  await second.controller.start();
  assert.equal((await second.controller.cycle()).outcome, "OWNER_DECISION_REQUIRED", "control flow is independent of the notifier");
});

function stubRuntime(outcomes) {
  const queue = [...outcomes];
  return () => ({ runtime: { runCycle: async () => queue.shift(), checkpointStore: { read: () => null } } });
}
const cycleResult = (outcome, state, retryAt = null) => ({ outcome, nextComputed: { state }, observation: { computed: { state } }, checkpoint: { retry: retryAt ? { nextEligibleAt: retryAt } : null } });

test("runtime waits/blocks map to Controller outcomes: WAIT_CI, WAIT_REVIEW, RETRY_EXTERNAL, then OWNER_DECISION_REQUIRED on a blocked review (WorkPackage BLOCKED, notified)", async () => {
  ws.setPlan(planText(1, task("TASK-001", "Only task")));
  const retryAt = "2026-10-01T12:00:00.000Z";
  const h = open({ overrides: { runtimeFactory: stubRuntime([cycleResult("WAIT_RETRYABLE", "TESTING", retryAt), cycleResult("WAIT_RETRYABLE", "REVIEWING"), cycleResult("WAIT_RETRYABLE", "MERGING"), cycleResult("BLOCKED_OWNER", "REVIEWING")]) } });
  await h.controller.start();
  await drive(h, { until: (r) => r.phase === "BUILD_WORK_PACKAGE" });
  const outcomes = [];
  for (let i = 0; i < 4; i += 1) outcomes.push(await h.controller.cycle());
  assert.deepEqual(outcomes.map((r) => r.outcome), ["WAIT_CI", "WAIT_REVIEW", "RETRY_EXTERNAL", "OWNER_DECISION_REQUIRED"]);
  assert.equal(outcomes[0].nextWakeAt, retryAt);
  assert.equal(h.stores.controllerStore.get("TASK-001").status, "BLOCKED");
  assert.deepEqual(h.notifier.events.map((e) => e.kind), ["REVIEW_OR_VALIDATION_FAILURE"]);
  assert.equal(h.agent.calls.length, 0, "waiting/blocking never invokes the agent");
});

test("a runtime external block is BLOCK_TASK (task-level), notified as an unrecoverable conflict", async () => {
  ws.setPlan(planText(1, task("TASK-001", "Only task")));
  const h = open({ overrides: { runtimeFactory: stubRuntime([cycleResult("BLOCKED_EXTERNAL", "VALIDATING")]) } });
  await h.controller.start();
  await drive(h, { until: (r) => r.phase === "BUILD_WORK_PACKAGE" });
  const result = await h.controller.cycle();
  assert.equal(result.outcome, "BLOCK_TASK");
  assert.equal(h.stores.controllerStore.get("TASK-001").status, "BLOCKED");
  assert.deepEqual(h.notifier.events.map((e) => e.kind), ["UNRECOVERABLE_CONFLICT"]);
});

// ---------------------------------------------------------------------------------------------
// Single instance + graceful shutdown
// ---------------------------------------------------------------------------------------------
test("SINGLE INSTANCE: controller B cannot become active while A holds the workspace; after A dies and its lease expires, B takes over and A is fenced out", async () => {
  ws.setPlan(TWO_TASKS());
  const fast = { timings: { instanceLeaseTtlMs: 1500, defaultWaitMs: 200 } };
  const a = open({ configExtra: { ...fast, ownerId: "controller-A" } });
  assert.equal((await a.controller.start()).owner, true);
  const b = inProcessController({ ws, port: mock.port, configExtra: { ...fast, ownerId: "controller-B" } });
  try {
    assert.deepEqual(await b.controller.start(), { owner: false, reason: "EXECUTION_LEASE_UNAVAILABLE" });
    await assert.rejects(b.controller.cycle(), /has not started/, "a non-owner never runs a cycle");
    assert.equal(a.agent.calls.length + b.agent.calls.length, 0);
    a.controller.stopHeartbeat(); // A "dies": it stops renewing (the heartbeat is what keeps a live controller's lease valid)
    await new Promise((resolve) => setTimeout(resolve, 1700));
    assert.equal((await b.controller.start()).owner, true);
    const fenced = await a.controller.cycle();
    assert.deepEqual([fenced.outcome, fenced.code], ["BLOCK_GLOBAL", "CONTROLLER_LEASE_LOST"]);
    assert.deepEqual(a.notifier.events.map((e) => e.kind), ["CONTROLLER_LEASE_LOST"]);
    assert.equal(a.controller.lease, null, "the fenced-out instance stops acting");
  } finally { b.close(); }
});

test("GRACEFUL SHUTDOWN: aborting the process loop finishes the cycle, releases the instance lease and lets another instance start immediately", async () => {
  const h = open(); // no plan file -> WAIT_SOURCE, the loop sleeps on a deterministic timer
  const abort = new AbortController();
  const events = [];
  const running = runControllerLoop({ controller: h.controller, signal: abort.signal, onCycle: (e) => events.push(e.outcome ?? e.phase), idlePollMs: 60000 });
  await new Promise((resolve) => setTimeout(resolve, 700));
  abort.abort();
  const result = await running;
  assert.equal(result.exit, "SIGNALED");
  assert.ok(events.includes("STARTED") && events.includes("WAIT_SOURCE"));
  assert.equal(h.controller.lease, null, "lease released on shutdown");
  const next = inProcessController({ ws, port: mock.port, configExtra: { ownerId: "after-shutdown" } });
  try { assert.equal((await next.controller.start()).owner, true, "no waiting for lease expiry after a graceful stop"); } finally { next.close(); }
});

test("HEARTBEAT: a live controller keeps its instance lease across an await longer than the TTL (e.g. a long agent run); a second controller still cannot take over", async () => {
  const fast = { timings: { instanceLeaseTtlMs: 1500, defaultWaitMs: 200 } };
  const a = open({ configExtra: { ...fast, ownerId: "long-runner" } });
  assert.equal((await a.controller.start()).owner, true);
  await new Promise((resolve) => setTimeout(resolve, 3200)); // > 2x the TTL with the event loop free, as during an asynchronous agent call
  const b = inProcessController({ ws, port: mock.port, configExtra: { ...fast, ownerId: "would-be-thief" } });
  try {
    assert.equal((await b.controller.start()).owner, false, "the heartbeat kept A's lease valid");
    await a.controller.stop();
    assert.equal((await b.controller.start()).owner, true, "after a graceful stop the lease is released at once");
  } finally { b.close(); }
});
