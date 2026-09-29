import { createHash } from "node:crypto";
import { LOOP_STATES } from "./contracts.js";

export const RUNTIME_ACTIONS = Object.freeze([
  "NO_OP", "LOAD_TASK", "PREPARE_SPEC", "REQUEST_SPEC_REVIEW",
  "PREPARE_IMPLEMENTATION", "CREATE_PULL_REQUEST", "RUN_TESTS", "RUN_VALIDATION", "REQUEST_REVIEW",
  "PREPARE_MERGE", "RUN_POST_MERGE_VALIDATION", "WRITE_PROJECTIONS", "WAIT",
  "ESCALATE_OWNER", "ESCALATE_EXTERNAL", "COMPLETE",
]);

export const ACTION_RECONCILIATION = Object.freeze(["NOT_STARTED", "COMPLETED", "IN_PROGRESS", "UNKNOWN"]);
export const ACTION_RESULTS = Object.freeze(["SUCCEEDED", "FAILED", "WAITING", "RECONCILE_REQUIRED", "BLOCKED"]);
export const ERROR_CLASSIFICATIONS = Object.freeze([
  "TRANSIENT", "PERMANENT", "OWNER_REQUIRED", "EXTERNAL_BLOCK", "INVARIANT_VIOLATION",
]);
export const EXECUTION_OUTCOMES = Object.freeze(["CONTINUE", "DONE", "WAIT_RETRYABLE", "BLOCKED_OWNER", "BLOCKED_EXTERNAL"]);

export class RuntimeContractError extends TypeError {
  constructor(path, message) {
    super(`${path}: ${message}`);
    this.name = "RuntimeContractError";
    this.path = path;
  }
}

function object(value, path) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new RuntimeContractError(path, "must be an object");
  return value;
}

function text(value, path) {
  if (typeof value !== "string" || value.trim() === "") throw new RuntimeContractError(path, "must be a non-empty string");
  return value.trim();
}

function timestamp(value, path) {
  const result = text(value, path);
  if (!Number.isFinite(Date.parse(result))) throw new RuntimeContractError(path, "must be a timestamp");
  return result;
}

function oneOf(value, options, path) {
  if (!options.includes(value)) throw new RuntimeContractError(path, `must be one of ${options.join(", ")}`);
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fingerprint(value) {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function executionFactsFingerprint(facts = {}) {
  const stable = Object.fromEntries([
    "task", "completedTaskIds", "revision", "specRevision", "specDigest", "specReview",
    "ci", "validation", "review", "pullRequest", "merge", "postMergeValidation",
  ].filter((key) => facts[key] !== undefined).map((key) => [key, facts[key]]));
  return fingerprint(stable);
}

export function makeObservation(input) {
  const value = object(input, "Observation");
  if (!value.computed || !LOOP_STATES.includes(value.computed.state)) throw new RuntimeContractError("Observation.computed", "must contain a canonical computed state");
  return Object.freeze({
    executionId: text(value.executionId, "Observation.executionId"),
    repository: text(value.repository ?? "repository-unspecified", "Observation.repository"),
    cycleId: text(value.cycleId, "Observation.cycleId"),
    observedAt: timestamp(value.observedAt, "Observation.observedAt"),
    recovery: value.recovery,
    snapshot: value.snapshot ?? null,
    computed: value.computed,
    projectionDrift: value.projectionDrift === true,
    evidenceSequence: Number.isInteger(value.evidenceSequence) && value.evidenceSequence >= 0 ? value.evidenceSequence : 0,
    evidenceRootHash: value.evidenceRootHash ?? null,
    checkpointStatus: value.checkpointStatus ?? "UNANCHORED",
    factsFingerprint: value.factsFingerprint ?? null,
    evidenceEventCount: value.evidenceEventCount ?? 0,
  });
}

export function makeExecutionSnapshot(input) {
  const value = object(input, "ExecutionSnapshot");
  if (!value.computed || !LOOP_STATES.includes(value.computed.state)) throw new RuntimeContractError("ExecutionSnapshot.computed", "must contain a canonical state");
  return Object.freeze({
    executionId: text(value.executionId, "ExecutionSnapshot.executionId"),
    repository: text(value.repository ?? "repository-unspecified", "ExecutionSnapshot.repository"),
    taskId: value.taskId == null ? null : text(value.taskId, "ExecutionSnapshot.taskId"),
    candidateRevision: value.candidateRevision ?? null,
    specDigest: value.specDigest ?? null,
    acceptanceCriteriaDigest: value.acceptanceCriteriaDigest ?? null,
    computed: value.computed,
    facts: value.facts ?? Object.freeze({}),
    observedAt: timestamp(value.observedAt, "ExecutionSnapshot.observedAt"),
  });
}

export function makePlannedAction(input) {
  const value = object(input, "PlannedAction");
  const actionType = oneOf(value.actionType, RUNTIME_ACTIONS, "PlannedAction.actionType");
  const actionId = text(value.actionId, "PlannedAction.actionId");
  const taskId = value.taskId == null ? null : text(value.taskId, "PlannedAction.taskId");
  const candidateRevision = value.candidateRevision == null ? null : text(value.candidateRevision, "PlannedAction.candidateRevision");
  const inputFingerprint = text(value.inputFingerprint, "PlannedAction.inputFingerprint");
  if (!Number.isInteger(value.attempt) || value.attempt < 1) throw new RuntimeContractError("PlannedAction.attempt", "must be a positive integer");
  return Object.freeze({
    actionId,
    actionType,
    taskId,
    candidateRevision,
    preconditions: Object.freeze({ ...object(value.preconditions ?? {}, "PlannedAction.preconditions") }),
    inputFingerprint,
    attempt: value.attempt,
    createdAt: timestamp(value.createdAt, "PlannedAction.createdAt"),
    executionId: text(value.executionId, "PlannedAction.executionId"),
    repository: text(value.repository ?? "repository-unspecified", "PlannedAction.repository"),
    cycleId: text(value.cycleId, "PlannedAction.cycleId"),
  });
}

export function makeActionResult(input) {
  const value = object(input, "ActionResult");
  if (value.errorClass != null) oneOf(value.errorClass, ERROR_CLASSIFICATIONS, "ActionResult.errorClass");
  return Object.freeze({
    actionId: text(value.actionId, "ActionResult.actionId"),
    executionId: text(value.executionId, "ActionResult.executionId"),
    cycleId: text(value.cycleId, "ActionResult.cycleId"),
    taskId: value.taskId == null ? null : text(value.taskId, "ActionResult.taskId"),
    candidateRevision: value.candidateRevision == null ? null : text(value.candidateRevision, "ActionResult.candidateRevision"),
    result: oneOf(value.result, ACTION_RESULTS, "ActionResult.result"),
    startedAt: timestamp(value.startedAt, "ActionResult.startedAt"),
    finishedAt: timestamp(value.finishedAt, "ActionResult.finishedAt"),
    provider: text(value.provider, "ActionResult.provider"),
    outputReference: value.outputReference == null ? null : text(value.outputReference, "ActionResult.outputReference"),
    errorClass: value.errorClass ?? null,
    retryable: value.retryable === true,
    errorMessage: value.errorMessage == null ? null : text(value.errorMessage, "ActionResult.errorMessage"),
    value: value.value ?? null,
  });
}

export function makeRuntimeCheckpoint(input) {
  const value = object(input, "RuntimeCheckpoint");
  if (!Number.isInteger(value.lastEvidenceSequence) || value.lastEvidenceSequence < 0) throw new RuntimeContractError("RuntimeCheckpoint.lastEvidenceSequence", "must be a non-negative integer");
  return Object.freeze({
    runtimeVersion: text(value.runtimeVersion, "RuntimeCheckpoint.runtimeVersion"),
    executionId: text(value.executionId, "RuntimeCheckpoint.executionId"),
    repository: text(value.repository ?? "repository-unspecified", "RuntimeCheckpoint.repository"),
    cycleId: text(value.cycleId, "RuntimeCheckpoint.cycleId"),
    taskId: value.taskId == null ? null : text(value.taskId, "RuntimeCheckpoint.taskId"),
    observedHead: value.observedHead == null ? null : text(value.observedHead, "RuntimeCheckpoint.observedHead"),
    computedState: oneOf(value.computedState, LOOP_STATES, "RuntimeCheckpoint.computedState"),
    plannedAction: value.plannedAction == null ? null : oneOf(value.plannedAction, RUNTIME_ACTIONS, "RuntimeCheckpoint.plannedAction"),
    actionId: value.actionId == null ? null : text(value.actionId, "RuntimeCheckpoint.actionId"),
    lastEvidenceSequence: value.lastEvidenceSequence,
    timestamp: timestamp(value.timestamp, "RuntimeCheckpoint.timestamp"),
    inputFingerprint: text(value.inputFingerprint, "RuntimeCheckpoint.inputFingerprint"),
    retry: value.retry == null ? null : Object.freeze({ ...value.retry }),
  });
}

export function makeRuntimeCycle(input) {
  const value = object(input, "RuntimeCycle");
  return Object.freeze({
    executionId: text(value.executionId, "RuntimeCycle.executionId"),
    repository: text(value.repository ?? "repository-unspecified", "RuntimeCycle.repository"),
    cycleId: text(value.cycleId, "RuntimeCycle.cycleId"),
    observation: value.observation,
    plannedAction: value.plannedAction ?? null,
    actionResult: value.actionResult ?? null,
    nextComputed: value.nextComputed ?? null,
    outcome: oneOf(value.outcome, EXECUTION_OUTCOMES, "RuntimeCycle.outcome"),
    evidenceEventIds: Object.freeze([...(value.evidenceEventIds ?? [])]),
    checkpoint: value.checkpoint ?? null,
  });
}

export function makeExecutionOutcome(input) {
  const value = object(input, "ExecutionOutcome");
  return Object.freeze({
    executionId: text(value.executionId, "ExecutionOutcome.executionId"),
    repository: text(value.repository ?? "repository-unspecified", "ExecutionOutcome.repository"),
    taskId: value.taskId == null ? null : text(value.taskId, "ExecutionOutcome.taskId"),
    state: oneOf(value.state, LOOP_STATES, "ExecutionOutcome.state"),
    outcome: oneOf(value.outcome, EXECUTION_OUTCOMES, "ExecutionOutcome.outcome"),
    nextTaskId: value.nextTaskId == null ? null : text(value.nextTaskId, "ExecutionOutcome.nextTaskId"),
    cycles: value.cycles,
    retry: value.retry ?? null,
    lastCycle: value.lastCycle ?? null,
  });
}

export function makeWakeupRequest(input) {
  const value = object(input, "WakeupRequest");
  return Object.freeze({
    executionId: text(value.executionId, "WakeupRequest.executionId"),
    reason: text(value.reason, "WakeupRequest.reason"),
    earliestRetryAt: timestamp(value.earliestRetryAt, "WakeupRequest.earliestRetryAt"),
    taskId: value.taskId == null ? null : text(value.taskId, "WakeupRequest.taskId"),
    state: oneOf(value.state, LOOP_STATES, "WakeupRequest.state"),
  });
}

export function makeExecutionLease(input) {
  const value = object(input, "ExecutionLease");
  if (!Number.isSafeInteger(value.fencingToken) || value.fencingToken < 1) {
    throw new RuntimeContractError("ExecutionLease.fencingToken", "must be a positive safe integer");
  }
  const acquiredAt = timestamp(value.acquiredAt, "ExecutionLease.acquiredAt");
  const expiresAt = timestamp(value.expiresAt, "ExecutionLease.expiresAt");
  if (Date.parse(expiresAt) <= Date.parse(acquiredAt)) {
    throw new RuntimeContractError("ExecutionLease.expiresAt", "must be after acquiredAt");
  }
  return Object.freeze({
    repository: text(value.repository, "ExecutionLease.repository"),
    taskId: text(value.taskId, "ExecutionLease.taskId"),
    executionId: text(value.executionId, "ExecutionLease.executionId"),
    ownerId: text(value.ownerId, "ExecutionLease.ownerId"),
    leaseId: text(value.leaseId, "ExecutionLease.leaseId"),
    fencingToken: value.fencingToken,
    acquiredAt,
    expiresAt,
  });
}
