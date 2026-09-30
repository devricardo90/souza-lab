import assert from "node:assert/strict";
import test from "node:test";
import { PlanCompileError, compilePlan } from "../src/plan/plan-compiler.js";

const plan = (body, { version = 17, grammar = 1 } = {}) => `Intro prose that is not executable.\n\nLOOP_EXECUTION_PLAN: ${grammar}\nPLAN_VERSION: ${version}\n\n${body}\nEND_LOOP_EXECUTION_PLAN\n\nTrailing prose.\n`;
const TASK_37 = "TASK_ID: RT-37\nEPIC_ID: RT-E4\nTITLE: Booking flow\nDEPENDS_ON: RT-35\nAC:\n- AC-001: user can book a slot\n- AC-002: double booking is refused\n";
const TASK_35 = "TASK_ID: RT-35\nTITLE: Slot model\nAC:\n- AC-001: slots are persisted\n";
const code = (source) => { try { compilePlan(source); return "COMPILED"; } catch (error) { assert.ok(error instanceof PlanCompileError, error.stack); return error.code; } };

test("valid one-task plan compiles to a canonical plan with a content hash", () => {
  const { canonicalPlan, contentHash } = compilePlan(plan(TASK_35));
  assert.equal(canonicalPlan.planVersion, 17);
  assert.equal(canonicalPlan.grammarVersion, 1);
  assert.deepEqual(canonicalPlan.tasks.map((t) => [t.taskId, t.title, t.epicId, t.dependsOn]), [["RT-35", "Slot model", null, []]]);
  assert.match(contentHash, /^[0-9a-f]{64}$/);
});

test("valid multi-task plan with a dependency chain", () => {
  const source = plan(`${TASK_37}\nTASK_ID: RT-36\nTITLE: Payments\nDEPENDS_ON: RT-35, RT-37\nAC:\n- AC-001: pay\n\n${TASK_35}`);
  const { canonicalPlan } = compilePlan(source);
  assert.deepEqual(canonicalPlan.tasks.map((t) => t.taskId), ["RT-35", "RT-36", "RT-37"]);
  assert.deepEqual(canonicalPlan.tasks.find((t) => t.taskId === "RT-36").dependsOn, ["RT-35", "RT-37"]);
  assert.equal(canonicalPlan.tasks.find((t) => t.taskId === "RT-37").epicId, "RT-E4");
});

const REJECTED = [
  ["duplicate TASK_ID", plan(`${TASK_35}\n${TASK_35}`), "DUPLICATE_TASK_ID"],
  ["missing TASK_ID (field before any task)", plan("TITLE: Orphan\nAC:\n- AC-001: x\n"), "MISSING_TASK_ID"],
  ["empty TASK_ID", plan("TASK_ID:\nTITLE: t\nAC:\n- AC-001: x\n"), "MISSING_TASK_ID"],
  ["invalid TASK_ID", plan("TASK_ID: rt-37\nTITLE: t\nAC:\n- AC-001: x\n"), "INVALID_TASK_ID"],
  ["invalid TASK_ID (title-derived style)", plan("TASK_ID: Booking flow\nTITLE: t\nAC:\n- AC-001: x\n"), "INVALID_TASK_ID"],
  ["duplicate AC id", plan("TASK_ID: RT-1\nTITLE: t\nAC:\n- AC-001: a\n- AC-001: b\n"), "DUPLICATE_AC"],
  ["malformed AC (no id)", plan("TASK_ID: RT-1\nTITLE: t\nAC:\n- the user can log in\n"), "MALFORMED_AC"],
  ["malformed AC (bad id)", plan("TASK_ID: RT-1\nTITLE: t\nAC:\n- AC-1: a\n"), "MALFORMED_AC"],
  ["AC inline text", plan("TASK_ID: RT-1\nTITLE: t\nAC: inline\n"), "MALFORMED_AC"],
  ["no AC at all", plan("TASK_ID: RT-1\nTITLE: t\n"), "MISSING_AC"],
  ["missing TITLE", plan("TASK_ID: RT-1\nAC:\n- AC-001: a\n"), "MISSING_TITLE"],
  ["missing dependency target", plan(`${TASK_37}`), "MISSING_DEPENDENCY"],
  ["self dependency", plan("TASK_ID: RT-1\nTITLE: t\nDEPENDS_ON: RT-1\nAC:\n- AC-001: a\n"), "SELF_DEPENDENCY"],
  ["dependency cycle", plan("TASK_ID: RT-1\nTITLE: a\nDEPENDS_ON: RT-2\nAC:\n- AC-001: a\n\nTASK_ID: RT-2\nTITLE: b\nDEPENDS_ON: RT-3\nAC:\n- AC-001: a\n\nTASK_ID: RT-3\nTITLE: c\nDEPENDS_ON: RT-1\nAC:\n- AC-001: a\n"), "DEPENDENCY_CYCLE"],
  ["unknown field", plan("TASK_ID: RT-1\nTITLE: t\nPRIORITY: high\nAC:\n- AC-001: a\n"), "UNKNOWN_FIELD"],
  ["lowercase field is not silently accepted", plan("TASK_ID: RT-1\ntitle: t\nAC:\n- AC-001: a\n"), "MALFORMED_LINE"],
  ["stray prose inside the executable section", plan("TASK_ID: RT-1\nTITLE: t\nthis is prose\nAC:\n- AC-001: a\n"), "MALFORMED_LINE"],
  ["duplicate field", plan("TASK_ID: RT-1\nTITLE: a\nTITLE: b\nAC:\n- AC-001: a\n"), "DUPLICATE_FIELD"],
  ["duplicate dependency entry", plan(`${TASK_35}\nTASK_ID: RT-2\nTITLE: t\nDEPENDS_ON: RT-35, RT-35\nAC:\n- AC-001: a\n`), "DUPLICATE_DEPENDENCY"],
  ["invalid EPIC_ID", plan("TASK_ID: RT-1\nEPIC_ID: e4\nTITLE: t\nAC:\n- AC-001: a\n"), "INVALID_EPIC_ID"],
  ["EPIC_ID colliding with a TASK_ID", plan(`${TASK_35}\nTASK_ID: RT-2\nEPIC_ID: RT-35\nTITLE: t\nAC:\n- AC-001: a\n`), "AMBIGUOUS_IDENTITY"],
  ["unknown grammar version", plan(TASK_35, { grammar: 2 }), "UNKNOWN_GRAMMAR_VERSION"],
  ["non-numeric grammar version", plan(TASK_35, { grammar: "beta" }), "UNKNOWN_GRAMMAR_VERSION"],
  ["invalid plan version (zero)", plan(TASK_35, { version: 0 }), "INVALID_PLAN_VERSION"],
  ["invalid plan version (text)", plan(TASK_35, { version: "seventeen" }), "INVALID_PLAN_VERSION"],
  ["invalid plan version (leading zero)", plan(TASK_35, { version: "017" }), "INVALID_PLAN_VERSION"],
  ["missing PLAN_VERSION", "LOOP_EXECUTION_PLAN: 1\n" + TASK_35 + "END_LOOP_EXECUTION_PLAN\n", "INVALID_PLAN_VERSION"],
  ["no executable section", "Just a narrative document.\nTASK_ID: RT-1\n", "NO_EXECUTABLE_SECTION"],
  ["two executable sections are ambiguous", `${plan(TASK_35)}\n${plan(TASK_35)}`, "AMBIGUOUS_SECTION"],
  ["missing end marker (truncated document)", `LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\n${TASK_35}`, "MISSING_END_MARKER"],
  ["section with no tasks", plan(""), "NO_TASKS"],
  ["non-string source", null, "INVALID_SOURCE"],
];
for (const [name, source, expected] of REJECTED) {
  test(`fails closed: ${name} -> ${expected}`, () => assert.equal(code(source), expected));
}

test("errors carry the source line number for the first offending line", () => {
  try { compilePlan(plan("TASK_ID: RT-1\nTITLE: t\nBOGUS: x\nAC:\n- AC-001: a\n")); assert.fail("expected a throw"); }
  catch (error) { assert.equal(error.code, "UNKNOWN_FIELD"); assert.equal(error.line, 8); }
});

test("prose outside the section is never executable, even if it looks like a task", () => {
  const source = `TASK_ID: RT-99\nTITLE: sneaky\nAC:\n- AC-001: x\n${plan(TASK_35)}TASK_ID: RT-98\n`;
  assert.deepEqual(compilePlan(source).canonicalPlan.tasks.map((t) => t.taskId), ["RT-35"]);
});

// ---------- hash stability ----------
const hashOf = (source) => compilePlan(source).contentHash;
const BASE = plan(`${TASK_35}\n${TASK_37}`);

test("hash: narrative/whitespace/line-ending/NBSP changes outside or cosmetic inside the section keep the hash", () => {
  const base = hashOf(BASE);
  assert.equal(hashOf(BASE.replace("Intro prose that is not executable.", "A completely rewritten, much longer introduction.\nWith more paragraphs.")), base, "narrative prose");
  assert.equal(hashOf(BASE.replace("Trailing prose.", "")), base, "trailing prose removed");
  assert.equal(hashOf(BASE.replace(/\n/g, "\r\n")), base, "CRLF line endings");
  assert.equal(hashOf(BASE.replace("TITLE: Booking flow", "TITLE:   Booking    flow  ").replace(/\n- AC-001: user/, "\n-   AC-001:   user")), base, "extra whitespace inside values");
  assert.equal(hashOf(BASE.replace("user can book", "user can​ book")), base, "NBSP and zero-width characters");
  assert.equal(hashOf(BASE.replace(/\n\n/g, "\n\n\n\n")), base, "blank lines");
});

test("hash: task order is NOT semantic (tasks sorted by TASK_ID); AC order and dependency order are not semantic either", () => {
  const reordered = plan(`${TASK_37}\n${TASK_35}`);
  assert.equal(hashOf(reordered), hashOf(BASE));
  const acSwapped = BASE.replace("- AC-001: user can book a slot\n- AC-002: double booking is refused\n", "- AC-002: double booking is refused\n- AC-001: user can book a slot\n");
  assert.equal(hashOf(acSwapped), hashOf(BASE));
  const two = plan(`${TASK_35}\nTASK_ID: RT-2\nTITLE: t\nDEPENDS_ON: RT-35, RT-1\nAC:\n- AC-001: a\n\nTASK_ID: RT-1\nTITLE: u\nAC:\n- AC-001: a\n`);
  assert.equal(hashOf(two), hashOf(two.replace("DEPENDS_ON: RT-35, RT-1", "DEPENDS_ON: RT-1, RT-35")));
});

test("hash: every meaningful executable change changes the hash", () => {
  const base = hashOf(BASE);
  const variants = {
    "title change": BASE.replace("Booking flow", "Booking flows"),
    "AC text change": BASE.replace("double booking is refused", "double booking is allowed"),
    "AC added": BASE.replace("- AC-002: double booking is refused\n", "- AC-002: double booking is refused\n- AC-003: extra\n"),
    "AC removed": BASE.replace("- AC-002: double booking is refused\n", ""),
    "AC id change": BASE.replace("AC-002", "AC-007"),
    "dependency change": BASE.replace("DEPENDS_ON: RT-35\n", ""),
    "epic change": BASE.replace("EPIC_ID: RT-E4", "EPIC_ID: RT-E5"),
    "plan version change": BASE.replace("PLAN_VERSION: 17", "PLAN_VERSION: 18"),
    "case change in title": BASE.replace("Booking flow", "booking flow"),
  };
  const seen = new Set([base]);
  for (const [name, source] of Object.entries(variants)) {
    const hash = hashOf(source);
    assert.ok(!seen.has(hash), `${name} must change content_hash`);
    seen.add(hash);
  }
});

test("hash: deterministic across repeated compilations and independent of object key order", () => {
  assert.equal(hashOf(BASE), hashOf(BASE));
  const { canonicalPlan, contentHash } = compilePlan(BASE);
  assert.equal(Object.keys(canonicalPlan).join(), "grammarVersion,planVersion,tasks");
  assert.equal(contentHash, compilePlan(BASE).contentHash);
});

test("stable identity: same TASK_ID keeps its identity while content changes; identity is never derived from content", () => {
  const a = compilePlan(plan(TASK_35)).canonicalPlan.tasks[0];
  const b = compilePlan(plan(TASK_35.replace("Slot model", "Slot model v2").replace("persisted", "stored"))).canonicalPlan.tasks[0];
  assert.equal(a.taskId, "RT-35");
  assert.equal(b.taskId, "RT-35");
  assert.notEqual(a.taskHash, b.taskHash);
  assert.equal(compilePlan(plan(TASK_35)).contentHash === compilePlan(plan(TASK_35.replace("Slot model", "X"))).contentHash, false);
});
