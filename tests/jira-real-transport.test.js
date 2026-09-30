import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { JiraSyncClient, JiraSyncError } from "../src/adapters/jira-sync-client.js";
import { JiraAdapterError, JiraTaskSystemAdapter } from "../src/adapters/jira-task-adapter.js";
import { buildCurlInvocation, jiraCurlTransport } from "../src/adapters/jira-transport.js";

/**
 * CP-01: the REAL curl transport against a local HTTP mock. SYNTHETIC evidence only:
 * it proves transport/classification/read-after-write logic, NOT real Jira behaviour.
 */
const EMAIL = "cp01-loop@example.invalid";
const TOKEN = "CP01-SECRET-TOKEN-0123456789abcdef";
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const STATUS_MAPPING = { "To Do": "OPEN", "In Progress": "OPEN", Done: "DONE" };
const leased = { assertLeaseCurrent: async () => true };

let server; let port;

before(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL("./helpers/jira-mock-server.js", import.meta.url))], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.stdout.once("data", (chunk) => resolve(Number(/PORT=(\d+)/.exec(String(chunk))[1])));
  });
});
after(() => server.kill());
beforeEach(() => control({ reset: true }));

const control = (payload) => fetch(`http://127.0.0.1:${port}/__control`, { method: "POST", body: JSON.stringify(payload) }).then((r) => r.json());
const requestLog = () => fetch(`http://127.0.0.1:${port}/__log`).then((r) => r.json());
const override = (o) => control({ override: o });
const site = () => `127.0.0.1:${port}`;
const syncClient = (extra = {}) => new JiraSyncClient({ site: site(), scheme: "http", email: EMAIL, apiToken: TOKEN, timeoutMs: 1500, ...extra });
const readAdapter = (extra = {}) => new JiraTaskSystemAdapter({ site: site(), scheme: "http", email: EMAIL, apiToken: TOKEN, projectKey: "LOOP", statusMapping: STATUS_MAPPING, timeoutMs: 1500, ...extra });
const raw = (path, method = "GET", body = null, extra = {}) => jiraCurlTransport({ site: site(), scheme: "http", email: EMAIL, apiToken: TOKEN, path, method, body, timeoutMs: 1500, ...extra });
const done = { executionId: "e1", computedState: "DONE", doneStatusName: "Done", transitionName: "Done" };

async function closedPort() {
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port: free } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return free;
}

test("real curl: HTTP 200 valid JSON returns structured facts and feeds the read adapter", () => {
  const facts = raw("issue/LOOP-1?fields=status");
  assert.equal(facts.httpStatus, 200);
  assert.equal(facts.transportError, null);
  assert.deepEqual(JSON.parse(facts.body).fields.status, { name: "In Progress" });
  assert.match(facts.headers.contentType, /application\/json/);
  assert.equal(readAdapter().listTasks()[0].id, "LOOP-1");
});

test("real curl: HTTP 204 transition is accepted as an empty success and the JSON body arrives intact", async () => {
  const facts = raw("issue/LOOP-1/transitions", "POST", { transition: { id: "31" } });
  assert.equal(facts.httpStatus, 204);
  assert.equal(facts.body, "");
  assert.equal((await requestLog()).at(-1).body, JSON.stringify({ transition: { id: "31" } }));
});

test("authorization header reaches the server even though it is absent from argv", async () => {
  raw("issue/LOOP-1?fields=status");
  assert.equal((await requestLog()).at(-1).authorization, `Basic ${BASIC}`);
});

const STATUS_MATRIX = [
  [400, "REQUEST_REJECTED", false], [401, "AUTH_INVALID", false], [403, "AUTH_FORBIDDEN", false],
  [404, "ISSUE_NOT_FOUND", false], [409, "STALE_STATE", false], [429, "RATE_LIMITED", true],
  [500, "JIRA_UNAVAILABLE", true], [503, "JIRA_UNAVAILABLE", true],
];
for (const [status, code, retryable] of STATUS_MATRIX) {
  test(`real curl: HTTP ${status} -> ${code}; Jira rejected the request, transport itself worked`, async () => {
    const response = { status, body: { errorMessages: ["x"] }, headers: status === 429 ? { "Retry-After": "42" } : {} };
    await override(response);
    const facts = raw("issue/LOOP-1?fields=status");
    assert.equal(facts.httpStatus, status);
    assert.equal(facts.transportError, null, "an HTTP error status is not a transport failure");
    await override(response);
    assert.throws(() => syncClient().request("issue/LOOP-1?fields=status"), (error) => {
      assert.ok(error instanceof JiraSyncError);
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, status);
      assert.equal(error.retryable, retryable);
      assert.equal(error.transportFailed, false);
      if (status === 429) assert.equal(error.retryAfterSeconds, 42);
      return true;
    });
  });
}

test("the read adapter classifies real HTTP failures too (401 and 403 are not collapsed)", async () => {
  await override({ status: 401, body: {} });
  assert.throws(() => readAdapter().listTasks(), (error) => error instanceof JiraAdapterError && error.code === "AUTH_INVALID");
  await override({ status: 403, body: {} });
  assert.throws(() => readAdapter().listTasks(), (error) => error instanceof JiraAdapterError && error.code === "AUTH_FORBIDDEN");
});

test("real curl: HTTP 200 with invalid JSON -> INVALID_RESPONSE (fail closed)", async () => {
  await override({ status: 200, rawBody: "<html>not json" });
  assert.throws(() => syncClient().request("issue/LOOP-1?fields=status"), (error) => error.code === "INVALID_RESPONSE" && error.classification === "EXTERNAL_BLOCK");
});

test("real curl: connection refused is a TRANSPORT failure (no HTTP status) and retryable", async () => {
  const dead = await closedPort();
  const facts = jiraCurlTransport({ site: `127.0.0.1:${dead}`, scheme: "http", email: EMAIL, apiToken: TOKEN, path: "issue/LOOP-1", timeoutMs: 1500 });
  assert.equal(facts.httpStatus, 0);
  assert.equal(facts.transportError.code, "TRANSIENT_NETWORK_FAILURE");
  assert.ok([7, 28].includes(facts.transportError.curlExit), `unexpected curl exit ${facts.transportError.curlExit}`); // Windows may report a refused loopback connect as a timeout
  const client = new JiraSyncClient({ site: `127.0.0.1:${dead}`, scheme: "http", email: EMAIL, apiToken: TOKEN, timeoutMs: 1500 });
  assert.throws(() => client.request("issue/LOOP-1"), (error) => error.code === "TRANSIENT_NETWORK_FAILURE" && error.retryable === true && error.transportFailed === true);
});

test("real curl: connection reset mid-request is a transient transport failure", async () => {
  await override({ fault: "reset" });
  const facts = raw("issue/LOOP-1?fields=status");
  assert.equal(facts.transportError?.code, "TRANSIENT_NETWORK_FAILURE");
  assert.equal(facts.httpStatus, 0);
});

test("real curl: premature close after a partial body is a transient transport failure", async () => {
  await override({ fault: "premature" });
  const facts = raw("issue/LOOP-1?fields=status");
  assert.equal(facts.transportError?.code, "TRANSIENT_NETWORK_FAILURE");
  assert.equal(facts.body, "", "a truncated body must never be surfaced as a response");
});

test("real curl: timeout is a transient transport failure", async () => {
  await override({ fault: "hang" });
  const facts = raw("issue/LOOP-1?fields=status", "GET", null, { timeoutMs: 1000 });
  assert.equal(facts.transportError?.code, "TRANSIENT_NETWORK_FAILURE");
  assert.equal(facts.transportError.curlExit, 28);
});

test("CONFIG_INVALID: bad site, plain http to a non-loopback host, missing credential, bad path", () => {
  for (const bad of [{ site: "evil.example\nx" }, { site: "example.com", scheme: "http" }, { apiToken: "" }, { path: 'a b"c' }]) {
    assert.equal(raw("issue/LOOP-1", "GET", null, bad).transportError?.code, "CONFIG_INVALID", JSON.stringify(bad));
  }
});

test("read-after-write: transition + matching re-read -> CONFIRMED, in the exact read/validate/write/read order", async () => {
  const result = await syncClient().markTaskComplete("LOOP-1", done, leased);
  assert.deepEqual(result, { status: "CONFIRMED", transitioned: true, alreadyDone: false });
  const sequence = (await requestLog()).map((entry) => `${entry.method} ${entry.path.split("?")[0]}`);
  assert.deepEqual(sequence, [
    "GET /rest/api/3/issue/LOOP-1", "GET /rest/api/3/issue/LOOP-1/transitions",
    "POST /rest/api/3/issue/LOOP-1/transitions", "GET /rest/api/3/issue/LOOP-1",
  ]);
});

test("read-after-write: POST succeeds but Jira state is wrong -> UNCERTAIN, never success", async () => {
  await control({ postNoop: true });
  const result = await syncClient().markTaskComplete("LOOP-1", done, leased);
  assert.equal(result.status, "UNCERTAIN");
  assert.equal(result.reason, "POST_WRITE_STATE_MISMATCH");
  assert.equal(result.observedStatus, "In Progress");
  assert.equal(result.transitioned, false);
});

test("read-after-write: POST succeeds but the verifying read fails -> UNCERTAIN", async () => {
  const inProgress = { method: "GET", pathIncludes: "fields=status", status: 200, body: { fields: { status: { name: "In Progress" } } } };
  await override(inProgress); // precondition read
  await override({ method: "POST", pathIncludes: "/transitions", status: 204 });
  await override({ method: "GET", pathIncludes: "fields=status", status: 503, body: {} }); // verifying read
  const result = await syncClient().markTaskComplete("LOOP-1", done, leased);
  assert.equal(result.status, "UNCERTAIN");
  assert.equal(result.reason, "POST_WRITE_READ_FAILED");
  assert.equal(result.cause, "JIRA_UNAVAILABLE");
});

test("read-after-write: an unexpected current state -> STALE_STATE and no write is issued", async () => {
  await assert.rejects(
    syncClient().markTaskComplete("LOOP-1", { ...done, expectedCurrentStatusNames: ["To Do"] }, leased),
    (error) => error.code === "STALE_STATE",
  );
  assert.ok(!(await requestLog()).some((entry) => entry.method === "POST"));
});

test("a transition POST rejected with 4xx is NOT_APPLIED; 503 and timeout leave the outcome UNKNOWN", async () => {
  await override({ method: "POST", pathIncludes: "/transitions", status: 400, body: {} });
  await assert.rejects(syncClient().markTaskComplete("LOOP-1", done, leased), (error) => error.code === "REQUEST_REJECTED" && error.writeOutcome === "NOT_APPLIED");
  await override({ method: "POST", pathIncludes: "/transitions", status: 503, body: {} });
  await assert.rejects(syncClient().markTaskComplete("LOOP-1", done, leased), (error) => error.code === "JIRA_UNAVAILABLE" && error.writeOutcome === "UNKNOWN");
  await override({ method: "POST", pathIncludes: "/transitions", fault: "hang" });
  await assert.rejects(syncClient({ timeoutMs: 1000 }).markTaskComplete("LOOP-1", done, leased), (error) => error.code === "TRANSIENT_NETWORK_FAILURE" && error.writeOutcome === "UNKNOWN");
});

test("comment idempotency over real HTTP: create once, rediscover, and a retry creates no second comment", async () => {
  const jira = syncClient();
  const first = await jira.recordExecutionStarted("LOOP-1", { executionId: "exec-9" }, leased);
  assert.equal(first.created, true);
  assert.equal(jira.findMarkedComment("LOOP-1", "<!-- loop-execution:exec-9:started -->")?.id, first.id, "created comment is rediscoverable");
  const retry = await jira.recordExecutionStarted("LOOP-1", { executionId: "exec-9" }, leased);
  assert.deepEqual({ created: retry.created, id: retry.id }, { created: false, id: first.id });
  assert.equal((await requestLog()).filter((entry) => entry.method === "POST").length, 1, "exactly one comment POST");
});

test("comment idempotency: a write whose response was lost is rediscovered on retry, not duplicated", async () => {
  await override({ method: "POST", pathIncludes: "/comment", fault: "applyThenReset" });
  const jira = syncClient();
  await assert.rejects(jira.recordExecutionStarted("LOOP-1", { executionId: "exec-10" }, leased), (error) => error.writeOutcome === "UNKNOWN");
  const retry = await jira.recordExecutionStarted("LOOP-1", { executionId: "exec-10" }, leased);
  assert.equal(retry.created, false, "the applied-but-unacknowledged comment must be found by its marker");
  assert.equal((await requestLog()).filter((entry) => entry.method === "POST").length, 1);
});

test("secrets: serialization/inspection of the adapter and client never exposes credentials", () => {
  for (const obj of [syncClient(), readAdapter()]) {
    const views = [
      JSON.stringify(obj), inspect(obj, { showHidden: true, depth: 6 }), inspect(obj, { showHidden: true, depth: null, getters: true }),
      JSON.stringify(Object.getOwnPropertyNames(obj)), JSON.stringify(Object.entries(obj)), JSON.stringify({ ...obj }),
      JSON.stringify(Object.getOwnPropertySymbols(obj).map(String)), `${obj}`,
      JSON.stringify(structuredClone(Object.fromEntries(Object.entries(obj).filter(([, value]) => typeof value !== "function")))),
    ];
    for (const view of views) {
      assert.ok(!view.includes(EMAIL), "email must not be enumerable/serializable");
      assert.ok(!view.includes(TOKEN), "token must not be enumerable/serializable");
      assert.ok(!view.includes(BASIC), "authorization material must not be enumerable/serializable");
    }
  }
});

test("secrets: errors and transport facts never contain credentials", async () => {
  await override({ status: 401, body: { echo: "x" } });
  try { syncClient().request("issue/LOOP-1"); assert.fail("expected a throw"); } catch (error) {
    const dump = `${error.message}${error.stack}${JSON.stringify(error)}`;
    assert.ok(!dump.includes(TOKEN) && !dump.includes(BASIC) && !dump.includes(EMAIL));
  }
  assert.ok(!JSON.stringify(raw("issue/LOOP-1")).includes(BASIC));
});

test("secrets: argv carries no credential, the secret travels only via stdin, and no temp file is created", () => {
  const { argv, stdin } = buildCurlInvocation({ site: "example.atlassian.net", email: EMAIL, apiToken: TOKEN, path: "issue/LOOP-1" });
  const joined = argv.join(" ");
  for (const secret of [EMAIL, TOKEN, BASIC, "Authorization"]) assert.ok(!joined.includes(secret), `argv leaked ${secret}`);
  assert.ok(stdin.includes(BASIC), "the credential must travel via the stdin config");
  const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("loop-jira")).sort();
  const before = leftovers();
  raw("issue/LOOP-1?fields=status");
  raw("issue/LOOP-1?fields=status", "GET", null, { timeoutMs: 1000, site: "127.0.0.1:1" });
  assert.deepEqual(leftovers(), before, "no credential temp file may be created or left behind, on success or failure");
});
