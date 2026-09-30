import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { hashCanonicalPlan, sortedStringify } from "../plan/plan-compiler.js";
import { PlanSnapshotError, makePlanSnapshot } from "../plan/plan-snapshot.js";

/**
 * Durable, IMMUTABLE store of PlanSnapshots.
 *
 * Required durability: a persisted snapshot must survive process death and power loss
 * (WorkPackages bind to it permanently), two workers persisting concurrently must not
 * corrupt anything, and a snapshot may never change or disappear. That is exactly what a
 * tiny SQLite table gives us (same WAL + synchronous=FULL settings as the outbox store),
 * so no second crash-sensitive JSONL store is invented.
 *
 * Database-enforced invariants:
 *   PRIMARY KEY (document_id, plan_version, content_hash)   identity
 *   UNIQUE (document_id, plan_version)                      one content per version; a different hash
 *                                                           for the same version is a conflict
 *   triggers                                                no UPDATE, no DELETE (immutability)
 * Latest-known-good = highest plan_version for the document (derived, never a mutable pointer).
 * plan_version is monotonic: persisting a version below the latest is rejected.
 */

export class PlanStoreError extends Error {
  constructor(message, code = "PLAN_STORE_ERROR") {
    super(message);
    this.name = "PlanStoreError";
    this.code = code;
    this.classification = "SOURCE_INVALID";
    this.retryable = false;
  }
}

const DDL = `
CREATE TABLE IF NOT EXISTS plan_snapshots (
  document_id      TEXT NOT NULL CHECK (length(document_id) > 0),
  plan_version     INTEGER NOT NULL CHECK (plan_version > 0),
  content_hash     TEXT NOT NULL CHECK (length(content_hash) = 64),
  grammar_version  INTEGER NOT NULL,
  canonical_plan   TEXT NOT NULL CHECK (json_valid(canonical_plan)),
  google_revision  TEXT,
  fetched_at       TEXT NOT NULL,
  compiled_at      TEXT NOT NULL,
  persisted_at     TEXT NOT NULL,
  PRIMARY KEY (document_id, plan_version, content_hash),
  UNIQUE (document_id, plan_version)
) STRICT;
CREATE TRIGGER IF NOT EXISTS plan_snapshots_no_update BEFORE UPDATE ON plan_snapshots
BEGIN SELECT RAISE(ABORT, 'plan snapshots are immutable'); END;
CREATE TRIGGER IF NOT EXISTS plan_snapshots_no_delete BEFORE DELETE ON plan_snapshots
BEGIN SELECT RAISE(ABORT, 'plan snapshots are never deleted'); END;
`;

export class SqlitePlanSnapshotStore {
  constructor({ path, clock = () => new Date().toISOString(), busyTimeoutMs = 10000 } = {}) {
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("SqlitePlanSnapshotStore requires a path");
    this.path = path;
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

  /**
   * Idempotent, conflict-detecting persist. Returns { created, snapshot }.
   *  - same identity already stored            -> created:false (existing snapshot wins, immutable)
   *  - same version, different content_hash    -> PLAN_VERSION_CONFLICT
   *  - version below the latest known          -> PLAN_VERSION_REGRESSION
   */
  persist(snapshot) {
    const plan = { grammarVersion: snapshot.grammarVersion, planVersion: snapshot.planVersion, tasks: snapshot.tasks.map(({ taskId, epicId, title, dependsOn, acceptanceCriteria, taskHash }) => ({ taskId, epicId, title, dependsOn, acceptanceCriteria, taskHash })) };
    if (hashCanonicalPlan(plan) !== snapshot.contentHash) throw new PlanStoreError("snapshot content does not match its content_hash; refusing to persist", "HASH_MISMATCH");
    return this.tx(() => {
      const sameVersion = this.db.prepare("SELECT content_hash FROM plan_snapshots WHERE document_id = ? AND plan_version = ?").get(snapshot.documentId, snapshot.planVersion);
      if (sameVersion) {
        if (sameVersion.content_hash === snapshot.contentHash) return { created: false, snapshot: this.load(snapshot.documentId, snapshot.planVersion, snapshot.contentHash) };
        throw new PlanStoreError(`plan_version ${snapshot.planVersion} of ${snapshot.documentId} already exists with different content`, "PLAN_VERSION_CONFLICT");
      }
      const latest = this.db.prepare("SELECT MAX(plan_version) AS v FROM plan_snapshots WHERE document_id = ?").get(snapshot.documentId).v;
      if (latest !== null && snapshot.planVersion < latest) throw new PlanStoreError(`plan_version ${snapshot.planVersion} is older than the latest known version ${latest}`, "PLAN_VERSION_REGRESSION");
      this.db.prepare(`INSERT INTO plan_snapshots (document_id, plan_version, content_hash, grammar_version, canonical_plan, google_revision, fetched_at, compiled_at, persisted_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        snapshot.documentId, snapshot.planVersion, snapshot.contentHash, snapshot.grammarVersion, sortedStringify(plan),
        snapshot.googleRevisionMetadata?.revisionId ?? null, snapshot.fetchedAt, snapshot.compiledAt, this.clock());
      return { created: true, snapshot: this.load(snapshot.documentId, snapshot.planVersion, snapshot.contentHash) };
    });
  }

  rowToSnapshot(row) {
    if (!row) return null;
    const plan = JSON.parse(row.canonical_plan);
    // Integrity on every load: a snapshot whose stored content no longer hashes to its identity is never served.
    if (hashCanonicalPlan(plan) !== row.content_hash) throw new PlanStoreError(`stored snapshot ${row.document_id}@${row.plan_version} failed its integrity check`, "CORRUPT_SNAPSHOT");
    return makePlanSnapshot({
      documentId: row.document_id, compiled: { canonicalPlan: plan, contentHash: row.content_hash },
      googleRevisionId: row.google_revision, fetchedAt: row.fetched_at, compiledAt: row.compiled_at,
    });
  }

  load(documentId, planVersion, contentHash) {
    return this.rowToSnapshot(this.db.prepare("SELECT * FROM plan_snapshots WHERE document_id = ? AND plan_version = ? AND content_hash = ?").get(documentId, planVersion, contentHash));
  }

  /** Latest-known-good for a document: highest plan_version, or null. */
  latest(documentId) {
    return this.rowToSnapshot(this.db.prepare("SELECT * FROM plan_snapshots WHERE document_id = ? ORDER BY plan_version DESC LIMIT 1").get(documentId));
  }

  listVersions(documentId) {
    return this.db.prepare("SELECT plan_version, content_hash FROM plan_snapshots WHERE document_id = ? ORDER BY plan_version").all(documentId)
      .map((row) => ({ planVersion: row.plan_version, contentHash: row.content_hash }));
  }
}

export { PlanSnapshotError };
