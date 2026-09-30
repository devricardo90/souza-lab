import { hashCanonicalPlan } from "./plan-compiler.js";

/**
 * Immutable PlanSnapshot. Persistent identity = (documentId, planVersion, contentHash).
 * googleRevision is supporting freshness metadata only, never identity.
 *
 * A WorkPackage materialized later stores `snapshotRef(snapshot)` (and its task's
 * taskHash) permanently: it stays bound to exactly that snapshot, so new Google
 * content can never silently mutate an in-flight WorkPackage. Comparing the bound
 * snapshot with a newer one (reconciliation) is deliberately NOT part of CP-03.
 */

export class PlanSnapshotError extends Error {
  constructor(message, code = "INVALID_PLAN_SNAPSHOT") {
    super(message);
    this.name = "PlanSnapshotError";
    this.code = code;
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const iso = (value, name) => {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new PlanSnapshotError(`${name} must be an ISO timestamp`);
  return new Date(value).toISOString();
};

export function makePlanSnapshot({ documentId, compiled, googleRevisionId = null, fetchedAt, compiledAt }) {
  if (typeof documentId !== "string" || documentId.trim() === "") throw new PlanSnapshotError("documentId is required");
  const plan = compiled?.canonicalPlan;
  if (!plan || !Array.isArray(plan.tasks) || !Number.isSafeInteger(plan.planVersion)) throw new PlanSnapshotError("compiled plan is required");
  if (hashCanonicalPlan(plan) !== compiled.contentHash) throw new PlanSnapshotError("contentHash does not match the canonical plan", "HASH_MISMATCH");
  const planVersion = plan.planVersion;
  const contentHash = compiled.contentHash;
  const tasks = plan.tasks.map((task) => ({
    taskId: task.taskId,
    epicId: task.epicId,
    title: task.title,
    dependsOn: [...task.dependsOn],
    acceptanceCriteria: task.acceptanceCriteria.map((ac) => ({ id: ac.id, text: ac.text })),
    taskHash: task.taskHash,
    planVersion,
    snapshotContentHash: contentHash,
  }));
  return deepFreeze({
    documentId, planVersion, contentHash, grammarVersion: plan.grammarVersion,
    googleRevisionMetadata: googleRevisionId === null || googleRevisionId === undefined ? null : { revisionId: googleRevisionId },
    fetchedAt: iso(fetchedAt, "fetchedAt"), compiledAt: iso(compiledAt, "compiledAt"),
    tasks,
  });
}

/** The permanent binding a WorkPackage records when it is materialized from this snapshot. */
export function snapshotRef(snapshot) {
  return Object.freeze({ documentId: snapshot.documentId, planVersion: snapshot.planVersion, contentHash: snapshot.contentHash });
}

export function taskBinding(snapshot, taskId) {
  const task = snapshot.tasks.find((candidate) => candidate.taskId === taskId);
  if (!task) throw new PlanSnapshotError(`task ${taskId} is not part of snapshot ${snapshot.documentId}@${snapshot.planVersion}`, "TASK_NOT_IN_SNAPSHOT");
  return Object.freeze({ ...snapshotRef(snapshot), taskId, taskHash: task.taskHash });
}
