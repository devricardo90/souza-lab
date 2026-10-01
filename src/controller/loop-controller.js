import { Worker } from "node:worker_threads";
import { normalizeJiraObservation } from "../reconcile/jira-observation.js";
import { RelationshipConfigError, parseRelationshipConfig } from "../reconcile/jira-relationship.js";
import { reconcilePlan } from "../reconcile/plan-reconciler.js";
import { buildMaterializationOperations } from "../materialize/jira-materialization.js";
import { ExecutionLeaseUnavailableError } from "../adapters/local-execution-lease-provider.js";
import { NullNotifier } from "./ports.js";
import { makeWorkPackage } from "./work-package.js";
import { selectNextTask } from "./task-selection.js";

/**
 * Deterministic orchestration only. The Controller never reads plan prose, never reasons about code, never
 * calls a model, and re-implements none of LoopRuntime: it sequences already-proven components.
 *
 * Every cycle (idempotent and restart-safe; progress lives in durable stores, never in memory):
 *   0 own the workspace (instance lease, renewed each cycle)
 *   1 RECOVER_EXTERNAL_OPS   process runnable outbox operations (PENDING / due RETRY_WAIT / expired IN_FLIGHT), reconcile-first
 *   2 SYNC_SOURCE            refresh the plan source; last-known-good is kept on invalid/unavailable source
 *   3 in-flight work?        a started WorkPackage is advanced with ITS frozen binding; the plan is NOT re-read for it
 *       EXECUTE              existing LoopRuntime cycles until LOCAL_DONE / wait / block
 *       SYNC_REMOTE_DONE     completion operation -> durable outbox -> Jira -> read-after-write -> REMOTE_DONE_CONFIRMED
 *   4 planning boundary (no work in flight; the only point where a newer plan is considered):
 *       RECONCILE_PLAN -> MATERIALIZE -> SELECT_TASK (deterministic gate) -> BUILD_WORK_PACKAGE
 *
 * LOCAL_DONE never releases the next task: advancement requires REMOTE_DONE_CONFIRMED. While any external
 * operation is unfinished, no new task is selected.
 */

const nowPlus = (iso, ms) => new Date(Date.parse(iso) + ms).toISOString();
const NON_TERMINAL = new Set(["PENDING", "IN_FLIGHT", "RETRY_WAIT"]);

export class LoopController {
  constructor({
    workspaceId, ownerId, leaseProvider, instanceLeaseTtlMs = 30000,
    documentId, planSynchronizer, planStore, jira, outboxStore, outboxExecutor, controllerStore,
    materialization, completion = { doneStatusName: "Done", transitionName: "Done", expectedCurrentStatusNames: null },
    repository, runtimeFactory, notifier = new NullNotifier(), clock = () => new Date().toISOString(),
    faultPoints = {}, defaultWaitMs = 5000, maxRuntimeCyclesPerTick = 50, persistentSourceFailureThreshold = 3, relationship = null, heartbeatWorker = false,
  } = {}) {
    for (const [name, value] of Object.entries({ workspaceId, ownerId, leaseProvider, documentId, planSynchronizer, planStore, jira, outboxStore, outboxExecutor, controllerStore, materialization, repository, runtimeFactory })) {
      if (value === undefined || value === null || value === "") throw new TypeError(`LoopController requires ${name}`);
    }
    Object.assign(this, {
      workspaceId, ownerId, leaseProvider, instanceLeaseTtlMs, documentId, planSynchronizer, planStore, jira, outboxStore, outboxExecutor,
      controllerStore, materialization, completion, repository, runtimeFactory, notifier, clock, faultPoints, defaultWaitMs,
      maxRuntimeCyclesPerTick, persistentSourceFailureThreshold,
    });
    this.lease = null;
    this.leaseLostError = null;
    this.heartbeatWorker = heartbeatWorker; // renew the instance lease from a separate thread (immune to blocking providers)
    this.worker = null;
    this.heartbeat = null;
    this.renewing = false;
    this.startupRecovered = false;
    this.runtimes = new Map();
    // Explicit dependency-link semantics (no implicit direction). Invalid configuration fails at construction.
    this.relationship = relationship === null ? null : parseRelationshipConfig(relationship);
    this.relationshipVerified = false;
    this.runtimeCycles = 0;
  }

  async fault(name, payload = {}) { if (typeof this.faultPoints[name] === "function") await this.faultPoints[name](payload); }

  // ---------------- ownership ----------------
  get instanceLeaseRequest() {
    return { repository: `workspace:${this.workspaceId}`, taskId: "controller", executionId: "controller-instance", ownerId: this.ownerId, ttlMs: this.instanceLeaseTtlMs };
  }

  /** Only one active Controller per workspace. Returns { owner:false } instead of throwing when another instance is active. */
  async start() {
    try { this.lease = await this.leaseProvider.acquire(this.instanceLeaseRequest); }
    catch (error) {
      if (error instanceof ExecutionLeaseUnavailableError || error?.code === "EXECUTION_LEASE_UNAVAILABLE") return { owner: false, reason: error.code };
      throw error;
    }
    this.leaseLostError = null;
    this.startHeartbeat();
    const report = await this.recoverOnStartup();
    return { owner: true, report };
  }

  async stop() {
    this.stopHeartbeat();
    if (this.lease) { try { await this.leaseProvider.release(this.lease); } catch {} this.lease = null; }
  }

  /**
   * Keeps the instance lease alive while the event loop is free (e.g. during a long, asynchronous agent execution that lasts
   * longer than the lease TTL). A failed renewal is remembered and ends the owner's authority at its next step.
   */
  startHeartbeat() {
    this.stopHeartbeat();
    if (this.heartbeatWorker) {
      this.worker = new Worker(new URL("./lease-heartbeat-worker.js", import.meta.url), {
        workerData: { directory: this.leaseProvider.directory, lease: this.lease, ttlMs: this.instanceLeaseTtlMs, intervalMs: Math.max(100, Math.floor(this.instanceLeaseTtlMs / 3)) },
      });
      this.worker.on("message", (message) => {
        if (message?.ok === false) this.leaseLostError = Object.assign(new Error(`instance lease heartbeat failed: ${message.message}`), { instanceLease: true, code: message.code });
      });
      this.worker.on("error", () => {});
      this.worker.unref();
      return;
    }
    this.heartbeat = setInterval(async () => {
      if (!this.lease || this.renewing) return;
      this.renewing = true;
      try { await this.renewLease(); } catch { /* recorded by renewLease; the next cycle step reports the loss */ } finally { this.renewing = false; }
    }, Math.max(100, Math.floor(this.instanceLeaseTtlMs / 3)));
    this.heartbeat.unref?.();
  }

  stopHeartbeat() {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null; }
    if (this.worker) { try { this.worker.postMessage({ type: "stop" }); } catch {} this.worker.terminate().catch(() => {}); this.worker = null; }
  }

  async renewLease() {
    if (this.leaseLostError) throw this.leaseLostError;
    try { this.lease = await this.leaseProvider.renew(this.lease, { ttlMs: this.instanceLeaseTtlMs }); }
    catch (error) { error.instanceLease = true; this.leaseLostError = error; throw error; }
  }

  /** Startup order: (lock held) -> recover unfinished outbox operations -> verify runtime checkpoints -> only then may work be selected. */
  async recoverOnStartup() {
    this.startupRecovered = false;
    const recovered = await this.recoverOps();
    const inFlight = this.controllerStore.inFlight();
    const checkpoints = {};
    for (const row of inFlight) checkpoints[row.taskId] = this.runtimeFor(row.workPackage).runtime.checkpointStore.read(row.workPackage.executionId)?.computedState ?? null;
    this.startupRecovered = true;
    await this.fault("after_startup_recovery", { recovered, inFlight: inFlight.map((r) => r.taskId) });
    return Object.freeze({ outboxProcessed: recovered.results.length, globalBlock: recovered.globalBlock, inFlight: inFlight.map((r) => [r.taskId, r.status]), checkpoints });
  }

  runtimeFor(workPackage) {
    if (!this.runtimes.has(workPackage.executionId)) this.runtimes.set(workPackage.executionId, this.runtimeFactory(workPackage));
    return this.runtimes.get(workPackage.executionId);
  }

  // ---------------- helpers ----------------
  result(outcome, phase, extra = {}) {
    const at = this.clock();
    return Object.freeze({ outcome, phase, at, nextWakeAt: extra.nextWakeAt ?? null, taskId: extra.taskId ?? null, detail: extra.detail ?? null, code: extra.code ?? null });
  }

  async notify(kind, dedupeKey, taskId, detail) {
    if (!this.controllerStore.markNotified(dedupeKey, kind)) return false; // never re-notify, including after restart
    try { await this.notifier.notify({ kind, dedupeKey, taskId, detail: String(detail).slice(0, 500), at: this.clock() }); } catch { /* a notifier failure never affects control flow */ }
    return true;
  }

  wakeAt(isoOrNull) { return isoOrNull ?? nowPlus(this.clock(), this.defaultWaitMs); }

  /** Maps a Jira/outbox failure code to a Controller outcome (deterministic; no model). */
  fromJiraError(error, phase, taskId = null) {
    const code = error?.code ?? "UNKNOWN_FAILURE";
    if (code === "AUTH_INVALID" || code === "AUTH_FORBIDDEN") return { outcome: "BLOCK_GLOBAL", kind: code, code, detail: error.message, taskId, phase };
    if (error?.retryable === true || error?.classification === "TRANSIENT") {
      const wait = Number.isFinite(error?.retryAfterSeconds) ? error.retryAfterSeconds * 1000 : this.defaultWaitMs;
      return { outcome: "WAIT_JIRA", code, detail: error.message, taskId, phase, nextWakeAt: nowPlus(this.clock(), wait) };
    }
    return { outcome: "BLOCK_GLOBAL", kind: "OWNER_DECISION_REQUIRED", code, detail: error?.message ?? code, taskId, phase };
  }

  async finishJiraFailure(failure) {
    if (failure.kind) await this.notify(failure.kind, `global:${failure.code}`, failure.taskId, failure.detail);
    return this.result(failure.outcome, failure.phase, failure);
  }

  // ---------------- external operations ----------------
  async recoverOps() {
    const results = await this.outboxExecutor.recover();
    const globalBlock = results.find((r) => r.globalBlock) ?? null;
    return { results, globalBlock };
  }

  pendingOps() { return this.outboxStore.list().filter((op) => NON_TERMINAL.has(op.status)); }
  failedOps() { return this.outboxStore.list().filter((op) => op.status === "CONFLICT" || op.status === "FAILED_PERMANENT"); }

  // ---------------- one deterministic cycle ----------------
  /** One cycle. Losing the instance lease at ANY step ends this controller's authority cleanly (never a crash, never a stale write). */
  async cycle() {
    if (!this.lease) throw new Error("controller has not started (no instance lease)");
    try { return await this.cycleBody(); }
    catch (error) {
      if (error?.instanceLease !== true) throw error;
      this.stopHeartbeat();
      this.lease = null;
      await this.notify("CONTROLLER_LEASE_LOST", `lease-lost:${this.ownerId}`, null, error.message);
      return this.result("BLOCK_GLOBAL", "OWNERSHIP", { code: "CONTROLLER_LEASE_LOST", detail: error.message });
    }
  }

  async cycleBody() {
    await this.renewLease();

    // 1. external operations first: a restart never selects new work before pending work is reconciled
    const recovered = await this.recoverOps();
    if (recovered.globalBlock) {
      const op = recovered.globalBlock.operation;
      await this.notify(op.lastErrorCode, `global:${op.lastErrorCode}`, op.taskId, op.lastErrorDetail);
      return this.result("BLOCK_GLOBAL", "RECOVER_EXTERNAL_OPS", { code: op.lastErrorCode, detail: op.lastErrorDetail });
    }
    for (const op of this.failedOps()) {
      if (op.lastErrorCode === "RETRIES_EXHAUSTED") await this.notify("RETRY_EXHAUSTED", `op:${op.operationId}`, op.taskId, `${op.action} ${op.targetObject}: ${op.lastErrorDetail}`);
      else await this.notify("UNRECOVERABLE_CONFLICT", `op:${op.operationId}:${op.status}`, op.taskId, `${op.action} ${op.targetObject}: ${op.lastErrorCode}`);
    }

    // 2. source
    const sync = await this.planSynchronizer.refresh({ documentId: this.documentId });
    if (sync.status === "SOURCE_INVALID" || sync.status === "SOURCE_UNAVAILABLE") {
      // the streak lives in durable state: a restart neither loses it nor repeats the alert
      const streak = this.controllerStore.recordSourceFailure(this.documentId, sync.status, this.persistentSourceFailureThreshold);
      if (streak.alert) await this.notify("PERSISTENT_SOURCE_FAILURE", `source:${this.documentId}:streak:${streak.streakId}`, null, `${sync.status} x${streak.consecutive}: ${sync.detail ?? sync.errorCode}`);
    } else this.controllerStore.resetSourceFailures(this.documentId);
    if (!sync.usable) {
      if (sync.status === "SOURCE_INVALID") return this.result("OWNER_DECISION_REQUIRED", "SYNC_SOURCE", { code: sync.errorCode, detail: sync.detail });
      return this.result("WAIT_SOURCE", "SYNC_SOURCE", { code: sync.errorCode, detail: sync.detail, nextWakeAt: this.wakeAt(null) });
    }

    // 3. a started WorkPackage keeps its frozen binding; the newer plan is not considered until it is finished
    const [inFlight] = this.controllerStore.inFlight();
    if (inFlight) return this.advance(inFlight);

    // 4. planning boundary
    return this.plan();
  }

  async advance(row) {
    if (row.status === "EXECUTING") return this.execute(row);
    return this.syncRemoteDone(row);
  }

  async execute(row) {
    const wp = row.workPackage;
    const { runtime } = this.runtimeFor(wp);
    let last = null;
    for (let index = 0; index < this.maxRuntimeCyclesPerTick; index += 1) {
      await this.renewLease();
      try { last = await runtime.runCycle({ executionId: wp.executionId, repository: wp.repository.identity }); }
      catch (error) {
        // A transient runtime failure (e.g. a predecessor's execution lease that has not expired yet) is a wait, never a process crash.
        if (error?.runtimeCrash === true) throw error;
        if (!(error?.retryable === true || error?.classification === "TRANSIENT")) {
          // A non-transient runtime failure (e.g. an evidence/invariant error) blocks THIS task and alerts the Owner; it must never
          // crash the long-running service into a restart loop that repeats the same failure.
          const reason = `runtime error ${error?.code ?? error?.name ?? "UNKNOWN"}: ${String(error?.message ?? error).slice(0, 300)}`;
          this.controllerStore.transition(wp.taskId, "EXECUTING", "BLOCKED", { reason });
          await this.notify("UNRECOVERABLE_CONFLICT", `wp:${wp.workPackageId}:runtime-error`, wp.taskId, reason);
          return this.result("BLOCK_TASK", "EXECUTE", { taskId: wp.taskId, code: error?.code ?? "RUNTIME_ERROR", detail: reason });
        }
        return this.result("RETRY_EXTERNAL", "EXECUTE", { taskId: wp.taskId, code: error.code ?? "TRANSIENT_RUNTIME_FAILURE", detail: String(error.message).slice(0, 200), nextWakeAt: this.wakeAt(null) });
      }
      this.runtimeCycles += 1;
      await this.fault("after_runtime_cycle", { taskId: wp.taskId, cycle: last, count: this.runtimeCycles });
      if (last.outcome !== "CONTINUE") break;
    }
    if (last.outcome === "CONTINUE") return this.result("CONTINUE", "EXECUTE", { taskId: wp.taskId });
    const state = last.nextComputed?.state ?? last.observation?.computed?.state ?? null;
    if (last.outcome === "DONE") {
      this.controllerStore.transition(wp.taskId, "EXECUTING", "LOCAL_DONE");
      await this.fault("after_local_done", { taskId: wp.taskId });
      return this.result("CONTINUE", "LOCAL_DONE", { taskId: wp.taskId });
    }
    if (last.outcome === "WAIT_RETRYABLE") {
      // Classified from the observed facts (CI/review still running), not only from the state name: a pending CI run is
      // reported by the state engine as WAIT_RETRYABLE, and a deterministic timer (never a model) decides when to look again.
      const facts = last.observation?.recovery?.facts ?? {};
      const outcome = (facts.ci?.status === "PENDING" || state === "TESTING") ? "WAIT_CI"
        : (facts.review?.verdict === "PENDING" || state === "REVIEWING") ? "WAIT_REVIEW" : "RETRY_EXTERNAL";
      return this.result(outcome, "EXECUTE", { taskId: wp.taskId, nextWakeAt: this.wakeAt(last.checkpoint?.retry?.nextEligibleAt ?? null), detail: state });
    }
    const reason = `${last.outcome} in ${state}`;
    this.controllerStore.transition(wp.taskId, "EXECUTING", "BLOCKED", { reason });
    if (last.outcome === "BLOCKED_OWNER") {
      await this.notify("REVIEW_OR_VALIDATION_FAILURE", `wp:${wp.workPackageId}:blocked`, wp.taskId, reason);
      return this.result("OWNER_DECISION_REQUIRED", "EXECUTE", { taskId: wp.taskId, detail: reason });
    }
    await this.notify("UNRECOVERABLE_CONFLICT", `wp:${wp.workPackageId}:blocked`, wp.taskId, reason);
    return this.result("BLOCK_TASK", "EXECUTE", { taskId: wp.taskId, detail: reason });
  }

  /** LOCAL_DONE -> completion operation (durable outbox) -> Jira -> read-after-write -> REMOTE_DONE_CONFIRMED. */
  async syncRemoteDone(row) {
    const wp = row.workPackage;
    const { operation: queued } = this.outboxExecutor.enqueueTransition({
      issueKey: row.jiraIssueKey, executionId: wp.executionId, doneStatusName: this.completion.doneStatusName,
      transitionName: this.completion.transitionName, expectedCurrentStatusNames: this.completion.expectedCurrentStatusNames ?? null,
      taskId: wp.taskId, sourceRevision: wp.planBinding.contentHash,
    });
    let op = queued;
    let globalBlock = false;
    if (op.status !== "CONFIRMED") {
      await this.renewLease();
      const processed = await this.outboxExecutor.process(op.operationId);
      op = processed.operation;
      globalBlock = processed.globalBlock === true;
    }
    if (op.status === "CONFIRMED") {
      this.controllerStore.transition(wp.taskId, "LOCAL_DONE", "REMOTE_DONE_CONFIRMED");
      await this.fault("after_remote_done_confirmed", { taskId: wp.taskId });
      return this.result("CONTINUE", "REMOTE_DONE_CONFIRMED", { taskId: wp.taskId });
    }
    if (globalBlock) {
      await this.notify(op.lastErrorCode, `global:${op.lastErrorCode}`, wp.taskId, op.lastErrorDetail);
      return this.result("BLOCK_GLOBAL", "SYNC_REMOTE_DONE", { taskId: wp.taskId, code: op.lastErrorCode, detail: op.lastErrorDetail });
    }
    if (op.status === "CONFLICT" || op.status === "FAILED_PERMANENT") {
      this.controllerStore.transition(wp.taskId, "LOCAL_DONE", "BLOCKED", { reason: `completion sync ${op.status}: ${op.lastErrorCode}` });
      await this.notify(op.lastErrorCode === "RETRIES_EXHAUSTED" ? "RETRY_EXHAUSTED" : "UNRECOVERABLE_CONFLICT", `op:${op.operationId}:${op.status}`, wp.taskId, `${op.lastErrorCode}: ${op.lastErrorDetail}`);
      return this.result(op.status === "CONFLICT" ? "OWNER_DECISION_REQUIRED" : "BLOCK_TASK", "SYNC_REMOTE_DONE", { taskId: wp.taskId, code: op.lastErrorCode });
    }
    // RETRY_WAIT / IN_FLIGHT elsewhere: local work, checkpoint and evidence are retained; nothing is re-run and nothing new is selected
    return this.result("WAIT_JIRA", "SYNC_REMOTE_DONE", { taskId: wp.taskId, code: op.lastErrorCode, nextWakeAt: this.wakeAt(op.nextRetryAt), detail: op.status });
  }

  // ---------------- planning boundary ----------------
  historicalTaskIds() {
    const ids = new Set();
    for (const { planVersion, contentHash } of this.planStore.listVersions(this.documentId)) {
      for (const task of this.planStore.load(this.documentId, planVersion, contentHash).tasks) ids.add(task.taskId);
    }
    return [...ids];
  }

  async plan() {
    const snapshot = this.planStore.latest(this.documentId);
    if (this.relationship && !this.relationshipVerified) {
      // verify the explicit mapping against Jira's own link-type definition once per process, before any link is written
      try { this.jira.verifyRelationship(this.relationship); this.relationshipVerified = true; }
      catch (error) {
        if (error instanceof RelationshipConfigError) {
          await this.notify("OWNER_DECISION_REQUIRED", `relationship-config:${error.message}`, null, error.message);
          return this.result("BLOCK_GLOBAL", "RECONCILE_PLAN", { code: error.code, detail: error.message });
        }
        return this.finishJiraFailure(this.fromJiraError(error, "RECONCILE_PLAN"));
      }
    }
    let raw;
    try { raw = this.jira.observeProject(this.materialization.projectKey); }
    catch (error) { return this.finishJiraFailure(this.fromJiraError(error, "RECONCILE_PLAN")); }
    const workPackages = this.controllerStore.list();
    const reconciliation = reconcilePlan({
      snapshot, observation: normalizeJiraObservation(raw, { relationship: this.relationship }), createdAt: this.clock(),
      bindings: workPackages.map((row) => ({ ...row.workPackage.planBinding, taskId: row.taskId })),
      historicalTaskIds: this.historicalTaskIds(),
    });

    // MATERIALIZE: approved CREATE decisions -> deterministic operations -> durable outbox -> Jira
    const { operations, blocked } = buildMaterializationOperations({ reconciliation, config: { ...this.materialization, relationship: this.relationship ?? undefined } });
    const unsupported = blocked.filter((b) => b.reasonCode === "RELATIONSHIPS_NOT_SUPPORTED");
    for (const entry of unsupported) await this.notify("OWNER_DECISION_REQUIRED", `blocked:${entry.taskId}:${entry.reasonCode}`, entry.taskId, entry.detail);
    if (operations.length > 0) {
      let progressed = false;
      for (const op of operations) {
        this.outboxExecutor.enqueueMaterialization(op);
        await this.renewLease(); // keep ownership alive before each blocking Jira step
        const processed = await this.outboxExecutor.process(op.operationId);
        if (processed.globalBlock) {
          await this.notify(processed.operation.lastErrorCode, `global:${processed.operation.lastErrorCode}`, op.taskId, processed.operation.lastErrorDetail);
          return this.result("BLOCK_GLOBAL", "MATERIALIZE", { taskId: op.taskId, code: processed.operation.lastErrorCode });
        }
        if (processed.operation.status === "CONFIRMED") progressed = true;
        else if (processed.operation.status === "RETRY_WAIT") return this.result("WAIT_JIRA", "MATERIALIZE", { taskId: op.taskId, code: processed.operation.lastErrorCode, nextWakeAt: this.wakeAt(processed.operation.nextRetryAt) });
      }
      if (progressed) return this.result("CONTINUE", "MATERIALIZE");
    }

    // nothing may be selected while any external operation is unfinished
    const pending = this.pendingOps();
    if (pending.length > 0) {
      const due = pending.filter((op) => op.status === "RETRY_WAIT").map((op) => op.nextRetryAt).sort()[0] ?? null;
      return this.result("WAIT_JIRA", "RECOVER_EXTERNAL_OPS", { nextWakeAt: this.wakeAt(due), detail: `${pending.length} external operation(s) unfinished` });
    }

    // SELECT_TASK
    const blockedTaskIds = [
      ...this.failedOps().map((op) => op.taskId), ...unsupported.map((b) => b.taskId),
      ...workPackages.filter((row) => row.status === "BLOCKED").map((row) => row.taskId),
    ];
    const activeLeaseTaskIds = [];
    for (const row of workPackages) {
      const status = await this.leaseProvider.inspect({ repository: row.workPackage.repository.identity, executionId: row.executionId });
      if (status.active) activeLeaseTaskIds.push(row.taskId);
    }
    const selection = selectNextTask({
      snapshot, reconciliation, workPackages, completionSyncPending: workPackages.some((row) => row.status === "LOCAL_DONE"),
      activeLeaseTaskIds, blockedTaskIds, startupRecovered: this.startupRecovered,
    });
    if (selection.selected === null) {
      const done = new Set(workPackages.filter((row) => row.status === "REMOTE_DONE_CONFIRMED").map((row) => row.taskId));
      if (snapshot.tasks.every((task) => done.has(task.taskId))) return this.result("COMPLETED", "NEXT", { detail: `plan v${snapshot.planVersion} fully confirmed in Jira` });
      if (reconciliation.conflicts.length > 0 || blockedTaskIds.length > 0) {
        const alreadyNotified = new Set(unsupported.map((b) => b.taskId)); // reported once, with its own reason, above
        const keys = [...new Set([...reconciliation.conflicts.map((d) => `${d.taskId}:${d.reasonCode}`), ...blockedTaskIds.filter((t) => !alreadyNotified.has(t)).map((t) => `${t}:blocked`)])].sort();
        if (keys.length > 0) await this.notify("OWNER_DECISION_REQUIRED", `conflicts:${snapshot.contentHash}:${keys.join(",")}`, null, `unresolved: ${keys.join(", ")}`);
        return this.result("OWNER_DECISION_REQUIRED", "SELECT_TASK", { detail: keys.join(", ") });
      }
      return this.result("IDLE", "SELECT_TASK", { detail: "no eligible task", nextWakeAt: this.wakeAt(null) });
    }

    // BUILD_WORK_PACKAGE
    const taskId = selection.selected;
    const workPackage = makeWorkPackage({ snapshot, taskId, repository: this.repository });
    const owner = reconciliation.noops.find((decision) => decision.taskId === taskId);
    this.controllerStore.createWorkPackage(workPackage, owner.jiraIssueKey);
    await this.fault("after_work_package_created", { taskId });
    return this.result("CONTINUE", "BUILD_WORK_PACKAGE", { taskId });
  }
}
