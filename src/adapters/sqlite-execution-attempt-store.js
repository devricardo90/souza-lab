import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable record of "what happened around the agent invocation" (CP-06). It is NOT a copy of the LoopRuntime
 * lifecycle: it only answers whether the agent was prepared, started, produced a durable result, or left the
 * workspace in a state that needs recovery. Same SQLite settings as the other stores (WAL, synchronous=FULL).
 *
 * States and (database-enforced) transitions:
 *   PREPARED              workspace identity persisted; the agent has NOT been called
 *   AGENT_RUNNING         the agent was (or may have been) invoked; its outcome is not yet durable
 *   AGENT_RESULT_RECORDED the structured result is durable (terminal for the attempt: never invoke the agent again)
 *   RECOVERY_REQUIRED     a restart found AGENT_RUNNING; git facts are being / must be classified
 *   IMPLEMENTATION_PRESENT work exists in the workspace without a durable result; preserved, awaiting resume
 *   FAILED                terminal (owner decision needed; nothing is discarded)
 *
 *   PREPARED -> AGENT_RUNNING
 *   AGENT_RUNNING -> AGENT_RESULT_RECORDED | RECOVERY_REQUIRED | IMPLEMENTATION_PRESENT | FAILED
 *   RECOVERY_REQUIRED -> AGENT_RUNNING | AGENT_RESULT_RECORDED | IMPLEMENTATION_PRESENT | FAILED
 *   IMPLEMENTATION_PRESENT -> AGENT_RUNNING | AGENT_RESULT_RECORDED | FAILED
 * Execution identity is stable (the WorkPackage execution id) and the row is created exactly once.
 */

export const ATTEMPT_STATES = Object.freeze(["PREPARED", "AGENT_RUNNING", "AGENT_RESULT_RECORDED", "RECOVERY_REQUIRED", "IMPLEMENTATION_PRESENT", "FAILED"]);
export const ATTEMPT_TRANSITIONS = Object.freeze({
  PREPARED: ["AGENT_RUNNING"],
  AGENT_RUNNING: ["AGENT_RESULT_RECORDED", "RECOVERY_REQUIRED", "IMPLEMENTATION_PRESENT", "FAILED"],
  RECOVERY_REQUIRED: ["AGENT_RUNNING", "AGENT_RESULT_RECORDED", "IMPLEMENTATION_PRESENT", "FAILED"],
  IMPLEMENTATION_PRESENT: ["AGENT_RUNNING", "AGENT_RESULT_RECORDED", "FAILED"],
  AGENT_RESULT_RECORDED: [], FAILED: [],
});

export class ExecutionAttemptError extends Error {
  constructor(message, code = "EXECUTION_ATTEMPT_ERROR") {
    super(message);
    this.name = "ExecutionAttemptError";
    this.code = code;
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS execution_attempts (
  execution_id        TEXT PRIMARY KEY CHECK (length(execution_id) > 0),
  task_id             TEXT NOT NULL,
  work_package_id     TEXT NOT NULL,
  plan_binding        TEXT NOT NULL CHECK (json_valid(plan_binding)),
  repository_identity TEXT NOT NULL,
  base_sha            TEXT NOT NULL CHECK (length(base_sha) = 40),
  workspace_path      TEXT NOT NULL,
  branch              TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('PREPARED','AGENT_RUNNING','AGENT_RESULT_RECORDED','RECOVERY_REQUIRED','IMPLEMENTATION_PRESENT','FAILED')),
  agent_invocations   INTEGER NOT NULL DEFAULT 0 CHECK (agent_invocations >= 0),
  started_at          TEXT,
  agent_result        TEXT CHECK (agent_result IS NULL OR json_valid(agent_result)),
  result_source       TEXT CHECK (result_source IS NULL OR result_source IN ('AGENT','GIT_RECONCILIATION','AGENT_RESUME')),
  observed_git_state  TEXT CHECK (observed_git_state IS NULL OR json_valid(observed_git_state)),
  classification      TEXT,
  failure_reason      TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  CHECK (status <> 'AGENT_RESULT_RECORDED' OR (agent_result IS NOT NULL AND result_source IS NOT NULL))
) STRICT;
CREATE TRIGGER IF NOT EXISTS attempt_insert_guard BEFORE INSERT ON execution_attempts WHEN NEW.status <> 'PREPARED' OR NEW.agent_invocations <> 0
BEGIN SELECT RAISE(ABORT, 'execution attempts start PREPARED'); END;
CREATE TRIGGER IF NOT EXISTS attempt_identity_immutable BEFORE UPDATE ON execution_attempts
WHEN NEW.execution_id <> OLD.execution_id OR NEW.task_id <> OLD.task_id OR NEW.work_package_id <> OLD.work_package_id
  OR NEW.plan_binding <> OLD.plan_binding OR NEW.repository_identity <> OLD.repository_identity OR NEW.base_sha <> OLD.base_sha
  OR NEW.workspace_path <> OLD.workspace_path OR NEW.branch <> OLD.branch OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'execution attempt identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS attempt_result_write_once BEFORE UPDATE ON execution_attempts
WHEN OLD.agent_result IS NOT NULL AND NEW.agent_result IS NOT OLD.agent_result
BEGIN SELECT RAISE(ABORT, 'a recorded agent result is never replaced'); END;
CREATE TRIGGER IF NOT EXISTS attempt_transition_guard BEFORE UPDATE ON execution_attempts
WHEN NOT (
     OLD.status = NEW.status
  OR (OLD.status = 'PREPARED' AND NEW.status = 'AGENT_RUNNING')
  OR (OLD.status = 'AGENT_RUNNING' AND NEW.status IN ('AGENT_RESULT_RECORDED','RECOVERY_REQUIRED','IMPLEMENTATION_PRESENT','FAILED'))
  OR (OLD.status = 'RECOVERY_REQUIRED' AND NEW.status IN ('AGENT_RUNNING','AGENT_RESULT_RECORDED','IMPLEMENTATION_PRESENT','FAILED'))
  OR (OLD.status = 'IMPLEMENTATION_PRESENT' AND NEW.status IN ('AGENT_RUNNING','AGENT_RESULT_RECORDED','FAILED'))
) OR (OLD.status IN ('AGENT_RESULT_RECORDED','FAILED') AND NEW.status <> OLD.status)
BEGIN SELECT RAISE(ABORT, 'invalid execution attempt transition'); END;
CREATE TRIGGER IF NOT EXISTS attempt_no_delete BEFORE DELETE ON execution_attempts
BEGIN SELECT RAISE(ABORT, 'execution attempts are never deleted'); END;
`;

const parse = (row) => (row ? Object.freeze({
  executionId: row.execution_id, taskId: row.task_id, workPackageId: row.work_package_id, planBinding: JSON.parse(row.plan_binding),
  repositoryIdentity: row.repository_identity, baseSha: row.base_sha, workspacePath: row.workspace_path, branch: row.branch,
  status: row.status, agentInvocations: row.agent_invocations, startedAt: row.started_at,
  agentResult: row.agent_result === null ? null : JSON.parse(row.agent_result), resultSource: row.result_source,
  observedGitState: row.observed_git_state === null ? null : JSON.parse(row.observed_git_state),
  classification: row.classification, failureReason: row.failure_reason, createdAt: row.created_at, updatedAt: row.updated_at,
}) : null);

export class SqliteExecutionAttemptStore {
  constructor({ path, clock = () => new Date().toISOString(), busyTimeoutMs = 10000 } = {}) {
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("SqliteExecutionAttemptStore requires a path");
    this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.tx(() => this.db.exec(DDL));
  }

  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { try { this.db.exec("ROLLBACK"); } catch {} throw error; }
  }

  close() { this.db.close(); }
  get(executionId) { return parse(this.db.prepare("SELECT * FROM execution_attempts WHERE execution_id = ?").get(executionId)); }

  /** Idempotent: persists the attempt (including its workspace identity) ONCE, before any agent invocation. */
  prepare({ executionId, taskId, workPackageId, planBinding, repositoryIdentity, baseSha, workspacePath, branch }) {
    const now = this.clock();
    return this.tx(() => {
      const existing = this.get(executionId);
      if (existing) {
        if (existing.taskId !== taskId || existing.workPackageId !== workPackageId || existing.baseSha !== baseSha || existing.workspacePath !== workspacePath || existing.branch !== branch) {
          throw new ExecutionAttemptError(`execution ${executionId} already exists with a different identity`, "EXECUTION_IDENTITY_CONFLICT");
        }
        return { created: false, attempt: existing };
      }
      this.db.prepare(`INSERT INTO execution_attempts (execution_id, task_id, work_package_id, plan_binding, repository_identity, base_sha, workspace_path, branch, status, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?, 'PREPARED', ?, ?)`).run(executionId, taskId, workPackageId, JSON.stringify(planBinding), repositoryIdentity, baseSha, workspacePath, branch, now, now);
      return { created: true, attempt: this.get(executionId) };
    });
  }

  /** Guarded transition from an expected status (also enforced by triggers). Counts agent invocations on entry to AGENT_RUNNING. */
  transition(executionId, from, to, { observedGitState, classification, failureReason } = {}) {
    const now = this.clock();
    const info = this.db.prepare(`UPDATE execution_attempts SET status = ?, updated_at = ?,
        agent_invocations = agent_invocations + CASE WHEN ? = 'AGENT_RUNNING' THEN 1 ELSE 0 END,
        started_at = CASE WHEN ? = 'AGENT_RUNNING' AND started_at IS NULL THEN ? ELSE started_at END,
        observed_git_state = COALESCE(?, observed_git_state), classification = COALESCE(?, classification), failure_reason = COALESCE(?, failure_reason)
      WHERE execution_id = ? AND status = ?`)
      .run(to, now, to, to, now, observedGitState === undefined ? null : JSON.stringify(observedGitState), classification ?? null, failureReason ?? null, executionId, from);
    if (info.changes !== 1) throw new ExecutionAttemptError(`execution ${executionId} is not ${from}`, "EXECUTION_STATE_MISMATCH");
    return this.get(executionId);
  }

  /** Durably records the structured agent result (write-once). */
  recordResult(executionId, from, result, source, observedGitState = null) {
    const info = this.db.prepare(`UPDATE execution_attempts SET status = 'AGENT_RESULT_RECORDED', agent_result = ?, result_source = ?,
        observed_git_state = COALESCE(?, observed_git_state), updated_at = ? WHERE execution_id = ? AND status = ?`)
      .run(JSON.stringify(result), source, observedGitState === null ? null : JSON.stringify(observedGitState), this.clock(), executionId, from);
    if (info.changes !== 1) throw new ExecutionAttemptError(`execution ${executionId} is not ${from}`, "EXECUTION_STATE_MISMATCH");
    return this.get(executionId);
  }
}
