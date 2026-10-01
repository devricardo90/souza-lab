import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { AgentExecutor, CONTROLLER_OUTCOMES, FakeNotifier, NOTIFY_KINDS, NotifierPort, NullNotifier, WAITING_OUTCOMES, validateAgentResult } from "../src/controller/ports.js";
import { WorkPackageTaskSystem, makeWorkPackage } from "../src/controller/work-package.js";
import { SELECTION_REASONS, selectNextTask } from "../src/controller/task-selection.js";
import { SqliteControllerStore } from "../src/adapters/sqlite-controller-store.js";
import { SyntheticAgentExecutor, SyntheticLifecycle } from "../src/testing/synthetic-lifecycle.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = "2026-10-01T10:00:00.000Z";
const block = (id, title, extra = "") => `TASK_ID: ${id}\nTITLE: ${title}\n${extra}AC:\n- AC-001: ${title} works\n- AC-002: and is verified\n`;
const snapshot = (version, ...blocks) => makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan(`LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: ${version}\n${blocks.join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`), fetchedAt: NOW, compiledAt: NOW });
const REPO = { identity: "synthetic/repo", baseRef: "main" };
const SNAP = snapshot(1, block("T-1", "One"), block("T-2", "Two", "DEPENDS_ON: T-1\n"), block("T-3", "Three"));

// ---------- WorkPackage ----------
test("WorkPackage: frozen, deterministic, bound to the exact snapshot task, and free of Jira/Google/credential material", () => {
  const wp = makeWorkPackage({ snapshot: SNAP, taskId: "T-2", repository: REPO });
  assert.equal(JSON.stringify(wp), JSON.stringify(makeWorkPackage({ snapshot: SNAP, taskId: "T-2", repository: REPO })));
  assert.ok(Object.isFrozen(wp) && Object.isFrozen(wp.acceptanceCriteria) && Object.isFrozen(wp.planBinding) && Object.isFrozen(wp.repository));
  assert.throws(() => { "use strict"; wp.title = "changed"; }, TypeError);
  assert.deepEqual(wp.planBinding, { documentId: "doc-1", planVersion: 1, contentHash: SNAP.contentHash, taskHash: SNAP.tasks[1].taskHash });
  assert.deepEqual([wp.taskId, wp.title, wp.dependencies, wp.repository], ["T-2", "Two", ["T-1"], REPO]);
  assert.deepEqual(wp.acceptanceCriteria, [{ id: "AC-001", text: "Two works" }, { id: "AC-002", text: "and is verified" }]);
  assert.deepEqual(Object.keys(wp).sort(), ["acceptanceCriteria", "dependencies", "executionId", "planBinding", "repository", "schema", "taskId", "title", "workPackageId"]);
  assert.ok(!/jira|token|password|secret|credential|issueKey|LOOP_/i.test(JSON.stringify(wp)), "nothing from Jira/credentials reaches the agent boundary");
  assert.match(wp.workPackageId, /^wp-[0-9a-f]{24}$/);
  assert.match(wp.executionId, /^exec-[0-9a-f]{24}$/);
});

test("WorkPackage identity follows the task definition: a changed definition is a different package, an unchanged one is the same across plan versions", () => {
  const v2same = snapshot(2, block("T-1", "One"), block("T-2", "Two", "DEPENDS_ON: T-1\n"), block("T-3", "Three"));
  const v2changed = snapshot(2, block("T-1", "One renamed"), block("T-2", "Two", "DEPENDS_ON: T-1\n"), block("T-3", "Three"));
  const id = (snap, task) => makeWorkPackage({ snapshot: snap, taskId: task, repository: REPO }).workPackageId;
  assert.equal(id(v2same, "T-2"), id(SNAP, "T-2"));
  assert.notEqual(id(v2changed, "T-1"), id(SNAP, "T-1"));
  assert.throws(() => makeWorkPackage({ snapshot: SNAP, taskId: "T-9", repository: REPO }), { code: "TASK_NOT_IN_SNAPSHOT" });
  assert.throws(() => makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: { identity: "", baseRef: "main" } }), { code: "REPOSITORY_REQUIRED" });
});

test("WorkPackageTaskSystem exposes exactly the one frozen task to the existing runtime", () => {
  const wp = makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: REPO });
  let completed = false;
  const system = new WorkPackageTaskSystem({ workPackage: wp, isCompleted: () => completed });
  const [only, ...rest] = system.listTasks();
  assert.deepEqual([rest.length, only.id, only.title, only.completed, only.specPresent, only.specReviewed], [0, "T-1", "One", false, true, true]);
  assert.equal(system.resolveNextTask().taskId, "T-1");
  completed = true;
  assert.equal(system.resolveNextTask().taskId, null);
  assert.equal(system.resolveNextTask({ additionalCompletedIds: ["T-1"] }).taskId, null);
});

// ---------- selection gate ----------
const wpRow = (taskId, status) => ({ taskId, status });
const reconciliation = (noops, conflicts = []) => ({ noops: noops.map((taskId) => ({ taskId })), conflicts: conflicts.map((taskId) => ({ taskId })) });
const gate = (over = {}) => selectNextTask({
  snapshot: SNAP, reconciliation: reconciliation(["T-1", "T-2", "T-3"]), workPackages: [], completionSyncPending: false, startupRecovered: true, ...over,
});

test("selection: first eligible task in TASK_ID order; dependents wait for REMOTE_DONE_CONFIRMED of their dependencies", () => {
  const first = gate();
  assert.equal(first.selected, "T-1");
  assert.deepEqual(first.reasons["T-2"], ["DEPENDENCY_NOT_DONE"]);
  assert.deepEqual(first.reasons["T-1"], []);
  // LOCAL_DONE is not enough
  assert.deepEqual(gate({ workPackages: [wpRow("T-1", "LOCAL_DONE")], completionSyncPending: true }).selected, null);
  const done = gate({ workPackages: [wpRow("T-1", "REMOTE_DONE_CONFIRMED")] });
  assert.equal(done.selected, "T-2");
  assert.deepEqual(done.reasons["T-1"], ["ALREADY_STARTED"]);
  assert.equal(gate({ workPackages: [wpRow("T-1", "REMOTE_DONE_CONFIRMED"), wpRow("T-2", "REMOTE_DONE_CONFIRMED")] }).selected, "T-3");
});

test("selection gate: every condition is enforced and explained with a stable reason code", () => {
  assert.deepEqual(gate({ reconciliation: reconciliation(["T-2", "T-3"]) }).reasons["T-1"], ["NOT_MATERIALIZED"]);
  assert.equal(gate({ reconciliation: reconciliation(["T-2", "T-3"]) }).selected, "T-3");
  assert.deepEqual(gate({ reconciliation: reconciliation(["T-1", "T-2", "T-3"], ["T-1"]) }).reasons["T-1"], ["UNRESOLVED_CONFLICT"]);
  assert.ok(gate({ reconciliation: reconciliation(["T-1", "T-2", "T-3"], ["T-1"]), workPackages: [wpRow("T-1", "REMOTE_DONE_CONFIRMED")] }).reasons["T-2"].includes("UNRESOLVED_CONFLICT"), "a conflict on a dependency blocks its dependents");
  assert.deepEqual(gate({ blockedTaskIds: ["T-3"] }).reasons["T-3"], ["UNRESOLVED_CONFLICT"]);
  assert.deepEqual(gate({ activeLeaseTaskIds: ["T-1"] }).reasons["T-1"], ["ACTIVE_LEASE"]);
  assert.ok(Object.values(gate({ completionSyncPending: true }).reasons).every((why) => why.includes("COMPLETION_SYNC_PENDING")));
  assert.equal(gate({ completionSyncPending: true }).selected, null);
  const stale = { ...SNAP, tasks: SNAP.tasks.map((t) => ({ ...t, planVersion: 0 })) };
  assert.ok(gate({ snapshot: stale }).reasons["T-1"].includes("SOURCE_BINDING_INVALID"));
  for (const why of Object.values(gate({ completionSyncPending: true, activeLeaseTaskIds: ["T-1"] }).reasons)) for (const code of why) assert.ok(SELECTION_REASONS.includes(code));
});

test("selection is a pure deterministic function and refuses to run before startup recovery", () => {
  assert.equal(JSON.stringify(gate()), JSON.stringify(gate()));
  assert.throws(() => gate({ startupRecovered: false }), /before startup recovery/);
  assert.throws(() => gate({ startupRecovered: undefined }), /before startup recovery/);
});

// ---------- controller store ----------
function store(t) {
  const dir = mkdtempSync(join(tmpdir(), "ctrl-store-"));
  const s = new SqliteControllerStore({ path: join(dir, "c.sqlite"), clock: () => NOW });
  t.after(() => { try { s.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  return s;
}

test("controller store: one immutable work package per task; guarded lifecycle EXECUTING -> LOCAL_DONE -> REMOTE_DONE_CONFIRMED", (t) => {
  const s = store(t);
  const wp = makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: REPO });
  assert.equal(s.createWorkPackage(wp, "LOOP-1").created, true);
  assert.equal(s.createWorkPackage(wp, "LOOP-1").created, false, "idempotent");
  const other = makeWorkPackage({ snapshot: snapshot(2, block("T-1", "One changed")), taskId: "T-1", repository: REPO });
  assert.throws(() => s.createWorkPackage(other, "LOOP-1"), { code: "WORK_PACKAGE_CONFLICT" });
  assert.deepEqual(s.inFlight().map((r) => [r.taskId, r.status, r.jiraIssueKey]), [["T-1", "EXECUTING", "LOOP-1"]]);
  assert.deepEqual(s.get("T-1").workPackage, wp);
  assert.throws(() => s.transition("T-1", "LOCAL_DONE", "REMOTE_DONE_CONFIRMED"), { code: "WORK_PACKAGE_STATE_MISMATCH" });
  assert.throws(() => s.db.prepare("UPDATE work_packages SET status = 'REMOTE_DONE_CONFIRMED' WHERE task_id = 'T-1'").run(), /invalid work package transition/, "the database itself forbids skipping LOCAL_DONE");
  assert.equal(s.transition("T-1", "EXECUTING", "LOCAL_DONE").status, "LOCAL_DONE");
  assert.deepEqual(s.inFlight().map((r) => r.status), ["LOCAL_DONE"]);
  assert.equal(s.transition("T-1", "LOCAL_DONE", "REMOTE_DONE_CONFIRMED").status, "REMOTE_DONE_CONFIRMED");
  assert.deepEqual(s.inFlight(), []);
  assert.throws(() => s.db.prepare("UPDATE work_packages SET status = 'EXECUTING' WHERE task_id = 'T-1'").run(), /invalid work package transition/, "terminal");
  assert.throws(() => s.db.prepare("UPDATE work_packages SET work_package = '{}' WHERE task_id = 'T-1'").run(), /immutable|invalid work package transition/);
  assert.throws(() => s.db.prepare("DELETE FROM work_packages").run(), /never deleted/);
});

test("controller store: BLOCKED is reachable only from started states and is terminal; notifications are de-duplicated durably", (t) => {
  const s = store(t);
  s.createWorkPackage(makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: REPO }), "LOOP-1");
  assert.equal(s.transition("T-1", "EXECUTING", "BLOCKED", { reason: "review findings" }).blockReason, "review findings");
  assert.throws(() => s.transition("T-1", "BLOCKED", "EXECUTING"), /invalid work package transition/, "terminal: the database trigger rejects leaving BLOCKED");
  assert.throws(() => s.transition("T-1", "EXECUTING", "LOCAL_DONE"), { code: "WORK_PACKAGE_STATE_MISMATCH" }, "the guarded update also checks the expected current status");
  assert.deepEqual([s.markNotified("k1", "OWNER_DECISION_REQUIRED"), s.markNotified("k1", "OWNER_DECISION_REQUIRED"), s.markNotified("k2", "AUTH_INVALID")], [true, false, true]);
});

test("controller store survives close/reopen (durable)", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctrl-store-"));
  try {
    const path = join(dir, "c.sqlite");
    const a = new SqliteControllerStore({ path, clock: () => NOW });
    a.createWorkPackage(makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: REPO }), "LOOP-1");
    a.transition("T-1", "EXECUTING", "LOCAL_DONE");
    a.markNotified("k", "AUTH_INVALID");
    a.close();
    const b = new SqliteControllerStore({ path, clock: () => NOW });
    assert.equal(b.get("T-1").status, "LOCAL_DONE");
    assert.equal(b.markNotified("k", "AUTH_INVALID"), false);
    b.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- ports ----------
test("outcome vocabulary is closed and covers the required classifications", () => {
  assert.deepEqual([...CONTROLLER_OUTCOMES].sort(), ["BLOCK_GLOBAL", "BLOCK_TASK", "COMPLETED", "CONTINUE", "IDLE", "OWNER_DECISION_REQUIRED", "RETRY_EXTERNAL", "WAIT_CI", "WAIT_JIRA", "WAIT_REVIEW", "WAIT_SOURCE"]);
  assert.ok(WAITING_OUTCOMES.every((o) => CONTROLLER_OUTCOMES.includes(o)));
  assert.ok(["OWNER_DECISION_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN", "PERSISTENT_SOURCE_FAILURE", "UNRECOVERABLE_CONFLICT", "RETRY_EXHAUSTED", "REVIEW_OR_VALIDATION_FAILURE"].every((k) => NOTIFY_KINDS.includes(k)));
});

test("NotifierPort: null notifier works, fake notifier records, base class is abstract", async () => {
  assert.deepEqual(await new NullNotifier().notify({ kind: "AUTH_INVALID" }), { delivered: false });
  const fake = new FakeNotifier();
  await fake.notify({ kind: "AUTH_INVALID", dedupeKey: "k", taskId: null, detail: "d", at: NOW });
  assert.equal(fake.events.length, 1);
  await assert.rejects(new NotifierPort().notify({}), /not implemented/);
});

test("AgentExecutor boundary: abstract base, strict structured result, deterministic fake that never touches a model", async () => {
  await assert.rejects(new AgentExecutor().execute({}), /not implemented/);
  const good = { head: "a".repeat(40), base: "b".repeat(40), branch: "x", authorId: "a@example.invalid", changedFiles: ["f"] };
  assert.deepEqual({ ...validateAgentResult(good) }, { ...good });
  for (const bad of [null, {}, { ...good, head: "short" }, { ...good, base: 7 }, { ...good, branch: "" }, { ...good, changedFiles: "f" }]) assert.throws(() => validateAgentResult(bad), { code: "AGENT_RESULT_INVALID" });
  const agent = new SyntheticAgentExecutor();
  const wp = makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: REPO });
  const a = await agent.execute(wp);
  const b = await new SyntheticAgentExecutor().execute(wp);
  assert.deepEqual(a, b, "deterministic");
  assert.deepEqual(Object.keys(validateAgentResult(a)).sort(), ["authorId", "base", "branch", "changedFiles", "head"]);
  assert.equal(agent.modelCalls, 0);
});

test("synthetic lifecycle persists facts across instances (what a restarted process observes)", () => {
  const dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  try {
    const wp = makeWorkPackage({ snapshot: SNAP, taskId: "T-1", repository: REPO });
    const first = new SyntheticLifecycle({ directory: dir }).scope(wp);
    assert.equal(first.gitProvider.getRevision(), null);
    first.actions.recordImplementation({ head: "c".repeat(40), base: "b".repeat(40), branch: "br", authorId: "a", changedFiles: [] });
    first.actions.runTests();
    const second = new SyntheticLifecycle({ directory: dir }).scope(wp);
    assert.equal(second.gitProvider.getRevision().head, "c".repeat(40));
    assert.equal(second.ciProvider.getCIResult("c".repeat(40)).status, "PASS");
    assert.equal(second.isCompleted(), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- zero model tokens ----------
test("CONTROL PLANE TOKEN BUDGET: no controller/plan/reconcile/outbox source references a model client, randomness or an LLM", () => {
  const files = [
    ...readdirSync(new URL("../src/controller/", import.meta.url)).map((f) => `../src/controller/${f}`),
    "../src/adapters/sqlite-controller-store.js", "../src/adapters/sqlite-outbox-store.js", "../src/adapters/jira-outbox-executor.js",
    "../src/plan/plan-compiler.js", "../src/plan/plan-source-sync.js", "../src/reconcile/plan-reconciler.js", "../src/materialize/jira-materialization.js",
    "../bin/loop-controller.js", "../src/testing/synthetic-profile.js",
  ];
  for (const file of files) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
    assert.ok(!/anthropic|openai|\bllm\b|claude|codex|hermes|Math\.random|completion\(|chat\.completions|messages\.create/i.test(text), `${file} must not reference a model`);
  }
  assert.ok(files.length > 10);
});
