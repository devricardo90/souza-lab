import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { makeReviewResult, makeValidationResult } from "../core/contracts.js";

/**
 * Durable, write-once gate evidence: validation and review facts, each bound to the EXACT head SHA they were produced
 * for. Lookup is by exact head, so evidence for H1 can never be returned for H2: a new head simply has no evidence and
 * every gate must run again (the state engine additionally rejects any fact whose head differs from the candidate).
 *
 *   validations: key (execution_id, task_id, head)    one record per exact head (post-merge records key on the merge SHA)
 *   reviews:     key (execution_id, head)             FINDINGS and CLEAN records are both kept (the correction history)
 *
 * Same SQLite settings as the other stores (WAL, synchronous=FULL, BEGIN IMMEDIATE); rows are immutable and never deleted.
 */

const DDL = `
CREATE TABLE IF NOT EXISTS gate_validations (
  execution_id TEXT NOT NULL, task_id TEXT NOT NULL, head TEXT NOT NULL CHECK (length(head) = 40),
  payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL,
  post_merge INTEGER NOT NULL DEFAULT 0 CHECK (post_merge IN (0, 1)),
  PRIMARY KEY (execution_id, task_id, head)
) STRICT;
CREATE TABLE IF NOT EXISTS gate_reviews (
  execution_id TEXT NOT NULL, head TEXT NOT NULL CHECK (length(head) = 40), verdict TEXT NOT NULL CHECK (verdict IN ('CLEAN','FINDINGS')),
  payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, head)
) STRICT;
CREATE TABLE IF NOT EXISTS gate_findings (
  execution_id TEXT NOT NULL, head TEXT NOT NULL CHECK (length(head) = 40),
  payload TEXT NOT NULL CHECK (json_valid(payload)), created_at TEXT NOT NULL,
  PRIMARY KEY (execution_id, head)
) STRICT;
CREATE TRIGGER IF NOT EXISTS gate_findings_immutable BEFORE UPDATE ON gate_findings BEGIN SELECT RAISE(ABORT, 'gate evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS gate_findings_no_delete BEFORE DELETE ON gate_findings BEGIN SELECT RAISE(ABORT, 'gate evidence is never deleted'); END;
CREATE TRIGGER IF NOT EXISTS gate_validations_immutable BEFORE UPDATE ON gate_validations BEGIN SELECT RAISE(ABORT, 'gate evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS gate_reviews_immutable BEFORE UPDATE ON gate_reviews BEGIN SELECT RAISE(ABORT, 'gate evidence is immutable'); END;
CREATE TRIGGER IF NOT EXISTS gate_validations_no_delete BEFORE DELETE ON gate_validations BEGIN SELECT RAISE(ABORT, 'gate evidence is never deleted'); END;
CREATE TRIGGER IF NOT EXISTS gate_reviews_no_delete BEFORE DELETE ON gate_reviews BEGIN SELECT RAISE(ABORT, 'gate evidence is never deleted'); END;
`;

export class SqliteGateFactStore {
  constructor({ path, clock = () => new Date().toISOString(), busyTimeoutMs = 10000 } = {}) {
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("SqliteGateFactStore requires a path");
    this.clock = clock;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA busy_timeout = ${Number(busyTimeoutMs)}`);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("BEGIN IMMEDIATE");
    try { this.db.exec(DDL); this.db.exec("COMMIT"); } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  close() { this.db.close(); }

  /** Write-once; recording the same head again returns the existing record (a head is validated/reviewed once). */
  recordValidation(executionId, taskId, validation, { postMerge = false } = {}) {
    const record = makeValidationResult(validation);
    this.db.prepare("INSERT OR IGNORE INTO gate_validations (execution_id, task_id, head, payload, created_at, post_merge) VALUES (?,?,?,?,?,?)")
      .run(executionId, taskId, record.head, JSON.stringify(record), this.clock(), postMerge ? 1 : 0);
    return this.getValidation(executionId, taskId, record.head);
  }

  getValidation(executionId, taskId, head) {
    const row = this.db.prepare("SELECT payload FROM gate_validations WHERE execution_id = ? AND task_id = ? AND head = ?").get(executionId, taskId, head);
    return row ? makeValidationResult(JSON.parse(row.payload)) : null;
  }

  recordReview(executionId, review) {
    const record = makeReviewResult(review);
    if (!["CLEAN", "FINDINGS"].includes(record.verdict)) throw new TypeError("only CLEAN or FINDINGS reviews are recorded");
    this.db.prepare("INSERT OR IGNORE INTO gate_reviews (execution_id, head, verdict, payload, created_at) VALUES (?,?,?,?,?)")
      .run(executionId, record.head, record.verdict, JSON.stringify(record), this.clock());
    return this.getReview(executionId, record.head);
  }

  getReview(executionId, head) {
    const row = this.db.prepare("SELECT payload FROM gate_reviews WHERE execution_id = ? AND head = ?").get(executionId, head);
    return row ? makeReviewResult(JSON.parse(row.payload)) : null;
  }

  /** The structured findings behind a FINDINGS review, bound to the exact head that was reviewed. */
  recordFindings(executionId, head, findings) {
    this.db.prepare("INSERT OR IGNORE INTO gate_findings (execution_id, head, payload, created_at) VALUES (?,?,?,?)").run(executionId, head, JSON.stringify(findings), this.clock());
  }

  getFindings(executionId, head) {
    const row = this.db.prepare("SELECT payload FROM gate_findings WHERE execution_id = ? AND head = ?").get(executionId, head);
    return row ? JSON.parse(row.payload) : null;
  }

  /** Findings of the most recent FINDINGS review (used to resume an interrupted correction). */
  latestFindings(executionId) {
    const row = this.db.prepare("SELECT head, payload FROM gate_findings WHERE execution_id = ? ORDER BY rowid DESC LIMIT 1").get(executionId);
    return row ? { head: row.head, findings: JSON.parse(row.payload) } : null;
  }

  /** True once a PASSING post-merge validation (head = the merge commit) exists for the execution. */
  postMergeValidated(executionId, taskId) {
    return this.db.prepare("SELECT 1 FROM gate_validations WHERE execution_id = ? AND task_id = ? AND post_merge = 1 AND json_extract(payload, '$.result') = 'PASS' LIMIT 1").get(executionId, taskId) !== undefined;
  }

  /** Number of FINDINGS reviews recorded for an execution: the bound for the correction loop. */
  findingsCount(executionId) {
    return this.db.prepare("SELECT COUNT(*) AS n FROM gate_reviews WHERE execution_id = ? AND verdict = 'FINDINGS'").get(executionId).n;
  }
}
