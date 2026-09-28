import { makePlannedAction, fingerprint, executionFactsFingerprint } from "./runtime-contracts.js";

const STATE_ACTION = Object.freeze({
  DISCOVER: "LOAD_TASK",
  SPEC_REQUIRED: "PREPARE_SPEC",
  SPEC_REVIEW: "REQUEST_SPEC_REVIEW",
  READY_TO_IMPLEMENT: "PREPARE_IMPLEMENTATION",
  IMPLEMENTING: "PREPARE_IMPLEMENTATION",
  TESTING: "RUN_TESTS",
  VALIDATING: "RUN_VALIDATION",
  REVIEWING: "REQUEST_REVIEW",
  READY_TO_MERGE: "PREPARE_MERGE",
  MERGING: "WAIT",
  POST_MERGE_VALIDATION: "RUN_POST_MERGE_VALIDATION",
  DONE: "COMPLETE",
  WAIT_RETRYABLE: "WAIT",
  BLOCKED_OWNER: "ESCALATE_OWNER",
  BLOCKED_EXTERNAL: "ESCALATE_EXTERNAL",
  INCONSISTENT_STATE: "ESCALATE_EXTERNAL",
});

export class ActionPlanner {
  plan(observation, { attempt = 1, now = new Date().toISOString(), repository = observation.repository, cycleId = observation.cycleId } = {}) {
    const computed = observation.computed;
    const actionType = observation.projectionDrift || computed.projectionMismatch
      ? "WRITE_PROJECTIONS"
      : STATE_ACTION[computed.state];
    if (!actionType) throw new TypeError(`no action is defined for computed state ${computed.state}`);
    const input = {
      executionId: observation.executionId,
      repository,
      taskId: computed.taskId,
      candidateRevision: computed.candidateHead,
      computedState: computed.state,
      derivedState: computed.derivedState,
      blockers: computed.blockers,
      nextTaskId: computed.nextTaskId,
      factsFingerprint: executionFactsFingerprint(observation.recovery?.facts ?? {}),
    };
    const inputFingerprint = fingerprint(input);
    const actionId = `${repository}:${observation.executionId}:${computed.taskId ?? "none"}:${actionType.toLowerCase()}:${inputFingerprint.slice(0, 20)}:${attempt}`;
    return makePlannedAction({
      actionId,
      actionType,
      taskId: computed.taskId,
      candidateRevision: computed.candidateHead,
      preconditions: {
        computedState: computed.state,
        candidateRevision: computed.candidateHead,
        recoveryInputFingerprint: executionFactsFingerprint(observation.recovery?.facts ?? {}),
      },
      inputFingerprint,
      attempt,
      createdAt: now,
      executionId: observation.executionId,
      repository,
      cycleId,
    });
  }
}

export function stateActionVocabulary() {
  return Object.freeze({ ...STATE_ACTION });
}
