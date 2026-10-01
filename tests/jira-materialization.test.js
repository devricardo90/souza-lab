import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";
import { encodeLoopDescription } from "../src/reconcile/jira-adf.js";
import { MaterializationConfigError, buildMaterializationOperations, jiraCreateOperationId, parseMaterializationConfig } from "../src/materialize/jira-materialization.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";

const NOW = "2026-09-30T19:00:00.000Z";
const CONFIG = { projectKey: "LOOP", issueTypeName: "Task" };
const block = (id, title, extra = "") => `TASK_ID: ${id}\nTITLE: ${title}\n${extra}AC:\n- AC-001: ${title} works\n`;
const snapshot = (version, ...blocks) => makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan(`LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: ${version}\n${blocks.join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`), fetchedAt: NOW, compiledAt: NOW });
const decide = (snap, raw = []) => reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation(raw, { relationship: SYNTHETIC_BLOCKS_RELATIONSHIP }), createdAt: NOW });
const loopIssue = (snap, taskId, key) => {
  const task = snap.tasks.find((t) => t.taskId === taskId);
  return { key, fields: { summary: task.title, status: { name: "To Do" }, issuelinks: [], description: encodeLoopDescription({ taskId, sourceDocumentId: snap.documentId, planVersion: snap.planVersion, snapshotContentHash: snap.contentHash, taskHash: task.taskHash, acceptanceCriteria: task.acceptanceCriteria }) } };
};

test("CREATE decision -> one deterministic JIRA_CREATE operation spec carrying the proposed materialization", () => {
  const snap = snapshot(1, block("RT-1", "Alpha"));
  const { operations, blocked } = buildMaterializationOperations({ reconciliation: decide(snap), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  assert.equal(blocked.length, 0);
  assert.equal(operations.length, 1);
  const [op] = operations;
  assert.deepEqual([op.action, op.targetSystem, op.targetObject, op.taskId, op.executionId, op.sourceRevision, op.head], ["JIRA_CREATE", "JIRA", "LOOP", "RT-1", null, snap.contentHash, null]);
  assert.equal(op.operationId, jiraCreateOperationId({ projectKey: "LOOP", documentId: "doc-1", taskId: "RT-1" }));
  assert.deepEqual(op.expectedPreviousState, { taskIdAbsent: "RT-1" });
  assert.deepEqual(op.desiredState, { projectKey: "LOOP", issueTypeName: "Task", materialization: decide(snap).creates[0].proposedMaterialization });
  assert.equal(op.desiredState.materialization.descriptionMarker, "LOOP_TASK_ID: RT-1");
});

test("operation_id is deterministic and independent of title, Jira key, ordering, plan version, task hash and randomness", () => {
  const a = buildMaterializationOperations({ reconciliation: decide(snapshot(1, block("RT-2", "B"), block("RT-1", "A"))), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  const b = buildMaterializationOperations({ reconciliation: decide(snapshot(1, block("RT-1", "A"), block("RT-2", "B"))), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  assert.deepEqual(a.operations.map((o) => o.operationId), b.operations.map((o) => o.operationId));
  assert.deepEqual(a.operations.map((o) => o.taskId), ["RT-1", "RT-2"]);
  assert.equal(JSON.stringify(a.operations), JSON.stringify(b.operations));
  const renamedV2 = buildMaterializationOperations({ reconciliation: decide(snapshot(2, block("RT-1", "A renamed"), block("RT-2", "B"))), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  assert.equal(renamedV2.operations[0].operationId, a.operations[0].operationId, "one TASK_ID has one materialization identity");
  assert.notEqual(jiraCreateOperationId({ projectKey: "LOOP", documentId: "doc-1", taskId: "RT-1" }), jiraCreateOperationId({ projectKey: "OTHR", documentId: "doc-1", taskId: "RT-1" }));
  assert.notEqual(jiraCreateOperationId({ projectKey: "LOOP", documentId: "doc-1", taskId: "RT-1" }), jiraCreateOperationId({ projectKey: "LOOP", documentId: "doc-2", taskId: "RT-1" }));
  assert.match(a.operations[0].operationId, /^JIRA_CREATE:[0-9a-f]{64}$/);
});

test("duplicate enqueue of the same logical materialization is ONE outbox operation; a changed payload is rejected, not duplicated", () => {
  const store = new SqliteOutboxStore({ path: ":memory:", clock: () => NOW });
  try {
    const [op] = buildMaterializationOperations({ reconciliation: decide(snapshot(1, block("RT-1", "Alpha"))), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } }).operations;
    assert.deepEqual([store.enqueue(op).created, store.enqueue(op).created, store.enqueue({ ...op }).created], [true, false, false]);
    assert.equal(store.list().length, 1);
    const [changed] = buildMaterializationOperations({ reconciliation: decide(snapshot(2, block("RT-1", "Alpha reworded"))), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } }).operations;
    assert.equal(changed.operationId, op.operationId);
    assert.throws(() => store.enqueue(changed), { code: "OPERATION_ID_CONFLICT" });
    assert.equal(store.list().length, 1);
  } finally { store.close(); }
});

test("only CREATE decisions become operations: NOOP, CONFLICT and remoteOnly never do", () => {
  const snap = snapshot(1, block("RT-1", "Matching"), block("RT-2", "Drifted"), block("RT-3", "Brand new"), block("RT-4", "Collides"));
  const raw = [
    loopIssue(snap, "RT-1", "LOOP-1"),
    { ...loopIssue(snap, "RT-2", "LOOP-2"), fields: { ...loopIssue(snap, "RT-2", "LOOP-2").fields, summary: "Edited by a human" } },
    { key: "LOOP-4", fields: { summary: "Collides", status: { name: "To Do" }, description: null, issuelinks: [] } },
    { key: "LOOP-5", fields: { summary: "Orphan", status: { name: "To Do" }, description: null, issuelinks: [] } },
  ];
  const reconciliation = decide(snap, raw);
  assert.deepEqual([reconciliation.creates.map((r) => r.taskId), reconciliation.noops.map((r) => r.taskId), reconciliation.conflicts.map((r) => [r.taskId, r.reasonCode]), reconciliation.remoteOnly.length],
    [["RT-3"], ["RT-1"], [["RT-2", "TITLE_DRIFT"], ["RT-4", "POTENTIAL_REMOTE_COLLISION"]], 2]);
  const { operations } = buildMaterializationOperations({ reconciliation, config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  assert.deepEqual(operations.map((o) => o.taskId), ["RT-3"]);
});

test("CREATE needing an Epic link is BLOCKED; a dependent CREATE waits until its dependencies are materialized (never created with a dropped relationship)", () => {
  const snap = snapshot(1, block("RT-1", "Plain"), block("RT-2", "Linked", "DEPENDS_ON: RT-1\n"), block("RT-3", "Epic child", "EPIC_ID: RT-E4\n"), block("RT-4", "Both", "EPIC_ID: RT-E4\nDEPENDS_ON: RT-1\n"));
  const first = buildMaterializationOperations({ reconciliation: decide(snap), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  assert.deepEqual(first.operations.map((o) => o.taskId), ["RT-1"]);
  assert.deepEqual(first.blocked.map((b) => [b.taskId, b.reasonCode]), [["RT-2", "DEPENDENCY_NOT_MATERIALIZED"], ["RT-3", "RELATIONSHIPS_NOT_SUPPORTED"], ["RT-4", "RELATIONSHIPS_NOT_SUPPORTED"]]);
  assert.match(first.blocked[0].detail, /RT-1/);
  assert.match(first.blocked[2].detail, /Epic link \(RT-E4\) and dependency links \(RT-1\)/);
  // once RT-1 exists in Jira, the dependent task becomes creatable; the Epic tasks stay blocked
  const second = buildMaterializationOperations({ reconciliation: decide(snap, [loopIssue(snap, "RT-1", "LOOP-1")]), config: { ...CONFIG, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP } });
  assert.deepEqual(second.operations.map((o) => o.taskId), ["RT-2"]);
  assert.deepEqual(second.operations[0].desiredState.materialization.dependsOn, ["RT-1"]);
  assert.deepEqual(second.blocked.map((b) => b.taskId), ["RT-3", "RT-4"]);
});

test("missing or invalid project configuration fails closed with CONFIG_INVALID", () => {
  const reconciliation = decide(snapshot(1, block("RT-1", "Alpha")));
  for (const bad of [undefined, null, {}, { projectKey: "LOOP" }, { issueTypeName: "Task" }, { projectKey: "loop", issueTypeName: "Task" }, { projectKey: "L", issueTypeName: "Task" }, { projectKey: "LOOP", issueTypeName: "  " }, { projectKey: "LOOP", issueTypeName: "a\nb" }, { projectKey: 7, issueTypeName: "Task" }]) {
    assert.throws(() => buildMaterializationOperations({ reconciliation, config: bad }), (error) => error instanceof MaterializationConfigError && error.code === "CONFIG_INVALID", JSON.stringify(bad));
    assert.throws(() => parseMaterializationConfig(bad), { code: "CONFIG_INVALID" });
  }
  assert.deepEqual({ ...parseMaterializationConfig({ projectKey: "LOOP", issueTypeName: " Task " }) }, { projectKey: "LOOP", issueTypeName: "Task" });
});

test("the materialization layer is pure: no I/O, store, network, clock, randomness or model reference", () => {
  const text = readFileSync(new URL("../src/materialize/jira-materialization.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.deepEqual([...text.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]), ["node:crypto", "../reconcile/jira-relationship.js"]);
  assert.ok(!/Date\.now|new Date\(|Math\.random|fetch\(|process\.|anthropic|openai|\bllm\b|claude|sqlite|outbox/i.test(text));
});
