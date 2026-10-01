import { createHash } from "node:crypto";

/**
 * Materialization layer (CP-04B): converts APPROVED reconciliation decisions into outbox
 * operation specs. Pure: no I/O, no clock, no enqueueing, no Jira. Keeps the three concepts apart:
 *
 *   decision   (reconcilePlan)            what is true / what should happen
 *   operation  (this layer)               a deterministic, idempotent intent to write
 *   execution  (JiraOutboxExecutor)       the actual, fenced, verified write
 *
 * Only `creates[]` can ever become an operation. Conflicts, noops and remote-only issues never do:
 * nothing is updated, closed, deleted or transitioned.
 *
 * Operation identity (JIRA_CREATE) = (action, target project, source document, TASK_ID). It deliberately
 * does NOT include the title, the Jira key, array order, randomness, or the task hash: one TASK_ID has
 * at most ONE materialization per project. If the plan definition changes while the operation is
 * not yet confirmed, re-enqueueing produces the same id with a different payload, which the outbox
 * rejects (OPERATION_ID_CONFLICT) instead of quietly creating a second issue.
 */

export class MaterializationConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "MaterializationConfigError";
    this.code = "CONFIG_INVALID";
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

const PROJECT_KEY = /^[A-Z][A-Z0-9]{1,9}$/;
const stable = (value) => JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** Non-secret target configuration. Fails closed; there is no default and no real project is hardcoded. */
export function parseMaterializationConfig(config) {
  if (!config || typeof config !== "object") throw new MaterializationConfigError("materialization config is required");
  const { projectKey, issueTypeName } = config;
  if (typeof projectKey !== "string" || !PROJECT_KEY.test(projectKey)) throw new MaterializationConfigError("projectKey must be a Jira project key such as LOOP");
  if (typeof issueTypeName !== "string" || issueTypeName.trim() === "" || issueTypeName.length > 60 || /[\r\n]/.test(issueTypeName)) {
    throw new MaterializationConfigError("issueTypeName is required");
  }
  return Object.freeze({ projectKey, issueTypeName: issueTypeName.trim() });
}

/** Deterministic id for one logical materialization. */
export function jiraCreateOperationId({ projectKey, documentId, taskId }) {
  const digest = createHash("sha256").update(stable(["JIRA_CREATE", projectKey, documentId, taskId]), "utf8").digest("hex");
  return `JIRA_CREATE:${digest}`;
}

export const BLOCKED_REASONS = Object.freeze(["RELATIONSHIPS_NOT_SUPPORTED"]);

/**
 * @returns {{ operations: object[], blocked: object[] }} operation specs are ready for outbox.enqueue().
 * A CREATE that needs an Epic link or dependency links is BLOCKED (never created with the relationship
 * silently dropped): creating/resolving those Jira relationships is not implemented in this phase.
 */
export function buildMaterializationOperations({ reconciliation, config }) {
  const { projectKey, issueTypeName } = parseMaterializationConfig(config);
  if (!reconciliation || !Array.isArray(reconciliation.creates)) throw new TypeError("a reconciliation result is required");
  const operations = [];
  const blocked = [];
  for (const decision of reconciliation.creates) {
    if (decision.decision !== "CREATE" || !decision.proposedMaterialization) continue;
    const payload = decision.proposedMaterialization;
    if (payload.epicId !== null || payload.dependsOn.length > 0) {
      blocked.push({
        taskId: decision.taskId, reasonCode: "RELATIONSHIPS_NOT_SUPPORTED",
        detail: `task needs ${payload.epicId !== null ? "an Epic link" : ""}${payload.epicId !== null && payload.dependsOn.length > 0 ? " and " : ""}${payload.dependsOn.length > 0 ? `dependency links (${payload.dependsOn.join(", ")})` : ""}; relationship creation is not implemented`,
        planVersion: decision.planVersion, snapshotContentHash: decision.snapshotContentHash,
      });
      continue;
    }
    operations.push({
      operationId: jiraCreateOperationId({ projectKey, documentId: payload.sourceDocumentId, taskId: payload.taskId }),
      action: "JIRA_CREATE", targetSystem: "JIRA", targetObject: projectKey, taskId: payload.taskId,
      executionId: null, sourceRevision: payload.snapshotContentHash, head: null,
      expectedPreviousState: { taskIdAbsent: payload.taskId },
      desiredState: { projectKey, issueTypeName, materialization: payload },
    });
  }
  operations.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  blocked.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return Object.freeze({ operations: Object.freeze(operations), blocked: Object.freeze(blocked) });
}
