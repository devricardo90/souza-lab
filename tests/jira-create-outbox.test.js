import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../src/adapters/jira-outbox-executor.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { encodeLoopDescription, decodeLoopDescription } from "../src/reconcile/jira-adf.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";
import { buildMaterializationOperations } from "../src/materialize/jira-materialization.js";

/**
 * CP-04B: plan -> reconcile -> JIRA_CREATE operation -> SQLite outbox -> Jira write -> read-after-write
 * -> CONFIRMED -> reconcile again -> NOOP. Local Jira mock only (SYNTHETIC evidence, never real Jira).
 * Crash/concurrency proofs use real child processes.
 */
const MOCK = fileURLToPath(new URL("./helpers/jira-mock-server.js", import.meta.url));
const WORKER = fileURLToPath(new URL("./helpers/outbox-worker.js", import.meta.url));
const NOW = "2026-09-30T20:00:00.000Z";
const CONFIG = { projectKey: "LOOP", issueTypeName: "Task" };

let server; let port; let dir; let dbPath; const opened = [];
before(async () => {
  server = spawn(process.execPath, [MOCK], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise((resolve, reject) => { server.once("error", reject); server.stdout.once("data", (c) => resolve(Number(/PORT=(\d+)/.exec(String(c))[1]))); });
});
const cleanup = () => { for (const s of opened.splice(0)) { try { s.close(); } catch {} } if (dir) rmSync(dir, { recursive: true, force: true }); };
after(() => { server.kill(); cleanup(); });
beforeEach(async () => {
  cleanup();
  dir = mkdtempSync(join(tmpdir(), "jira-create-"));
  dbPath = join(dir, "outbox.sqlite");
  await control({ reset: true, legacySearch: false });
});

const control = (payload) => fetch(`http://127.0.0.1:${port}/__control`, { method: "POST", body: JSON.stringify(payload), headers: { connection: "close" } }).then((r) => r.json());
const override = (o) => control({ override: o });
const requestLog = () => fetch(`http://127.0.0.1:${port}/__log`, { headers: { connection: "close" } }).then((r) => r.json());
const createPosts = async () => (await requestLog()).filter((e) => e.method === "POST" && /\/rest\/api\/3\/issue$/.test(e.path)).length;
const remoteIssues = async () => (await (await fetch(`http://127.0.0.1:${port}/rest/api/3/search?maxResults=100`, { headers: { connection: "close" } })).json()).issues;

const openStore = (clock) => { const s = new SqliteOutboxStore({ path: dbPath, ...(clock ? { clock } : {}) }); opened.push(s); return s; };
const jiraClient = () => new JiraSyncClient({ site: `127.0.0.1:${port}`, scheme: "http", email: "t@example.invalid", apiToken: "create-test-token-0123456789", timeoutMs: 2500 });
const executor = ({ store = openStore(), workerId = "w-main", clock, ...rest } = {}) => new JiraOutboxExecutor({ store, jira: jiraClient(), workerId, ...(clock ? { clock } : {}), ...rest });
const steppingClock = () => { let now = Date.parse(NOW); return { clock: () => new Date(now).toISOString(), advance: (ms) => { now += ms; } }; };

const block = (id, title, extra = "") => `TASK_ID: ${id}\nTITLE: ${title}\n${extra}AC:\n- AC-001: ${title} works\n- AC-002: and is verified\n`;
const snapshot = (version, ...blocks) => makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan(`LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: ${version}\n${blocks.join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`), fetchedAt: NOW, compiledAt: NOW });
const SNAP = snapshot(1, block("RT-1", "Alpha"));
const observe = () => normalizeJiraObservation(jiraClient().observeProject("LOOP"));
const reconcile = (snap = SNAP) => reconcilePlan({ snapshot: snap, observation: observe(), createdAt: NOW });
const opsFor = (snap = SNAP) => buildMaterializationOperations({ reconciliation: reconcile(snap), config: CONFIG });
const OP = () => opsFor().operations[0];

async function runWorker(config, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", WORKER, JSON.stringify({ dbPath, port, ...config })], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (c) => { out += c; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("worker timed out")); }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal, died: signal !== null || code !== 0, out: out.trim() }); });
  });
}
const json = (run) => JSON.parse(run.out);
const loopMarkedIssue = (key, snap = SNAP, taskId = "RT-1", summary) => {
  const task = snap.tasks.find((t) => t.taskId === taskId);
  return { key, fields: { summary: summary ?? task.title, status: { name: "To Do" }, issuelinks: [], description: encodeLoopDescription({ taskId, sourceDocumentId: snap.documentId, planVersion: snap.planVersion, snapshotContentHash: snap.contentHash, taskHash: task.taskHash, acceptanceCriteria: task.acceptanceCriteria }) } };
};

test("end to end: CREATE decision -> JIRA_CREATE -> outbox -> Jira create -> read-after-write -> CONFIRMED -> reconcile again -> NOOP", async () => {
  const before = reconcile();
  assert.deepEqual([before.creates.length, before.noops.length], [1, 0]);
  const { operations } = buildMaterializationOperations({ reconciliation: before, config: CONFIG });
  const exec = executor();
  assert.equal(exec.enqueueMaterialization(operations[0]).created, true);
  const result = await exec.process(operations[0].operationId);
  assert.equal(result.outcome, "CONFIRMED", JSON.stringify(result.operation));
  assert.equal(result.operation.attemptCount, 1);
  assert.equal(await createPosts(), 1);

  const [remote] = await remoteIssues();
  assert.equal(remote.fields.summary, "Alpha");
  assert.equal(remote.fields.issuetype.name, "Task");
  const decoded = decodeLoopDescription(remote.fields.description);
  assert.deepEqual([decoded.claimed, decoded.taskId, decoded.problem], [true, "RT-1", null]);
  assert.deepEqual(decoded.metadata, { sourceDocumentId: "doc-1", planVersion: 1, snapshotContentHash: SNAP.contentHash, taskHash: SNAP.tasks[0].taskHash });
  assert.ok(!JSON.stringify(remote).match(/token|password|secret|@example/i), "no credential material is written to Jira");

  // reconciliation closure: the same task that returned CREATE now returns NOOP / STATE_MATCH
  const after = reconcile();
  assert.deepEqual([after.creates.length, after.noops.length, after.conflicts.length], [0, 1, 0]);
  assert.deepEqual([after.noops[0].taskId, after.noops[0].decision, after.noops[0].reasonCode, after.noops[0].jiraIssueKey], ["RT-1", "NOOP", "STATE_MATCH", remote.key]);
  assert.equal(buildMaterializationOperations({ reconciliation: after, config: CONFIG }).operations.length, 0, "nothing left to materialize");
  // and the confirmed operation is never executed again
  assert.equal((await exec.process(operations[0].operationId)).owned, false);
  assert.equal(await createPosts(), 1);
});

test("the order is reconcile -> create -> verify: the existing issue is read before the POST and again after", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const exec = executor();
  exec.enqueueMaterialization(op);
  await exec.process(op.operationId);
  const sequence = (await requestLog()).map((e) => `${e.method} ${e.path.split("?")[0].replace("/rest/api/3/", "")}`);
  assert.deepEqual(sequence.filter((s) => s !== "GET search").length, 1);
  const postAt = sequence.indexOf("POST issue");
  assert.ok(sequence.slice(0, postAt).includes("GET search"), "remote state is read before the write");
  assert.ok(sequence.slice(postAt + 1).includes("GET search"), "remote state is read after the write");
});

test("duplicate enqueue across repeated decisions: one operation, one remote issue", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const exec = executor();
  const first = exec.enqueueMaterialization(op);
  const again = exec.enqueueMaterialization(op);
  assert.deepEqual([first.created, again.created], [true, false]);
  assert.equal(exec.store.list().length, 1);
  await exec.process(op.operationId);
  assert.equal((await remoteIssues()).length, 1);
  // a later decision run (issue now exists) produces no operation at all
  assert.equal(opsFor().operations.length, 0);
});

test("LOST RESPONSE (critical): Jira creates the issue, the response is lost -> RETRY_WAIT -> reconcile discovers LOOP_TASK_ID -> CONFIRMED, ZERO second issue", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const { clock, advance } = steppingClock();
  const exec = executor({ store: openStore(clock), clock });
  exec.enqueueMaterialization(op);
  await override({ method: "POST", pathIncludes: "/rest/api/3/issue", fault: "applyThenReset" });
  const first = await exec.process(op.operationId);
  assert.equal(first.outcome, "RETRY_WAIT");
  assert.equal(first.operation.lastErrorCode, "TRANSIENT_NETWORK_FAILURE");
  assert.equal((await remoteIssues()).length, 1, "Jira did create the issue");
  assert.equal(exec.store.get(op.operationId).status, "RETRY_WAIT", "the operation stays recoverable");
  advance(10 * 60_000);
  const second = await exec.process(op.operationId);
  assert.equal(second.outcome, "CONFIRMED");
  assert.match(second.operation.lastErrorDetail ?? "", /.*/);
  assert.equal(await createPosts(), 1, "no second create request was ever issued");
  assert.equal((await remoteIssues()).length, 1, "zero second issue");
  assert.equal(reconcile().noops.length, 1);
});

test("RESTART after remote create (real process killed after the write, before CONFIRMED) -> recovery reconciles -> CONFIRMED, zero duplicate issues", async () => {
  const op = OP();
  assert.equal(json(await runWorker({ command: "enqueue-spec", workerId: "w-r0", spec: op })).created, true);
  const crashed = await runWorker({ command: "process", workerId: "w-r1", operationId: op.operationId, claimTtlMs: 3000, crashAt: "afterRemoteWrite" });
  assert.ok(crashed.died, "worker must be killed after the remote write");
  assert.equal((await remoteIssues()).length, 1);
  assert.equal(openStore().get(op.operationId).status, "IN_FLIGHT", "local state never learned of the create");
  await new Promise((resolve) => setTimeout(resolve, 3200));
  const restart = await runWorker({ command: "recover", workerId: "w-r2" });
  assert.deepEqual(json(restart).map((r) => [r.outcome, r.recovered]), [["CONFIRMED", true]]);
  assert.equal(openStore().get(op.operationId).status, "CONFIRMED");
  assert.equal(await createPosts(), 1, "recovery found the remote issue; it did not create another");
  assert.equal((await remoteIssues()).length, 1);
});

test("RESTART before the remote create: reconcile proves not applied, then exactly one controlled create", async () => {
  const op = OP();
  await runWorker({ command: "enqueue-spec", workerId: "w-s0", spec: op });
  const crashed = await runWorker({ command: "process", workerId: "w-s1", operationId: op.operationId, claimTtlMs: 3000, crashAt: "beforeRemoteWrite" });
  assert.ok(crashed.died);
  assert.equal(await createPosts(), 0);
  await new Promise((resolve) => setTimeout(resolve, 3200));
  assert.deepEqual(json(await runWorker({ command: "recover", workerId: "w-s2" })).map((r) => r.outcome), ["CONFIRMED"]);
  assert.equal(await createPosts(), 1);
  assert.equal((await remoteIssues()).length, 1);
});

test("CONCURRENT CREATE: 8 real workers race to enqueue AND materialize the same TASK_ID -> one outbox operation, one remote issue, one CONFIRMED", async () => {
  const op = OP();
  const enqueueAt = Date.now() + 1500;
  const enqueues = await Promise.all(Array.from({ length: 6 }, (_, i) => runWorker({ command: "enqueue-spec", workerId: `w-e${i}`, spec: op, startAt: enqueueAt })));
  assert.equal(enqueues.map(json).filter((r) => r.created).length, 1, "exactly one enqueue created the operation");
  assert.equal(openStore().list().length, 1);
  const startAt = Date.now() + 1500;
  const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => runWorker({ command: "process", workerId: `w-c${i}`, operationId: op.operationId, startAt, sleepBeforeWriteMs: 400 })));
  const results = runs.map(json);
  assert.equal(results.filter((r) => r.owned).length, 1, JSON.stringify(results));
  assert.equal(results.find((r) => r.owned).outcome, "CONFIRMED");
  assert.equal(await createPosts(), 1, "exactly one Jira create request");
  assert.equal((await remoteIssues()).length, 1, "exactly one remote issue");
  assert.deepEqual(openStore().list().map((o) => [o.status, o.attemptCount]), [["CONFIRMED", 1]]);
});

test("duplicate remote TASK_ID appearing before the write -> CONFLICT, no create", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const exec = executor();
  exec.enqueueMaterialization(op);
  await control({ seedIssue: loopMarkedIssue("LOOP-1") });
  await control({ seedIssue: loopMarkedIssue("LOOP-2") });
  const result = await exec.process(op.operationId);
  assert.equal(result.outcome, "CONFLICT");
  assert.equal(result.operation.lastErrorCode, "DUPLICATE_TASK_ID_REMOTE");
  assert.match(result.operation.lastErrorDetail, /LOOP-1, LOOP-2/);
  assert.equal(await createPosts(), 0);
});

test("duplicate remote TASK_ID produced by the create itself (concurrent outside writer) -> CONFLICT after read-after-write", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const exec = executor();
  exec.enqueueMaterialization(op);
  // a foreign writer also created a marked issue between our reconcile and our verification
  await control({ seedIssue: loopMarkedIssue("LOOP-1") });
  await override({ method: "GET", pathIncludes: "/search", status: 200, body: { total: 0, issues: [] } }); // our reconcile read sees nothing
  const result = await exec.process(op.operationId);
  assert.equal(result.outcome, "CONFLICT");
  assert.equal(result.operation.lastErrorCode, "DUPLICATE_TASK_ID_REMOTE");
  assert.equal(await createPosts(), 1);
});

test("remote created with a WRONG definition -> CONFLICT, never CONFIRMED", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const exec = executor();
  exec.enqueueMaterialization(op);
  await control({ createTweak: { summary: "Tampered title" } });
  const result = await exec.process(op.operationId);
  assert.equal(result.outcome, "CONFLICT");
  assert.equal(result.operation.lastErrorCode, "TITLE_DRIFT");
  assert.equal(await createPosts(), 1);
  assert.equal(reconcile().conflicts[0].reasonCode, "TITLE_DRIFT");
});

test("zero matching issues after a successful POST (Jira did not keep the marker) -> UNCERTAIN, recoverable, NOT success", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const { clock } = steppingClock();
  const exec = executor({ store: openStore(clock), clock });
  exec.enqueueMaterialization(op);
  await control({ createTweak: { summary: "Something else", description: { type: "doc", version: 1, content: [] } } });
  const result = await exec.process(op.operationId);
  assert.equal(result.outcome, "RETRY_WAIT");
  assert.equal(result.operation.lastErrorCode, "UNCERTAIN_WRITE");
  assert.match(result.operation.lastErrorDetail, /no issue carrying the LOOP_TASK_ID/);
});

test("unmarked remote issue with the exact normalized title -> no create (decision is CONFLICT, and a racing operation also ends CONFLICT with zero POSTs)", async () => {
  await control({ seedIssue: { key: "LOOP-50", fields: { summary: " Alpha ", status: { name: "To Do" }, issuelinks: [], description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "made by a human" }] }] } } } });
  const decision = reconcile();
  assert.deepEqual([decision.creates.length, decision.conflicts[0].reasonCode, decision.conflicts[0].jiraIssueKeys], [0, "POTENTIAL_REMOTE_COLLISION", ["LOOP-50"]]);
  assert.equal(buildMaterializationOperations({ reconciliation: decision, config: CONFIG }).operations.length, 0);
  // an operation enqueued earlier (before the collision appeared) must still refuse to write
  const exec = executor();
  exec.enqueueMaterialization(buildMaterializationOperations({ reconciliation: reconcilePlan({ snapshot: SNAP, observation: normalizeJiraObservation([]), createdAt: NOW }), config: CONFIG }).operations[0]);
  const result = await exec.process(OP_ID());
  assert.deepEqual([result.outcome, result.operation.lastErrorCode], ["CONFLICT", "POTENTIAL_REMOTE_COLLISION"]);
  assert.equal(await createPosts(), 0);
  assert.equal((await remoteIssues()).length, 1, "the human's issue was left untouched and did not become the owner");
});
const OP_ID = () => buildMaterializationOperations({ reconciliation: reconcilePlan({ snapshot: SNAP, observation: normalizeJiraObservation([]), createdAt: NOW }), config: CONFIG }).operations[0].operationId;

test("missing/invalid project config inside an operation -> FAILED_PERMANENT CONFIG_INVALID with zero Jira requests", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const exec = executor();
  const good = op;
  const bad = { ...good, operationId: "JIRA_CREATE:badconfig", desiredState: { ...good.desiredState, projectKey: "not-a-key" } };
  exec.store.enqueue(bad);
  const requestsBefore = (await requestLog()).length;
  const result = await exec.process(bad.operationId);
  assert.deepEqual([result.outcome, result.operation.lastErrorCode], ["FAILED_PERMANENT", "CONFIG_INVALID"]);
  assert.equal((await requestLog()).length, requestsBefore, "an invalid operation config makes zero Jira requests");
});

test("a failed reconcile read -> no write (503 -> RETRY_WAIT, zero POSTs)", async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
  const { clock } = steppingClock();
  const exec = executor({ store: openStore(clock), clock });
  exec.enqueueMaterialization(op);
  await override({ method: "GET", pathIncludes: "/search", status: 503, body: {} });
  const result = await exec.process(op.operationId);
  assert.deepEqual([result.outcome, result.operation.lastErrorCode], ["RETRY_WAIT", "JIRA_UNAVAILABLE"]);
  assert.equal(await createPosts(), 0);
});

const ERRORS = [
  ["create POST 429 (Retry-After honoured)", { method: "POST", status: 429, body: {}, headers: { "Retry-After": "900" } }, "RETRY_WAIT", "RATE_LIMITED"],
  ["create POST 503", { method: "POST", status: 503, body: {} }, "RETRY_WAIT", "JIRA_UNAVAILABLE"],
  ["create POST connection reset", { method: "POST", fault: "reset" }, "RETRY_WAIT", "TRANSIENT_NETWORK_FAILURE"],
  ["create POST 401", { method: "POST", status: 401, body: {} }, "FAILED_PERMANENT", "AUTH_INVALID"],
  ["create POST 403", { method: "POST", status: 403, body: {} }, "FAILED_PERMANENT", "AUTH_FORBIDDEN"],
  ["create POST 400", { method: "POST", status: 400, body: {} }, "FAILED_PERMANENT", "REQUEST_REJECTED"],
  ["reconcile read 401", { method: "GET", pathIncludes: "/search", status: 401, body: {} }, "FAILED_PERMANENT", "AUTH_INVALID"],
  ["reconcile read 429", { method: "GET", pathIncludes: "/search", status: 429, body: {}, headers: { "Retry-After": "30" } }, "RETRY_WAIT", "RATE_LIMITED"],
];
for (const [name, response, status, code] of ERRORS) {
  test(`error mapping: ${name} -> ${status} (${code})`, async () => {
  const op = OP(); // decided BEFORE any fault is armed: observing Jira consumes queued one-shot faults
    const clock = () => NOW;
    const exec = executor({ store: openStore(clock), clock });
    exec.enqueueMaterialization(op);
    await override({ pathIncludes: "/rest/api/3/issue", ...response });
    const result = await exec.process(op.operationId);
    assert.equal(result.outcome, status);
    assert.equal(result.operation.lastErrorCode, code);
    if (code === "AUTH_INVALID" || code === "AUTH_FORBIDDEN") assert.equal(result.globalBlock, true, "auth failures are a global system block");
    if (code === "RATE_LIMITED") assert.ok(result.operation.nextRetryAt >= new Date(Date.parse(NOW) + 30_000).toISOString());
    if (status === "RETRY_WAIT") assert.ok(result.operation.nextRetryAt > NOW);
    assert.equal(result.operation.status, status);
  });
}

test("CONTROL LOGIC IS DETERMINISTIC: materialization, ADF, reconciler and executor sources reference no model or randomness", () => {
  for (const file of ["../src/materialize/jira-materialization.js", "../src/reconcile/jira-adf.js", "../src/reconcile/plan-reconciler.js", "../src/adapters/jira-outbox-executor.js", "../src/adapters/sqlite-outbox-store.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/anthropic|openai|\bllm\b|claude|Math\.random|fetch\(/i.test(text), `${file} must not call a model`);
  }
});
