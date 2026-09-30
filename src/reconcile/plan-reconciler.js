import { cleanText, planOwnedFingerprint, sortedStringify } from "./fingerprint.js";

/**
 * Deterministic desired-state reconciler (CP-04). PURE: no I/O, no clock, no randomness, no
 * retries, no model. Inputs in, structured decisions out.
 *
 *   desired  = PlanSnapshot (Google-owned planning intent)
 *   observed = normalized Jira issues (Jira-owned operational state)
 *
 * Outcomes (this stage proves DECISIONS only; nothing is executed or enqueued):
 *   CREATE    desired TASK_ID owned by no Jira issue AND no unmarked remote issue has the same normalized title
 *             (an exact-title collision with an unmarked issue is a CONFLICT / POTENTIAL_REMOTE_COLLISION: the
 *             title never becomes identity, but the Loop must not autonomously create a probable duplicate)
 *   NOOP      the plan-owned facts of the single owning issue are equivalent
 *   CONFLICT  anything else - a mismatch on an existing issue is NEVER read as permission to overwrite
 * Plus `remoteOnly`: Jira issues no desired task claims (unmarked, unknown, or orphaned by a removed
 * task). They are classified, never deleted/closed/transitioned.
 *
 * Identity is ONLY the TASK_ID marker; Jira titles are never used to match.
 */

export const DECISIONS = Object.freeze(["CREATE", "NOOP", "CONFLICT"]);
export const REASON_CODES = Object.freeze([
  "TASK_NOT_MATERIALIZED", "STATE_MATCH", "DUPLICATE_TASK_ID_REMOTE", "REMOTE_DEFINITION_DRIFT",
  "TITLE_DRIFT", "EPIC_DRIFT", "DEPENDENCY_DRIFT", "AC_DRIFT", "REMOTE_INVALID", "POTENTIAL_REMOTE_COLLISION",
]);
export const REMOTE_ONLY_CLASSIFICATIONS = Object.freeze([
  "UNMARKED_REMOTE_ISSUE", "AMBIGUOUS_REMOTE_IDENTITY", "ORPHANED_REMOVED_TASK", "UNKNOWN_TASK_MARKER",
]);

export class ReconcileInputError extends Error {
  constructor(message, code = "INVALID_RECONCILE_INPUT") {
    super(message);
    this.name = "ReconcileInputError";
    this.code = code;
  }
}

const lt = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const FIELD_ORDER = { title: 0, epic: 1, dependencies: 2, acceptanceCriteria: 3 };
const deepFreeze = (value) => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); Object.values(value).forEach(deepFreeze); }
  return value;
};

function validateInputs({ snapshot, observation, createdAt, bindings, historicalTaskIds }) {
  if (!snapshot || !Array.isArray(snapshot.tasks) || typeof snapshot.documentId !== "string" || !Number.isSafeInteger(snapshot.planVersion) || typeof snapshot.contentHash !== "string") {
    throw new ReconcileInputError("snapshot must be a PlanSnapshot");
  }
  if (!observation || !Array.isArray(observation.issues)) throw new ReconcileInputError("observation must be a normalized Jira observation");
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt))) throw new ReconcileInputError("createdAt (an ISO timestamp) must be supplied by the caller; the reconciler has no clock");
  if (!Array.isArray(bindings)) throw new ReconcileInputError("bindings must be an array");
  if (!Array.isArray(historicalTaskIds)) throw new ReconcileInputError("historicalTaskIds must be an array");
}

function diffTask(task, issue) {
  const differences = [];
  if (cleanText(task.title) !== issue.title) differences.push({ field: "title", kind: "CHANGED", key: null, desired: cleanText(task.title), observed: issue.title });

  const desiredEpic = task.epicId ?? null;
  if (issue.epic.unresolvedKey !== null) {
    differences.push({ field: "epic", kind: "UNRESOLVED_REMOTE_EPIC", key: issue.epic.unresolvedKey, desired: desiredEpic, observed: null });
  } else if (desiredEpic !== issue.epic.epicId) {
    const kind = desiredEpic === null ? "EXTRA" : issue.epic.epicId === null ? "MISSING" : "CHANGED";
    differences.push({ field: "epic", kind, key: null, desired: desiredEpic, observed: issue.epic.epicId });
  }

  const desiredDeps = new Set(task.dependsOn);
  const observedDeps = new Set(issue.dependencies.taskIds);
  for (const id of [...desiredDeps].sort()) if (!observedDeps.has(id)) differences.push({ field: "dependencies", kind: "MISSING", key: id, desired: id, observed: null });
  for (const id of [...observedDeps].sort()) if (!desiredDeps.has(id)) differences.push({ field: "dependencies", kind: "EXTRA", key: id, desired: null, observed: id });
  for (const entry of issue.dependencies.unresolved) {
    differences.push({ field: "dependencies", kind: entry.reason === "AMBIGUOUS_MARKER" ? "AMBIGUOUS_REMOTE_DEPENDENCY" : "UNKNOWN_REMOTE_DEPENDENCY", key: entry.key, desired: null, observed: entry.reason });
  }

  if (issue.acceptanceCriteria === null) {
    differences.push({ field: "acceptanceCriteria", kind: "REMOTE_UNPARSEABLE", key: null, desired: null, observed: issue.acceptanceCriteriaProblem });
  } else {
    const observed = new Map(issue.acceptanceCriteria.map((ac) => [ac.id, ac.text]));
    const desired = new Map(task.acceptanceCriteria.map((ac) => [ac.id, cleanText(ac.text)]));
    for (const id of [...new Set([...desired.keys(), ...observed.keys()])].sort()) {
      if (!observed.has(id)) differences.push({ field: "acceptanceCriteria", kind: "MISSING", key: id, desired: desired.get(id), observed: null });
      else if (!desired.has(id)) differences.push({ field: "acceptanceCriteria", kind: "EXTRA", key: id, desired: null, observed: observed.get(id) });
      else if (desired.get(id) !== observed.get(id)) differences.push({ field: "acceptanceCriteria", kind: "CHANGED", key: id, desired: desired.get(id), observed: observed.get(id) });
    }
  }
  return differences.sort((a, b) => FIELD_ORDER[a.field] - FIELD_ORDER[b.field] || lt(a.kind, b.kind) || lt(a.key ?? "", b.key ?? ""));
}

function conflictReason(differences) {
  const fields = new Set(differences.map((d) => d.field));
  if (fields.size > 1) return "REMOTE_DEFINITION_DRIFT";
  const [field] = fields;
  if (field === "title") return "TITLE_DRIFT";
  if (field === "epic") return "EPIC_DRIFT";
  if (field === "dependencies") return "DEPENDENCY_DRIFT";
  return differences.every((d) => d.kind === "REMOTE_UNPARSEABLE") ? "REMOTE_INVALID" : "AC_DRIFT";
}

function materializationPayload(snapshot, task) {
  return {
    taskId: task.taskId, title: task.title, epicId: task.epicId ?? null, dependsOn: [...task.dependsOn],
    acceptanceCriteria: task.acceptanceCriteria.map(({ id, text }) => ({ id, text })),
    descriptionMarker: `LOOP_TASK_ID: ${task.taskId}`,
    sourceDocumentId: snapshot.documentId, planVersion: snapshot.planVersion,
    snapshotContentHash: snapshot.contentHash, taskHash: task.taskHash,
  };
}

/**
 * @param {object} input
 * @param {object} input.snapshot            PlanSnapshot (desired)
 * @param {object} input.observation         result of normalizeJiraObservation (observed)
 * @param {string} input.createdAt           ISO timestamp stamped on every record (caller-supplied: no clock here)
 * @param {object[]} [input.bindings]        taskBinding() records of WorkPackages already materialized/executing
 * @param {string[]} [input.historicalTaskIds] TASK_IDs seen in older snapshots (to recognize removed tasks)
 */
export function reconcilePlan({ snapshot, observation, createdAt, bindings = [], historicalTaskIds = [] } = {}) {
  validateInputs({ snapshot, observation, createdAt, bindings, historicalTaskIds });
  const created = new Date(createdAt).toISOString();
  const history = new Set(historicalTaskIds);
  const bindingByTask = new Map(bindings.map((binding) => [binding.taskId, binding]));

  const byMarker = new Map();
  for (const issue of observation.issues) {
    if (issue.taskIdMarker === null) continue;
    if (!byMarker.has(issue.taskIdMarker)) byMarker.set(issue.taskIdMarker, []);
    byMarker.get(issue.taskIdMarker).push(issue);
  }

  const unmarked = observation.issues.filter((issue) => issue.taskIdMarker === null);
  const desiredIds = new Set(snapshot.tasks.map((task) => task.taskId));
  const creates = [];
  const noops = [];
  const conflicts = [];

  for (const task of [...snapshot.tasks].sort((a, b) => lt(a.taskId, b.taskId))) {
    const desiredFingerprint = planOwnedFingerprint({ taskId: task.taskId, title: cleanText(task.title), epicId: task.epicId ?? null, dependsOn: task.dependsOn, acceptanceCriteria: task.acceptanceCriteria.map((ac) => ({ id: ac.id, text: cleanText(ac.text) })) });
    const binding = bindingByTask.get(task.taskId) ?? null;
    if (binding && binding.documentId !== snapshot.documentId) throw new ReconcileInputError(`binding for ${task.taskId} belongs to a different document`);
    // A running WorkPackage stays bound to ITS snapshot; this only reports that the desired definition moved on.
    const sourceVersionDrift = binding && binding.taskHash !== task.taskHash
      ? { boundPlanVersion: binding.planVersion, boundContentHash: binding.contentHash, boundTaskHash: binding.taskHash, desiredPlanVersion: snapshot.planVersion, desiredTaskHash: task.taskHash }
      : null;
    const record = (decision, reasonCode, extra = {}) => ({
      taskId: task.taskId, documentId: snapshot.documentId, planVersion: snapshot.planVersion, snapshotContentHash: snapshot.contentHash,
      decision, reasonCode, desiredFingerprint, observedFingerprint: null, jiraIssueKey: null, differences: [],
      sourceVersionDrift, createdAt: created, ...extra,
    });

    const owners = byMarker.get(task.taskId) ?? [];
    const normalizedTitle = cleanText(task.title);
    const collisions = owners.length === 0 ? unmarked.filter((issue) => issue.title === normalizedTitle) : [];
    if (collisions.length > 0) {
      // Fail closed. The unmarked issue does NOT become the owner of the TASK_ID; an explicit resolution is required.
      conflicts.push(record("CONFLICT", "POTENTIAL_REMOTE_COLLISION", {
        jiraIssueKeys: collisions.map((issue) => issue.jiraIssueKey).sort(lt),
        differences: collisions.map((issue) => ({ field: "identity", kind: "UNMARKED_TITLE_COLLISION", key: issue.jiraIssueKey, desired: normalizedTitle, observed: issue.title })).sort((a, b) => lt(a.key, b.key)),
      }));
    } else if (owners.length === 0) {
      creates.push(record("CREATE", "TASK_NOT_MATERIALIZED", { proposedMaterialization: materializationPayload(snapshot, task) }));
    } else if (owners.length > 1) {
      conflicts.push(record("CONFLICT", "DUPLICATE_TASK_ID_REMOTE", {
        jiraIssueKeys: owners.map((issue) => issue.jiraIssueKey).sort(lt),
        differences: owners.map((issue) => ({ field: "identity", kind: "DUPLICATE_OWNER", key: issue.jiraIssueKey, desired: task.taskId, observed: issue.taskIdMarker })).sort((a, b) => lt(a.key, b.key)),
      }));
    } else {
      const [issue] = owners;
      const differences = diffTask(task, issue);
      const equalFingerprints = issue.observedFingerprint === desiredFingerprint;
      if (differences.length === 0 && !equalFingerprints) throw new ReconcileInputError(`internal inconsistency for ${task.taskId}: no differences but fingerprints differ`, "FINGERPRINT_INCONSISTENT");
      if (differences.length > 0 && equalFingerprints) throw new ReconcileInputError(`internal inconsistency for ${task.taskId}: differences but equal fingerprints`, "FINGERPRINT_INCONSISTENT");
      const common = { observedFingerprint: issue.observedFingerprint, jiraIssueKey: issue.jiraIssueKey, differences };
      if (differences.length === 0) noops.push(record("NOOP", "STATE_MATCH", common));
      else conflicts.push(record("CONFLICT", conflictReason(differences), common));
    }
  }

  const remoteOnly = [];
  for (const issue of observation.issues) {
    if (issue.taskIdMarker !== null && desiredIds.has(issue.taskIdMarker)) continue;
    const classification = issue.markerProblem !== null ? "AMBIGUOUS_REMOTE_IDENTITY"
      : issue.taskIdMarker === null ? "UNMARKED_REMOTE_ISSUE"
        : history.has(issue.taskIdMarker) ? "ORPHANED_REMOVED_TASK" : "UNKNOWN_TASK_MARKER";
    remoteOnly.push({
      jiraIssueKey: issue.jiraIssueKey, taskIdMarker: issue.taskIdMarker, classification,
      duplicateMarker: issue.taskIdMarker !== null && (byMarker.get(issue.taskIdMarker)?.length ?? 0) > 1,
      status: issue.status, observedFingerprint: issue.observedFingerprint,
      planVersion: snapshot.planVersion, snapshotContentHash: snapshot.contentHash, createdAt: created,
    });
  }
  remoteOnly.sort((a, b) => lt(a.jiraIssueKey, b.jiraIssueKey));

  const result = {
    documentId: snapshot.documentId, planVersion: snapshot.planVersion, snapshotContentHash: snapshot.contentHash,
    creates, noops, conflicts, remoteOnly,
    // counts are derived from the arrays at this single point; there are no maintained counters
    counts: { creates: creates.length, noops: noops.length, conflicts: conflicts.length, remoteOnly: remoteOnly.length },
  };
  if (result.counts.creates + result.counts.noops + result.counts.conflicts !== snapshot.tasks.length) {
    throw new ReconcileInputError("every desired task must receive exactly one decision", "DECISION_COUNT_MISMATCH");
  }
  return deepFreeze(result);
}

/** Canonical byte-stable serialization of a reconciliation result. */
export const serializeReconciliation = (result) => sortedStringify(result);
