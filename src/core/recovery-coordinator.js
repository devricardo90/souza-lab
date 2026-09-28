import { makeEvidenceEvent } from "./contracts.js";
import { ComputedStateEngine } from "./state-engine.js";

const REQUIRED_METHODS = Object.freeze({
  taskSystem: ["listTasks", "resolveNextTask"],
  gitProvider: ["getRevision"],
  scmProvider: ["getMergeFact"],
  ciProvider: ["getCIResult"],
  reviewProvider: ["getReviewResult"],
  validationProvider: ["getValidationResult"],
});

function recoveryProjections(computed) {
  const projection = Object.freeze({
    state: computed.state,
    derivedState: computed.derivedState,
    taskId: computed.taskId,
    candidateHead: computed.candidateHead,
    nextTaskId: computed.nextTaskId,
    computedAt: computed.computedAt,
  });
  return Object.freeze({ state: projection, handoff: projection });
}

function sameRecoveryEvent(existing, proposed) {
  if (!existing) return false;
  const withoutTime = ({ occurredAt: _occurredAt, ...event }) => JSON.stringify(event);
  return withoutTime(existing) === withoutTime(proposed);
}

export class RecoveryError extends Error {
  constructor(message, code = "RECOVERY_ERROR") {
    super(message);
    this.name = "RecoveryError";
    this.code = code;
  }
}

function assertProviders(providers) {
  for (const [providerName, methods] of Object.entries(REQUIRED_METHODS)) {
    const provider = providers[providerName];
    for (const method of methods) {
      if (typeof provider?.[method] !== "function") {
        throw new RecoveryError(`${providerName}.${method} is required`, "PROVIDER_CONTRACT_MISSING");
      }
    }
  }
  if (providers.evidenceStore && (typeof providers.evidenceStore.append !== "function"
    || typeof providers.evidenceStore.getById !== "function")) {
    throw new RecoveryError("evidenceStore.append/getById are required", "PROVIDER_CONTRACT_MISSING");
  }
}

/** Rebuild the first unproved step from providers after an interrupted run. */
export class RecoveryCoordinator {
  constructor({ taskSystem, gitProvider, scmProvider, ciProvider, reviewProvider, validationProvider, evidenceStore = null, stateEngine = new ComputedStateEngine() } = {}) {
    this.providers = { taskSystem, gitProvider, scmProvider, ciProvider, reviewProvider, validationProvider, evidenceStore };
    assertProviders(this.providers);
    if (typeof stateEngine?.compute !== "function" || typeof stateEngine?.recover !== "function") {
      throw new RecoveryError("stateEngine.compute/recover are required", "PROVIDER_CONTRACT_MISSING");
    }
    this.stateEngine = stateEngine;
  }

  recover({
    activeTaskId = null,
    activeTaskHint = null,
    specRevision = null,
    specDigest = null,
    stateProjection = null,
    handoffProjection = null,
    narrativeClaim = null,
    eventId = null,
    now = new Date().toISOString(),
  } = {}) {
    const { taskSystem, gitProvider, scmProvider, ciProvider, reviewProvider, validationProvider, evidenceStore } = this.providers;
    const tasks = taskSystem.listTasks();
    const selection = taskSystem.resolveNextTask();
    let taskId = activeTaskId ?? selection.taskId;
    if (activeTaskHint !== null) {
      const hintedTask = tasks.find((entry) => entry.id === activeTaskHint) ?? null;
      if (!hintedTask) throw new RecoveryError(`active task ${activeTaskHint} is not present in the task source`, "ACTIVE_TASK_MISSING");
      // A checkpoint can resume the same selected task or finish a task already
      // marked complete. It cannot steer execution ahead of current task order.
      taskId = hintedTask.completed || selection.taskId === activeTaskHint
        ? activeTaskHint
        : selection.taskId;
    }
    const task = taskId === null ? null : tasks.find((entry) => entry.id === taskId) ?? null;
    if (taskId !== null && !task) throw new RecoveryError(`active task ${taskId} is not present in the task source`, "ACTIVE_TASK_MISSING");

    if (!task) {
      const recovered = this.stateEngine.recover({ now });
      const result = Object.freeze({ ...recovered, taskId: null, selection, nextTaskId: null, projections: recoveryProjections(recovered.computed) });
      return this.recordRecovery(result, { eventId, now, evidenceStore });
    }

    const completedTaskIds = tasks.filter((entry) => entry.completed).map((entry) => entry.id);
    let revision = null;
    let specReview = null;
    let ci = null;
    let validation = null;
    let review = null;
    let merge = null;
    let postMergeValidation = null;
    let providerFailure = null;
    try {
      revision = gitProvider.getRevision();
      specReview = specRevision ? reviewProvider.getReviewResult(specRevision.head) : null;
      ci = revision ? ciProvider.getCIResult(revision.head) : null;
      validation = revision ? validationProvider.getValidationResult(task.id, revision.head) : null;
      review = revision ? reviewProvider.getReviewResult(revision.head) : null;
      merge = revision ? scmProvider.getMergeFact(task.id, revision.head) : null;
      postMergeValidation = merge?.merged
        ? validationProvider.getValidationResult(task.id, merge.mergeCommit)
        : null;
    } catch (error) {
      providerFailure = error;
    }

    const facts = {
      task,
      completedTaskIds,
      revision,
      specRevision,
      specReview,
      specDigest,
      ci,
      validation,
      review,
      merge,
      postMergeValidation,
      stateProjection,
      handoffProjection,
      narrativeClaim,
      now,
    };
    let recovered = providerFailure
      ? this.stateEngine.recover({
        ...facts,
        retryableWait: providerFailure.retryable === true,
        externalBlocked: providerFailure.retryable !== true,
      })
      : this.stateEngine.recover(facts);
    let nextTaskId = null;
    if (recovered.computed.state === "DONE") {
      const next = taskSystem.resolveNextTask({ additionalCompletedIds: [task.id] });
      nextTaskId = next.taskId;
      recovered = this.stateEngine.recover({ ...facts, nextTaskId });
    }
    const result = Object.freeze({
      ...recovered,
      taskId: task.id,
      selection,
      nextTaskId,
      facts,
      providerFailure: providerFailure ? Object.freeze({ retryable: providerFailure.retryable === true }) : null,
      projections: recoveryProjections(recovered.computed),
    });
    return this.recordRecovery(result, { eventId, now, evidenceStore });
  }

  recordRecovery(result, { eventId, now, evidenceStore }) {
    if (!evidenceStore) return result;
    if (typeof eventId !== "string" || eventId.trim() === "") {
      throw new RecoveryError("eventId is required when recording recovery", "RECOVERY_EVENT_ID_REQUIRED");
    }
    const computed = result.computed;
    const event = makeEvidenceEvent({
      eventId,
      eventType: "RECOVERY_COMPUTED",
      occurredAt: now,
      taskId: computed.taskId,
      revisionHead: computed.candidateHead,
      payload: {
        state: computed.state,
        derivedState: computed.derivedState,
        firstUnprovedStep: result.firstUnprovedStep,
        blockers: computed.blockers,
        nextTaskId: result.nextTaskId,
      },
    });
    const existing = evidenceStore.getById(eventId);
    if (existing) {
      if (!sameRecoveryEvent(existing, event)) {
        throw new RecoveryError(`event id ${eventId} already records a different recovery`, "EVIDENCE_EVENT_ID_CONFLICT");
      }
      return Object.freeze({ ...result, evidenceEvent: existing, evidenceReused: true });
    }
    evidenceStore.append(event);
    return Object.freeze({ ...result, evidenceEvent: event, evidenceReused: false });
  }
}
