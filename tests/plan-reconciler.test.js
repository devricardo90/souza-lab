import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot, taskBinding } from "../src/plan/plan-snapshot.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { DECISIONS, REASON_CODES, REMOTE_ONLY_CLASSIFICATIONS, ReconcileInputError, reconcilePlan, serializeReconciliation } from "../src/reconcile/plan-reconciler.js";
import { planOwnedFingerprint } from "../src/reconcile/fingerprint.js";

const DOC = "doc-1";
const NOW = "2026-09-30T15:00:00.000Z";

// ---------- builders ----------
const block = (id, title, { epic = null, deps = [], ac = ["first", "second"] } = {}) =>
  `TASK_ID: ${id}\n${epic ? `EPIC_ID: ${epic}\n` : ""}TITLE: ${title}\n${deps.length ? `DEPENDS_ON: ${deps.join(", ")}\n` : ""}AC:\n${ac.map((text, i) => `- AC-00${i + 1}: ${text}`).join("\n")}\n`;
const planText = (version, ...blocks) => `Prose.\nLOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: ${version}\n\n${blocks.join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`;
const snapshot = (version, ...blocks) => makePlanSnapshot({ documentId: DOC, compiled: compilePlan(planText(version, ...blocks)), fetchedAt: NOW, compiledAt: NOW });

const description = (marker, ac = ["first", "second"]) =>
  `${marker ? `LOOP_TASK_ID: ${marker}\n` : ""}Some human context.\n\nAcceptance Criteria\n${ac.map((text, i) => `- AC-00${i + 1}: ${text}`).join("\n")}\n`;
const jira = (key, marker, title, { status = "To Do", ac, parent, blockedBy = [], extraDesc = "" } = {}) => ({
  key,
  fields: {
    summary: title, status: { name: status }, description: `${description(marker, ac)}${extraDesc}`,
    issuelinks: blockedBy.map((k) => ({ type: { name: "Blocks" }, inwardIssue: { key: k } })),
    ...(parent ? { parent: { key: parent } } : {}),
  },
});
const epicIssue = (key, epicId) => ({ key, fields: { summary: `Epic ${epicId}`, issuetype: { name: "Epic" }, description: `LOOP_EPIC_ID: ${epicId}\n`, status: { name: "To Do" } } });
const run = (snap, raw, extra = {}) => reconcilePlan({ snapshot: snap, observation: normalizeJiraObservation(raw, { relationship: SYNTHETIC_BLOCKS_RELATIONSHIP }), createdAt: NOW, ...extra });
const one = (result) => [...result.creates, ...result.noops, ...result.conflicts][0];

const S1 = snapshot(1, block("RT-1", "Alpha"));

// ---------- basic outcomes ----------
test("empty plan vs empty Jira: nothing to do", () => {
  const empty = { documentId: DOC, planVersion: 1, contentHash: "h".repeat(64), tasks: [] };
  const result = reconcilePlan({ snapshot: empty, observation: normalizeJiraObservation([]), createdAt: NOW });
  assert.deepEqual(result.counts, { creates: 0, noops: 0, conflicts: 0, remoteOnly: 0 });
});

test("one desired task and no Jira issue -> CREATE with a deterministic materialization payload (nothing is called or enqueued)", () => {
  const result = run(S1, []);
  assert.deepEqual(result.counts, { creates: 1, noops: 0, conflicts: 0, remoteOnly: 0 });
  const record = result.creates[0];
  assert.deepEqual([record.decision, record.reasonCode, record.taskId, record.jiraIssueKey, record.observedFingerprint], ["CREATE", "TASK_NOT_MATERIALIZED", "RT-1", null, null]);
  assert.deepEqual(record.proposedMaterialization, {
    taskId: "RT-1", title: "Alpha", epicId: null, dependsOn: [],
    acceptanceCriteria: [{ id: "AC-001", text: "first" }, { id: "AC-002", text: "second" }],
    descriptionMarker: "LOOP_TASK_ID: RT-1", sourceDocumentId: DOC, planVersion: 1,
    snapshotContentHash: S1.contentHash, taskHash: S1.tasks[0].taskHash,
  });
  assert.equal(record.planVersion, 1);
  assert.equal(record.snapshotContentHash, S1.contentHash);
  assert.equal(record.createdAt, NOW);
});

test("multiple desired tasks -> CREATE decisions in deterministic TASK_ID order regardless of plan order", () => {
  const a = snapshot(1, block("RT-3", "C"), block("RT-1", "A"), block("RT-2", "B"));
  const b = snapshot(1, block("RT-1", "A"), block("RT-2", "B"), block("RT-3", "C"));
  assert.deepEqual(run(a, []).creates.map((r) => r.taskId), ["RT-1", "RT-2", "RT-3"]);
  assert.equal(serializeReconciliation(run(a, [])), serializeReconciliation(run(b, [])));
});

test("exact match -> NOOP / STATE_MATCH with equal fingerprints; workflow status, key and comments do not matter", () => {
  for (const status of ["To Do", "In Progress", "Done"]) {
    const result = run(S1, [jira("LOOP-7", "RT-1", "Alpha", { status })]);
    const record = result.noops[0];
    assert.deepEqual([record.decision, record.reasonCode, record.jiraIssueKey, record.differences], ["NOOP", "STATE_MATCH", "LOOP-7", []]);
    assert.equal(record.observedFingerprint, record.desiredFingerprint);
  }
});

test("desired fingerprint equals the PlanSnapshot taskHash; fingerprints ignore status/key/comments but see plan-owned drift", () => {
  const task = S1.tasks[0];
  assert.equal(run(S1, []).creates[0].desiredFingerprint, task.taskHash);
  const base = normalizeJiraObservation([jira("LOOP-1", "RT-1", "Alpha")]).issues[0].observedFingerprint;
  assert.equal(normalizeJiraObservation([jira("LOOP-99", "RT-1", "Alpha", { status: "Done", extraDesc: "\nComment-ish trailing text." })]).issues[0].observedFingerprint, base);
  assert.notEqual(normalizeJiraObservation([jira("LOOP-1", "RT-1", "Alpha2")]).issues[0].observedFingerprint, base);
  assert.notEqual(normalizeJiraObservation([jira("LOOP-1", "RT-1", "Alpha", { ac: ["first", "CHANGED"] })]).issues[0].observedFingerprint, base);
  assert.equal(planOwnedFingerprint({ taskId: "X-1", title: "t", dependsOn: ["B-1", "A-1"], acceptanceCriteria: [{ id: "AC-002", text: "b" }, { id: "AC-001", text: "a" }] }),
    planOwnedFingerprint({ taskId: "X-1", title: "t", dependsOn: ["A-1", "B-1"], acceptanceCriteria: [{ id: "AC-001", text: "a" }, { id: "AC-002", text: "b" }] }));
});

test("equivalent semantics with different cosmetic form -> NOOP (whitespace, NBSP, AC order, dependency link order)", () => {
  const snap = snapshot(1, block("RT-1", "Alpha"), block("RT-2", "Beta two", { deps: ["RT-1"] }));
  const raw = [
    jira("LOOP-1", "RT-1", "  Alpha  "),
    { ...jira("LOOP-2", "RT-2", "Beta two", { blockedBy: ["LOOP-1"] }) },
  ];
  raw[0].fields.description = "LOOP_TASK_ID: RT-1\r\n\r\nAcceptance Criteria\r\n- AC-002:   second\r\n- AC-001: first\r\n";
  const result = run(snap, raw);
  assert.deepEqual(result.noops.map((r) => r.taskId), ["RT-1", "RT-2"]);
  assert.equal(result.conflicts.length, 0);
});

test("task reordering in plan or Jira -> same decisions", () => {
  const snapA = snapshot(1, block("RT-1", "A"), block("RT-2", "B"));
  const snapB = snapshot(1, block("RT-2", "B"), block("RT-1", "A"));
  const raw = [jira("LOOP-2", "RT-2", "B"), jira("LOOP-1", "RT-1", "A")];
  assert.equal(serializeReconciliation(run(snapA, raw)), serializeReconciliation(run(snapB, [...raw].reverse())));
});

// ---------- identity ----------
test("duplicate Jira TASK_ID -> CONFLICT / DUPLICATE_TASK_ID_REMOTE, no issue is picked", () => {
  const result = run(S1, [jira("LOOP-2", "RT-1", "Alpha"), jira("LOOP-1", "RT-1", "Alpha")]);
  const record = result.conflicts[0];
  assert.deepEqual([record.decision, record.reasonCode, record.jiraIssueKey, record.jiraIssueKeys], ["CONFLICT", "DUPLICATE_TASK_ID_REMOTE", null, ["LOOP-1", "LOOP-2"]]);
  assert.equal(record.differences.length, 2);
});

test("unmarked issue with the SAME normalized title: never becomes the owner, and the task fails closed as POTENTIAL_REMOTE_COLLISION (no autonomous duplicate)", () => {
  const result = run(S1, [jira("LOOP-5", null, "  Alpha ")]);
  assert.equal(result.creates.length + result.noops.length, 0, "neither CREATE nor NOOP");
  const record = result.conflicts[0];
  assert.deepEqual([record.taskId, record.decision, record.reasonCode, record.jiraIssueKey, record.jiraIssueKeys], ["RT-1", "CONFLICT", "POTENTIAL_REMOTE_COLLISION", null, ["LOOP-5"]]);
  assert.deepEqual(record.differences, [{ field: "identity", kind: "UNMARKED_TITLE_COLLISION", key: "LOOP-5", desired: "Alpha", observed: "Alpha" }]);
  assert.equal(record.observedFingerprint, null, "the colliding issue is not treated as the task's observed state");
  assert.ok(!("proposedMaterialization" in record));
  assert.deepEqual(result.remoteOnly.map((r) => [r.jiraIssueKey, r.classification]), [["LOOP-5", "UNMARKED_REMOTE_ISSUE"]], "it stays an unmarked remote issue");
  const two = run(S1, [jira("LOOP-9", null, "Alpha"), jira("LOOP-5", null, "Alpha")]).conflicts[0];
  assert.deepEqual(two.jiraIssueKeys, ["LOOP-5", "LOOP-9"]);
});

test("unmarked issue with a DIFFERENT title is unrelated: the task is CREATE and the issue is remoteOnly UNMARKED", () => {
  const result = run(S1, [jira("LOOP-5", null, "Alpha but not really")]);
  assert.equal(result.creates[0].taskId, "RT-1");
  assert.deepEqual(result.remoteOnly.map((r) => [r.jiraIssueKey, r.classification, r.taskIdMarker]), [["LOOP-5", "UNMARKED_REMOTE_ISSUE", null]]);
  assert.equal(result.noops.length + result.conflicts.length, 0);
});

test("a marked owner wins over an unmarked same-title issue (no collision when the TASK_ID is already owned)", () => {
  const result = run(S1, [jira("LOOP-1", "RT-1", "Alpha"), jira("LOOP-5", null, "Alpha")]);
  assert.deepEqual(result.noops.map((r) => r.jiraIssueKey), ["LOOP-1"]);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.remoteOnly.map((r) => r.jiraIssueKey), ["LOOP-5"]);
});

test("a marked issue of ANOTHER task with the same title is not a collision (identity is known)", () => {
  const result = run(S1, [jira("LOOP-2", "RT-2", "Alpha")], { historicalTaskIds: ["RT-2"] });
  assert.equal(result.creates[0].taskId, "RT-1");
});

test("ambiguous markers (two different TASK_IDs, or an invalid marker) -> remoteOnly AMBIGUOUS_REMOTE_IDENTITY", () => {
  const multi = jira("LOOP-1", "RT-1", "Alpha", { extraDesc: "\nLOOP_TASK_ID: RT-9\n" });
  const invalid = jira("LOOP-2", "rt-bad", "Alpha");
  const result = run(S1, [multi, invalid]);
  assert.deepEqual(result.remoteOnly.map((r) => [r.jiraIssueKey, r.classification]), [["LOOP-1", "AMBIGUOUS_REMOTE_IDENTITY"], ["LOOP-2", "AMBIGUOUS_REMOTE_IDENTITY"]]);
  // they have no usable marker and carry the task's exact title: fail closed rather than create a probable duplicate
  assert.deepEqual([result.creates.length, result.conflicts[0].reasonCode, result.conflicts[0].jiraIssueKeys], [0, "POTENTIAL_REMOTE_COLLISION", ["LOOP-1", "LOOP-2"]]);
});

// ---------- drift -> CONFLICT ----------
const only = (snap, raw, extra) => one(run(snap, raw, extra));

test("title drift -> CONFLICT / TITLE_DRIFT", () => {
  const record = only(S1, [jira("LOOP-1", "RT-1", "Alpha renamed by a human")]);
  assert.deepEqual([record.decision, record.reasonCode], ["CONFLICT", "TITLE_DRIFT"]);
  assert.deepEqual(record.differences, [{ field: "title", kind: "CHANGED", key: null, desired: "Alpha", observed: "Alpha renamed by a human" }]);
  assert.notEqual(record.observedFingerprint, record.desiredFingerprint);
});

test("AC drift (changed / missing / extra) -> CONFLICT / AC_DRIFT", () => {
  assert.deepEqual(only(S1, [jira("LOOP-1", "RT-1", "Alpha", { ac: ["first", "edited"] })]).differences.map((d) => [d.kind, d.key]), [["CHANGED", "AC-002"]]);
  assert.deepEqual(only(S1, [jira("LOOP-1", "RT-1", "Alpha", { ac: ["first"] })]).differences.map((d) => [d.kind, d.key]), [["MISSING", "AC-002"]]);
  const extra = only(S1, [jira("LOOP-1", "RT-1", "Alpha", { ac: ["first", "second", "third"] })]);
  assert.deepEqual([extra.reasonCode, extra.differences.map((d) => [d.kind, d.key])], ["AC_DRIFT", [["EXTRA", "AC-003"]]]);
});

test("unparseable remote AC -> CONFLICT / REMOTE_INVALID (never guessed)", () => {
  const raw = jira("LOOP-1", "RT-1", "Alpha");
  raw.fields.description = "LOOP_TASK_ID: RT-1\n\nAcceptance Criteria\n- the user is happy\n";
  const record = only(S1, [raw]);
  assert.deepEqual([record.decision, record.reasonCode, record.differences[0].kind], ["CONFLICT", "REMOTE_INVALID", "REMOTE_UNPARSEABLE"]);
  raw.fields.description = "LOOP_TASK_ID: RT-1\n";
  assert.equal(only(S1, [raw]).reasonCode, "REMOTE_INVALID");
});

test("dependencies: missing, extra, unknown TASK_ID, unmarked target, unknown issue -> CONFLICT / DEPENDENCY_DRIFT", () => {
  const snap = snapshot(1, block("RT-1", "A"), block("RT-2", "B", { deps: ["RT-1"] }), block("RT-3", "C"));
  const base = [jira("LOOP-1", "RT-1", "A"), jira("LOOP-3", "RT-3", "C")];
  const missing = run(snap, [...base, jira("LOOP-2", "RT-2", "B")]).conflicts[0];
  assert.deepEqual([missing.taskId, missing.reasonCode, missing.differences.map((d) => [d.kind, d.key])], ["RT-2", "DEPENDENCY_DRIFT", [["MISSING", "RT-1"]]]);
  const extra = run(snap, [...base, jira("LOOP-2", "RT-2", "B", { blockedBy: ["LOOP-1", "LOOP-3"] })]).conflicts[0];
  assert.deepEqual(extra.differences.map((d) => [d.kind, d.key]), [["EXTRA", "RT-3"]]);
  const unknownTask = run(snap, [...base, jira("LOOP-2", "RT-2", "B", { blockedBy: ["LOOP-1", "LOOP-9"] }), jira("LOOP-9", "RT-99", "Ghost")]).conflicts[0];
  assert.deepEqual(unknownTask.differences.map((d) => [d.kind, d.key]), [["EXTRA", "RT-99"]]);
  const unmarked = run(snap, [...base, jira("LOOP-2", "RT-2", "B", { blockedBy: ["LOOP-1", "LOOP-8"] }), jira("LOOP-8", null, "Unmarked")]).conflicts[0];
  assert.deepEqual(unmarked.differences.map((d) => [d.kind, d.key, d.observed]), [["UNKNOWN_REMOTE_DEPENDENCY", "LOOP-8", "NO_MARKER"]]);
  const unknownIssue = run(snap, [...base, jira("LOOP-2", "RT-2", "B", { blockedBy: ["LOOP-1", "LOOP-404"] })]).conflicts[0];
  assert.deepEqual(unknownIssue.differences.map((d) => [d.kind, d.observed]), [["UNKNOWN_REMOTE_DEPENDENCY", "UNKNOWN_ISSUE"]]);
  const ambiguous = run(snap, [...base, jira("LOOP-2", "RT-2", "B", { blockedBy: ["LOOP-1", "LOOP-7"] }), jira("LOOP-7", "RT-7", "Amb", { extraDesc: "\nLOOP_TASK_ID: RT-8\n" })]).conflicts[0];
  assert.deepEqual(ambiguous.differences.map((d) => d.kind), ["AMBIGUOUS_REMOTE_DEPENDENCY"]);
  assert.ok([missing, extra, unknownTask, unmarked, unknownIssue, ambiguous].every((r) => r.decision === "CONFLICT"));
});

test("matching dependency and matching epic -> NOOP (dependencies compared by TASK_ID, not Jira key)", () => {
  const snap = snapshot(1, block("RT-1", "A", { epic: "RT-E4" }), block("RT-2", "B", { epic: "RT-E4", deps: ["RT-1"] }));
  const raw = [epicIssue("LOOP-100", "RT-E4"), jira("LOOP-55", "RT-1", "A", { parent: "LOOP-100" }), jira("LOOP-3", "RT-2", "B", { parent: "LOOP-100", blockedBy: ["LOOP-55"] })];
  const result = run(snap, raw);
  assert.deepEqual(result.noops.map((r) => r.taskId), ["RT-1", "RT-2"]);
  assert.equal(result.remoteOnly.length, 0, "Epic issues are not task candidates");
});

test("epic drift: moved, missing, extra, unresolved parent -> CONFLICT / EPIC_DRIFT", () => {
  const withEpic = snapshot(1, block("RT-1", "A", { epic: "RT-E4" }));
  const epics = [epicIssue("LOOP-100", "RT-E4"), epicIssue("LOOP-101", "RT-E5")];
  assert.deepEqual(only(withEpic, [...epics, jira("LOOP-1", "RT-1", "A", { parent: "LOOP-101" })]).differences.map((d) => [d.kind, d.desired, d.observed]), [["CHANGED", "RT-E4", "RT-E5"]]);
  assert.deepEqual(only(withEpic, [...epics, jira("LOOP-1", "RT-1", "A")]).differences.map((d) => d.kind), ["MISSING"]);
  assert.deepEqual(only(S1, [...epics, jira("LOOP-1", "RT-1", "Alpha", { parent: "LOOP-100" })]).differences.map((d) => d.kind), ["EXTRA"]);
  const unresolved = only(withEpic, [jira("LOOP-1", "RT-1", "A", { parent: "LOOP-999" })]);
  assert.deepEqual([unresolved.reasonCode, unresolved.differences[0].kind], ["EPIC_DRIFT", "UNRESOLVED_REMOTE_EPIC"]);
});

test("several kinds of drift at once -> REMOTE_DEFINITION_DRIFT with every difference listed in stable order", () => {
  const record = only(S1, [jira("LOOP-1", "RT-1", "Other", { ac: ["x"] })]);
  assert.equal(record.reasonCode, "REMOTE_DEFINITION_DRIFT");
  assert.deepEqual(record.differences.map((d) => [d.field, d.kind, d.key]), [["title", "CHANGED", null], ["acceptanceCriteria", "CHANGED", "AC-001"], ["acceptanceCriteria", "MISSING", "AC-002"]]);
});

// ---------- source version change ----------
test("plan v2 changes a task; Jira still reflects v1 -> deterministic CONFLICT, existing issue untouched, v1 binding unchanged", () => {
  const v1 = snapshot(1, block("RT-1", "Alpha"));
  const v2 = snapshot(2, block("RT-1", "Alpha, reworded"));
  const jiraStillV1 = [jira("LOOP-1", "RT-1", "Alpha")];
  assert.equal(only(v1, jiraStillV1).decision, "NOOP");
  const binding = taskBinding(v1, "RT-1"); // the running WorkPackage's permanent binding
  const bindingBefore = structuredClone(binding);
  const frozenRaw = structuredClone(jiraStillV1);
  const result = run(v2, jiraStillV1, { bindings: [binding] });
  const record = result.conflicts[0];
  assert.deepEqual([record.decision, record.reasonCode, record.planVersion, record.snapshotContentHash], ["CONFLICT", "TITLE_DRIFT", 2, v2.contentHash]);
  assert.deepEqual(record.sourceVersionDrift, { boundPlanVersion: 1, boundContentHash: v1.contentHash, boundTaskHash: v1.tasks[0].taskHash, desiredPlanVersion: 2, desiredTaskHash: v2.tasks[0].taskHash });
  assert.deepEqual(binding, bindingBefore, "the v1 binding is never altered");
  assert.deepEqual(jiraStillV1, frozenRaw, "inputs are never mutated");
  assert.equal(binding.planVersion, 1);
});

test("a new plan version that does NOT change the task reports no source-version drift; a v2 change is reported even on a matching Jira", () => {
  const v1 = snapshot(1, block("RT-1", "Alpha"), block("RT-2", "Beta"));
  const v2 = snapshot(2, block("RT-1", "Alpha"), block("RT-2", "Beta renamed"));
  const raw = [jira("LOOP-1", "RT-1", "Alpha"), jira("LOOP-2", "RT-2", "Beta")];
  const result = run(v2, raw, { bindings: [taskBinding(v1, "RT-1"), taskBinding(v1, "RT-2")] });
  assert.equal(result.noops[0].sourceVersionDrift, null);
  assert.equal(result.conflicts[0].taskId, "RT-2");
  assert.equal(result.conflicts[0].sourceVersionDrift.boundPlanVersion, 1);
});

// ---------- removed tasks ----------
test("a Jira issue for a task removed from the plan -> remoteOnly ORPHANED_REMOVED_TASK; unknown markers are classified differently; nothing is deleted/closed", () => {
  const v2 = snapshot(2, block("RT-1", "Alpha"));
  const raw = [jira("LOOP-1", "RT-1", "Alpha"), jira("LOOP-2", "RT-2", "Removed one", { status: "In Progress" }), jira("LOOP-3", "RT-77", "Never in any plan")];
  const result = run(v2, raw, { historicalTaskIds: ["RT-1", "RT-2"] });
  assert.deepEqual(result.remoteOnly.map((r) => [r.jiraIssueKey, r.classification, r.status]), [["LOOP-2", "ORPHANED_REMOVED_TASK", "In Progress"], ["LOOP-3", "UNKNOWN_TASK_MARKER", "To Do"]]);
  assert.equal(result.noops.length, 1);
  assert.ok(!result.creates.some((r) => r.taskId === "RT-2"), "a removed task is not re-created");
});

test("removed task that still has a duplicate Jira marker is flagged", () => {
  const result = run(S1, [jira("LOOP-1", "RT-1", "Alpha"), jira("LOOP-2", "RT-2", "x"), jira("LOOP-3", "RT-2", "y")], { historicalTaskIds: ["RT-2"] });
  assert.deepEqual(result.remoteOnly.map((r) => [r.jiraIssueKey, r.duplicateMarker]), [["LOOP-2", true], ["LOOP-3", true]]);
});

// ---------- global result ----------
test("mixed result: one CREATE + one NOOP + one CONFLICT + remoteOnly, derived counts and deterministic ordering", () => {
  const snap = snapshot(3, block("RT-3", "C"), block("RT-1", "A"), block("RT-2", "B"));
  const raw = [jira("LOOP-9", "RT-9", "Orphan"), jira("LOOP-2", "RT-2", "B but edited"), jira("LOOP-1", "RT-1", "A"), jira("LOOP-4", null, "Loose")];
  const result = run(snap, raw, { historicalTaskIds: ["RT-9"] });
  assert.deepEqual(result.creates.map((r) => r.taskId), ["RT-3"]);
  assert.deepEqual(result.noops.map((r) => r.taskId), ["RT-1"]);
  assert.deepEqual(result.conflicts.map((r) => r.taskId), ["RT-2"]);
  assert.deepEqual(result.remoteOnly.map((r) => r.jiraIssueKey), ["LOOP-4", "LOOP-9"]);
  assert.deepEqual(result.counts, { creates: result.creates.length, noops: result.noops.length, conflicts: result.conflicts.length, remoteOnly: result.remoteOnly.length });
  assert.deepEqual([result.documentId, result.planVersion, result.snapshotContentHash], [DOC, 3, snap.contentHash]);
  assert.ok(result.creates.length + result.noops.length + result.conflicts.length === snap.tasks.length);
});

test("every record has structured fields; reason codes and classifications are from the explicit, closed sets", () => {
  const snap = snapshot(1, block("RT-1", "A"), block("RT-2", "B"), block("RT-3", "C"));
  const result = run(snap, [jira("LOOP-1", "RT-1", "A"), jira("LOOP-2", "RT-2", "drift"), jira("LOOP-8", null, "x")]);
  for (const record of [...result.creates, ...result.noops, ...result.conflicts]) {
    for (const field of ["taskId", "planVersion", "snapshotContentHash", "decision", "reasonCode", "desiredFingerprint", "observedFingerprint", "jiraIssueKey", "differences", "createdAt"]) assert.ok(field in record, `${field} missing`);
    assert.ok(DECISIONS.includes(record.decision));
    assert.ok(REASON_CODES.includes(record.reasonCode));
    assert.match(record.desiredFingerprint, /^[0-9a-f]{64}$/);
  }
  assert.ok(result.remoteOnly.every((r) => REMOTE_ONLY_CLASSIFICATIONS.includes(r.classification)));
  assert.deepEqual([...new Set(REASON_CODES)].length, REASON_CODES.length);
});

// ---------- determinism & purity ----------
test("identical input -> byte-equivalent logical result; input order of Jira issues and links does not matter; results and inputs are frozen/unmutated", () => {
  const snap = snapshot(2, block("RT-2", "B", { deps: ["RT-1"] }), block("RT-1", "A"));
  const raw = [jira("LOOP-2", "RT-2", "B", { blockedBy: ["LOOP-1"] }), jira("LOOP-1", "RT-1", "A"), jira("LOOP-5", "RT-5", "Orphan"), jira("LOOP-6", null, "Loose")];
  const rawBefore = structuredClone(raw);
  const a = serializeReconciliation(run(snap, raw));
  assert.equal(a, serializeReconciliation(run(snap, raw)));
  assert.equal(a, serializeReconciliation(run(snap, [...raw].reverse())));
  assert.deepEqual(raw, rawBefore);
  const result = run(snap, raw);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.creates) && Object.isFrozen(result.counts));
  assert.throws(() => { "use strict"; result.counts.creates = 99; }, TypeError);
});

test("the reconciler has no clock: createdAt is required from the caller and is the only time in the output", () => {
  assert.throws(() => reconcilePlan({ snapshot: S1, observation: normalizeJiraObservation([]) }), ReconcileInputError);
  const result = run(S1, []);
  const again = reconcilePlan({ snapshot: S1, observation: normalizeJiraObservation([]), createdAt: "2030-01-01T00:00:00Z" });
  assert.equal(again.creates[0].createdAt, "2030-01-01T00:00:00.000Z");
  assert.equal(serializeReconciliation(result).replaceAll(NOW, "T"), serializeReconciliation(again).replaceAll("2030-01-01T00:00:00.000Z", "T"));
});

test("malformed inputs fail closed instead of producing decisions", () => {
  assert.throws(() => reconcilePlan({ snapshot: null, observation: normalizeJiraObservation([]), createdAt: NOW }), ReconcileInputError);
  assert.throws(() => reconcilePlan({ snapshot: S1, observation: null, createdAt: NOW }), ReconcileInputError);
  assert.throws(() => normalizeJiraObservation("nope"), { code: "INVALID_JIRA_OBSERVATION" });
  assert.throws(() => normalizeJiraObservation([jira("LOOP-1", "RT-1", "a"), jira("LOOP-1", "RT-1", "a")]), { code: "DUPLICATE_ISSUE_KEY" });
  assert.throws(() => run(S1, [], { bindings: [{ ...taskBinding(S1, "RT-1"), documentId: "other-doc" }] }), ReconcileInputError);
});

test("purity: reconcile modules import no I/O, network, database, timer, clock, randomness, or model client", () => {
  for (const file of ["../src/reconcile/plan-reconciler.js", "../src/reconcile/jira-observation.js", "../src/reconcile/fingerprint.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const imports = [...text.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(imports.every((spec) => spec === "node:crypto" || spec.startsWith("./")), `${file} imports: ${imports}`);
    assert.ok(!/Date\.now|new Date\(\)|Math\.random|setTimeout|setInterval|fetch\(|process\.|anthropic|openai|\bllm\b|claude/i.test(text), `${file} must be pure`);
  }
});
