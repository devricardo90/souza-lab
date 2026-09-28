import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { EvidenceCheckpointProvider } from "../core/contracts.js";

const ZERO_HASH = "0".repeat(64);

export class EvidenceCheckpointError extends Error {
  constructor(message, code = "INVALID_EVIDENCE_CHECKPOINT") {
    super(message);
    this.name = "EvidenceCheckpointError";
    this.code = code;
  }
}

function checksum(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function validateCheckpoint(value) {
  if (!value || !Number.isInteger(value.sequence) || value.sequence < 0
    || typeof value.rootHash !== "string" || !/^[0-9a-f]{64}$/i.test(value.rootHash)
    || typeof value.timestamp !== "string" || !Number.isFinite(Date.parse(value.timestamp))) {
    throw new EvidenceCheckpointError("checkpoint has invalid sequence, root hash, or timestamp", "INVALID_CHECKPOINT_SCHEMA");
  }
  const body = { sequence: value.sequence, rootHash: value.rootHash, timestamp: value.timestamp };
  if (value.checksum !== checksum(body)) throw new EvidenceCheckpointError("checkpoint checksum mismatch", "CHECKPOINT_CHECKSUM_MISMATCH");
  return Object.freeze({ ...body, checksum: value.checksum });
}

/** A local trust anchor. Protect this path separately from the event log. */
export class LocalEvidenceCheckpointProvider extends EvidenceCheckpointProvider {
  constructor({ path } = {}) {
    super();
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("checkpoint path is required");
    this.path = path;
  }

  readTrustedCheckpoint() {
    if (!existsSync(this.path)) return null;
    try { return validateCheckpoint(JSON.parse(readFileSync(this.path, "utf8"))); }
    catch (error) {
      if (error instanceof EvidenceCheckpointError) throw error;
      throw new EvidenceCheckpointError(`cannot read checkpoint: ${error.message}`, "CORRUPTED_CHECKPOINT");
    }
  }

  publishCheckpoint({ sequence, rootHash, timestamp = new Date().toISOString() }) {
    if (!Number.isInteger(sequence) || sequence < 0 || typeof rootHash !== "string" || !/^[0-9a-f]{64}$/i.test(rootHash)) {
      throw new EvidenceCheckpointError("cannot publish malformed checkpoint", "INVALID_CHECKPOINT_SCHEMA");
    }
    const previous = this.readTrustedCheckpoint();
    if (previous && sequence < previous.sequence) throw new EvidenceCheckpointError("checkpoint cannot move backwards", "CHECKPOINT_ROLLBACK");
    if (previous && sequence === previous.sequence && rootHash !== previous.rootHash) {
      throw new EvidenceCheckpointError("same-sequence root hash changed", "CHECKPOINT_CONFLICT");
    }
    const body = { sequence, rootHash, timestamp };
    const saved = { ...body, checksum: checksum(body) };
    mkdirSync(dirname(this.path), { recursive: true });
    const temporaryPath = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(saved)}\n`, { encoding: "utf8", flag: "w" });
    renameSync(temporaryPath, this.path);
    return Object.freeze(saved);
  }
}

export function verifyEvidenceCheckpoint(checkpointProvider, evidenceStore) {
  const trusted = checkpointProvider.readTrustedCheckpoint();
  const current = evidenceStore.getIntegrityCheckpoint();
  if (!trusted) return Object.freeze({ status: "UNANCHORED", trusted: null, current });
  if (current.sequence < trusted.sequence) return Object.freeze({ status: "TRUNCATED", trusted, current });
  const observedHash = evidenceStore.getHashAtSequence(trusted.sequence);
  if (observedHash !== trusted.rootHash) return Object.freeze({ status: "MISMATCH", trusted, current });
  return Object.freeze({ status: current.sequence === trusted.sequence ? "VERIFIED" : "STALE", trusted, current });
}

export function publishCurrentEvidenceCheckpoint(checkpointProvider, evidenceStore, timestamp) {
  const current = evidenceStore.getIntegrityCheckpoint();
  return checkpointProvider.publishCheckpoint({ ...current, timestamp });
}
