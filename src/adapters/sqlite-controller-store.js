import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * Durable Controller state: frozen WorkPackages with their completion status, and notification
 * de-duplication (so a restart never re-notifies the Owner). Same SQLite settings as the outbox
 * (WAL, synchronous=FULL, busy timeout, BEGIN IMMEDIATE).
 *
 * Work package lifecycle (database-enforced):
 *   EXECUTING -> LOCAL_DONE -> REMOTE_DONE_CONFIRMED
 *   EXECUTING | LOCAL_DONE -> BLOCKED
 * The package itself is immutable, there is exactly one per TASK_ID (a task is executed once), and
 * REMOTE_DONE_CONFIRMED / BLOCKED are terminal.
 */

export const WORK_PACKAGE_STATES = Object.freeze(["EXECUTING", "LOCAL_DONE", "REMOTE_DONE_CONFIRMED", "BLOCKED"]);

export class ControllerStoreError extends Error {
  constructor(message, code = "CONTROLLER_STORE_ERROR") {
    super(message);
    this.name = "ControllerStoreError";
    this.code = code;
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS work_packages (
  task_id           TEXT PRIMARY KEY CHECK (length(task_id) > 0),
  work_package_id   TEXT NOT NULL UNIQUE,
  execution_id      TEXT NOT NULL UNIQUE,
  work_package      TEXT NOT NULL CHECK (json_valid(work_package)),
  jira_issue_key    TEXT NOT NULL CHECK (length(jira_issue_key) > 0),
  status            TEXT NOT NULL CHECK (status IN ('EXECUTING','LOCAL_DONE','REMOTE_DONE_CONFIRMED','BLOCKED')),
  block_reason      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS wp_insert_guard BEFORE INSERT ON work_packages WHEN NEW.status <> 'EXECUTING'
BEGIN SELECT RAISE(ABORT, 'work packages start EXECUTING'); END;
CREATE TRIGGER IF NOT EXISTS wp_immutable BEFORE UPDATE ON work_packages
WHEN NEW.task_id <> OLD.task_id OR NEW.work_package_id <> OLD.work_package_id OR NEW.execution_id <> OLD.execution_id
  OR NEW.work_package <> OLD.work_package OR NEW.jira_issue_key <> OLD.jira_issue_key OR NEW.created_at <> OLD.created_at
BEGIN SELECT RAISE(ABORT, 'work package is immutable'); END;
CREATE TRIGGER IF NOT EXISTS wp_transition_guard BEFORE UPDATE ON work_packages
WHEN NOT (
     (OLD.status = 'EXECUTING'  AND NEW.status IN ('LOCAL_DONE','BLOCKED'))
  OR (OLD.status = 'LOCAL_DONE' AND NEW.status IN ('REMOTE_DONE_CONFIRMED','BLOCKED'))
)
BEGIN SELECT RAISE(ABORT, 'invalid work package transition'); END;
CREATE TRIGGER IF NOT EXISTS wp_no_delete BEFORE DELETE ON work_packages
BEGIN SELECT RAISE(ABORT, 'work packages are never deleted'); END;

-- Consecutive plan-source failure streak per document, so the persistent-failure alert threshold survives restarts.
CREATE TABLE IF NOT EXISTS source_failure_state (
  document_id          TEXT PRIMARY KEY,
  streak_id            INTEGER NOT NULL DEFAULT 1 CHECK (streak_id >= 1),
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  alerted              INTEGER NOT NULL DEFAULT 0 CHECK (alerted IN (0, 1)),
  last_status          TEXT,
  updated_at           TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS notifications_sent (
  dedupe_key TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
`;

const parse = (row) => (row ? Object.freeze({
  taskId: row.task_id, workPackageId: row.work_package_id, executionId: row.execution_id,
  workPackage: Object.freeze(JSON.parse(row.work_package)), jiraIssueKey: row.jira_issue_key,
  status: row.status, blockReason: row.block_reason, createdAt: row.created_at, updatedAt: row.updated_at,
}) : null);

export class SqliteControllerStore {
  constructor({ path, clock = () => new Date().toISOString(), busyTimeoutMs = 10000 } = {}) {
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("SqliteControllerStore requires a path");
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

  /** Idempotent: the same work package returns the stored one; a DIFFERENT package for the same task is rejected. */
  createWorkPackage(workPackage, jiraIssueKey) {
    const serialized = JSON.stringify(workPackage);
    const now = this.clock();
    return this.tx(() => {
      const existing = this.db.prepare("SELECT * FROM work_packages WHERE task_id = ?").get(workPackage.taskId);
      if (existing) {
        if (existing.work_package !== serialized) throw new ControllerStoreError(`task ${workPackage.taskId} already has a different work package`, "WORK_PACKAGE_CONFLICT");
        return { created: false, record: parse(existing) };
      }
      this.db.prepare(`INSERT INTO work_packages (task_id, work_package_id, execution_id, work_package, jira_issue_key, status, created_at, updated_at)
        VALUES (?,?,?,?,?, 'EXECUTING', ?, ?)`).run(workPackage.taskId, workPackage.workPackageId, workPackage.executionId, serialized, jiraIssueKey, now, now);
      return { created: true, record: this.get(workPackage.taskId) };
    });
  }

  get(taskId) { return parse(this.db.prepare("SELECT * FROM work_packages WHERE task_id = ?").get(taskId)); }
  list() { return this.db.prepare("SELECT * FROM work_packages ORDER BY task_id").all().map(parse); }
  /** Work that is started but not finished (at most one in the single-task controller). */
  inFlight() { return this.db.prepare("SELECT * FROM work_packages WHERE status IN ('EXECUTING','LOCAL_DONE') ORDER BY task_id").all().map(parse); }

  /** Guarded transition: only from the expected status, enforced again by database triggers. */
  transition(taskId, from, to, { reason = null } = {}) {
    const info = this.db.prepare("UPDATE work_packages SET status = ?, block_reason = ?, updated_at = ? WHERE task_id = ? AND status = ?")
      .run(to, reason === null ? null : String(reason).slice(0, 500), this.clock(), taskId, from);
    if (info.changes !== 1) throw new ControllerStoreError(`work package ${taskId} is not ${from}`, "WORK_PACKAGE_STATE_MISMATCH");
    return this.get(taskId);
  }

  /**
   * Records one failed source refresh. Returns { streakId, consecutive, alert }: alert is true exactly ONCE per streak,
   * on the failure that reaches the threshold. Transactional, so restarts neither lose the streak nor repeat the alert.
   */
  recordSourceFailure(documentId, status, threshold) {
    const now = this.clock();
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM source_failure_state WHERE document_id = ?").get(documentId)
        ?? { document_id: documentId, streak_id: 1, consecutive_failures: 0, alerted: 0 };
      const consecutive = row.consecutive_failures + 1;
      const alert = consecutive >= threshold && row.alerted === 0;
      this.db.prepare(`INSERT INTO source_failure_state (document_id, streak_id, consecutive_failures, alerted, last_status, updated_at)
        VALUES (?,?,?,?,?,?) ON CONFLICT(document_id) DO UPDATE SET consecutive_failures = excluded.consecutive_failures,
        alerted = excluded.alerted, last_status = excluded.last_status, updated_at = excluded.updated_at`)
        .run(documentId, row.streak_id, consecutive, alert ? 1 : row.alerted, status, now);
      return { streakId: row.streak_id, consecutive, alert };
    });
  }

  /** A successful refresh ends the streak: the counter resets and a later streak may alert again. */
  resetSourceFailures(documentId) {
    return this.tx(() => {
      const row = this.db.prepare("SELECT * FROM source_failure_state WHERE document_id = ?").get(documentId);
      if (!row || row.consecutive_failures === 0) return false;
      this.db.prepare("UPDATE source_failure_state SET streak_id = streak_id + 1, consecutive_failures = 0, alerted = 0, last_status = NULL, updated_at = ? WHERE document_id = ?")
        .run(this.clock(), documentId);
      return true;
    });
  }

  sourceFailureState(documentId) {
    const row = this.db.prepare("SELECT * FROM source_failure_state WHERE document_id = ?").get(documentId);
    return row ? { streakId: row.streak_id, consecutive: row.consecutive_failures, alerted: row.alerted === 1, lastStatus: row.last_status } : null;
  }

  /** True only the first time a dedupe key is recorded. */
  markNotified(dedupeKey, kind) {
    return this.db.prepare("INSERT OR IGNORE INTO notifications_sent (dedupe_key, kind, created_at) VALUES (?,?,?)").run(dedupeKey, kind, this.clock()).changes === 1;
  }
}
