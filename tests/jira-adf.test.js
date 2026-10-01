import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { ADF_PROBLEMS, adfTopLevelLines, decodeLoopDescription, encodeLoopDescription, epicIdFromAdf } from "../src/reconcile/jira-adf.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";

const NOW = "2026-09-30T18:00:00.000Z";
const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const facts = { taskId: "RT-1", sourceDocumentId: "doc-1", planVersion: 4, snapshotContentHash: H1, taskHash: H2, acceptanceCriteria: [{ id: "AC-002", text: "second  thing" }, { id: "AC-001", text: "first" }] };
const para = (text) => ({ type: "paragraph", content: [{ type: "text", text }] });
const clone = (value) => structuredClone(value);

test("ADF encode is deterministic, well-formed, and carries the marker and source identity as top-level lines", () => {
  const a = encodeLoopDescription(facts);
  assert.deepEqual(a, encodeLoopDescription({ ...facts, acceptanceCriteria: [...facts.acceptanceCriteria].reverse() }), "AC input order does not matter");
  assert.deepEqual([a.type, a.version], ["doc", 1]);
  assert.deepEqual(adfTopLevelLines(a), ["LOOP_TASK_ID: RT-1", "LOOP_SOURCE_DOCUMENT: doc-1", "LOOP_PLAN_VERSION: 4", `LOOP_SNAPSHOT_HASH: ${H1}`, `LOOP_TASK_HASH: ${H2}`]);
  assert.ok(!JSON.stringify(a).includes("password") && !JSON.stringify(a).includes("token"));
});

test("ADF roundtrip: decode(encode(x)) yields the same machine-readable facts (whitespace normalized, ids sorted)", () => {
  const decoded = decodeLoopDescription(JSON.parse(JSON.stringify(encodeLoopDescription(facts)))); // through JSON like a real API round trip
  assert.deepEqual(decoded, {
    claimed: true, taskId: "RT-1", markerProblem: null, problem: null,
    metadata: { sourceDocumentId: "doc-1", planVersion: 4, snapshotContentHash: H1, taskHash: H2 },
    criteria: [{ id: "AC-001", text: "first" }, { id: "AC-002", text: "second thing" }],
  });
});

test("encode rejects missing or malformed facts", () => {
  for (const bad of [{ taskId: "rt-1" }, { planVersion: 0 }, { sourceDocumentId: "" }, { acceptanceCriteria: [] }, { snapshotContentHash: "x\ny" }]) {
    assert.throws(() => encodeLoopDescription({ ...facts, ...bad }), TypeError, JSON.stringify(bad));
  }
});

const UNSUPPORTED = {
  "human prose paragraph added": (d) => d.content.splice(5, 0, para("Please also handle refunds")),
  "unknown LOOP_ key": (d) => d.content.splice(5, 0, para("LOOP_PRIORITY: high")),
  "duplicate metadata line": (d) => d.content.splice(5, 0, para("LOOP_PLAN_VERSION: 4")),
  "missing metadata line": (d) => d.content.splice(4, 1),
  "bold mark on a line": (d) => { d.content[2].content[0].marks = [{ type: "strong" }]; },
  "unsupported node (code block)": (d) => d.content.push({ type: "codeBlock", content: [{ type: "text", text: "x" }] }),
  "nested list in AC": (d) => { d.content[6].content[0].content.push({ type: "bulletList", content: [] }); },
  "AC list before the heading": (d) => { const [list] = d.content.splice(6, 1); d.content.splice(5, 0, list); },
  "second AC block": (d) => d.content.push(clone(d.content[6])),
  "wrong heading level": (d) => { d.content[5].attrs.level = 3; },
  "AC item not AC-NNN": (d) => { d.content[6].content[0].content[0].content[0].text = "the user is happy"; },
  "duplicate AC id": (d) => d.content[6].content.push(clone(d.content[6].content[0])),
  "AC bullets missing entirely": (d) => d.content.splice(6, 1),
  "non-numeric plan version": (d) => { d.content[2].content[0].text = "LOOP_PLAN_VERSION: four"; },
  "paragraph with two text nodes": (d) => { d.content[1].content.push({ type: "text", text: " extra" }); },
  "hardBreak inside a paragraph": (d) => { d.content[1].content.push({ type: "hardBreak" }); },
};
for (const [name, mutate] of Object.entries(UNSUPPORTED)) {
  test(`unsupported ADF fails closed: ${name}`, () => {
    const doc = clone(encodeLoopDescription(facts));
    mutate(doc);
    const decoded = decodeLoopDescription(doc);
    assert.equal(decoded.claimed, true);
    assert.equal(decoded.criteria, null);
    assert.equal(decoded.metadata, null);
    assert.ok(ADF_PROBLEMS.includes(decoded.problem), `${decoded.problem}`);
    assert.equal(decoded.taskId, "RT-1", "identity is still readable when it is clean, so the owner is known and the issue is a REMOTE_INVALID conflict, not a duplicate-create risk");
  });
}

test("ADF: conflicting or invalid identity markers are not guessed", () => {
  const two = clone(encodeLoopDescription(facts));
  two.content.unshift(para("LOOP_TASK_ID: RT-9"));
  assert.deepEqual([decodeLoopDescription(two).taskId, decodeLoopDescription(two).markerProblem], [null, "MULTIPLE_MARKERS"]);
  const bad = clone(encodeLoopDescription(facts));
  bad.content[0] = para("LOOP_TASK_ID: not an id");
  assert.deepEqual([decodeLoopDescription(bad).taskId, decodeLoopDescription(bad).markerProblem], [null, "INVALID_MARKER"]);
});

test("ADF: rich documents without a Loop marker are FOREIGN (unmarked), never interpreted", () => {
  const rich = { type: "doc", version: 1, content: [{ type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Spec" }] }, { type: "table", content: [] }, para("TASK_ID: RT-1 is mentioned in prose only")] };
  assert.deepEqual(decodeLoopDescription(rich), { claimed: false, taskId: null, markerProblem: null, metadata: null, criteria: null, problem: null });
  for (const notDoc of [null, "a string", { type: "paragraph" }, { type: "doc", version: 2, content: [] }]) assert.equal(decodeLoopDescription(notDoc).claimed, false);
  // a marker nested in a table is not a top-level line, so it is NOT claimed
  assert.equal(decodeLoopDescription({ type: "doc", version: 1, content: [{ type: "table", content: [para("LOOP_TASK_ID: RT-1")] }] }).claimed, false);
});

test("epic marker is read only from a clean top-level ADF line", () => {
  assert.equal(epicIdFromAdf({ type: "doc", version: 1, content: [para("LOOP_EPIC_ID: RT-E4")] }), "RT-E4");
  assert.equal(epicIdFromAdf({ type: "doc", version: 1, content: [para("LOOP_EPIC_ID: RT-E4"), para("LOOP_EPIC_ID: RT-E5")] }), null);
  assert.equal(epicIdFromAdf({ type: "doc", version: 1, content: [para("LOOP_EPIC_ID: bad")] }), null);
  assert.equal(epicIdFromAdf("plain"), null);
});

// ---------- observation + reconciler on ADF issues ----------
const snapshot = makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan(`LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 4\nTASK_ID: RT-1\nTITLE: Alpha\nAC:\n- AC-001: first\n- AC-002: second thing\nEND_LOOP_EXECUTION_PLAN\n`), fetchedAt: NOW, compiledAt: NOW });
const task = snapshot.tasks[0];
const adfIssue = (key, description, summary = "Alpha") => ({ key, fields: { summary, status: { name: "To Do" }, description, issuelinks: [] } });
const reconcile = (raw) => reconcilePlan({ snapshot, observation: normalizeJiraObservation(raw, { relationship: SYNTHETIC_BLOCKS_RELATIONSHIP }), createdAt: NOW });
const loopDoc = () => encodeLoopDescription({ taskId: "RT-1", sourceDocumentId: "doc-1", planVersion: 4, snapshotContentHash: snapshot.contentHash, taskHash: task.taskHash, acceptanceCriteria: task.acceptanceCriteria });

test("a Loop-written ADF issue is observed correctly and reconciles to NOOP / STATE_MATCH, with audit metadata kept out of the fingerprint", () => {
  const observation = normalizeJiraObservation([adfIssue("LOOP-7", loopDoc())]);
  const [issue] = observation.issues;
  assert.deepEqual([issue.taskIdMarker, issue.acceptanceCriteriaProblem], ["RT-1", null]);
  assert.deepEqual(issue.materialization, { sourceDocumentId: "doc-1", planVersion: 4, snapshotContentHash: snapshot.contentHash, taskHash: task.taskHash });
  assert.equal(issue.observedFingerprint, task.taskHash);
  const other = normalizeJiraObservation([adfIssue("LOOP-7", encodeLoopDescription({ taskId: "RT-1", sourceDocumentId: "doc-OTHER", planVersion: 99, snapshotContentHash: H1, taskHash: H2, acceptanceCriteria: task.acceptanceCriteria }))]).issues[0];
  assert.equal(other.observedFingerprint, issue.observedFingerprint, "materialization audit facts are not plan-owned");
  const result = reconcile([adfIssue("LOOP-7", loopDoc())]);
  assert.deepEqual([result.noops[0].decision, result.noops[0].reasonCode, result.noops[0].jiraIssueKey], ["NOOP", "STATE_MATCH", "LOOP-7"]);
});

test("a claimed ADF issue the codec cannot read is CONFLICT / REMOTE_INVALID (never matched loosely, never re-created)", () => {
  const doc = clone(loopDoc());
  doc.content.push(para("A human added a note here"));
  const result = reconcile([adfIssue("LOOP-7", doc)]);
  assert.equal(result.creates.length, 0);
  assert.deepEqual([result.conflicts[0].decision, result.conflicts[0].reasonCode, result.conflicts[0].jiraIssueKey], ["CONFLICT", "REMOTE_INVALID", "LOOP-7"]);
  assert.match(result.conflicts[0].differences[0].observed, /^ADF_/);
});

test("ADF and plain-text descriptions may coexist; a foreign ADF issue is unmarked remoteOnly (and collides only on an exact title)", () => {
  const foreign = { type: "doc", version: 1, content: [para("just a human description")] };
  const result = reconcile([adfIssue("LOOP-8", foreign, "Unrelated"), adfIssue("LOOP-9", null, "Also unrelated")]);
  assert.equal(result.creates[0].taskId, "RT-1");
  assert.deepEqual(result.remoteOnly.map((r) => [r.jiraIssueKey, r.classification]), [["LOOP-8", "UNMARKED_REMOTE_ISSUE"], ["LOOP-9", "UNMARKED_REMOTE_ISSUE"]]);
  const collide = reconcile([adfIssue("LOOP-8", foreign, "Alpha")]);
  assert.equal(collide.conflicts[0].reasonCode, "POTENTIAL_REMOTE_COLLISION");
  const plain = reconcile([{ key: "LOOP-5", fields: { summary: "Alpha", status: { name: "To Do" }, description: `LOOP_TASK_ID: RT-1\n\nAcceptance Criteria\n- AC-001: first\n- AC-002: second thing\n`, issuelinks: [] } }]);
  assert.equal(plain.noops.length, 1, "the plain-text path still works");
});

test("ADF codec purity: no I/O, clock, randomness or model reference", () => {
  const text = readFileSync(new URL("../src/reconcile/jira-adf.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.deepEqual([...text.matchAll(/^import .* from "([^"]+)"/gm)].map((m) => m[1]), ["./fingerprint.js"]);
  assert.ok(!/Date\.now|new Date\(|Math\.random|fetch\(|process\.|anthropic|openai|\bllm\b|claude/i.test(text));
});
