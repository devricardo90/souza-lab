import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor, jiraCommentOperation, jiraTransitionOperation } from "../src/adapters/jira-outbox-executor.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";

/**
 * CP-02: durable outbox + Jira (local mock only; SYNTHETIC evidence, never real Jira).
 * Crash proofs use REAL child processes that are terminated abruptly (SIGKILL/TerminateProcess).
 */
const HELPERS = "./helpers/";
const MOCK = fileURLToPath(new URL(`${HELPERS}jira-mock-server.js`, import.meta.url));
const WORKER = fileURLToPath(new URL(`${HELPERS}outbox-worker.js`, import.meta.url));
const leased = { assertLeaseCurrent: async () => true };

let server; let port; let dir; let dbPath; const opened = [];

before(async () => {
  server = spawn(process.execPath, [MOCK], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.stdout.once("data", (chunk) => resolve(Number(/PORT=(\d+)/.exec(String(chunk))[1])));
  });
});
after(() => server.kill());
beforeEach(async () => {
  for (const store of opened.splice(0)) { try { store.close(); } catch {} }
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = mkdtempSync(join(tmpdir(), "jira-outbox-"));
  dbPath = join(dir, "outbox.sqlite");
  await control({ reset: true });
});
after(() => { for (const store of opened.splice(0)) { try { store.close(); } catch {} } if (dir) rmSync(dir, { recursive: true, force: true }); });

const control = (payload) => fetch(`http://127.0.0.1:${port}/__control`, { method: "POST", body: JSON.stringify(payload), headers: { connection: "close" } }).then((r) => r.json());
const override = (o) => control({ override: o });
const requestLog = () => fetch(`http://127.0.0.1:${port}/__log`, { headers: { connection: "close" } }).then((r) => r.json());
const posts = async (pathPart) => (await requestLog()).filter((e) => e.method === "POST" && e.path.includes(pathPart)).length;

const openStore = (clock) => { const s = new SqliteOutboxStore({ path: dbPath, ...(clock ? { clock } : {}) }); opened.push(s); return s; };
const jiraClient = () => new JiraSyncClient({ site: `127.0.0.1:${port}`, scheme: "http", email: "t@example.invalid", apiToken: "outbox-test-token-0123456789", timeoutMs: 1500 });
function executor({ store = openStore(), workerId = "w-main", clock, ...rest } = {}) {
  return new JiraOutboxExecutor({ store, jira: jiraClient(), workerId, ...(clock ? { clock } : {}), ...rest });
}
const comment = { issueKey: "LOOP-1", executionId: "exec-1", kind: "started", body: "Loop execution exec-1 started." };
const transition = { issueKey: "LOOP-1", executionId: "exec-1", doneStatusName: "Done", transitionName: "Done", expectedCurrentStatusNames: ["In Progress"] };

function runWorker(config, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", WORKER, JSON.stringify({ dbPath, port, ...config })], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("worker timed out")); }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, died: signal !== null || code !== 0, out: out.trim() }); });
  });
}
const json = (run) => JSON.parse(run.out);

test("happy path: PENDING -> claim -> reconcile -> write -> read-after-write -> CONFIRMED (comment and transition)", async () => {
  const exec = executor();
  const c = exec.enqueueComment(comment);
  const t = exec.enqueueTransition(transition);
  assert.deepEqual([c.created, t.created], [true, true]);
  const results = await exec.recover();
  assert.deepEqual(results.map((r) => r.outcome), ["CONFIRMED", "CONFIRMED"]);
  assert.equal(await posts("/comment"), 1);
  assert.equal(await posts("/transitions"), 1);
  assert.deepEqual(exec.store.list().map((o) => [o.status, o.attemptCount]), [["CONFIRMED", 1], ["CONFIRMED", 1]]);
});

test("idempotent enqueue: the same logical operation twice is one row and one Jira mutation", async () => {
  const exec = executor();
  assert.equal(exec.enqueueComment(comment).created, true);
  assert.equal(exec.enqueueComment({ ...comment }).created, false);
  assert.equal(exec.store.list().length, 1);
  await exec.process(jiraCommentOperation(comment).operationId);
  const again = await exec.process(jiraCommentOperation(comment).operationId);
  assert.equal(again.owned, false, "a CONFIRMED operation is never executed twice");
  assert.equal(await posts("/comment"), 1);
});

test("reserved Jira capabilities have identities but no implementation (fail closed)", async () => {
  const exec = executor();
  const operationId = "JIRA_CREATE:reserved";
  exec.store.enqueue({ operationId, action: "JIRA_CREATE", targetObject: "LOOP", taskId: "LOOP-1", desiredState: { summary: "x" } });
  const result = await exec.process(operationId);
  assert.equal(result.outcome, "FAILED_PERMANENT");
  assert.equal(result.operation.lastErrorCode, "ACTION_NOT_IMPLEMENTED");
  assert.equal((await requestLog()).length, 0);
});

test("CRASH TEST A: PENDING persisted -> process killed -> restart recovers it -> executed once -> CONFIRMED", async () => {
  const enqueueRun = await runWorker({ command: "enqueue", workerId: "w-a1", op: { type: "comment", input: comment } });
  assert.equal(json(enqueueRun).created, true);
  // the process that persisted the intent dies immediately after; nothing else ran
  const dead = await runWorker({ command: "process", workerId: "w-a2", operationId: jiraCommentOperation(comment).operationId, crashAt: "afterClaim" });
  assert.ok(dead.died, "claiming worker must be dead");
  // that worker claimed then died => IN_FLIGHT; also prove a never-claimed PENDING op recovers
  const pendingOnly = { ...comment, kind: "pr", body: "Loop execution exec-1 opened pr." };
  assert.equal(json(await runWorker({ command: "enqueue", workerId: "w-a3", op: { type: "comment", input: pendingOnly } })).created, true);
  const store = openStore();
  assert.equal(store.get(jiraCommentOperation(pendingOnly).operationId).status, "PENDING");
  const restart = await runWorker({ command: "recover", workerId: "w-a4", claimTtlMs: 120000 });
  assert.equal(restart.died, false);
  const byStatus = Object.fromEntries(store.list().map((o) => [o.desiredState.kind, o.status]));
  assert.equal(byStatus.pr, "CONFIRMED", "the PENDING operation is recovered and executed");
  assert.equal(await posts("/comment"), 1, "only the recovered PENDING operation wrote (the other claim is still live)");
});

test("CRASH TEST B (critical): IN_FLIGHT, remote applied, process killed before CONFIRMED -> restart reconciles -> CONFIRMED with ZERO duplicate writes", async () => {
  const operationId = jiraCommentOperation(comment).operationId;
  await runWorker({ command: "enqueue", workerId: "w-b0", op: { type: "comment", input: comment } });
  const crashed = await runWorker({ command: "process", workerId: "w-b1", operationId, claimTtlMs: 3000, crashAt: "afterRemoteWrite" });
  assert.ok(crashed.died, "worker must have been killed after the remote write");
  assert.equal(await posts("/comment"), 1, "the mutation reached Jira");
  const store = openStore();
  assert.equal(store.get(operationId).status, "IN_FLIGHT", "local state never learned of the write");
  await new Promise((resolve) => setTimeout(resolve, 3100)); // claim expires
  const restart = await runWorker({ command: "recover", workerId: "w-b2" });
  assert.equal(restart.died, false);
  assert.deepEqual(json(restart).map((r) => [r.outcome, r.recovered]), [["CONFIRMED", true]]);
  const op = store.get(operationId);
  assert.equal(op.status, "CONFIRMED");
  assert.match(op.lastErrorDetail, /already present/);
  assert.equal(await posts("/comment"), 1, "reconciliation found the remote mutation; no duplicate write");
  assert.equal((await (await fetch(`http://127.0.0.1:${port}/__log`, { headers: { connection: "close" } })).json()).filter((e) => e.method === "GET" && e.path.includes("/comment")).length >= 2, true, "remote state was read before deciding");
});

test("CRASH TEST B2: the same crash for a Jira transition reconciles by status, no second transition", async () => {
  const operationId = jiraTransitionOperation(transition).operationId;
  await runWorker({ command: "enqueue", workerId: "w-b20", op: { type: "transition", input: transition } });
  const crashed = await runWorker({ command: "process", workerId: "w-b21", operationId, claimTtlMs: 3000, crashAt: "afterRemoteWrite" });
  assert.ok(crashed.died);
  assert.equal(await posts("/transitions"), 1);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const restart = await runWorker({ command: "recover", workerId: "w-b22" });
  assert.deepEqual(json(restart).map((r) => r.outcome), ["CONFIRMED"]);
  assert.equal(openStore().get(operationId).status, "CONFIRMED");
  assert.equal(await posts("/transitions"), 1);
});

test("CRASH TEST C: IN_FLIGHT, killed BEFORE the remote write -> restart reconciles (not applied) -> controlled retry -> exactly one mutation", async () => {
  const operationId = jiraCommentOperation(comment).operationId;
  await runWorker({ command: "enqueue", workerId: "w-c0", op: { type: "comment", input: comment } });
  const crashed = await runWorker({ command: "process", workerId: "w-c1", operationId, claimTtlMs: 2500, crashAt: "beforeRemoteWrite" });
  assert.ok(crashed.died);
  assert.equal(await posts("/comment"), 0, "nothing reached Jira");
  const store = openStore();
  assert.equal(store.get(operationId).status, "IN_FLIGHT");
  // a recoverer arriving while the dead worker's claim is still live must NOT act
  assert.equal(store.acquire(operationId, { workerId: "w-c2" }), null, "a dead worker's claim stays authoritative until it expires");
  assert.equal(await posts("/comment"), 0);
  await new Promise((resolve) => setTimeout(resolve, 2600));
  const restart = await runWorker({ command: "recover", workerId: "w-c3" });
  assert.deepEqual(json(restart).map((r) => [r.outcome, r.recovered]), [["CONFIRMED", true]]);
  assert.equal(store.get(operationId).status, "CONFIRMED");
  assert.equal(await posts("/comment"), 1, "exactly one mutation");
});

test("MULTI-PROCESS CONCURRENCY: 8 workers race to claim one operation -> one claim, one Jira mutation, one CONFIRMED", async () => {
  const operationId = jiraCommentOperation(comment).operationId;
  await runWorker({ command: "enqueue", workerId: "w-x0", op: { type: "comment", input: comment } });
  const startAt = Date.now() + 1500;
  const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => runWorker({ command: "process", workerId: `w-race-${i}`, operationId, startAt, sleepBeforeWriteMs: 400 })));
  const results = runs.map((r) => json(r));
  assert.equal(results.filter((r) => r.owned).length, 1, JSON.stringify(results));
  assert.equal(results.filter((r) => !r.owned).length, 7);
  assert.equal(results.find((r) => r.owned).outcome, "CONFIRMED");
  assert.equal(await posts("/comment"), 1, "exactly one external mutation");
  const store = openStore();
  assert.deepEqual(store.list().map((o) => [o.status, o.attemptCount]), [["CONFIRMED", 1]]);
});

test("MULTI-PROCESS stale takeover: racing recoverers of an expired IN_FLIGHT op -> exactly one takes over, no duplicate", async () => {
  const operationId = jiraCommentOperation(comment).operationId;
  await runWorker({ command: "enqueue", workerId: "w-y0", op: { type: "comment", input: comment } });
  const crashed = await runWorker({ command: "process", workerId: "w-y1", operationId, claimTtlMs: 3000, crashAt: "afterRemoteWrite" });
  assert.ok(crashed.died);
  await new Promise((resolve) => setTimeout(resolve, 3100));
  const startAt = Date.now() + 1500;
  const runs = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker({ command: "process", workerId: `w-take-${i}`, operationId, startAt })));
  const results = runs.map((r) => json(r));
  assert.equal(results.filter((r) => r.owned).length, 1, JSON.stringify(results));
  assert.equal(await posts("/comment"), 1);
  assert.equal(openStore().get(operationId).status, "CONFIRMED");
});

test("a fenced-out worker (claim taken over) cannot write or settle", async () => {
  const store = openStore();
  const slow = executor({ store, workerId: "slow", claimTtlMs: 50, faultPoints: { beforeRemoteWrite: () => new Promise((r) => setTimeout(r, 200)) } });
  slow.enqueueComment(comment);
  const operationId = jiraCommentOperation(comment).operationId;
  const slowRun = slow.process(operationId);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const taker = executor({ store, workerId: "taker" });
  const takeover = await taker.process(operationId);
  assert.equal(takeover.outcome, "CONFIRMED");
  const slowResult = await slowRun;
  assert.equal(slowResult.owned, false);
  assert.equal(slowResult.outcome, "CLAIM_LOST");
  assert.equal(await posts("/comment"), 1, "the fenced-out worker never reached the write");
});

test("UNCERTAIN write (POST ok, state wrong) -> RETRY_WAIT, never an immediate re-write; later remote state reconciles to CONFIRMED with no extra POST", async () => {
  let now = Date.parse("2026-09-30T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const store = openStore(clock);
  const exec = executor({ store, clock });
  exec.enqueueTransition(transition);
  const operationId = jiraTransitionOperation(transition).operationId;
  await control({ postNoop: true });
  const first = await exec.process(operationId);
  assert.equal(first.outcome, "RETRY_WAIT");
  assert.equal(first.operation.lastErrorCode, "UNCERTAIN_WRITE");
  assert.equal(await posts("/transitions"), 1);
  // not yet due: no worker may touch it, so no blind retry
  assert.equal((await exec.process(operationId)).owned, false);
  assert.equal(await posts("/transitions"), 1);
  // Jira's state converges (eventual consistency): the retry must reconcile first and find it applied
  await control({ setStatus: "Done" });
  now += 10 * 60_000;
  const second = await exec.process(operationId);
  assert.equal(second.outcome, "CONFIRMED");
  assert.equal(await posts("/transitions"), 1, "reconciliation, not a second POST, resolved the uncertainty");
});

test("UNCERTAIN then genuinely not applied: reconcile proves it, then exactly one controlled retry", async () => {
  let now = Date.parse("2026-09-30T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const exec = executor({ store: openStore(clock), clock });
  exec.enqueueTransition(transition);
  const operationId = jiraTransitionOperation(transition).operationId;
  await control({ postNoop: true });
  assert.equal((await exec.process(operationId)).outcome, "RETRY_WAIT");
  await control({ postNoop: false });
  now += 10 * 60_000;
  assert.equal((await exec.process(operationId)).outcome, "CONFIRMED");
  assert.equal(await posts("/transitions"), 2, "one failed-to-apply write, one successful retry");
});

test("lost comment response (applied, then connection reset) -> RETRY_WAIT -> reconcile finds the marker -> CONFIRMED, no duplicate", async () => {
  let now = Date.parse("2026-09-30T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const exec = executor({ store: openStore(clock), clock });
  exec.enqueueComment(comment);
  const operationId = jiraCommentOperation(comment).operationId;
  await override({ method: "POST", pathIncludes: "/comment", fault: "applyThenReset" });
  const first = await exec.process(operationId);
  assert.equal(first.outcome, "RETRY_WAIT");
  assert.equal(first.operation.lastErrorCode, "TRANSIENT_NETWORK_FAILURE");
  now += 10 * 60_000;
  assert.equal((await exec.process(operationId)).outcome, "CONFIRMED");
  assert.equal(await posts("/comment"), 1);
});

const MAPPING = [
  ["401", { status: 401, body: {} }, "FAILED_PERMANENT", "AUTH_INVALID"],
  ["403", { status: 403, body: {} }, "FAILED_PERMANENT", "AUTH_FORBIDDEN"],
  ["429", { status: 429, body: {}, headers: { "Retry-After": "900" } }, "RETRY_WAIT", "RATE_LIMITED"],
  ["503", { status: 503, body: {} }, "RETRY_WAIT", "JIRA_UNAVAILABLE"],
  ["reset", { fault: "reset" }, "RETRY_WAIT", "TRANSIENT_NETWORK_FAILURE"],
  ["409", { status: 409, body: {} }, "CONFLICT", "STALE_STATE"],
  ["400", { status: 400, body: {} }, "FAILED_PERMANENT", "REQUEST_REJECTED"],
  ["404", { status: 404, body: {} }, "FAILED_PERMANENT", "ISSUE_NOT_FOUND"],
];
for (const [name, response, status, code] of MAPPING) {
  test(`error mapping: Jira ${name} -> outbox ${status} (${code})`, async () => {
    const clock = () => "2026-09-30T10:00:00.000Z";
    const exec = executor({ store: openStore(clock), clock });
    exec.enqueueComment(comment);
    await override({ method: "GET", pathIncludes: "/comment", ...response });
    const result = await exec.process(jiraCommentOperation(comment).operationId);
    assert.equal(result.outcome, status);
    assert.equal(result.operation.lastErrorCode, code);
    if (code === "AUTH_INVALID" || code === "AUTH_FORBIDDEN") assert.equal(result.globalBlock, true);
    if (code === "RATE_LIMITED") assert.ok(result.operation.nextRetryAt >= "2026-09-30T10:15:00.000Z", "Retry-After is honoured as a floor");
    if (status === "RETRY_WAIT") assert.ok(result.operation.nextRetryAt > "2026-09-30T10:00:00.000Z");
    assert.equal(await posts("/comment"), 0, "a failed reconcile read never triggers a write");
  });
}

test("a stale/conflicting remote state is CONFLICT and nothing is written", async () => {
  const exec = executor();
  exec.enqueueTransition({ ...transition, expectedCurrentStatusNames: ["To Do"] });
  const result = await exec.process(jiraTransitionOperation({ ...transition, expectedCurrentStatusNames: ["To Do"] }).operationId);
  assert.equal(result.outcome, "CONFLICT");
  assert.equal(await posts("/transitions"), 0);
});

test("retries exhaust deterministically into FAILED_PERMANENT; recover() stops at a global auth block", async () => {
  let now = Date.parse("2026-09-30T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const store = openStore(clock);
  const exec = executor({ store, clock });
  exec.enqueueComment(comment);
  const id = jiraCommentOperation(comment).operationId;
  for (let i = 0; i < 6 && store.get(id).status !== "FAILED_PERMANENT"; i += 1) {
    await override({ method: "GET", pathIncludes: "/comment", status: 503, body: {} });
    await exec.process(id);
    now += 24 * 3600_000;
  }
  assert.equal(store.get(id).status, "FAILED_PERMANENT");
  assert.equal(store.get(id).lastErrorCode, "RETRIES_EXHAUSTED");

  exec.enqueueComment({ ...comment, kind: "pr", body: "pr" });
  exec.enqueueComment({ ...comment, kind: "merge", body: "merge" });
  await override({ method: "GET", pathIncludes: "/comment", status: 401, body: {} });
  const results = await exec.recover();
  assert.equal(results.length, 1, "recover() must stop after a global auth block instead of hammering Jira");
  assert.equal(store.list({ status: "PENDING" }).length, 1);
});

test("control logic is deterministic: outbox/executor sources import no LLM or network client", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/adapters/sqlite-outbox-store.js", "../src/adapters/jira-outbox-executor.js"]) {
    const text = readFileSync(fileURLToPath(new URL(file, import.meta.url)), "utf8");
    assert.ok(!/anthropic|openai|fetch\(|llm|claude/i.test(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "")), `${file} must not call any model`);
  }
});
