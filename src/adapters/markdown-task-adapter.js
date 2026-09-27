import { readFileSync } from "node:fs";
import { TaskSystemAdapter, makeTask } from "../core/contracts.js";

const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const AC_ID = /^AC-\d{2,}$/;
const TASK_LINE = /^- \[([ xX])\] ([A-Z][A-Z0-9]*-\d+)\s+[—-]\s+(.+?)\s*$/;

export class TaskSourceError extends Error {
  constructor(message, code = "INVALID_TASK_SOURCE") {
    super(message);
    this.name = "TaskSourceError";
    this.code = code;
  }
}

function splitIds(raw, location) {
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "none") return [];
  const ids = value.split(",").map((id) => id.trim());
  for (const id of ids) {
    if (!TASK_ID.test(id)) throw new TaskSourceError(`${location}: invalid dependency id ${id}`);
  }
  if (new Set(ids).size !== ids.length) throw new TaskSourceError(`${location}: duplicate dependency`);
  return ids;
}

function finalizeTask(draft, tasks) {
  if (!draft) return;
  if (tasks.some((task) => task.id === draft.id)) throw new TaskSourceError(`duplicate task id ${draft.id}`, "DUPLICATE_TASK");
  if (draft.criteria.length === 0) throw new TaskSourceError(`${draft.id} has no acceptance criteria`, "MISSING_ACCEPTANCE_CRITERIA");
  const ids = draft.criteria.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new TaskSourceError(`${draft.id} has duplicate acceptance criterion ids`, "DUPLICATE_CRITERION");

  tasks.push(makeTask({
    id: draft.id,
    title: draft.title,
    completed: draft.completed,
    specPresent: draft.spec !== "missing",
    specReviewed: draft.spec === "reviewed",
    acceptanceCriteria: draft.criteria,
    dependencies: draft.dependencies.map((taskId) => ({ taskId, requiresDone: true })),
  }));
}

function withoutHtmlComments(line, wasInComment) {
  let output = "";
  let cursor = 0;
  let inComment = wasInComment;
  while (cursor < line.length) {
    if (inComment) {
      const end = line.indexOf("-->", cursor);
      if (end < 0) return { line: output, inComment: true };
      cursor = end + 3;
      inComment = false;
      continue;
    }
    const start = line.indexOf("<!--", cursor);
    if (start < 0) {
      output += line.slice(cursor);
      break;
    }
    output += line.slice(cursor, start);
    cursor = start + 4;
    const end = line.indexOf("-->", cursor);
    if (end < 0) return { line: output, inComment: true };
    cursor = end + 3;
  }
  return { line: output, inComment };
}

/**
 * Parse this deliberately small format:
 *
 * - [ ] TASK-001 — Description
 *   - spec: missing | present | reviewed
 *   - depends_on: TASK-000, TASK-002
 *   - acceptance_criteria:
 *     - AC-01 — Observable condition
 *
 * Unknown roadmap prose is ignored, but malformed task rows and fields fail closed.
 */
export function parseTasksMarkdown(markdown) {
  if (typeof markdown !== "string") throw new TaskSourceError("roadmap content must be text");
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const tasks = [];
  let draft = null;
  let inCriteria = false;
  let fence = null;
  let inHtmlComment = false;

  for (let index = 0; index < lines.length; index += 1) {
    let line = lines[index];
    const lineNumber = index + 1;
    if (fence) {
      const closesFence = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (closesFence && closesFence[1][0] === fence.character && closesFence[1].length >= fence.length) fence = null;
      continue;
    }
    const uncommented = withoutHtmlComments(line, inHtmlComment);
    line = uncommented.line;
    inHtmlComment = uncommented.inComment;
    const fenceLine = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceLine) {
      fence = { character: fenceLine[1][0], length: fenceLine[1].length };
      continue;
    }
    if (/^- \[[ xX]\] /.test(line)) {
      finalizeTask(draft, tasks);
      const match = line.match(TASK_LINE);
      if (!match) throw new TaskSourceError(`line ${lineNumber}: malformed task row`);
      draft = {
        id: match[2],
        title: match[3].trim(),
        completed: match[1].toLowerCase() === "x",
        spec: "missing",
        dependencies: [],
        criteria: [],
        seen: new Set(),
      };
      inCriteria = false;
      continue;
    }
    if (line.trim() === "") continue;
    if (!draft) {
      if (/^\s{2}-\s+(spec|depends_on|acceptance_criteria)\b/.test(line)
        || /^\s{4}-\s+AC-/.test(line)) {
        throw new TaskSourceError(`line ${lineNumber}: task field appears outside a task`, "ORPHAN_TASK_FIELD");
      }
      continue;
    }

    const spec = line.match(/^\s{2}-\s+spec:\s*(missing|present|reviewed)\s*$/i);
    if (spec) {
      if (draft.seen.has("spec")) throw new TaskSourceError(`${draft.id}: duplicate spec field`);
      draft.seen.add("spec");
      draft.spec = spec[1].toLowerCase();
      inCriteria = false;
      continue;
    }

    const dependencies = line.match(/^\s{2}-\s+depends_on:\s*(.*?)\s*$/);
    if (dependencies) {
      if (draft.seen.has("depends_on")) throw new TaskSourceError(`${draft.id}: duplicate depends_on field`);
      draft.seen.add("depends_on");
      draft.dependencies = splitIds(dependencies[1], `${draft.id} line ${lineNumber}`);
      if (draft.dependencies.includes(draft.id)) throw new TaskSourceError(`${draft.id} depends on itself`, "DEPENDENCY_CYCLE");
      inCriteria = false;
      continue;
    }

    if (/^\s{2}-\s+acceptance_criteria:\s*$/.test(line)) {
      if (draft.seen.has("acceptance_criteria")) throw new TaskSourceError(`${draft.id}: duplicate acceptance_criteria field`);
      draft.seen.add("acceptance_criteria");
      inCriteria = true;
      continue;
    }

    if (inCriteria && /^\s{4}-\s+/.test(line)) {
      const criterion = line.match(/^\s{4}-\s+(AC-\d{2,})\s+[—-]\s+(.+?)\s*$/);
      if (!criterion) throw new TaskSourceError(`line ${lineNumber}: malformed acceptance criterion`);
      if (!AC_ID.test(criterion[1])) throw new TaskSourceError(`line ${lineNumber}: invalid acceptance criterion id`);
      draft.criteria.push({ id: criterion[1], description: criterion[2].trim() });
      continue;
    }

    if (/^\s{2}-\s+(spec|depends_on|acceptance_criteria)\b/.test(line)) {
      throw new TaskSourceError(`line ${lineNumber}: malformed task field`);
    }
    inCriteria = false;
  }

  if (fence) throw new TaskSourceError("unclosed Markdown code fence", "UNCLOSED_CODE_FENCE");
  finalizeTask(draft, tasks);
  validateDependencyGraph(tasks);
  return Object.freeze(tasks);
}

function validateDependencyGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency.taskId)) {
        throw new TaskSourceError(`${task.id} depends on missing task ${dependency.taskId}`, "MISSING_DEPENDENCY");
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  function visit(taskId) {
    if (visiting.has(taskId)) throw new TaskSourceError(`dependency cycle includes ${taskId}`, "DEPENDENCY_CYCLE");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).dependencies) visit(dependency.taskId);
    visiting.delete(taskId);
    visited.add(taskId);
  }
  for (const task of tasks) visit(task.id);
}

/** Select the first incomplete task whose required dependencies are complete. */
export function resolveNextTask(tasks) {
  if (!Array.isArray(tasks)) throw new TaskSourceError("tasks must be an array");
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const skipped = [];

  for (const task of tasks) {
    if (task.completed) continue;
    const blockers = task.dependencies
      .filter((dependency) => dependency.requiresDone && !byId.get(dependency.taskId)?.completed)
      .map((dependency) => dependency.taskId);
    if (blockers.length === 0) return Object.freeze({ taskId: task.id, reason: "ELIGIBLE_TASK_FOUND", skipped: Object.freeze(skipped) });
    skipped.push(Object.freeze({ taskId: task.id, blockers: Object.freeze(blockers) }));
  }

  const pending = tasks.some((task) => !task.completed);
  return Object.freeze({
    taskId: null,
    reason: pending ? "NO_ELIGIBLE_TASK" : "ROADMAP_COMPLETE",
    skipped: Object.freeze(skipped),
  });
}

export class MarkdownTaskAdapter extends TaskSystemAdapter {
  constructor({ path, readFile = readFileSync } = {}) {
    super();
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("MarkdownTaskAdapter requires a path");
    this.path = path;
    this.readFile = readFile;
  }

  listTasks() {
    return parseTasksMarkdown(this.readFile(this.path, "utf8"));
  }

  resolveNextTask({ additionalCompletedIds = [] } = {}) {
    const completed = new Set(additionalCompletedIds);
    const tasks = this.listTasks().map((task) => completed.has(task.id) && !task.completed
      ? makeTask({ ...task, completed: true })
      : task);
    return resolveNextTask(tasks);
  }
}
