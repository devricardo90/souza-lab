import { ACTION_RECONCILIATION, makeActionResult, makeExecutionOutcome, makeRuntimeCheckpoint, makeRuntimeCycle, makePlannedAction, fingerprint, executionFactsFingerprint } from "./runtime-contracts.js";
import { makeEvidenceEvent } from "./contracts.js";
import { ActionPlanner } from "./action-planner.js";
import { RuntimeRetryPolicy } from "./retry-policy.js";
import { executeWithTimeout, reconcileWithTimeout } from "./capability-executor.js";

const RUNTIME_VERSION = "loop-runtime/1";
const TERMINAL = new Map([
  ["DONE", "DONE"],
  ["BLOCKED_OWNER", "BLOCKED_OWNER"],
  ["BLOCKED_EXTERNAL", "BLOCKED_EXTERNAL"],
]);

export class RuntimeError extends Error {
  constructor(message, code = "RUNTIME_ERROR", classification = "INVARIANT_VIOLATION") {
    super(message);
    this.name = "RuntimeError";
    this.code = code;
    this.classification = classification;
  }
}

function eventFor({ eventId, eventType, now, action, taskId, revisionHead, payload }) {
  return makeEvidenceEvent({ eventId, eventType, occurredAt: now, taskId, revisionHead, payload: { ...payload, executionId: action?.executionId ?? null, repository: action?.repository ?? null, cycleId: action?.cycleId ?? null, actionId: action?.actionId ?? null, actionType: action?.actionType ?? null, inputFingerprint: action?.inputFingerprint ?? null } });
}

function equivalentEvent(left, right) {
  if (!left) return false;
  const omitTime = ({ occurredAt: _time, ...record }) => record;
  return fingerprint(omitTime(left)) === fingerprint(omitTime(right));
}

function validateSuccessResult(value, action) {
  const result = makeActionResult(value);
  if (result.actionId !== action.actionId || result.executionId !== action.executionId
    || result.cycleId !== action.cycleId || result.taskId !== action.taskId
    || result.candidateRevision !== action.candidateRevision || result.result !== "SUCCEEDED") {
    throw new RuntimeError("capability result identity/status does not match the planned action", "ACTION_RESULT_MISMATCH");
  }
  return result;
}

export class LoopRuntime {
  constructor({
    observer, executor, evidenceStore, evidenceCheckpointProvider, checkpointStore,
    planner = new ActionPlanner(), retryPolicy = new RuntimeRetryPolicy(), wakeupProvider = null,
    timeoutMs = 30000, clock = () => new Date().toISOString(), faultInjector = () => {},
  } = {}) {
    if (typeof observer?.observe !== "function" || typeof executor?.execute !== "function" || typeof executor?.reconcile !== "function") throw new TypeError("LoopRuntime requires observer and reconcile-capable executor");
    if (typeof evidenceStore?.append !== "function" || typeof evidenceStore?.getById !== "function" || typeof evidenceStore?.listAll !== "function") throw new TypeError("LoopRuntime requires durable EvidenceStore");
    if (typeof evidenceCheckpointProvider?.publishCheckpoint !== "function") throw new TypeError("LoopRuntime requires EvidenceCheckpointProvider");
    if (typeof checkpointStore?.read !== "function" || typeof checkpointStore?.write !== "function") throw new TypeError("LoopRuntime requires RuntimeCheckpointStore");
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
    this.observer = observer;
    this.executor = executor;
    this.evidenceStore = evidenceStore;
    this.evidenceCheckpointProvider = evidenceCheckpointProvider;
    this.checkpointStore = checkpointStore;
    this.planner = planner;
    this.retryPolicy = retryPolicy;
    this.wakeupProvider = wakeupProvider;
    this.timeoutMs = timeoutMs;
    this.clock = clock;
    this.faultInjector = faultInjector;
    this.cycleCount = new Map();
  }

  async inject(point, data) {
    try { await this.faultInjector(point, data); }
    catch (error) {
      error.runtimeCrash = true;
      throw error;
    }
  }

  async appendEvidence(event) {
    const existing = this.evidenceStore.getById(event.eventId);
    if (existing) {
      if (!equivalentEvent(existing, event)) throw new RuntimeError(`evidence event id conflict: ${event.eventId}; existing=${JSON.stringify(existing)}; proposed=${JSON.stringify(event)}`, "EVIDENCE_EVENT_CONFLICT");
      return { event: existing, reused: true };
    }
    const saved = this.evidenceStore.append(event);
    await this.inject("after_evidence_append_before_checkpoint", { event: saved });
    const tail = this.evidenceStore.getIntegrityCheckpoint();
    this.evidenceCheckpointProvider.publishCheckpoint({ ...tail, timestamp: this.clock() });
    return { event: saved, reused: false };
  }

  nextCycleId(executionId, checkpoint) {
    const previous = this.cycleCount.get(executionId)
      ?? Number(checkpoint?.cycleId?.match(/:(\d+)$/)?.[1] ?? 0);
    const next = previous + 1;
    this.cycleCount.set(executionId, next);
    return `${executionId}:cycle:${next}`;
  }

  attemptFor(observation, planned) {
    const baseFingerprint = planned.inputFingerprint;
    const attempts = this.evidenceStore.listAll()
      .filter((event) => event.eventType === "ACTION_RESULT" && event.payload?.inputFingerprint === baseFingerprint
        && (event.payload?.result === "FAILED" || event.payload?.result === "WAITING"))
      .length;
    return attempts + 1;
  }

  async checkpoint(executionId, cycleId, observation, action, retry = null) {
    const tail = this.evidenceStore.getIntegrityCheckpoint();
    return this.checkpointStore.write(makeRuntimeCheckpoint({
      runtimeVersion: RUNTIME_VERSION,
      executionId,
      repository: observation.repository,
      cycleId,
      taskId: observation.computed.taskId,
      observedHead: observation.computed.candidateHead,
      computedState: observation.computed.state,
      plannedAction: action?.actionType ?? null,
      actionId: action?.actionId ?? null,
      lastEvidenceSequence: tail.sequence,
      timestamp: this.clock(),
      inputFingerprint: fingerprint({ state: observation.computed.state, facts: observation.recovery?.facts ?? {} }),
      retry,
    }));
  }

  async runCycle({ executionId, repository, maxCyclesHint = null } = {}) {
    if (typeof executionId !== "string" || executionId.trim() === "") throw new TypeError("executionId is required");
    if (typeof repository !== "string" || repository.trim() === "") throw new TypeError("repository identity is required");
    const now = this.clock();
    const previousCheckpoint = this.checkpointStore.read(executionId);
    const cycleId = this.nextCycleId(executionId, previousCheckpoint);
    let observation = this.observer.observe({ executionId, repository, cycleId, checkpoint: previousCheckpoint, now });
    let planned = this.planner.plan(observation, { now, repository, cycleId });
    planned = this.planner.plan(observation, { attempt: this.attemptFor(observation, planned), now, repository, cycleId });
    const priorPlan = this.evidenceStore.getById(`${planned.actionId}:planned`);
    if (priorPlan?.payload?.cycleId && priorPlan.payload.cycleId !== planned.cycleId) {
      planned = makePlannedAction({ ...planned, cycleId: priorPlan.payload.cycleId });
    }

    const plannedEvent = eventFor({
      eventId: `${planned.actionId}:planned`, eventType: "ACTION_PLANNED", now,
      action: planned, taskId: planned.taskId, revisionHead: planned.candidateRevision,
      payload: { repository, preconditions: planned.preconditions, attempt: planned.attempt },
    });
    await this.appendEvidence(plannedEvent);
    await this.checkpoint(executionId, cycleId, observation, planned, previousCheckpoint?.retry ?? null);
    await this.inject("after_planning_before_execution", { observation, plannedAction: planned });

    let actionResult = null;
    let retry = null;
    let resultAlreadyDurable = false;
    let outcome = "CONTINUE";
    if (TERMINAL.has(observation.computed.state) && planned.actionType !== "WRITE_PROJECTIONS") {
      outcome = TERMINAL.get(observation.computed.state);
    }
    const eventIds = [plannedEvent.eventId];
    const retryNotDue = previousCheckpoint?.retry?.nextEligibleAt && Date.parse(previousCheckpoint.retry.nextEligibleAt) > Date.parse(now);
    if (retryNotDue) {
      retry = previousCheckpoint.retry;
      outcome = "WAIT_RETRYABLE";
    } else if (outcome === "CONTINUE" && ["WAIT", "ESCALATE_OWNER", "ESCALATE_EXTERNAL", "COMPLETE"].includes(planned.actionType)) {
      if (planned.actionType === "WAIT") outcome = "WAIT_RETRYABLE";
      else if (planned.actionType === "ESCALATE_OWNER") outcome = "BLOCKED_OWNER";
      else if (planned.actionType === "ESCALATE_EXTERNAL") outcome = "BLOCKED_EXTERNAL";
      else outcome = "DONE";
    } else if (outcome === "CONTINUE") {
      const evidenceResult = this.evidenceStore.getById(`${planned.actionId}:result`);
      const context = { repository, executionId, cycleId, idempotencyKey: planned.actionId, observation, timeoutMs: this.timeoutMs };
      const fresh = this.observer.observe({ executionId, repository, cycleId, checkpoint: previousCheckpoint, now: this.clock() });
      const freshFingerprint = executionFactsFingerprint(fresh.recovery?.facts ?? {});
      if (fresh.computed.state !== planned.preconditions.computedState
        || fresh.computed.candidateHead !== planned.preconditions.candidateRevision
        || freshFingerprint !== planned.preconditions.recoveryInputFingerprint) {
        actionResult = makeActionResult({
          actionId: planned.actionId, result: "BLOCKED", startedAt: this.clock(), finishedAt: this.clock(),
          executionId, cycleId, taskId: planned.taskId, candidateRevision: planned.candidateRevision,
          provider: "runtime-precondition-guard", errorClass: "INVARIANT_VIOLATION", retryable: false,
          errorMessage: "authoritative facts changed after planning; action aborted",
        });
        observation = fresh;
        outcome = "CONTINUE";
      } else if (evidenceResult?.payload?.result === "SUCCEEDED") {
        actionResult = makeActionResult({
          actionId: planned.actionId, result: "RECONCILE_REQUIRED", startedAt: now, finishedAt: this.clock(),
          executionId, cycleId, taskId: planned.taskId, candidateRevision: planned.candidateRevision,
          provider: "evidence-store", outputReference: evidenceResult.payload.outputReference ?? planned.actionId,
          errorClass: "INVARIANT_VIOLATION", errorMessage: "successful action evidence exists but provider state has not advanced",
        });
        resultAlreadyDurable = true;
        outcome = "BLOCKED_EXTERNAL";
      } else {
        let reconciled;
        try { reconciled = await reconcileWithTimeout(this.executor, planned, context, this.timeoutMs); }
        catch (error) { reconciled = { status: "UNKNOWN", error }; }
        if (!ACTION_RECONCILIATION.includes(reconciled?.status)) {
          actionResult = makeActionResult({
            actionId: planned.actionId, executionId, cycleId, taskId: planned.taskId, candidateRevision: planned.candidateRevision,
            result: "BLOCKED", startedAt: now, finishedAt: this.clock(), provider: "capability-reconciler",
            errorClass: "INVARIANT_VIOLATION", errorMessage: "executor returned an unknown reconciliation status",
          });
          outcome = "BLOCKED_EXTERNAL";
        } else if (reconciled.status === "COMPLETED") {
          try { actionResult = validateSuccessResult(reconciled.result, planned); }
          catch (error) {
            actionResult = makeActionResult({
              actionId: planned.actionId, executionId, cycleId, taskId: planned.taskId, candidateRevision: planned.candidateRevision,
              result: "BLOCKED", startedAt: now, finishedAt: this.clock(), provider: "capability-reconciler",
              errorClass: "INVARIANT_VIOLATION", errorMessage: error.message,
            });
            outcome = "BLOCKED_EXTERNAL";
          }
        } else if (reconciled?.status === "IN_PROGRESS" || reconciled?.status === "UNKNOWN") {
          const error = reconciled.error ?? Object.assign(new Error(`action reconciliation is ${reconciled.status}`), { classification: "TRANSIENT", retryable: true });
          retry = this.retryPolicy.decide(error, planned, { now: this.clock() });
          outcome = retry.outcome;
          actionResult = makeActionResult({
            actionId: planned.actionId, executionId, cycleId, taskId: planned.taskId, candidateRevision: planned.candidateRevision,
            result: retry.outcome === "WAIT_RETRYABLE" ? "WAITING" : "FAILED",
            startedAt: now, finishedAt: this.clock(), provider: "capability-reconciler",
            errorClass: retry.classification, retryable: retry.classification === "TRANSIENT", errorMessage: retry.lastFailure,
          });
        } else {
          try {
            const output = await executeWithTimeout(this.executor, planned, context, this.timeoutMs);
            actionResult = validateSuccessResult(output, planned);
            await this.inject("after_provider_success_before_evidence", { observation, plannedAction: planned, actionResult });
          } catch (error) {
            if (error.runtimeCrash === true) throw error;
            const decision = this.retryPolicy.decide(error, planned, { now: this.clock() });
            retry = decision;
            outcome = decision.outcome;
            actionResult = makeActionResult({
              actionId: planned.actionId, result: decision.outcome === "WAIT_RETRYABLE" ? "WAITING" : "FAILED",
              executionId, cycleId, taskId: planned.taskId, candidateRevision: planned.candidateRevision,
              startedAt: now, finishedAt: this.clock(), provider: "capability-executor",
              errorClass: decision.classification, retryable: decision.classification === "TRANSIENT",
              errorMessage: error.message ?? String(error),
            });
          }
        }
      }

      if (actionResult && !resultAlreadyDurable) {
        const resultEvent = eventFor({
          eventId: `${planned.actionId}:result`, eventType: "ACTION_RESULT", now: actionResult.finishedAt,
          action: planned, taskId: planned.taskId, revisionHead: planned.candidateRevision,
          payload: {
            result: actionResult.result, provider: actionResult.provider, outputReference: actionResult.outputReference,
            errorClass: actionResult.errorClass, retryable: actionResult.retryable,
            attempt: planned.attempt, repository, startedAt: actionResult.startedAt, finishedAt: actionResult.finishedAt,
          },
        });
        await this.appendEvidence(resultEvent);
        eventIds.push(resultEvent.eventId);
      }
      if (retry?.wakeup && this.wakeupProvider?.schedule) {
        this.wakeupProvider.schedule(retry.wakeup);
        const wakeupEvent = eventFor({
          eventId: `${planned.actionId}:wakeup:${planned.attempt}`, eventType: "WAKEUP_SCHEDULED", now: this.clock(),
          action: planned, taskId: planned.taskId, revisionHead: planned.candidateRevision,
          payload: retry.wakeup,
        });
        await this.appendEvidence(wakeupEvent);
        eventIds.push(wakeupEvent.eventId);
      }
      await this.inject("after_action_result_before_checkpoint", { observation, plannedAction: planned, actionResult });
    }

    let nextObservation = observation;
    if (outcome === "CONTINUE" && actionResult?.result === "SUCCEEDED") {
      nextObservation = this.observer.observe({ executionId, repository, cycleId, checkpoint: previousCheckpoint, now: this.clock() });
    }
    const checkpoint = await this.checkpoint(executionId, cycleId, nextObservation, planned, retry);
    await this.inject("after_checkpoint_before_next_observation", { checkpoint, observation: nextObservation });
    const cycleEvent = eventFor({
      eventId: `${cycleId}:reconciled`, eventType: "RUNTIME_CYCLE", now: this.clock(), action: planned,
      taskId: nextObservation.computed.taskId, revisionHead: nextObservation.computed.candidateHead,
      payload: {
        repository,
        observedState: observation.computed.state,
        observedBlockers: observation.computed.blockers,
        plannedAction: planned.actionType,
        actionResult: actionResult ? { result: actionResult.result, provider: actionResult.provider, errorClass: actionResult.errorClass } : null,
        evidenceEventIds: eventIds,
        nextState: nextObservation.computed.state,
        nextBlockers: nextObservation.computed.blockers,
        outcome,
      },
    });
    await this.appendEvidence(cycleEvent);
    eventIds.push(cycleEvent.eventId);
    const finalCheckpoint = await this.checkpoint(executionId, cycleId, nextObservation, planned, retry);
    return makeRuntimeCycle({
      executionId, repository, cycleId, observation, plannedAction: planned, actionResult,
      nextComputed: nextObservation.computed, outcome, evidenceEventIds: eventIds, checkpoint: finalCheckpoint,
      maxCyclesHint,
    });
  }

  async runUntilStop({ executionId, repository, maxCycles = 100 } = {}) {
    if (!Number.isInteger(maxCycles) || maxCycles < 1) throw new TypeError("maxCycles must be a positive integer");
    const cycles = [];
    let outcome = "CONTINUE";
    for (let index = 0; index < maxCycles; index += 1) {
      const cycle = await this.runCycle({ executionId, repository, maxCyclesHint: maxCycles });
      cycles.push(cycle);
      outcome = cycle.outcome;
      if (outcome !== "CONTINUE") break;
    }
    const last = cycles.at(-1);
    const state = last?.nextComputed?.state ?? "DISCOVER";
    return makeExecutionOutcome({
      executionId, repository, taskId: last?.nextComputed?.taskId ?? null, state,
      outcome: outcome === "CONTINUE" ? "CONTINUE" : outcome,
      nextTaskId: last?.nextComputed?.nextTaskId ?? null,
      cycles: cycles.length, retry: last?.checkpoint?.retry ?? null, lastCycle: last ?? null,
    });
  }
}
