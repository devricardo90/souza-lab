import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { OUTBOX_TRANSITIONS, SqliteOutboxStore, deriveOperationId } from "../src/adapters/sqlite-outbox-store.js";

const WORKER = fileURLToPath(new URL("./helpers/outbox-worker.js", import.meta.url));
const T0 = "2026-09-30T10:00:00.000Z";
const at = (ms) => new Date(Date.parse(T0) + ms).toISOString();

// One after-hook: close every store opened for the test, THEN remove the directory (Windows cannot delete an open database).
const OPENED = new Map(); // db path -> stores opened for it
function tempDb(t) {
  const dir = mkdtempSync(join(tmpdir(), "outbox-store-"));
  const opened = [];
  OPENED.set(join(dir, "outbox.sqlite"), opened);
  t.after(() => {
    for (const store of opened) { try { store.close(); } catch {} }
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "outbox.sqlite");
  return path;
}
function open(path, options = {}) {
  const store = new SqliteOutboxStore({ path, ...options });
  OPENED.get(path).push(store);
  return store;
}
const spec = (over = {}) => ({
  operationId: deriveOperationId("JIRA_COMMENT", { issueKey: "LOOP-1", executionId: "e1", kind: "started" }),
  action: "JIRA_COMMENT", targetObject: "LOOP-1", taskId: "LOOP-1", executionId: "e1", sourceRevision: "rev1", head: "abc",
  expectedPreviousState: { markerAbsent: "m" }, desiredState: { kind: "started", marker: "m" }, ...over,
});

test("SQLite configuration: WAL, synchronous FULL, busy timeout, foreign keys", (t) => {
  const store = open(tempDb(t));
  assert.deepEqual(store.configuration(), { journalMode: "wal", synchronous: 2, busyTimeoutMs: 10000, foreignKeys: 1 });
});

test("deriveOperationId is deterministic, key-order independent, and distinct per identity", () => {
  const a = deriveOperationId("JIRA_TRANSITION", { issueKey: "L-1", executionId: "e", doneStatusName: "Done" });
  assert.equal(a, deriveOperationId("JIRA_TRANSITION", { doneStatusName: "Done", executionId: "e", issueKey: "L-1" }));
  assert.notEqual(a, deriveOperationId("JIRA_TRANSITION", { issueKey: "L-2", executionId: "e", doneStatusName: "Done" }));
  assert.notEqual(a, deriveOperationId("JIRA_COMMENT", { issueKey: "L-1", executionId: "e", doneStatusName: "Done" }));
  assert.throws(() => deriveOperationId("NOPE", {}), { code: "INVALID_ACTION" });
});

test("idempotent enqueue: the same operation_id resolves to one row; a different payload under the same id is rejected", (t) => {
  const store = open(tempDb(t), { clock: () => T0 });
  const first = store.enqueue(spec());
  const second = store.enqueue(spec());
  assert.deepEqual([first.created, second.created], [true, false]);
  assert.equal(store.list().length, 1);
  assert.equal(first.operation.status, "PENDING");
  assert.equal(first.operation.attemptCount, 0);
  assert.throws(() => store.enqueue(spec({ desiredState: { kind: "started", marker: "DIFFERENT" } })), { code: "OPERATION_ID_CONFLICT" });
  // the database boundary itself rejects a raw duplicate primary key
  assert.throws(() => store.db.prepare(`INSERT INTO outbox_operations (operation_id,target_system,target_object,action,task_id,desired_state,payload_digest,status,created_at,updated_at)
    VALUES (?, 'JIRA','x','JIRA_COMMENT','x','{}','d','PENDING','a','a')`).run(spec().operationId), /constraint|UNIQUE|PRIMARY/i);
});

test("database constraints reject bad rows", (t) => {
  const store = open(tempDb(t), { clock: () => T0 });
  const insert = (over) => {
    const row = { id: "x", sys: "JIRA", action: "JIRA_COMMENT", desired: "{}", status: "PENDING", attempts: 0, ...over };
    return store.db.prepare(`INSERT INTO outbox_operations (operation_id,target_system,target_object,action,task_id,desired_state,payload_digest,status,attempt_count,created_at,updated_at)
      VALUES (?,?,'o',?,'t',?,'d',?,?,'a','a')`).run(row.id, row.sys, row.action, row.desired, row.status, row.attempts);
  };
  const rejected = /constraint|created PENDING/i;
  assert.throws(() => insert({ sys: "GOOGLE" }), rejected);
  assert.throws(() => insert({ action: "DROP_TABLE" }), rejected);
  assert.throws(() => insert({ desired: "not json" }), rejected);
  assert.throws(() => insert({ status: "BOGUS" }), rejected);
  assert.throws(() => insert({ status: "CONFIRMED" }), /created PENDING/);
  assert.throws(() => insert({ attempts: -1 }), /constraint|created PENDING/i);
});

test("state machine: every allowed transition works, every other one fails closed at the database", (t) => {
  const store = open(tempDb(t), { clock: () => T0 });
  const states = Object.keys(OUTBOX_TRANSITIONS);
  let n = 0;
  // Build one row in each source state through legal paths, then attempt every target by raw SQL.
  const makeIn = (state) => {
    const id = `op-${n++}`;
    store.enqueue(spec({ operationId: id, desiredState: { n } }));
    if (state === "PENDING") return id;
    const claim = store.acquire(id, { workerId: "w", now: T0 });
    const c = { workerId: "w", claimToken: claim.operation.claimToken };
    if (state === "IN_FLIGHT") return id;
    store.settle(id, c, { to: state, nextRetryAt: state === "RETRY_WAIT" ? at(1000) : null, now: T0 });
    return id;
  };
  for (const from of states) {
    for (const to of states) {
      const id = makeIn(from);
      const allowed = OUTBOX_TRANSITIONS[from].includes(to);
      const attempt = () => store.db.prepare("UPDATE outbox_operations SET status = ?, claimed_by = 'w', claim_expires_at = 'z', next_retry_at = 'z', claim_token = claim_token + 1 WHERE operation_id = ?").run(to, id);
      if (allowed) attempt(); else assert.throws(attempt, /invalid state transition/, `${from} -> ${to} must be rejected`);
    }
  }
});

test("terminal states are immutable, identity is immutable, operations are never deleted", (t) => {
  const store = open(tempDb(t), { clock: () => T0 });
  store.enqueue(spec());
  const id = spec().operationId;
  const claim = store.acquire(id, { workerId: "w", now: T0 });
  store.settle(id, { workerId: "w", claimToken: claim.operation.claimToken }, { to: "CONFIRMED", now: T0 });
  assert.throws(() => store.db.prepare("UPDATE outbox_operations SET last_error_code = 'x' WHERE operation_id = ?").run(id), /invalid state transition/);
  assert.throws(() => store.db.prepare("UPDATE outbox_operations SET desired_state = '{}' WHERE operation_id = ?").run(id), /immutable|invalid state transition/);
  assert.throws(() => store.db.prepare("DELETE FROM outbox_operations WHERE operation_id = ?").run(id), /never deleted/);
  assert.equal(store.acquire(id, { workerId: "other", now: at(10_000_000) }), null, "a CONFIRMED operation can never be claimed again");
});

test("atomic claim: one winner; fencing token and claimed_by guard every settle", (t) => {
  const store = open(tempDb(t), { clock: () => T0 });
  store.enqueue(spec());
  const id = spec().operationId;
  const a = store.acquire(id, { workerId: "A", ttlMs: 1000, now: T0 });
  assert.equal(a.operation.claimToken, 1);
  assert.equal(a.operation.attemptCount, 1);
  assert.equal(store.acquire(id, { workerId: "B", ttlMs: 1000, now: at(500) }), null, "a live claim cannot be taken");
  // A's claim expires; B takes over with a higher token and does NOT consume an attempt
  const b = store.acquire(id, { workerId: "B", ttlMs: 1000, now: at(1001) });
  assert.equal(b.recovered, true);
  assert.equal(b.operation.claimToken, 2);
  assert.equal(b.operation.attemptCount, 1);
  assert.throws(() => store.assertClaim(id, { workerId: "A", claimToken: 1 }, at(1002)), { code: "CLAIM_LOST" });
  assert.throws(() => store.settle(id, { workerId: "A", claimToken: 1 }, { to: "CONFIRMED", now: at(1002) }), { code: "CLAIM_LOST" });
  assert.equal(store.get(id).status, "IN_FLIGHT", "a fenced-out worker must change nothing");
  assert.equal(store.settle(id, { workerId: "B", claimToken: 2 }, { to: "CONFIRMED", now: at(1003) }).status, "CONFIRMED");
});

test("RETRY_WAIT is claimable only when due; settle validates targets", (t) => {
  const store = open(tempDb(t), { clock: () => T0 });
  store.enqueue(spec());
  const id = spec().operationId;
  const c = store.acquire(id, { workerId: "A", now: T0 }).operation;
  assert.throws(() => store.settle(id, { workerId: "A", claimToken: c.claimToken }, { to: "RETRY_WAIT", now: T0 }), { code: "INVALID_TRANSITION" });
  assert.throws(() => store.settle(id, { workerId: "A", claimToken: c.claimToken }, { to: "PENDING", now: T0 }), { code: "INVALID_TRANSITION" });
  store.settle(id, { workerId: "A", claimToken: c.claimToken }, { to: "RETRY_WAIT", nextRetryAt: at(5000), errorCode: "RATE_LIMITED", now: T0 });
  assert.equal(store.acquire(id, { workerId: "B", now: at(4999) }), null);
  assert.deepEqual(store.listRunnable(at(4999)).map((o) => o.operationId), []);
  assert.deepEqual(store.listRunnable(at(5000)).map((o) => o.operationId), [id]);
  const again = store.acquire(id, { workerId: "B", now: at(5000) });
  assert.equal(again.operation.attemptCount, 2);
  assert.equal(again.recovered, false);
});

test("database recovery: clean close/reopen preserves pending and confirmed operations", (t) => {
  const path = tempDb(t);
  let store = open(path, { clock: () => T0 });
  store.enqueue(spec());
  store.enqueue(spec({ operationId: "second", desiredState: { kind: "pr" } }));
  const claim = store.acquire("second", { workerId: "w", now: T0 });
  store.settle("second", { workerId: "w", claimToken: claim.operation.claimToken }, { to: "CONFIRMED", now: T0 });
  store.close();
  store = open(path, { clock: () => T0 });
  assert.equal(store.get(spec().operationId).status, "PENDING");
  assert.equal(store.get("second").status, "CONFIRMED");
  assert.throws(() => store.enqueue(spec({ operationId: "second", desiredState: { kind: "pr" }, taskId: "OTHER" })), { code: "OPERATION_ID_CONFLICT" });
  assert.equal(store.enqueue(spec({ operationId: "second", desiredState: { kind: "pr" } })).created, false);
});

function runWorker(config, { killWhen } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", WORKER, JSON.stringify(config)], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk;
      if (killWhen && out.includes(killWhen)) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal, out: out.trim() }));
  });
}

test("unclean process termination: a committed row survives; an uncommitted transaction never appears; the database stays usable", async (t) => {
  const path = tempDb(t);
  const seed = open(path, { clock: () => T0 });
  seed.enqueue(spec());
  seed.close();
  const crashed = await runWorker({ command: "uncommitted-tx", dbPath: path }, { killWhen: "READY" });
  assert.ok(crashed.signal || crashed.code !== 0, "the worker must have died uncleanly");
  const store = open(path, { clock: () => T0 });
  assert.equal(store.get(spec().operationId).status, "PENDING", "committed transaction survives the crash");
  assert.equal(store.get("uncommitted-op"), null, "uncommitted transaction must not appear committed");
  assert.equal(store.list().length, 1);
  assert.equal(store.enqueue(spec({ operationId: "after-crash", desiredState: { x: 1 } })).created, true, "database stays writable after the crash");
  assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});
