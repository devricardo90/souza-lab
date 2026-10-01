import { createHash } from "node:crypto";
import { TaskSystemAdapter, makeTask } from "../core/contracts.js";
import { resolveNextTask } from "../adapters/markdown-task-adapter.js";

/**
 * WorkPackage: the frozen, self-contained unit of work bound to ONE exact PlanSnapshot task.
 * Once created and persisted it is immutable: later Google plan changes can never mutate it. It
 * deliberately carries NO Jira issue key, NO credentials and NO Google/Jira prose - this is what an
 * implementation agent will eventually receive.
 */

const sha = (value) => createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};

export class WorkPackageError extends Error {
  constructor(message, code = "WORK_PACKAGE_INVALID") {
    super(message);
    this.name = "WorkPackageError";
    this.code = code;
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

export function makeWorkPackage({ snapshot, taskId, repository }) {
  const task = snapshot?.tasks?.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new WorkPackageError(`task ${taskId} is not part of the plan snapshot`, "TASK_NOT_IN_SNAPSHOT");
  if (typeof repository?.identity !== "string" || repository.identity.trim() === "" || typeof repository?.baseRef !== "string" || repository.baseRef.trim() === "") {
    throw new WorkPackageError("repository identity and baseRef are required", "REPOSITORY_REQUIRED");
  }
  const key = sha([snapshot.documentId, task.taskId, task.taskHash]).slice(0, 24);
  return deepFreeze({
    schema: "loop-work-package/1",
    workPackageId: `wp-${key}`,
    executionId: `exec-${key}`,
    taskId: task.taskId,
    title: task.title,
    acceptanceCriteria: task.acceptanceCriteria.map(({ id, text }) => ({ id, text })),
    dependencies: [...task.dependsOn],
    planBinding: { documentId: snapshot.documentId, planVersion: snapshot.planVersion, contentHash: snapshot.contentHash, taskHash: task.taskHash },
    repository: { identity: repository.identity, baseRef: repository.baseRef },
  });
}

/**
 * Task source for the existing LoopRuntime: exposes exactly the ONE frozen task of the WorkPackage, so the runtime
 * can never wander to another task or observe a changed plan. Dependency gating was already enforced by the
 * Controller's selection gate, so dependencies are not re-exposed here.
 */
export class WorkPackageTaskSystem extends TaskSystemAdapter {
  constructor({ workPackage, isCompleted }) {
    super();
    if (typeof isCompleted !== "function") throw new TypeError("isCompleted is required");
    this.workPackage = workPackage;
    this.isCompleted = isCompleted;
  }

  listTasks() {
    const wp = this.workPackage;
    return Object.freeze([makeTask({
      id: wp.taskId, title: wp.title, completed: this.isCompleted(), specPresent: true, specReviewed: true,
      acceptanceCriteria: wp.acceptanceCriteria.map(({ id, text }) => ({ id, description: text })), dependencies: [],
    })]);
  }

  resolveNextTask({ additionalCompletedIds = [] } = {}) {
    const completed = new Set(additionalCompletedIds);
    const tasks = this.listTasks().map((task) => (completed.has(task.id) && !task.completed ? makeTask({ ...task, completed: true }) : task));
    return resolveNextTask(tasks);
  }
}
