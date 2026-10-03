import assert from "node:assert/strict";
import test from "node:test";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../src/adapters/jira-outbox-executor.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { encodeLoopDescription } from "../src/reconcile/jira-adf.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";
import { buildMaterializationOperations } from "../src/materialize/jira-materialization.js";

/**
 * CP-08 scoped board observation: the board endpoint only enumerates candidate keys (its `description` is a rendered
 * string, not canonical ADF); reconciliation reads GET issue/{key}. Offline stub: SYNTHETIC evidence.
 */
const CLOUD = "11111111-2222-3333-4444-555555555555";
const EMAIL = "scoped@example.invalid";
const TOKEN = "scoped-token-0123456789-abcdefghij";
const NOW = "2026-09-30T20:00:00.000Z";
const facts = (body, httpStatus = 200) => ({ httpStatus, body: JSON.stringify(body), headers: {}, requestId: "req-1", transportError: null });
const guard = { projectKey: "LOOP", taskIdPattern: /^CP08[A-Z0-9]*-\d+$/ };
const CONFIG = { projectKey: "LOOP", issueTypeName: "Task", relationship: SYNTHETIC_BLOCKS_RELATIONSHIP };

const SNAP = makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan("LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\nTASK_ID: CP08ABC-1\nTITLE: Alpha\nAC:\n- AC-001: Alpha works\n- AC-002: and is verified\nEND_LOOP_EXECUTION_PLAN\n"), fetchedAt: NOW, compiledAt: NOW });
const ownedAdf = () => { const t = SNAP.tasks[0]; return encodeLoopDescription({ taskId: t.taskId, sourceDocumentId: SNAP.documentId, planVersion: SNAP.planVersion, snapshotContentHash: SNAP.contentHash, taskHash: t.taskHash, acceptanceCriteria: t.acceptanceCriteria }); };
const issueRow = (summary, description) => ({ summary, description, status: { name: "To Do" }, issuelinks: [] });

/** The BOARD endpoint serves a stringified description (as the live gateway does); only GET issue/{key} serves ADF. */
function fakeJira({ loseFirstCreateResponse = false } = {}) {
  const store = new Map();
  const log = [];
  let lost = loseFirstCreateResponse;
  const transport = (r) => {
    const method = r.method ?? "GET";
    log.push(`${method} ${r.api === "agile" ? "agile/" : ""}${r.path.split("?")[0]}`);
    if (r.path === "board/199") return facts({ location: { projectKey: "LOOP" } });
    if (r.path.startsWith("board/199/issue")) return facts({ issues: [...store].map(([key, f]) => ({ key, fields: { summary: f.summary, description: JSON.stringify(f.description) } })), total: store.size });
    if (method === "POST" && r.path === "issue") {
      const key = `LOOP-${store.size + 1}`;
      store.set(key, issueRow(r.body.fields.summary, r.body.fields.description));
      if (lost) { lost = false; return { httpStatus: 0, body: "", headers: {}, requestId: null, transportError: { code: "TRANSIENT_NETWORK_FAILURE", curlExit: 56, message: "connection reset" } }; }
      return facts({ id: String(store.size), key }, 201);
    }
    const m = /^issue\/([^?]+)/.exec(r.path);
    if (method === "GET" && m && store.has(m[1])) { const f = store.get(m[1]); return facts({ key: m[1], fields: { ...f, issuetype: { name: "Task" }, project: { key: "LOOP" } } }); }
    return facts({ errorMessages: ["not found"] }, 404);
  };
  const client = (override = transport) => new JiraSyncClient({ mode: "scoped", cloudId: CLOUD, email: EMAIL, apiToken: TOKEN, transport: override, observation: { source: "board", boardId: 199 }, writeGuard: guard });
  return { store, log, transport, client };
}
const decide = (client) => reconcilePlan({ snapshot: SNAP, observation: normalizeJiraObservation(client.observeProject("LOOP"), { relationship: SYNTHETIC_BLOCKS_RELATIONSHIP }), createdAt: NOW });

test("the board's string description is never used: ADF comes from the per-issue canonical read", () => {
  const jira = fakeJira();
  jira.store.set("LOOP-1", issueRow("Alpha", ownedAdf()));
  const [issue] = jira.client().observeProject("LOOP");
  assert.equal(typeof issue.fields.description, "object");
  assert.deepEqual(issue.fields.description, ownedAdf());
  assert.ok(jira.log.includes("GET issue/LOOP-1"));
});

test("an already-created CP-08 issue reconciles to NOOP / STATE_MATCH through the board path", () => {
  const jira = fakeJira();
  jira.store.set("LOOP-1", issueRow("Alpha", ownedAdf()));
  const decision = decide(jira.client());
  assert.deepEqual([decision.creates.length, decision.conflicts.length, decision.noops[0].decision, decision.noops[0].reasonCode, decision.noops[0].jiraIssueKey], [0, 0, "NOOP", "STATE_MATCH", "LOOP-1"]);
});

test("REMOTE_INVALID detection is not weakened: a canonical description without parseable ACs is still a conflict", () => {
  const jira = fakeJira();
  const adf = ownedAdf();
  jira.store.set("LOOP-1", issueRow("Alpha", { ...adf, content: adf.content.filter((n) => n.type !== "bulletList" && n.type !== "heading") }));
  const decision = decide(jira.client());
  assert.deepEqual([decision.noops.length, decision.conflicts[0]?.reasonCode], [0, "REMOTE_INVALID"]);
});

test("ownership filtering is preserved: foreign-project entries are never fetched; unowned issues are neither claimed nor mistaken for the task", () => {
  const jira = fakeJira();
  jira.store.set("RCC-9", issueRow("Foreign", null));
  jira.store.set("LOOP-2", issueRow("Human issue", { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "by a human" }] }] }));
  assert.deepEqual(jira.client().observeProject("LOOP").map((i) => i.key), ["LOOP-2"]);
  assert.ok(!jira.log.some((l) => l.startsWith("GET issue/RCC-9")), "no canonical read for a foreign project");
  const decision = decide(jira.client());
  assert.deepEqual([decision.creates.length, decision.noops.length], [1, 0]);
});

test("a canonical read that answers for a different key fails closed", () => {
  const jira = fakeJira();
  jira.store.set("LOOP-1", issueRow("Alpha", ownedAdf()));
  const lying = jira.client((r) => (r.path.startsWith("issue/") ? facts({ key: "LOOP-77", fields: {} }) : jira.transport(r)));
  assert.throws(() => lying.observeProject("LOOP"), (e) => e.code === "INVALID_RESPONSE");
});

test("UNCERTAIN_WRITE (response lost after Jira applied the create): retry reconciles via the board path -> CONFIRMED, exactly one POST", async () => {
  const jira = fakeJira({ loseFirstCreateResponse: true });
  let now = Date.parse(NOW);
  const clock = () => new Date(now).toISOString();
  const exec = new JiraOutboxExecutor({ store: new SqliteOutboxStore({ path: ":memory:", clock }), jira: jira.client(), workerId: "w", relationship: SYNTHETIC_BLOCKS_RELATIONSHIP, clock });
  const [op] = buildMaterializationOperations({ reconciliation: decide(jira.client()), config: CONFIG }).operations;
  exec.enqueueMaterialization(op);
  assert.equal((await exec.process(op.operationId)).outcome, "RETRY_WAIT");
  assert.equal(jira.store.size, 1, "Jira did apply the create");
  now += 10 * 60_000;
  const second = await exec.process(op.operationId);
  assert.equal(second.outcome, "CONFIRMED", JSON.stringify(second.operation));
  assert.equal(jira.log.filter((l) => l === "POST issue").length, 1, "no second create request");
  assert.equal(jira.store.size, 1);
  const after = decide(jira.client());
  assert.deepEqual([after.noops.length, after.conflicts.length], [1, 0]);
});
