import {
  CIProvider,
  EvidenceStore,
  GitProvider,
  ReviewProvider,
  SCMProvider,
  TaskSystemAdapter,
  ValidationProvider,
  makeCIResult,
  makeEvidenceEvent,
  makeMergeFact,
  makeReviewResult,
  makeRevision,
  makeTask,
  makeValidationResult,
} from "../core/contracts.js";
import { resolveNextTask } from "../adapters/markdown-task-adapter.js";

function uniqueBy(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id)) throw new TypeError(`duplicate ${label} fixture key: ${id}`);
    seen.add(id);
  }
  return values;
}

export class FakeTaskSystemAdapter extends TaskSystemAdapter {
  constructor({ tasks = [] } = {}) {
    super();
    this.tasks = Object.freeze(uniqueBy(tasks.map((task) => makeTask(task)), (task) => task.id, "task"));
  }

  listTasks() { return this.tasks; }
  resolveNextTask({ additionalCompletedIds = [] } = {}) {
    const completed = new Set(additionalCompletedIds);
    const tasks = this.tasks.map((task) => completed.has(task.id) && !task.completed
      ? makeTask({ ...task, completed: true })
      : task);
    return resolveNextTask(tasks);
  }
}

export class FakeGitProvider extends GitProvider {
  constructor({ revision = null } = {}) {
    super();
    this.revision = revision === null ? null : makeRevision(revision);
  }

  getRevision() { return this.revision; }
}

export class FakeSCMProvider extends SCMProvider {
  constructor({ mergeFacts = [] } = {}) {
    super();
    this.mergeFacts = Object.freeze(uniqueBy(mergeFacts.map((fact) => makeMergeFact(fact)), (fact) => fact.candidateHead, "merge fact"));
  }

  getMergeFact(_taskId, candidateHead) {
    return this.mergeFacts.find((fact) => fact.candidateHead === candidateHead) ?? null;
  }
}

export class FakeCIProvider extends CIProvider {
  constructor({ results = [] } = {}) {
    super();
    this.results = Object.freeze(uniqueBy(results.map((result) => makeCIResult(result)), (result) => result.head, "CI result"));
  }

  getCIResult(head) { return this.results.find((result) => result.head === head) ?? null; }
}

export class FakeReviewProvider extends ReviewProvider {
  constructor({ results = [] } = {}) {
    super();
    this.results = Object.freeze(uniqueBy(results.map((result) => makeReviewResult(result)), (result) => result.head, "review result"));
  }

  getReviewResult(head) { return this.results.find((result) => result.head === head) ?? null; }
}

export class FakeValidationProvider extends ValidationProvider {
  constructor({ results = [] } = {}) {
    super();
    this.results = Object.freeze(uniqueBy(
      results.map(({ taskId, ...result }) => ({ taskId, result: makeValidationResult(result) })),
      (entry) => `${entry.taskId}:${entry.result.head}`,
      "validation result",
    ));
  }

  getValidationResult(taskId, head) {
    return this.results.find((entry) => entry.taskId === taskId && entry.result.head === head)?.result ?? null;
  }
}

export class FakeEvidenceStore extends EvidenceStore {
  #events = [];

  constructor() {
    super();
  }

  append(input) {
    const event = JSON.parse(JSON.stringify(makeEvidenceEvent(input)));
    deepFreeze(event);
    if (this.#events.some((existing) => existing.eventId === event.eventId)) throw new TypeError(`duplicate event id ${event.eventId}`);
    this.#events.push(event);
    return event;
  }

  listByTask(taskId) { return Object.freeze(this.#events.filter((event) => event.taskId === taskId)); }
  listAll() { return Object.freeze([...this.#events]); }
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
