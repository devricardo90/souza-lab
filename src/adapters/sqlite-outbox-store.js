import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * SQLite-backed durable store for EXTERNAL-OPERATION state (the outbox).
 * JsonlEvidenceStore keeps owning append-only audit evidence; this store owns
 * the mutable state of pending external writes. The database is the only
 * authority for claims and state transitions: every change is one guarded
 * statement or one BEGIN IMMEDIATE transaction, and SQL triggers reject any
 * transition the state machine does not allow (fail closed even if the JS
 * layer is bypassed).
 *
 * Configuration (reliability over throughput; outbox volume is tiny):
 *   journal_mode = WAL      crash-safe, readers never block the writer, recovers
 *                           committed transactions and discards uncommitted ones
 *   synchronous  = FULL     fsync on every commit, including the WAL, so a
 *                           committed transition survives OS/power loss on a
 *                           POSIX filesystem (VPS). Windows gives best-effort.
 *   busy_timeout = 10000ms  concurrent workers wait for the write lock instead
 *                           of failing with SQLITE_BUSY
 *   foreign_keys = ON
 *   transactions            BEGIN IMMEDIATE (write lock taken up-front, so no
 *                           read-then-write race and no deadlock upgrades)
 * WAL requires a local filesystem (not a network share).
 */

export const OUTBOX_STATES = Object.freeze(["PENDING", "IN_FLIGHT", "CONFIRMED", "RETRY_WAIT", "CONFLICT", "FAILED_PERMANENT"]);
export const OUTBOX_TERMINAL_STATES = Object.freeze(["CONFIRMED", "CONFLICT", "FAILED_PERMANENT"]);
/** Implemented: JIRA_COMMENT, JIRA_TRANSITION. The others are reserved identities only. */
export const OUTBOX_ACTIONS = Object.freeze(["JIRA_COMMENT", "JIRA_TRANSITION", "JIRA_CREATE", "JIRA_UPDATE", "JIRA_SPRINT_ASSIGNMENT"]);
export const OUTBOX_TRANSITIONS = Object.freeze({
  PENDING: ["IN_FLIGHT"],
  RETRY_WAIT: ["IN_FLIGHT"],
  IN_FLIGHT: ["CONFIRMED", "RETRY_WAIT", "CONFLICT", "FAILED_PERMANENT", "IN_FLIGHT"], // IN_FLIGHT->IN_FLIGHT = stale-claim takeover
  CONFIRMED: [], CONFLICT: [], FAILED_PERMANENT: [],
});
const SETTLE_STATES = ["CONFIRMED", "RETRY_WAIT", "CONFLICT", "FAILED_PERMANENT"];

export class OutboxError extends Error {
  constructor(message, code = "OUTBOX_ERROR") {
    super(message);
    this.name = "OutboxError";
    this.code = code;
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

const stable = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));
const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");

/** Deterministic identity: the same logical operation always yields the same id. */
export function deriveOperationId(action, identity) {
  if (!OUTBOX_ACTIONS.includes(action)) throw new OutboxError(`unknown outbox action ${action}`, "INVALID_ACTION");
  return `${action}:${sha256(stable([action, identity]))}`;
}

const SCHEMA_VERSION = 1;
const DDL = `
CREATE TABLE IF NOT EXISTS outbox_operations (
  operation_id            TEXT PRIMARY KEY CHECK (length(operation_id) > 0),
  target_system           TEXT NOT NULL CHECK (target_system IN ('JIRA')),
  target_object           TEXT NOT NULL CHECK (length(target_object) > 0),
  action                  TEXT NOT NULL CHECK (action IN ('JIRA_COMMENT','JIRA_TRANSITION','JIRA_CREATE','JIRA_UPDATE','JIRA_SPRINT_ASSIGNMENT')),
  task_id                 TEXT NOT NULL CHECK (length(task_id) > 0),
  execution_id            TEXT,
  source_revision         TEXT,
  head                    TEXT,
  expected_previous_state TEXT CHECK (expected_previous_state IS NULL OR json_valid(expected_previous_state)),
  desired_state           TEXT NOT NULL CHECK (json_valid(desired_state)),
  payload_digest          TEXT NOT NULL,
  status                  TEXT NOT NULL CHECK (status IN ('PENDING','IN_FLIGHT','CONFIRMED','RETRY_WAIT','CONFLICT','FAILED_PERMANENT')),
  attempt_count           INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_retry_at           TEXT,
  claimed_by              TEXT,
  claim_token             INTEGER NOT NULL DEFAULT 0 CHECK (claim_token >= 0),
  claim_expires_at        TEXT,
  last_error_code         TEXT,
  last_error_detail       TEXT,
  created_at              TEXT NOT NULL,
  updated_at              TEXT NOT NULL,
  CHECK (status <> 'IN_FLIGHT' OR (claimed_by IS NOT NULL AND claim_expires_at IS NOT NULL)),
  CHECK (status <> 'RETRY_WAIT' OR next_retry_at IS NOT NULL)
) STRICT;
CREATE INDEX IF NOT EXISTS outbox_status_idx ON outbox_operations (status, next_retry_at);

CREATE TRIGGER IF NOT EXISTS outbox_insert_guard BEFORE INSERT ON outbox_operations
WHEN NEW.status <> 'PENDING' OR NEW.attempt_count <> 0 OR NEW.claim_token <> 0
BEGIN SELECT RAISE(ABORT, 'outbox: operations must be created PENDING'); END;

CREATE TRIGGER IF NOT EXISTS outbox_identity_immutable BEFORE UPDATE ON outbox_operations
WHEN NEW.operation_id <> OLD.operation_id OR NEW.target_system <> OLD.target_system OR NEW.target_object <> OLD.target_object
  OR NEW.action <> OLD.action OR NEW.task_id <> OLD.task_id OR NEW.desired_state <> OLD.desired_state
  OR NEW.payload_digest <> OLD.payload_digest OR NEW.created_at <> OLD.created_at
  OR NEW.execution_id IS NOT OLD.execution_id OR NEW.source_revision IS NOT OLD.source_revision OR NEW.head IS NOT OLD.head
  OR NEW.expected_previous_state IS NOT OLD.expected_previous_state
BEGIN SELECT RAISE(ABORT, 'outbox: operation identity is immutable'); END;

CREATE TRIGGER IF NOT EXISTS outbox_transition_guard BEFORE UPDATE ON outbox_operations
WHEN NOT (
     (OLD.status = 'PENDING'    AND NEW.status = 'IN_FLIGHT')
  OR (OLD.status = 'RETRY_WAIT' AND NEW.status = 'IN_FLIGHT')
  OR (OLD.status = 'IN_FLIGHT'  AND NEW.status IN ('CONFIRMED','RETRY_WAIT','CONFLICT','FAILED_PERMANENT'))
  OR (OLD.status = 'IN_FLIGHT'  AND NEW.status = 'IN_FLIGHT' AND NEW.claim_token > OLD.claim_token)
)
BEGIN SELECT RAISE(ABORT, 'outbox: invalid state transition'); END;

CREATE TRIGGER IF NOT EXISTS outbox_no_delete BEFORE DELETE ON outbox_operations
BEGIN SELECT RAISE(ABORT, 'outbox: operations are never deleted'); END;
`;

function parseRow(row) {
  if (!row) return null;
  const json = (text) => (text === null || text === undefined ? null : JSON.parse(text));
  return Object.freeze({
    operationId: row.operation_id, targetSystem: row.target_system, targetObject: row.target_object, action: row.action,
    taskId: row.task_id, executionId: row.execution_id, sourceRevision: row.source_revision, head: row.head,
    expectedPreviousState: json(row.expected_previous_state), desiredState: json(row.desired_state),
    status: row.status, attemptCount: row.attempt_count, nextRetryAt: row.next_retry_at,
    claimedBy: row.claimed_by, claimToken: row.claim_token, claimExpiresAt: row.claim_expires_at,
    lastErrorCode: row.last_error_code, lastErrorDetail: row.last_error_detail,
    createdAt: row.created_at, updatedAt: row.updated_at,
  });
}

const str = (value, name, { optional = false } = {}) => {
  if (value === undefined || value === null) { if (optional) return null; throw new OutboxError(`${name} is required`, "INVALID_OPERATION"); }
  if (typeof value !== "string" || value.trim() === "") throw new OutboxError(`${name} must be a non-empty string`, "INVALID_OPERATION");
  return value;
};

export class SqliteOutboxStore {
  constructor({ path, clock = () => new Date().toISOString(), busyTimeoutMs = 10000 } = {}) {
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("SqliteOutboxStore requires a path");
    this.path = path;
    this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.tx(() => {
      const { user_version: version } = this.db.prepare("PRAGMA user_version").get();
      if (version > SCHEMA_VERSION) throw new OutboxError(`outbox schema version ${version} is newer than supported`, "SCHEMA_TOO_NEW");
      this.db.exec(DDL);
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  /** Effective settings, for evidence/tests. */
  configuration() {
    const one = (sql) => Object.values(this.db.prepare(sql).get())[0];
    return { journalMode: one("PRAGMA journal_mode"), synchronous: one("PRAGMA synchronous"), busyTimeoutMs: one("PRAGMA busy_timeout"), foreignKeys: one("PRAGMA foreign_keys") };
  }

  /** Runs fn inside BEGIN IMMEDIATE ... COMMIT; rolls back on any throw. */
  tx(fn) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  close() { this.db.close(); }

  /** Idempotent enqueue. The same operation_id never yields a second row. */
  enqueue(spec) {
    const action = spec?.action;
    if (!OUTBOX_ACTIONS.includes(action)) throw new OutboxError(`unknown outbox action ${action}`, "INVALID_ACTION");
    const operationId = str(spec.operationId, "operationId");
    const targetSystem = str(spec.targetSystem ?? "JIRA", "targetSystem");
    const targetObject = str(spec.targetObject, "targetObject");
    const taskId = str(spec.taskId, "taskId");
    if (spec.desiredState === undefined || spec.desiredState === null || typeof spec.desiredState !== "object") throw new OutboxError("desiredState must be an object", "INVALID_OPERATION");
    const digest = sha256(stable({ action, targetSystem, targetObject, taskId, executionId: spec.executionId ?? null, desired: spec.desiredState, expected: spec.expectedPreviousState ?? null }));
    const now = this.clock();
    return this.tx(() => {
      const existing = this.db.prepare("SELECT * FROM outbox_operations WHERE operation_id = ?").get(operationId);
      if (existing) {
        if (existing.payload_digest !== digest) throw new OutboxError(`operation ${operationId} already exists with a different payload`, "OPERATION_ID_CONFLICT");
        return { created: false, operation: parseRow(existing) };
      }
      this.db.prepare(`INSERT INTO outbox_operations
        (operation_id, target_system, target_object, action, task_id, execution_id, source_revision, head,
         expected_previous_state, desired_state, payload_digest, status, attempt_count, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?, 'PENDING', 0, ?, ?)`).run(
        operationId, targetSystem, targetObject, action, taskId, str(spec.executionId, "executionId", { optional: true }),
        str(spec.sourceRevision, "sourceRevision", { optional: true }), str(spec.head, "head", { optional: true }),
        spec.expectedPreviousState === undefined || spec.expectedPreviousState === null ? null : JSON.stringify(spec.expectedPreviousState),
        JSON.stringify(spec.desiredState), digest, now, now);
      return { created: true, operation: this.get(operationId) };
    });
  }

  get(operationId) {
    return parseRow(this.db.prepare("SELECT * FROM outbox_operations WHERE operation_id = ?").get(operationId));
  }

  list({ status } = {}) {
    const rows = status
      ? this.db.prepare("SELECT * FROM outbox_operations WHERE status = ? ORDER BY created_at, operation_id").all(status)
      : this.db.prepare("SELECT * FROM outbox_operations ORDER BY created_at, operation_id").all();
    return rows.map(parseRow);
  }

  /** Operations some worker may act on now: PENDING, RETRY_WAIT due, IN_FLIGHT with an expired claim. */
  listRunnable(now = this.clock()) {
    return this.db.prepare(`SELECT * FROM outbox_operations
      WHERE status = 'PENDING' OR (status = 'RETRY_WAIT' AND next_retry_at <= ?) OR (status = 'IN_FLIGHT' AND claim_expires_at <= ?)
      ORDER BY created_at, operation_id`).all(now, now).map(parseRow);
  }

  /**
   * Atomic claim. One guarded UPDATE is the authority: exactly one caller can move
   * PENDING / due RETRY_WAIT / expired IN_FLIGHT to a fresh IN_FLIGHT claim with a
   * higher fencing token. Returns null when the caller does not own the operation.
   * `recovered` is true when an expired IN_FLIGHT claim was taken over (remote
   * state MUST be reconciled before any write).
   */
  acquire(operationId, { workerId, ttlMs = 120000, now = this.clock() } = {}) {
    str(workerId, "workerId");
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new OutboxError("ttlMs must be positive", "INVALID_CLAIM");
    const expiresAt = new Date(Date.parse(now) + ttlMs).toISOString();
    return this.tx(() => {
      const before = this.db.prepare("SELECT status FROM outbox_operations WHERE operation_id = ?").get(operationId);
      if (!before) return null;
      const info = this.db.prepare(`UPDATE outbox_operations SET
          attempt_count = attempt_count + CASE WHEN status = 'IN_FLIGHT' THEN 0 ELSE 1 END,
          status = 'IN_FLIGHT', claimed_by = ?, claim_token = claim_token + 1, claim_expires_at = ?,
          next_retry_at = NULL, updated_at = ?
        WHERE operation_id = ? AND (status = 'PENDING' OR (status = 'RETRY_WAIT' AND next_retry_at <= ?) OR (status = 'IN_FLIGHT' AND claim_expires_at <= ?))`)
        .run(workerId, expiresAt, now, operationId, now, now);
      if (info.changes !== 1) return null;
      return { operation: this.get(operationId), recovered: before.status === "IN_FLIGHT" };
    });
  }

  /** Throws unless this exact claim (worker + fencing token) is still the live owner. */
  assertClaim(operationId, { workerId, claimToken }, now = this.clock()) {
    const row = this.db.prepare("SELECT status, claimed_by, claim_token, claim_expires_at FROM outbox_operations WHERE operation_id = ?").get(operationId);
    if (!row || row.status !== "IN_FLIGHT" || row.claimed_by !== workerId || row.claim_token !== claimToken || row.claim_expires_at <= now) {
      throw new OutboxError(`claim on ${operationId} is no longer held`, "CLAIM_LOST");
    }
    return true;
  }

  /** Extends a live claim (same fencing token). */
  renewClaim(operationId, { workerId, claimToken }, { ttlMs = 120000, now = this.clock() } = {}) {
    const info = this.db.prepare(`UPDATE outbox_operations SET claim_expires_at = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'IN_FLIGHT' AND claimed_by = ? AND claim_token = ? AND claim_expires_at > ?`)
      .run(new Date(Date.parse(now) + ttlMs).toISOString(), now, operationId, workerId, claimToken, now);
    if (info.changes !== 1) throw new OutboxError(`claim on ${operationId} is no longer held`, "CLAIM_LOST");
  }

  /** Settles an IN_FLIGHT operation. Guarded by (status, worker, fencing token): a fenced-out worker changes nothing. */
  settle(operationId, { workerId, claimToken }, { to, errorCode = null, errorDetail = null, nextRetryAt = null, now = this.clock() }) {
    if (!SETTLE_STATES.includes(to)) throw new OutboxError(`cannot settle an operation to ${to}`, "INVALID_TRANSITION");
    if (to === "RETRY_WAIT" && !nextRetryAt) throw new OutboxError("RETRY_WAIT requires next_retry_at", "INVALID_TRANSITION");
    const info = this.db.prepare(`UPDATE outbox_operations SET status = ?, next_retry_at = ?, last_error_code = ?, last_error_detail = ?,
        claim_expires_at = NULL, updated_at = ?
      WHERE operation_id = ? AND status = 'IN_FLIGHT' AND claimed_by = ? AND claim_token = ?`)
      .run(to, to === "RETRY_WAIT" ? nextRetryAt : null, errorCode, errorDetail === null ? null : String(errorDetail).slice(0, 500), now, operationId, workerId, claimToken);
    if (info.changes !== 1) throw new OutboxError(`claim on ${operationId} is no longer held`, "CLAIM_LOST");
    return this.get(operationId);
  }
}
