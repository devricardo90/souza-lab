import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../src/adapters/jira-outbox-executor.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";
import { RelationshipConfigError, SYNTHETIC_BLOCKS_RELATIONSHIP, blockerOf, linkBody, parseRelationshipConfig, verifyAgainstLinkTypes } from "../src/reconcile/jira-relationship.js";
import { buildMaterializationOperations } from "../src/materialize/jira-materialization.js";

const NOW = "2026-10-02T10:00:00.000Z";
const PROVEN = SYNTHETIC_BLOCKS_RELATIONSHIP; // live-proven (CP-08): the dependent is the POSTed outwardIssue
const REVERSED = { ...PROVEN, dependentEnd: "inward" }; // the DISPROVEN hypothesis, kept to prove it is detected
const TYPES = [{ id: "10000", name: "Blocks", inward: "is blocked by", outward: "blocks" }];

// Jira's LIVE-OBSERVED rendering rule (also the mock's): an entry on an issue lists the OTHER issue under the key of the OTHER issue's own POST end.
const render = (body, viewer) => (body.inwardIssue.key === viewer
  ? { type: body.type, outwardIssue: { key: body.outwardIssue.key } } : { type: body.type, inwardIssue: { key: body.inwardIssue.key } });

test("relationship config is explicit: absent, partial, ambiguous or unknown values fail closed with RELATIONSHIP_CONFIG_INVALID", () => {
  assert.deepEqual({ ...parseRelationshipConfig(PROVEN) }, { linkTypeName: "Blocks", linkTypeId: null, inwardLabel: "is blocked by", outwardLabel: "blocks", dependentEnd: "outward" });
  for (const bad of [undefined, null, {}, { ...PROVEN, linkTypeName: "" }, { ...PROVEN, inwardLabel: undefined }, { ...PROVEN, dependentEnd: undefined }, { ...PROVEN, dependentEnd: "both" }, { ...PROVEN, outwardLabel: "is blocked by" }]) {
    assert.throws(() => parseRelationshipConfig(bad), (e) => e instanceof RelationshipConfigError && e.code === "RELATIONSHIP_CONFIG_INVALID", JSON.stringify(bad));
  }
});

test("one definition drives both write and read, for either dependent end (no disagreement possible)", () => {
  for (const relationship of [PROVEN, REVERSED]) {
    const body = linkBody(relationship, { blockerKey: "LOOP-1", dependentKey: "LOOP-2" });
    assert.equal(body[`${relationship.dependentEnd}Issue`].key, "LOOP-2", "the dependent occupies the configured end");
    assert.equal(blockerOf(relationship, render(body, "LOOP-2")), "LOOP-1", "reading the dependent's entry yields the blocker");
    assert.equal(blockerOf(relationship, render(body, "LOOP-1")), null, "the blocker's own entry is not a dependency of the blocker");
  }
  assert.notDeepEqual(linkBody(PROVEN, { blockerKey: "A-1", dependentKey: "A-2" }), linkBody(REVERSED, { blockerKey: "A-1", dependentKey: "A-2" }));
  assert.equal(blockerOf(PROVEN, { type: { name: "Relates" }, inwardIssue: { key: "LOOP-9" } }), null, "other link types are ignored");
  assert.throws(() => linkBody(PROVEN, { blockerKey: "A-1", dependentKey: "A-1" }), RelationshipConfigError);
});

test("the configuration is verified against Jira's own link type definition", () => {
  assert.equal(verifyAgainstLinkTypes(PROVEN, TYPES).linkTypeName, "Blocks");
  assert.throws(() => verifyAgainstLinkTypes({ ...PROVEN, inwardLabel: "depends on" }, TYPES), /do not match Jira/);
  assert.throws(() => verifyAgainstLinkTypes({ ...PROVEN, linkTypeName: "Duplicate" }, TYPES), /matched 0/);
  assert.throws(() => verifyAgainstLinkTypes({ ...PROVEN, linkTypeId: "10000", linkTypeName: "Other" }, [{ ...TYPES[0] }]), RelationshipConfigError);
  assert.throws(() => verifyAgainstLinkTypes(PROVEN, "nope"), RelationshipConfigError);
});

const block = (id, title, extra = "") => `TASK_ID: ${id}\nTITLE: ${title}\n${extra}AC:\n- AC-001: ${title} works\n`;
const snapshot = (...blocks) => makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan(`LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\n${blocks.join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`), fetchedAt: NOW, compiledAt: NOW });
const marked = (key, snap, taskId, links = []) => {
  const t = snap.tasks.find((x) => x.taskId === taskId);
  return { key, fields: { summary: t.title, status: { name: "To Do" }, issuelinks: links, description: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: `LOOP_TASK_ID: ${taskId}` }] }, { type: "paragraph", content: [{ type: "text", text: "LOOP_SOURCE_DOCUMENT: doc-1" }] }, { type: "paragraph", content: [{ type: "text", text: "LOOP_PLAN_VERSION: 1" }] }, { type: "paragraph", content: [{ type: "text", text: `LOOP_SNAPSHOT_HASH: ${snap.contentHash}` }] }, { type: "paragraph", content: [{ type: "text", text: `LOOP_TASK_HASH: ${t.taskHash}` }] }, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Acceptance Criteria" }] }, { type: "bulletList", content: t.acceptanceCriteria.map((ac) => ({ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: `${ac.id}: ${ac.text}` }] }] })) }] } } };
};

test("observation without a relationship config fails closed on any link entry; with config it reads by the explicit mapping", () => {
  const snap = snapshot(block("RT-1", "A"), block("RT-2", "B", "DEPENDS_ON: RT-1\n"));
  const entry = render(linkBody(PROVEN, { blockerKey: "LOOP-1", dependentKey: "LOOP-2" }), "LOOP-2");
  const raw = [marked("LOOP-1", snap, "RT-1"), marked("LOOP-2", snap, "RT-2", [entry])];
  const without = reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation(raw), createdAt: NOW });
  assert.equal(without.conflicts[0].taskId, "RT-2");
  assert.equal(without.conflicts[0].differences.find((d) => d.field === "dependencies" && d.kind === "UNKNOWN_REMOTE_DEPENDENCY").observed, "RELATIONSHIP_CONFIG_MISSING");
  const withConfig = reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation(raw, { relationship: PROVEN }), createdAt: NOW });
  assert.deepEqual(withConfig.noops.map((d) => d.taskId), ["RT-1", "RT-2"]);
  const wrongEnd = reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation(raw, { relationship: REVERSED }), createdAt: NOW });
  assert.equal(wrongEnd.conflicts[0].reasonCode, "DEPENDENCY_DRIFT", "a mapping that disagrees with Jira is detected, never silently accepted");
});

test("materialization never creates a dependent task when the relationship config is absent or invalid", () => {
  const snap = snapshot(block("RT-1", "A"), block("RT-2", "B", "DEPENDS_ON: RT-1\n"));
  const reconciliation = reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation([marked("LOOP-1", snap, "RT-1")]), createdAt: NOW });
  const config = { projectKey: "LOOP", issueTypeName: "Task" };
  for (const relationship of [undefined, { ...PROVEN, dependentEnd: "x" }]) {
    const { operations, blocked } = buildMaterializationOperations({ reconciliation, config: { ...config, relationship } });
    assert.deepEqual([operations.length, blocked.map((b) => [b.taskId, b.reasonCode])], [0, [["RT-2", "RELATIONSHIP_CONFIG_INVALID"]]]);
  }
  assert.equal(buildMaterializationOperations({ reconciliation, config: { ...config, relationship: PROVEN } }).operations.length, 1);
});

// ---------- against the local Jira mock ----------
let server; let port; let dir; const opened = [];
before(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL("./helpers/jira-mock-server.js", import.meta.url))], { stdio: ["ignore", "pipe", "inherit"] });
  port = await new Promise((resolve, reject) => { server.once("error", reject); server.stdout.once("data", (c) => resolve(Number(/PORT=(\d+)/.exec(String(c))[1]))); });
});
const cleanup = () => { for (const s of opened.splice(0)) { try { s.close(); } catch {} } if (dir) rmSync(dir, { recursive: true, force: true }); };
after(() => { server.kill(); cleanup(); });
beforeEach(async () => { cleanup(); dir = mkdtempSync(join(tmpdir(), "rel-")); await control({ reset: true, legacySearch: false }); });
const control = (payload) => fetch(`http://127.0.0.1:${port}/__control`, { method: "POST", body: JSON.stringify(payload), headers: { connection: "close" } }).then((r) => r.json());
const issues = async () => (await (await fetch(`http://127.0.0.1:${port}/rest/api/3/search?maxResults=100`, { headers: { connection: "close" } })).json()).issues;
const posts = async (re) => (await (await fetch(`http://127.0.0.1:${port}/__log`, { headers: { connection: "close" } })).json()).filter((e) => e.method === "POST" && re.test(e.path)).length;
const client = () => new JiraSyncClient({ site: `127.0.0.1:${port}`, scheme: "http", email: "r@example.invalid", apiToken: "relationship-test-token-0123456789", timeoutMs: 2500 });
const executor = (relationship) => { const store = new SqliteOutboxStore({ path: join(dir, "o.sqlite") }); opened.push(store); return new JiraOutboxExecutor({ store, jira: client(), workerId: "w", relationship }); };
const SNAP = snapshot(block("RT-1", "Alpha"), block("RT-2", "Beta", "DEPENDS_ON: RT-1\n"));
const ops = (relationship) => buildMaterializationOperations({ reconciliation: reconcilePlan({ snapshot: SNAP, observation: normalizeJiraObservation(client().observeProject("LOOP"), { relationship }), createdAt: NOW }), config: { projectKey: "LOOP", issueTypeName: "Task", relationship } });

test("Jira mock: verifyRelationship passes for the real definition and fails closed on a label mismatch", async () => {
  assert.equal(client().verifyRelationship(PROVEN).dependentEnd, "outward");
  await control({ setLinkTypes: [{ id: "10000", name: "Blocks", inward: "is blocked by", outward: "is blocking" }] });
  assert.throws(() => client().verifyRelationship(PROVEN), (e) => e.code === "RELATIONSHIP_CONFIG_INVALID");
});

for (const relationship of [PROVEN, REVERSED]) {
  test(`dependent task is created with its link via the explicit mapping (dependentEnd=${relationship.dependentEnd}) and reconciles to NOOP; the same mapping reads it back`, async () => {
    const exec = executor(relationship);
    const [first] = ops(relationship).operations;
    exec.enqueueMaterialization(first);
    assert.equal((await exec.process(first.operationId)).outcome, "CONFIRMED");
    const [second] = ops(relationship).operations;
    exec.enqueueMaterialization(second);
    const result = await exec.process(second.operationId);
    assert.equal(result.outcome, "CONFIRMED", JSON.stringify(result.operation));
    const [alpha, beta] = (await issues()).sort((a, b) => (a.fields.summary < b.fields.summary ? -1 : 1));
    assert.equal(blockerOf(relationship, beta.fields.issuelinks[0]), alpha.key);
    const closure = reconcilePlan({ snapshot: SNAP, observation: normalizeJiraObservation(client().observeProject("LOOP"), { relationship }), createdAt: NOW });
    assert.deepEqual([closure.noops.length, closure.conflicts.length], [2, 0]);
  });
}

test("an executor with NO relationship config creates nothing for a dependent task (FAILED_PERMANENT RELATIONSHIP_CONFIG_INVALID, zero create POSTs)", async () => {
  const withConfig = executor(PROVEN);
  const [first] = ops(PROVEN).operations;
  withConfig.enqueueMaterialization(first);
  await withConfig.process(first.operationId);
  const [dependentOp] = ops(PROVEN).operations;
  const bare = executor(null);
  bare.enqueueMaterialization(dependentOp);
  const createsBefore = await posts(/\/rest\/api\/3\/issue$/);
  const result = await bare.process(dependentOp.operationId);
  assert.deepEqual([result.outcome, result.operation.lastErrorCode], ["FAILED_PERMANENT", "RELATIONSHIP_CONFIG_INVALID"]);
  assert.equal(await posts(/\/rest\/api\/3\/issue$/), createsBefore, "no dependent issue was created");
  assert.equal(await posts(/issueLink$/), 0);
});

// ---------- regression: CP-08 live evidence (run CP08MUS8I9PM) is the source of truth for the direction ----------
test("REGRESSION (live CP-08): the dependent is POSTed as outwardIssue and the blocker as inwardIssue", () => {
  assert.equal(PROVEN.dependentEnd, "outward");
  const body = linkBody(PROVEN, { blockerKey: "LOOP-1", dependentKey: "LOOP-2" });
  assert.deepEqual([body.inwardIssue, body.outwardIssue], [{ key: "LOOP-1" }, { key: "LOOP-2" }]);
});

test("REGRESSION (live CP-08): raw live issuelinks shapes read as 'LOOP-2 is blocked by LOOP-1' / 'LOOP-1 blocks LOOP-2'", () => {
  const correctLoop2 = { type: { name: "Blocks" }, inwardIssue: { key: "LOOP-1" } };   // LOOP-2 "is blocked by" LOOP-1
  const correctLoop1 = { type: { name: "Blocks" }, outwardIssue: { key: "LOOP-2" } };  // LOOP-1 "blocks" LOOP-2
  assert.equal(blockerOf(PROVEN, correctLoop2), "LOOP-1");
  assert.equal(blockerOf(PROVEN, correctLoop1), null, "the blocker's own entry is not a dependency of the blocker");
  // the REVERSED link that the disproven hypothesis wrote live: LOOP-2 showed outwardIssue LOOP-1, LOOP-1 showed inwardIssue LOOP-2
  assert.equal(blockerOf(PROVEN, { type: { name: "Blocks" }, outwardIssue: { key: "LOOP-1" } }), null, "a reversed link is never read as a dependency");
  assert.equal(blockerOf(PROVEN, { type: { name: "Blocks" }, inwardIssue: { key: "LOOP-2" } }), "LOOP-2", "read on LOOP-1 it would claim LOOP-1 depends on LOOP-2 (drift is detected by reconciliation)");
  // end to end: the written body, rendered the live way, reads back correctly from both issues
  const written = linkBody(PROVEN, { blockerKey: "LOOP-1", dependentKey: "LOOP-2" });
  assert.deepEqual(render(written, "LOOP-2"), correctLoop2);
  assert.deepEqual(render(written, "LOOP-1"), correctLoop1);
});

test("REGRESSION (live CP-08): a reversed live link is reported as DEPENDENCY_DRIFT on both tasks, never accepted", () => {
  const snap = snapshot(block("RT-1", "A"), block("RT-2", "B", "DEPENDS_ON: RT-1\n"));
  const reversed = linkBody(PROVEN, { blockerKey: "LOOP-2", dependentKey: "LOOP-1" }); // blocker/dependent swapped
  const raw = [marked("LOOP-1", snap, "RT-1", [render(reversed, "LOOP-1")]), marked("LOOP-2", snap, "RT-2", [render(reversed, "LOOP-2")])];
  const result = reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation(raw, { relationship: PROVEN }), createdAt: NOW });
  assert.deepEqual([result.noops.length, result.conflicts.map((c) => c.reasonCode).sort()], [0, ["DEPENDENCY_DRIFT", "DEPENDENCY_DRIFT"]]);
});
