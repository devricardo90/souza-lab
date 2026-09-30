import { createHash } from "node:crypto";

/**
 * Deterministic compiler for the LOOP executable plan section of a planning document.
 * No model participates: a strict line grammar, fail-closed, first error wins.
 *
 * GRAMMAR v1 (only text between the two marker lines is executable; all other
 * document prose is non-executable context and is ignored):
 *
 *   LOOP_EXECUTION_PLAN: 1            begin marker = grammar version (exactly one per document)
 *   PLAN_VERSION: 17                  positive integer, first field after the marker
 *
 *   TASK_ID: RT-37                    starts a task block; explicit, immutable, case-sensitive
 *   EPIC_ID: RT-E4                    optional desired Epic relationship
 *   TITLE: Booking flow
 *   DEPENDS_ON: RT-35, RT-36          optional, comma separated TASK_IDs
 *   AC:
 *   - AC-001: first observable condition
 *   - AC-002: second observable condition
 *
 *   END_LOOP_EXECUTION_PLAN           end marker (missing => truncated document => rejected)
 *
 * Safe normalization only: CRLF/CR -> LF, NBSP-class spaces -> space, zero-width
 * characters removed, Unicode NFC, trim, and whitespace runs collapsed inside values.
 * Identifiers are NEVER case-folded or derived from content.
 *
 * Canonical form: tasks sorted by TASK_ID, acceptance criteria sorted by id, dependencies
 * sorted. Task ORDER in the document is therefore NOT semantic (reordering does not change
 * content_hash). Object key order never affects the hash (keys are sorted when serialized).
 */

export const SUPPORTED_GRAMMAR_VERSION = 1;
export const BEGIN_MARKER = "LOOP_EXECUTION_PLAN";
export const END_MARKER = "END_LOOP_EXECUTION_PLAN";
const MAX_SOURCE_CHARS = 1_000_000;
const MAX_TASKS = 500;
const MAX_TITLE = 200;
const MAX_AC_TEXT = 1000;
const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const EPIC_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const AC_ID = /^AC-\d{2,}$/;
const KEY_LINE = /^([A-Za-z][A-Za-z0-9_]*):(?: (.*))?$/;
const TASK_KEYS = new Set(["TASK_ID", "EPIC_ID", "TITLE", "DEPENDS_ON", "AC"]);

export class PlanCompileError extends Error {
  constructor(code, message, line = null) {
    super(line === null ? message : `line ${line}: ${message}`);
    this.name = "PlanCompileError";
    this.code = code;
    this.line = line;
    this.classification = "SOURCE_INVALID";
    this.retryable = false;
  }
}

const fail = (code, message, line = null) => { throw new PlanCompileError(code, message, line); };

export function sortedStringify(value) {
  return JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
}
export const sha256Hex = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const byKey = (key) => (a, b) => (a[key] < b[key] ? -1 : a[key] > b[key] ? 1 : 0);

function normalizeSource(source) {
  if (typeof source !== "string") fail("INVALID_SOURCE", "plan source must be a string");
  if (source.length > MAX_SOURCE_CHARS) fail("SOURCE_TOO_LARGE", `plan source exceeds ${MAX_SOURCE_CHARS} characters`);
  return source.normalize("NFC")
    .replace(/[​‌‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/\r\n?/g, "\n");
}
const clean = (value) => value.replace(/\s+/g, " ").trim();

function parseTasks(lines, from, to) {
  const tasks = [];
  let current = null;
  let inAc = false;
  const closeTask = () => {
    if (!current) return;
    if (current.title === undefined) fail("MISSING_TITLE", `task ${current.taskId} has no TITLE`, current.line);
    if (current.acceptanceCriteria.length === 0) fail("MISSING_AC", `task ${current.taskId} has no acceptance criteria`, current.line);
    tasks.push(current);
    current = null;
    inAc = false;
  };
  for (let index = from; index < to; index += 1) {
    const lineNo = index + 1;
    const line = lines[index].trim();
    if (line === "") continue;
    if (line.startsWith("-")) {
      if (!current || !inAc) fail("MALFORMED_LINE", "bullet outside an AC: block", lineNo);
      const match = line.match(/^-\s+(\S+)\s*:\s*(.+)$/);
      if (!match || !AC_ID.test(match[1])) fail("MALFORMED_AC", `acceptance criterion must be "- AC-NNN: text", got "${line}"`, lineNo);
      const text = clean(match[2]);
      if (text.length > MAX_AC_TEXT) fail("MALFORMED_AC", `acceptance criterion exceeds ${MAX_AC_TEXT} characters`, lineNo);
      if (current.acceptanceCriteria.some((ac) => ac.id === match[1])) fail("DUPLICATE_AC", `duplicate acceptance criterion ${match[1]} in ${current.taskId}`, lineNo);
      current.acceptanceCriteria.push({ id: match[1], text });
      continue;
    }
    const keyMatch = line.match(KEY_LINE);
    if (!keyMatch || keyMatch[1] !== keyMatch[1].toUpperCase()) fail("MALFORMED_LINE", `unrecognized line "${line}"`, lineNo);
    const key = keyMatch[1];
    const value = clean(keyMatch[2] ?? "");
    if (key === "PLAN_VERSION") fail("DUPLICATE_FIELD", "PLAN_VERSION may appear only once, before the first task", lineNo);
    if (!TASK_KEYS.has(key)) fail("UNKNOWN_FIELD", `unknown executable field ${key}`, lineNo);
    if (key === "TASK_ID") {
      closeTask();
      if (value === "") fail("MISSING_TASK_ID", "TASK_ID is empty", lineNo);
      if (!TASK_ID.test(value)) fail("INVALID_TASK_ID", `invalid TASK_ID "${value}"`, lineNo);
      if (tasks.some((task) => task.taskId === value)) fail("DUPLICATE_TASK_ID", `duplicate TASK_ID ${value}`, lineNo);
      if (tasks.length >= MAX_TASKS) fail("TOO_MANY_TASKS", `more than ${MAX_TASKS} tasks`, lineNo);
      current = { taskId: value, line: lineNo, seen: new Set(["TASK_ID"]), acceptanceCriteria: [], dependsOn: [], epicId: null, title: undefined };
      inAc = false;
      continue;
    }
    if (!current) fail("MISSING_TASK_ID", `${key} appears before any TASK_ID`, lineNo);
    if (current.seen.has(key)) fail("DUPLICATE_FIELD", `duplicate ${key} in ${current.taskId}`, lineNo);
    current.seen.add(key);
    inAc = key === "AC";
    if (key === "AC") {
      if (value !== "") fail("MALFORMED_AC", "AC: must be followed by bullet lines, not inline text", lineNo);
      continue;
    }
    if (value === "") fail("EMPTY_VALUE", `${key} is empty in ${current.taskId}`, lineNo);
    if (key === "TITLE") {
      if (value.length > MAX_TITLE) fail("INVALID_TITLE", `TITLE exceeds ${MAX_TITLE} characters`, lineNo);
      current.title = value;
    } else if (key === "EPIC_ID") {
      if (!EPIC_ID.test(value)) fail("INVALID_EPIC_ID", `invalid EPIC_ID "${value}"`, lineNo);
      current.epicId = value;
    } else {
      const ids = value.split(",").map((part) => part.trim());
      for (const id of ids) if (!TASK_ID.test(id)) fail("INVALID_DEPENDENCY", `invalid dependency id "${id}" in ${current.taskId}`, lineNo);
      if (new Set(ids).size !== ids.length) fail("DUPLICATE_DEPENDENCY", `duplicate dependency in ${current.taskId}`, lineNo);
      current.dependsOn = ids;
    }
  }
  closeTask();
  return tasks;
}

function validateGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.taskId, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (dependency === task.taskId) fail("SELF_DEPENDENCY", `${task.taskId} depends on itself`, task.line);
      if (!byId.has(dependency)) fail("MISSING_DEPENDENCY", `${task.taskId} depends on unknown task ${dependency}`, task.line);
    }
    if (task.epicId !== null && byId.has(task.epicId)) fail("AMBIGUOUS_IDENTITY", `EPIC_ID ${task.epicId} collides with a TASK_ID`, task.line);
  }
  const state = new Map();
  const walk = (id, path) => {
    if (state.get(id) === "done") return;
    if (state.get(id) === "visiting") fail("DEPENDENCY_CYCLE", `dependency cycle: ${[...path.slice(path.indexOf(id)), id].join(" -> ")}`, byId.get(id).line);
    state.set(id, "visiting");
    for (const dependency of [...byId.get(id).dependsOn].sort()) walk(dependency, [...path, id]);
    state.set(id, "done");
  };
  for (const id of [...byId.keys()].sort()) walk(id, []);
}

/** content_hash = SHA-256 over the canonical serialization (sorted keys, sorted tasks/AC/deps). */
export function hashCanonicalPlan(canonicalPlan) {
  return sha256Hex(sortedStringify(canonicalPlan));
}

/** Compiles source text into the canonical plan. Throws PlanCompileError (fail closed) on anything unexpected. */
export function compilePlan(source) {
  const lines = normalizeSource(source).split("\n");
  const begins = [];
  const ends = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (/^LOOP_EXECUTION_PLAN(?::|\s|$)/.test(line)) begins.push(index);
    else if (/^END_LOOP_EXECUTION_PLAN\s*$/.test(line)) ends.push(index);
  });
  if (begins.length === 0) fail("NO_EXECUTABLE_SECTION", `no ${BEGIN_MARKER} section found`);
  if (begins.length > 1) fail("AMBIGUOUS_SECTION", `${begins.length} ${BEGIN_MARKER} markers found; exactly one is allowed`, begins[1] + 1);
  const begin = begins[0];
  const versionMatch = lines[begin].trim().match(/^LOOP_EXECUTION_PLAN:[ ]*(\S+)$/);
  if (!versionMatch || versionMatch[1] !== String(SUPPORTED_GRAMMAR_VERSION)) {
    fail("UNKNOWN_GRAMMAR_VERSION", `unsupported executable grammar version "${versionMatch?.[1] ?? ""}" (supported: ${SUPPORTED_GRAMMAR_VERSION})`, begin + 1);
  }
  if (ends.length === 0 || ends[0] < begin) fail("MISSING_END_MARKER", `missing ${END_MARKER} (document may be truncated)`, begin + 1);
  if (ends.length > 1) fail("AMBIGUOUS_SECTION", `${ends.length} ${END_MARKER} markers found`, ends[1] + 1);
  const end = ends[0];

  let cursor = begin + 1;
  while (cursor < end && lines[cursor].trim() === "") cursor += 1;
  const versionLine = cursor < end ? lines[cursor].trim().match(/^PLAN_VERSION:[ ]*(.*)$/) : null;
  if (!versionLine) fail("INVALID_PLAN_VERSION", "PLAN_VERSION must be the first field after the begin marker", cursor + 1);
  if (!/^[1-9]\d{0,8}$/.test(versionLine[1].trim())) fail("INVALID_PLAN_VERSION", `PLAN_VERSION must be a positive integer, got "${versionLine[1].trim()}"`, cursor + 1);
  const planVersion = Number(versionLine[1].trim());

  const parsed = parseTasks(lines, cursor + 1, end);
  if (parsed.length === 0) fail("NO_TASKS", "executable section contains no tasks", begin + 1);
  validateGraph(parsed);

  const tasks = parsed
    .map((task) => ({
      taskId: task.taskId,
      epicId: task.epicId,
      title: task.title,
      dependsOn: [...task.dependsOn].sort(),
      acceptanceCriteria: [...task.acceptanceCriteria].sort(byKey("id")),
    }))
    .sort(byKey("taskId"))
    .map((task) => ({ ...task, taskHash: sha256Hex(sortedStringify(task)) }));

  const canonicalPlan = { grammarVersion: SUPPORTED_GRAMMAR_VERSION, planVersion, tasks };
  return Object.freeze({ canonicalPlan, contentHash: hashCanonicalPlan(canonicalPlan) });
}
