/**
 * Deterministic task selection gate. Pure: no I/O, no clock, no model. The first task (in TASK_ID order)
 * that passes EVERY condition is selected; for every other task the failing conditions are returned as
 * stable reason codes so a decision is always explainable.
 *
 * A task is eligible only when
 *   1. it exists in the accepted PlanSnapshot
 *   2. its Jira materialization is confirmed (the reconciler says NOOP for it)
 *   3. all its dependencies are REMOTE_DONE_CONFIRMED
 *   4. neither it nor any dependency has an unresolved conflict (reconciler conflict or failed/conflicting operation)
 *   5. no execution lease is active for it
 *   6. no earlier completion sync is pending (no LOCAL_DONE work package, no unfinished completion operation)
 *   7. its source binding is valid (no WorkPackage exists for it yet: one TASK_ID is executed once)
 */

export const SELECTION_REASONS = Object.freeze([
  "ALREADY_STARTED", "NOT_MATERIALIZED", "DEPENDENCY_NOT_DONE", "UNRESOLVED_CONFLICT",
  "ACTIVE_LEASE", "COMPLETION_SYNC_PENDING", "SOURCE_BINDING_INVALID",
]);

export function selectNextTask({ snapshot, reconciliation, workPackages, completionSyncPending, activeLeaseTaskIds = [], blockedTaskIds = [], startupRecovered }) {
  if (startupRecovered !== true) throw new Error("selection is forbidden before startup recovery has completed");
  const done = new Set(workPackages.filter((wp) => wp.status === "REMOTE_DONE_CONFIRMED").map((wp) => wp.taskId));
  const started = new Set(workPackages.map((wp) => wp.taskId));
  const materialized = new Set(reconciliation.noops.map((d) => d.taskId));
  const conflicted = new Set([...reconciliation.conflicts.map((d) => d.taskId), ...blockedTaskIds]);
  const leased = new Set(activeLeaseTaskIds);
  const reasons = {};
  let selected = null;
  for (const task of [...snapshot.tasks].sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0))) {
    const why = [];
    if (started.has(task.taskId)) why.push("ALREADY_STARTED");
    if (!materialized.has(task.taskId)) why.push("NOT_MATERIALIZED");
    if (task.dependsOn.some((id) => !done.has(id))) why.push("DEPENDENCY_NOT_DONE");
    if (conflicted.has(task.taskId) || task.dependsOn.some((id) => conflicted.has(id))) why.push("UNRESOLVED_CONFLICT");
    if (leased.has(task.taskId)) why.push("ACTIVE_LEASE");
    if (completionSyncPending) why.push("COMPLETION_SYNC_PENDING");
    if (task.snapshotContentHash !== snapshot.contentHash || task.planVersion !== snapshot.planVersion) why.push("SOURCE_BINDING_INVALID");
    reasons[task.taskId] = Object.freeze(why);
    if (why.length === 0 && selected === null) selected = task.taskId;
  }
  return Object.freeze({ selected, reasons: Object.freeze(reasons) });
}
