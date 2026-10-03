import assert from "node:assert/strict";
import test from "node:test";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor, jiraSprintOperation } from "../src/adapters/jira-outbox-executor.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";
import { buildCurlInvocation, classifyJiraFacts, jiraBaseUrl } from "../src/adapters/jira-transport.js";
import { encodeLoopDescription } from "../src/reconcile/jira-adf.js";

/** CP-08 scoped routing, board observation, write guard and sprint assignment. Offline (stub transport): SYNTHETIC evidence. */
const CLOUD = "11111111-2222-3333-4444-555555555555";
const EMAIL = "scoped@example.invalid";
const TOKEN = "scoped-token-0123456789-abcdefghij";
const BASIC = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const facts = (body, httpStatus = 200) => ({ httpStatus, body: JSON.stringify(body), headers: {}, requestId: "req-1", transportError: null });

test("classic routing is unchanged; scoped routing is explicit and never inferred", () => {
  assert.equal(jiraBaseUrl({ site: "x.atlassian.net" }), "https://x.atlassian.net/rest/api/3/");
  assert.equal(jiraBaseUrl({ mode: "scoped", cloudId: CLOUD }), `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/`);
  assert.equal(jiraBaseUrl({ mode: "scoped", cloudId: CLOUD, api: "agile" }), `https://api.atlassian.com/ex/jira/${CLOUD}/rest/agile/1.0/`);
  assert.throws(() => jiraBaseUrl({ mode: "scoped", site: "x.atlassian.net" }), /cloudId/);
  assert.throws(() => jiraBaseUrl({ mode: "auto", site: "x.atlassian.net" }), /mode/);
  assert.throws(() => jiraBaseUrl({ mode: "scoped", cloudId: CLOUD, gatewayHost: "evil.example" }), /gateway/);
  assert.throws(() => jiraBaseUrl({ mode: "scoped", cloudId: "../x" }), /cloudId/);
  assert.equal(jiraBaseUrl({ mode: "scoped", cloudId: CLOUD, gatewayHost: "127.0.0.1:9", scheme: "http" }), `http://127.0.0.1:9/ex/jira/${CLOUD}/rest/api/3/`);
});

test("scoped: the secret travels only on stdin, never in argv; the URL carries the cloud id and path", () => {
  const { argv, stdin } = buildCurlInvocation({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, path: "myself" });
  assert.equal(argv.at(-1), `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/myself`);
  for (const secret of [EMAIL, TOKEN, BASIC, "Authorization"]) assert.ok(!argv.join(" ").includes(secret));
  assert.ok(stdin.includes(BASIC));
});

test("scoped keeps the CP-01 classification of HTTP facts (401 vs 403, 429 Retry-After, 5xx)", () => {
  assert.equal(classifyJiraFacts({ httpStatus: 401, body: "", headers: {}, transportError: null }).code, "AUTH_INVALID");
  assert.equal(classifyJiraFacts({ httpStatus: 403, body: "", headers: {}, transportError: null }).code, "AUTH_FORBIDDEN");
  const limited = classifyJiraFacts({ httpStatus: 429, body: "", headers: { retryAfter: "7" }, transportError: null });
  assert.deepEqual([limited.code, limited.retryAfterSeconds], ["RATE_LIMITED", 7]);
  assert.equal(classifyJiraFacts({ httpStatus: 503, body: "", headers: {}, transportError: null }).code, "JIRA_UNAVAILABLE");
});

test("client: scoped needs a cloud id, passes mode/api to the transport and exposes no credential", () => {
  assert.throws(() => new JiraSyncClient({ mode: "scoped", email: EMAIL, apiToken: TOKEN }), /cloudId/);
  const seen = [];
  const client = new JiraSyncClient({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, transport: (r) => { seen.push(r); return facts({ ok: true }); } });
  client.request("myself");
  client.request("sprint/1", { api: "agile" });
  assert.deepEqual(seen.map((r) => [r.mode, r.cloudId, r.api, r.path]), [["scoped", CLOUD, "platform", "myself"], ["scoped", CLOUD, "agile", "sprint/1"]]);
  assert.ok(!JSON.stringify(client).includes(TOKEN));
});

test("board observation: proves the board belongs to the project and drops foreign keys", () => {
  const issue = (key) => ({ key, fields: {} });
  const transport = (r) => (r.path === "board/199" ? facts({ location: { projectKey: "LOOP" } }) : facts({ issues: [issue("LOOP-1"), issue("RCC-9")], total: 2 }));
  const client = new JiraSyncClient({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, transport, observation: { source: "board", boardId: 199 } });
  assert.deepEqual(client.observeProject("LOOP").map((i) => i.key), ["LOOP-1"]);
  const wrong = new JiraSyncClient({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, transport: () => facts({ location: { projectKey: "RCC" } }), observation: { source: "board", boardId: 199 } });
  assert.throws(() => wrong.observeProject("LOOP"), (e) => e.code === "CONFIG_INVALID");
  assert.throws(() => new JiraSyncClient({ site: "x.atlassian.net", email: EMAIL, apiToken: TOKEN, observation: { source: "board" } }), /observation/);
});

const owned = (taskId) => ({ fields: { project: { key: "LOOP" }, description: encodeLoopDescription({ taskId, sourceDocumentId: "d", planVersion: 1, snapshotContentHash: "h", taskHash: "t", acceptanceCriteria: [{ id: "AC-001", text: "x" }] }) } });
const guard = { projectKey: "LOOP", taskIdPattern: /^CP08[A-Z0-9]*-\d+$/ };
const lease = { assertLeaseCurrent: async () => {} };

test("write guard fails closed before any write: foreign project, unowned issue, foreign task id", async () => {
  const writes = [];
  const transport = (r) => {
    if (r.method !== "GET") { writes.push(r.path); return facts({ id: "1", key: "LOOP-9" }); }
    if (r.path.startsWith("issue/RCC-1")) return facts({ fields: { project: { key: "RCC" }, description: null } });
    if (r.path.startsWith("issue/LOOP-2")) return facts({ fields: { project: { key: "LOOP" }, description: null } });
    if (r.path.startsWith("issue/LOOP-3")) return facts(owned("RT-1"));
    return facts(owned("CP08ABC-1"));
  };
  const client = new JiraSyncClient({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, transport, writeGuard: guard });
  for (const key of ["RCC-1", "LOOP-2", "LOOP-3"]) {
    await assert.rejects(client.addExecutionComment(key, { executionId: "e", kind: "started", body: "b" }, lease), (e) => e.code === "WRITE_GUARD_VIOLATION", key);
  }
  await assert.rejects(client.createIssue({ projectKey: "RCC", issueTypeName: "Task", summary: "s", description: {} }, lease), (e) => e.code === "WRITE_GUARD_VIOLATION");
  assert.deepEqual(writes, [], "no write was attempted");
  assert.doesNotThrow(() => client.assertWritable("LOOP-4"));
});

test("sprint assignment: exact membership, idempotent by membership, executed through the outbox", async () => {
  const members = new Set();
  const writes = [];
  const transport = (r) => {
    if (r.method === "POST" && r.path === "sprint/137/issue") { writes.push(r.body); for (const k of r.body.issues) members.add(k); return { httpStatus: 204, body: "", headers: {}, requestId: null, transportError: null }; }
    if (r.path.startsWith("sprint/137/issue")) return facts({ issues: [...members].map((key) => ({ key })), total: members.size });
    return facts(owned("CP08ABC-1"));
  };
  const client = new JiraSyncClient({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, transport, writeGuard: guard });
  const store = new SqliteOutboxStore({ path: ":memory:" });
  const exec = new JiraOutboxExecutor({ store, jira: client, workerId: "w" });
  const spec = jiraSprintOperation({ issueKey: "LOOP-5", sprintId: 137 });
  assert.equal(exec.store.enqueue(spec).created, true);
  assert.equal((await exec.process(spec.operationId)).outcome, "CONFIRMED");
  assert.deepEqual([...members], ["LOOP-5"]);
  assert.equal((await exec.process(spec.operationId)).owned, false);
  const fresh = new JiraOutboxExecutor({ store: new SqliteOutboxStore({ path: ":memory:" }), jira: client, workerId: "w2" });
  fresh.store.enqueue(spec);
  assert.equal((await fresh.process(spec.operationId)).outcome, "CONFIRMED");
  assert.equal(writes.length, 1, "exactly one sprint write across repeats and a lost outbox");
});
