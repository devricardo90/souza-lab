import { RuntimeRetryPolicy } from "../core/retry-policy.js";
import { executionMarker } from "./jira-sync-client.js";
import { OutboxError, deriveOperationId } from "./sqlite-outbox-store.js";
import { encodeLoopDescription } from "../reconcile/jira-adf.js";
import { normalizeJiraObservation } from "../reconcile/jira-observation.js";
import { parseRelationshipConfig } from "../reconcile/jira-relationship.js";
import { reconcilePlan } from "../reconcile/plan-reconciler.js";
import { parseMaterializationConfig } from "../materialize/jira-materialization.js";

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
 * JIRA_CREATE reconciles and verifies through the SAME pure reconcilePlan() used for decisions: a task
 * counts as materialized only when exactly one issue carries its LOOP_TASK_ID and its plan-owned
 * definition matches. A POST response alone is never proof.
 * JIRA_SPRINT_ASSIGNMENT reconciles by exact sprint membership and verifies membership after the write.
 * Reserved, not implemented: JIRA_UPDATE.
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

export function jiraSprintOperation({ issueKey, sprintId, taskId = issueKey, sourceRevision = null, head = null }) {
  return {
    operationId: deriveOperationId("JIRA_SPRINT_ASSIGNMENT", { issueKey, sprintId }),
    action: "JIRA_SPRINT_ASSIGNMENT", targetSystem: "JIRA", targetObject: issueKey, taskId, executionId: null, sourceRevision, head,
    expectedPreviousState: { sprintMember: false },
    desiredState: { sprintId, issueKey },
  };
}

/** Builds the single-task desired snapshot a JIRA_CREATE operation was approved against. */
function createView(op, clock, jira, relationship) {
  const config = parseMaterializationConfig(op.desiredState); // CONFIG_INVALID fails closed before any remote call
  const m = op.desiredState.materialization;
  const snapshot = {
    documentId: m.sourceDocumentId, planVersion: m.planVersion, contentHash: m.snapshotContentHash,
    tasks: [{ taskId: m.taskId, title: m.title, epicId: m.epicId, dependsOn: m.dependsOn, acceptanceCriteria: m.acceptanceCriteria, taskHash: m.taskHash }],
  };
  const observe = (include = []) => normalizeJiraObservation(jira.observeProject(config.projectKey, { include }), { relationship });
  const decide = (include = []) => {
    const result = reconcilePlan({ snapshot, observation: observe(include), createdAt: clock() });
    return [...result.creates, ...result.noops, ...result.conflicts][0];
  };
  return { config, m, decide, observe };
}

function handlers(jira, clock, relationship) {
  return {
    JIRA_CREATE: {
      reconcile(op) {
        const record = createView(op, clock, jira, relationship).decide();
        if (record.decision === "CREATE") return { state: "NOT_APPLIED" };
        if (record.decision === "NOOP") return { state: "APPLIED", issueKey: record.jiraIssueKey };
        // Additive repair: the issue was materialized by THIS operation (audit metadata matches) and only its
        // plan-owned dependency links are missing (e.g. a crash between the create and the link calls).
        const onlyMissingLinks = record.jiraIssueKey && record.differences.length > 0
          && record.differences.every((d) => d.field === "dependencies" && d.kind === "MISSING");
        if (onlyMissingLinks) {
          const owner = createView(op, clock, jira, relationship).observe().issues.find((issue) => issue.jiraIssueKey === record.jiraIssueKey);
          if (owner?.materialization?.taskHash === op.desiredState.materialization.taskHash) {
            return { state: "NOT_APPLIED", repair: { issueKey: record.jiraIssueKey, missing: record.differences.map((d) => d.key) } };
          }
        }
        return { state: "CONFLICT", code: record.reasonCode, detail: `${record.reasonCode}${record.jiraIssueKeys ? ` (${record.jiraIssueKeys.join(", ")})` : record.jiraIssueKey ? ` (${record.jiraIssueKey})` : ""}` };
      },
      async write(op, context, remote = {}) {
        const { config, m, decide, observe } = createView(op, clock, jira, relationship);
        // Dependency links need the explicit relationship mapping. Without it NOTHING is created (fail closed).
        if (m.dependsOn.length > 0 || remote.repair) parseRelationshipConfig(relationship);
        // Resolve dependency issue keys from the TASK_ID markers BEFORE any write; unresolvable => conflict, nothing created.
        const owners = new Map();
        for (const issue of observe().issues) if (issue.taskIdMarker) owners.set(issue.taskIdMarker, [...(owners.get(issue.taskIdMarker) ?? []), issue.jiraIssueKey]);
        const wanted = remote.repair ? remote.repair.missing : m.dependsOn;
        const blockerKeys = [];
        for (const taskId of wanted) {
          const keys = owners.get(taskId) ?? [];
          if (keys.length !== 1) return { result: "CONFLICT", code: "DEPENDENCY_UNRESOLVED", detail: `dependency ${taskId} is owned by ${keys.length} Jira issues` };
          blockerKeys.push(keys[0]);
        }
        let dependentKey = remote.repair?.issueKey;
        if (!dependentKey) {
          const created = await jira.createIssue({ projectKey: config.projectKey, issueTypeName: config.issueTypeName, summary: m.title, description: encodeLoopDescription(m) }, context);
          dependentKey = created.key;
        }
        for (const blockerKey of blockerKeys) await jira.linkIssues({ blockerKey, dependentKey, relationship }, context);
        // read-after-write: exactly one issue with this LOOP_TASK_ID and a matching plan-owned definition. The key Jira just
        // returned is read canonically (never only through an index that may lag), so a created issue cannot look absent.
        const record = decide([dependentKey]);
        if (record.decision === "NOOP") return { result: "CONFIRMED", issueKey: record.jiraIssueKey };
        if (record.decision === "CREATE") return { result: "UNCERTAIN", detail: "no issue carrying the LOOP_TASK_ID found after create" };
        return { result: "CONFLICT", code: record.reasonCode, detail: `${record.reasonCode}${record.jiraIssueKeys ? ` (${record.jiraIssueKeys.join(", ")})` : ""}` };
      },
    },
    JIRA_COMMENT: {
      reconcile: (op) => (jira.findMarkedComment(op.targetObject, op.desiredState.marker) ? { state: "APPLIED" } : { state: "NOT_APPLIED" }),
      async write(op, context) {
        await jira.addExecutionComment(op.targetObject, { executionId: op.executionId, kind: op.desiredState.kind, body: op.desiredState.body }, context);
        // read-after-write: the comment must be rediscoverable by its marker
        return jira.findMarkedComment(op.targetObject, op.desiredState.marker)
          ? { result: "CONFIRMED" } : { result: "UNCERTAIN", detail: "comment not rediscoverable after write" };
      },
    },
    JIRA_SPRINT_ASSIGNMENT: {
      reconcile: (op) => (jira.getSprintMembership(op.desiredState.sprintId).includes(op.targetObject) ? { state: "APPLIED" } : { state: "NOT_APPLIED" }),
      async write(op, context) {
        const outcome = await jira.assignToSprint(op.targetObject, op.desiredState.sprintId, context);
        return outcome.assigned || outcome.alreadyMember ? { result: "CONFIRMED" } : { result: "UNCERTAIN", detail: "issue not a member of the sprint after assignment" };
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
  constructor({ store, jira, workerId, claimTtlMs = 120000, retryPolicy = new RuntimeRetryPolicy(), clock = () => new Date().toISOString(), faultPoints = {}, relationship = null } = {}) {
    if (!store || !jira) throw new TypeError("JiraOutboxExecutor requires a store and a JiraSyncClient");
    if (relationship !== null) relationship = parseRelationshipConfig(relationship); // explicit mapping, validated up front (RELATIONSHIP_CONFIG_INVALID)
    if (typeof workerId !== "string" || workerId.trim() === "") throw new TypeError("workerId is required");
    Object.assign(this, { store, jira, workerId, claimTtlMs, retryPolicy, clock, faultPoints });
    this.handlers = handlers(jira, clock, relationship);
  }

  enqueueComment(input) { return this.store.enqueue(jiraCommentOperation(input)); }
  enqueueTransition(input) { return this.store.enqueue(jiraTransitionOperation(input)); }
  enqueueSprintAssignment(input) { return this.store.enqueue(jiraSprintOperation(input)); }

  /** Enqueues an operation spec from the materialization layer. A changed payload under an existing id is reported, never duplicated. */
  enqueueMaterialization(spec) {
    try { return this.store.enqueue(spec); }
    catch (error) {
      if (error instanceof OutboxError && error.code === "OPERATION_ID_CONFLICT") return { created: false, conflict: true, code: error.code, operation: this.store.get(spec.operationId) };
      throw error;
    }
  }

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
      if (remote.state === "CONFLICT") return settle("CONFLICT", { errorCode: remote.code ?? "STALE_STATE", errorDetail: remote.detail });
      await context.assertLeaseCurrent();
      await this.fault("beforeRemoteWrite", op);
      const written = await handler.write(op, context, remote);
      await this.fault("afterRemoteWrite", { op, written });
      if (written.result === "CONFIRMED") return settle("CONFIRMED");
      if (written.result === "CONFLICT") return settle("CONFLICT", { errorCode: written.code ?? "STALE_STATE", errorDetail: written.detail });
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
