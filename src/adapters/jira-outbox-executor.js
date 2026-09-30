import { RuntimeRetryPolicy } from "../core/retry-policy.js";
import { executionMarker } from "./jira-sync-client.js";
import { OutboxError, deriveOperationId } from "./sqlite-outbox-store.js";

/**
 * Drives outbox operations against Jira through JiraSyncClient (CP-01).
 * Fully deterministic: no model is consulted for claiming, reconciliation,
 * retry scheduling, duplicate detection or state choice.
 *
 * Lifecycle per operation:
 *   atomically claim (PENDING | due RETRY_WAIT | expired IN_FLIGHT -> IN_FLIGHT)
 *   -> reconcile remote state (ALWAYS, before any write)
 *   -> write only if the desired state is not already present
 *   -> read-after-write verification (inside the handler)
 *   -> transactional settle (CONFIRMED / RETRY_WAIT / CONFLICT / FAILED_PERMANENT)
 *
 * An UNCERTAIN write is settled RETRY_WAIT(UNCERTAIN_WRITE); the next claim
 * reconciles remote state first, so there is never a blind re-write.
 *
 * Reserved, not implemented: JIRA_CREATE, JIRA_UPDATE, JIRA_SPRINT_ASSIGNMENT.
 */

const GLOBAL_BLOCK_CODES = new Set(["AUTH_INVALID", "AUTH_FORBIDDEN"]);
const RETRYABLE_CODES = new Set(["RATE_LIMITED", "JIRA_UNAVAILABLE", "TRANSIENT_NETWORK_FAILURE"]);
const CONFLICT_CODES = new Set(["STALE_STATE", "JIRA_TRANSITION_NOT_FOUND"]);

export function jiraCommentOperation({ issueKey, executionId, kind, body, taskId = issueKey, sourceRevision, head }) {
  return {
    operationId: deriveOperationId("JIRA_COMMENT", { issueKey, executionId, kind }),
    action: "JIRA_COMMENT", targetSystem: "JIRA", targetObject: issueKey, taskId, executionId, sourceRevision, head,
    expectedPreviousState: { markerAbsent: executionMarker(executionId, kind) },
    desiredState: { kind, body, marker: executionMarker(executionId, kind) },
  };
}

export function jiraTransitionOperation({ issueKey, executionId, doneStatusName, transitionName, expectedCurrentStatusNames = null, taskId = issueKey, sourceRevision, head }) {
  return {
    operationId: deriveOperationId("JIRA_TRANSITION", { issueKey, executionId, doneStatusName }),
    action: "JIRA_TRANSITION", targetSystem: "JIRA", targetObject: issueKey, taskId, executionId, sourceRevision, head,
    expectedPreviousState: expectedCurrentStatusNames ? { statusNames: expectedCurrentStatusNames } : null,
    desiredState: { statusName: doneStatusName, transitionName, computedState: "DONE" },
  };
}

function handlers(jira) {
  return {
    JIRA_COMMENT: {
      reconcile: (op) => (jira.findMarkedComment(op.targetObject, op.desiredState.marker) ? { state: "APPLIED" } : { state: "NOT_APPLIED" }),
      async write(op, context) {
        await jira.addExecutionComment(op.targetObject, { executionId: op.executionId, kind: op.desiredState.kind, body: op.desiredState.body }, context);
        // read-after-write: the comment must be rediscoverable by its marker
        return jira.findMarkedComment(op.targetObject, op.desiredState.marker)
          ? { result: "CONFIRMED" } : { result: "UNCERTAIN", detail: "comment not rediscoverable after write" };
      },
    },
    JIRA_TRANSITION: {
      reconcile(op) {
        const status = jira.getIssueStatusName(op.targetObject);
        if (status === op.desiredState.statusName) return { state: "APPLIED" };
        const expected = op.expectedPreviousState?.statusNames;
        if (Array.isArray(expected) && !expected.includes(status)) return { state: "CONFLICT", detail: `Jira status is "${status}", expected one of ${JSON.stringify(expected)}` };
        return { state: "NOT_APPLIED" };
      },
      async write(op, context) {
        const outcome = await jira.markTaskComplete(op.targetObject, {
          executionId: op.executionId, computedState: op.desiredState.computedState,
          doneStatusName: op.desiredState.statusName, transitionName: op.desiredState.transitionName,
          expectedCurrentStatusNames: op.expectedPreviousState?.statusNames ?? null,
        }, context);
        return outcome.status === "CONFIRMED" ? { result: "CONFIRMED" } : { result: "UNCERTAIN", detail: `${outcome.reason} (observed ${outcome.observedStatus ?? "unknown"})` };
      },
    },
  };
}

export class JiraOutboxExecutor {
  /**
   * faultPoints: test-only hooks {afterClaim, afterReconcile, beforeRemoteWrite, afterRemoteWrite}
   * used by the real-process crash tests; they are no-ops in production.
   */
  constructor({ store, jira, workerId, claimTtlMs = 120000, retryPolicy = new RuntimeRetryPolicy(), clock = () => new Date().toISOString(), faultPoints = {} } = {}) {
    if (!store || !jira) throw new TypeError("JiraOutboxExecutor requires a store and a JiraSyncClient");
    if (typeof workerId !== "string" || workerId.trim() === "") throw new TypeError("workerId is required");
    Object.assign(this, { store, jira, workerId, claimTtlMs, retryPolicy, clock, faultPoints });
    this.handlers = handlers(jira);
  }

  enqueueComment(input) { return this.store.enqueue(jiraCommentOperation(input)); }
  enqueueTransition(input) { return this.store.enqueue(jiraTransitionOperation(input)); }

  async fault(name, payload) {
    if (typeof this.faultPoints[name] === "function") await this.faultPoints[name](payload);
  }

  /** Processes one operation. Returns { owned, outcome, operation }. owned=false means another worker owns it or it is not runnable. */
  async process(operationId) {
    const acquired = this.store.acquire(operationId, { workerId: this.workerId, ttlMs: this.claimTtlMs, now: this.clock() });
    if (!acquired) return { owned: false, outcome: "NOT_OWNER", operation: this.store.get(operationId) };
    const { operation: op, recovered } = acquired;
    const claim = { workerId: this.workerId, claimToken: op.claimToken };
    const context = { assertLeaseCurrent: async () => this.store.assertClaim(operationId, claim, this.clock()) };
    const settle = (to, extra = {}) => ({ owned: true, recovered, outcome: to, operation: this.store.settle(operationId, claim, { to, ...extra, now: this.clock() }) });
    try {
      const handler = this.handlers[op.action];
      if (!handler) return settle("FAILED_PERMANENT", { errorCode: "ACTION_NOT_IMPLEMENTED", errorDetail: op.action });
      await this.fault("afterClaim", op);
      // Reconcile BEFORE any write, on every claim (fresh, retry, or post-crash recovery).
      const remote = await handler.reconcile(op);
      await this.fault("afterReconcile", { op, remote });
      if (remote.state === "APPLIED") return settle("CONFIRMED", { errorCode: null, errorDetail: recovered ? "reconciled: desired state already present" : null });
      if (remote.state === "CONFLICT") return settle("CONFLICT", { errorCode: "STALE_STATE", errorDetail: remote.detail });
      await context.assertLeaseCurrent();
      await this.fault("beforeRemoteWrite", op);
      const written = await handler.write(op, context);
      await this.fault("afterRemoteWrite", { op, written });
      if (written.result === "CONFIRMED") return settle("CONFIRMED");
      return this.retry(op, settle, { code: "UNCERTAIN_WRITE", message: written.detail ?? "write outcome could not be verified", classification: "TRANSIENT" });
    } catch (error) {
      if (error instanceof OutboxError && error.code === "CLAIM_LOST") return { owned: false, outcome: "CLAIM_LOST", operation: this.store.get(operationId) };
      return this.fromError(op, error, settle);
    }
  }

  fromError(op, error, settle) {
    const code = error?.code ?? "UNKNOWN_FAILURE";
    const detail = String(error?.message ?? code);
    if (GLOBAL_BLOCK_CODES.has(code)) return { ...settle("FAILED_PERMANENT", { errorCode: code, errorDetail: detail }), globalBlock: true };
    if (CONFLICT_CODES.has(code)) return settle("CONFLICT", { errorCode: code, errorDetail: detail });
    if (RETRYABLE_CODES.has(code) || error?.classification === "TRANSIENT" || error?.retryable === true) {
      return this.retry(op, settle, { code, message: detail, classification: "TRANSIENT", retryAfterSeconds: error?.retryAfterSeconds ?? null });
    }
    return settle("FAILED_PERMANENT", { errorCode: code, errorDetail: detail }); // unknown failures fail closed
  }

  /** Retry timing is decided by RuntimeRetryPolicy (honouring Retry-After), never by this executor. */
  retry(op, settle, { code, message, classification, retryAfterSeconds = null }) {
    const now = this.clock();
    const decision = this.retryPolicy.decide(
      Object.assign(new Error(message), { classification }),
      { attempt: op.attemptCount, actionType: op.action, executionId: op.executionId ?? op.operationId, taskId: op.taskId },
      { now },
    );
    if (decision.outcome !== "WAIT_RETRYABLE") return settle("FAILED_PERMANENT", { errorCode: "RETRIES_EXHAUSTED", errorDetail: `${code}: ${message}` });
    let nextRetryAt = decision.nextEligibleAt;
    if (Number.isFinite(retryAfterSeconds)) {
      const floor = new Date(Date.parse(now) + retryAfterSeconds * 1000).toISOString();
      if (floor > nextRetryAt) nextRetryAt = floor;
    }
    return settle("RETRY_WAIT", { errorCode: code, errorDetail: message, nextRetryAt });
  }

  /** Restart recovery: every runnable operation (PENDING, due RETRY_WAIT, expired IN_FLIGHT) is processed, reconcile-first. */
  async recover() {
    const results = [];
    for (const op of this.store.listRunnable(this.clock())) {
      const result = await this.process(op.operationId);
      results.push(result);
      if (result.globalBlock) break; // auth failure blocks the whole Jira system; do not hammer it
    }
    return results;
  }
}
