import { createHash } from "node:crypto";

/**
 * Runtime contracts for the provider-neutral Loop core.
 * Providers exchange only these structures; adapters own external formats.
 */

export const LOOP_STATES = Object.freeze([
  "DISCOVER",
  "SPEC_REQUIRED",
  "SPEC_REVIEW",
  "READY_TO_IMPLEMENT",
  "IMPLEMENTING",
  "TESTING",
  "VALIDATING",
  "REVIEWING",
  "READY_TO_MERGE",
  "MERGING",
  "POST_MERGE_VALIDATION",
  "DONE",
  "WAIT_RETRYABLE",
  "BLOCKED_OWNER",
  "BLOCKED_EXTERNAL",
  "INCONSISTENT_STATE",
]);

export const EVIDENCE_EVENT_TYPES = Object.freeze([
  "TASK_SELECTED",
  "SPEC_REVIEWED",
  "REVISION_OBSERVED",
  "CI_RECORDED",
  "VALIDATION_RECORDED",
  "REVIEW_RECORDED",
  "MERGE_RECORDED",
  "POST_MERGE_VALIDATION_RECORDED",
  "STATE_COMPUTED",
  "RECOVERY_COMPUTED",
  "ACTION_PLANNED",
  "ACTION_RESULT",
  "RUNTIME_CYCLE",
  "CHECKPOINT_WRITTEN",
  "PROJECTIONS_WRITTEN",
  "WAKEUP_SCHEDULED",
]);

const ENUMS = Object.freeze({
  CI_STATUS: ["PASS", "FAIL", "PENDING", "UNKNOWN"],
  REVIEW_VERDICT: ["CLEAN", "FINDINGS", "PENDING", "UNKNOWN"],
  VALIDATION_RESULT: ["PASS", "FAIL", "PENDING", "UNKNOWN"],
});

export class ContractError extends TypeError {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "ContractError";
    this.path = path;
  }
}

function record(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ContractError(path, "must be an object");
  }
  return value;
}

function nonEmptyString(value, path) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContractError(path, "must be a non-empty string");
  }
  return value.trim();
}

function isoTimestamp(value, path) {
  const timestamp = nonEmptyString(value, path);
  if (!/^\d{4}-\d\d-\d\dT/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new ContractError(path, "must be an ISO timestamp");
  }
  return timestamp;
}

function enumValue(value, choices, path) {
  if (!choices.includes(value)) {
    throw new ContractError(path, `must be one of: ${choices.join(", ")}`);
  }
  return value;
}

function stringArray(value, path) {
  if (!Array.isArray(value)) throw new ContractError(path, "must be an array");
  return value.map((item, index) => nonEmptyString(item, `${path}[${index}]`));
}

function objectArray(value, factory, path) {
  if (!Array.isArray(value)) throw new ContractError(path, "must be an array");
  return value.map((item, index) => factory(item, `${path}[${index}]`));
}

export function makeAcceptanceCriterion(input, path = "AcceptanceCriterion") {
  const value = record(input, path);
  return Object.freeze({
    id: nonEmptyString(value.id, `${path}.id`),
    description: nonEmptyString(value.description, `${path}.description`),
  });
}

export function makeDependency(input, path = "Dependency") {
  const value = record(input, path);
  return Object.freeze({
    taskId: nonEmptyString(value.taskId, `${path}.taskId`),
    requiresDone: value.requiresDone === undefined ? true : Boolean(value.requiresDone),
  });
}

export function makeTask(input, path = "Task") {
  const value = record(input, path);
  const acceptanceCriteria = objectArray(value.acceptanceCriteria, makeAcceptanceCriterion, `${path}.acceptanceCriteria`);
  const dependencies = objectArray(value.dependencies, makeDependency, `${path}.dependencies`);
  const criterionIds = acceptanceCriteria.map(({ id }) => id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new ContractError(`${path}.acceptanceCriteria`, "criterion ids must be unique within a task");
  }
  const canonicalCriteria = acceptanceCriteria
    .map(({ id, description }) => ({ id, description }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const acceptanceCriteriaDigest = createHash("sha256")
    .update(JSON.stringify(canonicalCriteria), "utf8")
    .digest("hex");
  return Object.freeze({
    id: nonEmptyString(value.id, `${path}.id`),
    title: nonEmptyString(value.title, `${path}.title`),
    acceptanceCriteria: Object.freeze(acceptanceCriteria),
    acceptanceCriteriaDigest,
    dependencies: Object.freeze(dependencies),
    completed: Boolean(value.completed),
    specPresent: Boolean(value.specPresent),
    specReviewed: Boolean(value.specReviewed),
  });
}

export function makeRevision(input, path = "Revision") {
  const value = record(input, path);
  const head = nonEmptyString(value.head, `${path}.head`);
  if (!/^[0-9a-f]{7,64}$/i.test(head)) throw new ContractError(`${path}.head`, "must be a Git object id");
  const base = value.base == null ? null : nonEmptyString(value.base, `${path}.base`);
  if (base !== null && !/^[0-9a-f]{7,64}$/i.test(base)) throw new ContractError(`${path}.base`, "must be a Git object id");
  return Object.freeze({
    head,
    base,
    branch: value.branch == null ? null : nonEmptyString(value.branch, `${path}.branch`),
    authorId: value.authorId == null ? null : nonEmptyString(value.authorId, `${path}.authorId`),
    dirty: Boolean(value.dirty),
    changedFiles: Object.freeze(stringArray(value.changedFiles ?? [], `${path}.changedFiles`)),
  });
}

export function makeCIResult(input, path = "CIResult") {
  const value = record(input, path);
  return Object.freeze({
    head: nonEmptyString(value.head, `${path}.head`),
    status: enumValue(value.status, ENUMS.CI_STATUS, `${path}.status`),
    checkedAt: value.checkedAt == null ? null : isoTimestamp(value.checkedAt, `${path}.checkedAt`),
    runId: value.runId == null ? null : nonEmptyString(value.runId, `${path}.runId`),
    repository: value.repository == null ? null : nonEmptyString(value.repository, `${path}.repository`),
    workflowIdentity: value.workflowIdentity == null ? null : nonEmptyString(value.workflowIdentity, `${path}.workflowIdentity`),
    conclusion: value.conclusion == null ? null : nonEmptyString(value.conclusion, `${path}.conclusion`),
  });
}

export function makeReviewResult(input, path = "ReviewResult") {
  const value = record(input, path);
  return Object.freeze({
    head: nonEmptyString(value.head, `${path}.head`),
    verdict: enumValue(value.verdict, ENUMS.REVIEW_VERDICT, `${path}.verdict`),
    independent: Boolean(value.independent),
    unresolvedFindings: Number.isInteger(value.unresolvedFindings) && value.unresolvedFindings >= 0
      ? value.unresolvedFindings
      : (() => { throw new ContractError(`${path}.unresolvedFindings`, "must be a non-negative integer"); })(),
    publishedAt: value.publishedAt == null ? null : isoTimestamp(value.publishedAt, `${path}.publishedAt`),
    reviewerId: value.reviewerId == null ? null : nonEmptyString(value.reviewerId, `${path}.reviewerId`),
  });
}

export function makeValidationResult(input, path = "ValidationResult") {
  const value = record(input, path);
  const acProof = record(value.acProof, `${path}.acProof`);
  const total = acProof.total;
  const proved = acProof.proved;
  if (!Number.isInteger(total) || total < 0 || !Number.isInteger(proved) || proved < 0 || proved > total) {
    throw new ContractError(`${path}.acProof`, "total/proved must be valid non-negative criterion counts");
  }
  return Object.freeze({
    head: nonEmptyString(value.head, `${path}.head`),
    baseline: nonEmptyString(value.baseline, `${path}.baseline`),
    specDigest: nonEmptyString(value.specDigest, `${path}.specDigest`),
    acceptanceCriteriaDigest: nonEmptyString(value.acceptanceCriteriaDigest, `${path}.acceptanceCriteriaDigest`),
    result: enumValue(value.result, ENUMS.VALIDATION_RESULT, `${path}.result`),
    acProof: Object.freeze({ total, proved }),
    checkedAt: value.checkedAt == null ? null : isoTimestamp(value.checkedAt, `${path}.checkedAt`),
    independent: Boolean(value.independent),
  });
}

export function makeMergeFact(input, path = "MergeFact") {
  const value = record(input, path);
  const candidateHead = nonEmptyString(value.candidateHead, `${path}.candidateHead`);
  const mergeCommit = value.mergeCommit == null ? null : nonEmptyString(value.mergeCommit, `${path}.mergeCommit`);
  const status = enumValue(value.status ?? (value.merged ? "MERGED" : "NOT_STARTED"), ["NOT_STARTED", "PENDING", "FAILED", "UNKNOWN", "MERGED"], `${path}.status`);
  if (status === "MERGED" && !mergeCommit) throw new ContractError(`${path}.mergeCommit`, "is required when status is MERGED");
  if (value.merged !== undefined && Boolean(value.merged) !== (status === "MERGED")) {
    throw new ContractError(`${path}.merged`, "must agree with status");
  }
  return Object.freeze({
    status,
    merged: status === "MERGED",
    candidateHead,
    mergeCommit,
    mergedAt: value.mergedAt == null ? null : isoTimestamp(value.mergedAt, `${path}.mergedAt`),
  });
}

export function makePullRequestFact(input, path = "PullRequestFact") {
  const value = record(input, path);
  return Object.freeze({
    status: enumValue(value.status, ["ABSENT", "OPEN", "CLOSED", "MERGED", "UNKNOWN"], `${path}.status`),
    taskId: nonEmptyString(value.taskId, `${path}.taskId`),
    candidateHead: nonEmptyString(value.candidateHead, `${path}.candidateHead`),
    headSha: value.headSha == null ? null : nonEmptyString(value.headSha, `${path}.headSha`),
    branch: value.branch == null ? null : nonEmptyString(value.branch, `${path}.branch`),
    number: value.number == null ? null : (() => {
      if (!Number.isSafeInteger(value.number) || value.number < 1) throw new ContractError(`${path}.number`, "must be a positive integer");
      return value.number;
    })(),
    mergeable: value.mergeable == null ? null : Boolean(value.mergeable),
    url: value.url == null ? null : nonEmptyString(value.url, `${path}.url`),
  });
}

export function makeEvidenceEvent(input, path = "EvidenceEvent") {
  const value = record(input, path);
  const eventType = enumValue(value.eventType, EVIDENCE_EVENT_TYPES, `${path}.eventType`);
  const payload = value.payload === undefined ? {} : record(value.payload, `${path}.payload`);
  return Object.freeze({
    schemaVersion: 1,
    eventId: nonEmptyString(value.eventId, `${path}.eventId`),
    eventType,
    occurredAt: isoTimestamp(value.occurredAt, `${path}.occurredAt`),
    taskId: value.taskId == null ? null : nonEmptyString(value.taskId, `${path}.taskId`),
    revisionHead: value.revisionHead == null ? null : nonEmptyString(value.revisionHead, `${path}.revisionHead`),
    payload: Object.freeze({ ...payload }),
  });
}

export function makeComputedState(input, path = "ComputedState") {
  const value = record(input, path);
  const state = enumValue(value.state, LOOP_STATES, `${path}.state`);
  const derivedState = value.derivedState == null ? state : enumValue(value.derivedState, LOOP_STATES, `${path}.derivedState`);
  return Object.freeze({
    state,
    derivedState,
    taskId: value.taskId == null ? null : nonEmptyString(value.taskId, `${path}.taskId`),
    candidateHead: value.candidateHead == null ? null : nonEmptyString(value.candidateHead, `${path}.candidateHead`),
    nextTaskId: value.nextTaskId == null ? null : nonEmptyString(value.nextTaskId, `${path}.nextTaskId`),
    projectionMismatch: value.projectionMismatch === true,
    blockers: Object.freeze(stringArray(value.blockers ?? [], `${path}.blockers`)),
    computedAt: isoTimestamp(value.computedAt, `${path}.computedAt`),
  });
}

class ProviderContract {
  notImplemented(method) {
    throw new Error(`${this.constructor.name}.${method} is not implemented`);
  }
}

export class TaskSystemAdapter extends ProviderContract {
  listTasks() { return this.notImplemented("listTasks"); }
  resolveNextTask() { return this.notImplemented("resolveNextTask"); }
}

export class GitProvider extends ProviderContract {
  getRevision() { return this.notImplemented("getRevision"); }
}

export class SCMProvider extends ProviderContract {
  getMergeFact() { return this.notImplemented("getMergeFact"); }
  getPullRequestFact() { return null; }
}

export class CIProvider extends ProviderContract {
  getCIResult() { return this.notImplemented("getCIResult"); }
}

export class ReviewProvider extends ProviderContract {
  getReviewResult() { return this.notImplemented("getReviewResult"); }
}

export class ValidationProvider extends ProviderContract {
  getValidationResult() { return this.notImplemented("getValidationResult"); }
}

export class EvidenceStore extends ProviderContract {
  append() { return this.notImplemented("append"); }
  getById() { return this.notImplemented("getById"); }
  listByTask() { return this.notImplemented("listByTask"); }
  getIntegrityCheckpoint() { return this.notImplemented("getIntegrityCheckpoint"); }
  getHashAtSequence() { return this.notImplemented("getHashAtSequence"); }
}

export class EvidenceCheckpointProvider extends ProviderContract {
  readTrustedCheckpoint() { return this.notImplemented("readTrustedCheckpoint"); }
  publishCheckpoint() { return this.notImplemented("publishCheckpoint"); }
}

export class RuntimeCheckpointStore extends ProviderContract {
  read() { return this.notImplemented("read"); }
  write() { return this.notImplemented("write"); }
}

export class WakeupProvider extends ProviderContract {
  schedule() { return this.notImplemented("schedule"); }
  listDue() { return this.notImplemented("listDue"); }
}

export class ExecutionLeaseProvider extends ProviderContract {
  acquire() { return this.notImplemented("acquire"); }
  renew() { return this.notImplemented("renew"); }
  release() { return this.notImplemented("release"); }
  inspect() { return this.notImplemented("inspect"); }
}

export class StateEngine extends ProviderContract {
  compute() { return this.notImplemented("compute"); }
  recover() { return this.notImplemented("recover"); }
}
