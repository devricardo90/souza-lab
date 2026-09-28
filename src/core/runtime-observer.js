import { makeExecutionSnapshot, makeObservation, fingerprint } from "./runtime-contracts.js";
import { publishCurrentEvidenceCheckpoint, verifyEvidenceCheckpoint } from "../adapters/local-evidence-checkpoint-provider.js";

export class RuntimeObservationError extends Error {
  constructor(message, code = "RUNTIME_OBSERVATION_FAILED", classification = "INVARIANT_VIOLATION") {
    super(message);
    this.name = "RuntimeObservationError";
    this.code = code;
    this.classification = classification;
  }
}

export class RuntimeObserver {
  constructor({ recoveryCoordinator, evidenceStore, evidenceCheckpointProvider, projectionStore = null, contextProvider = () => ({}) } = {}) {
    if (typeof recoveryCoordinator?.recover !== "function") throw new TypeError("RuntimeObserver requires RecoveryCoordinator.recover");
    if (typeof evidenceStore?.listAll !== "function" || typeof evidenceStore?.getIntegrityCheckpoint !== "function") throw new TypeError("RuntimeObserver requires an integrity-verifiable EvidenceStore");
    if (typeof evidenceCheckpointProvider?.readTrustedCheckpoint !== "function" || typeof evidenceCheckpointProvider?.publishCheckpoint !== "function") throw new TypeError("RuntimeObserver requires EvidenceCheckpointProvider");
    this.recoveryCoordinator = recoveryCoordinator;
    this.evidenceStore = evidenceStore;
    this.evidenceCheckpointProvider = evidenceCheckpointProvider;
    this.projectionStore = projectionStore;
    this.contextProvider = contextProvider;
  }

  observe({ executionId, repository = "repository-unspecified", cycleId, checkpoint = null, now = new Date().toISOString() }) {
    let events;
    try { events = this.evidenceStore.listAll(); }
    catch (error) { throw new RuntimeObservationError(`evidence history is invalid: ${error.message}`, "EVIDENCE_HISTORY_INVALID"); }
    let checkpointStatus;
    try {
      const verification = verifyEvidenceCheckpoint(this.evidenceCheckpointProvider, this.evidenceStore);
      if (verification.status === "TRUNCATED" || verification.status === "MISMATCH") {
        throw new RuntimeObservationError(`trusted evidence checkpoint ${verification.status.toLowerCase()}`, `EVIDENCE_CHECKPOINT_${verification.status}`);
      }
      checkpointStatus = verification.status;
      if (verification.status === "UNANCHORED" || verification.status === "STALE") {
        publishCurrentEvidenceCheckpoint(this.evidenceCheckpointProvider, this.evidenceStore, now);
      }
    } catch (error) {
      if (error instanceof RuntimeObservationError) throw error;
      throw new RuntimeObservationError(`evidence checkpoint validation failed: ${error.message}`, error.code ?? "EVIDENCE_CHECKPOINT_INVALID");
    }

    const projections = this.projectionStore?.read(executionId) ?? { stateProjection: null, handoffProjection: null, drift: false };
    const context = this.contextProvider({ executionId, checkpoint, now }) ?? {};
    let recovery;
    try {
      recovery = this.recoveryCoordinator.recover({
        ...context,
        // Task order comes from the task-system adapter. Recovery validates this
        // checkpoint hint against that selection before reusing an active task.
        activeTaskHint: checkpoint?.taskId ?? null,
        stateProjection: projections.stateProjection,
        handoffProjection: projections.handoffProjection,
        now,
      });
    } catch (error) {
      throw new RuntimeObservationError(`authoritative provider observation failed: ${error.message}`, error.code ?? "PROVIDER_OBSERVATION_FAILED", error.classification ?? (error.retryable ? "TRANSIENT" : "EXTERNAL_BLOCK"));
    }
    const evidenceTail = this.evidenceStore.getIntegrityCheckpoint();
    const computed = recovery.computed;
    const snapshot = makeExecutionSnapshot({
      executionId,
      repository,
      taskId: recovery.taskId,
      candidateRevision: recovery.facts?.revision?.head ?? null,
      specDigest: recovery.facts?.specDigest ?? context.specDigest ?? null,
      acceptanceCriteriaDigest: recovery.facts?.task?.acceptanceCriteriaDigest ?? null,
      computed,
      facts: recovery.facts ?? {},
      observedAt: now,
    });
    return makeObservation({
      executionId,
      repository,
      cycleId,
      observedAt: now,
      recovery,
      computed,
      projectionDrift: projections.drift,
      evidenceSequence: evidenceTail.sequence,
      evidenceRootHash: evidenceTail.rootHash,
      checkpointStatus,
      snapshot,
      factsFingerprint: fingerprint(snapshot.facts),
      evidenceEventCount: events.length,
    });
  }
}
