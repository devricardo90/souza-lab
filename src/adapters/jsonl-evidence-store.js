import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { EvidenceStore, makeEvidenceEvent } from "../core/contracts.js";

const ZERO_HASH = "0".repeat(64);

export class EvidenceStoreError extends Error {
  constructor(message, code = "INVALID_EVIDENCE_STORE") {
    super(message);
    this.name = "EvidenceStoreError";
    this.code = code;
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function canonicalEvent(input) {
  try {
    return JSON.parse(JSON.stringify(makeEvidenceEvent(input)));
  } catch (error) {
    if (error instanceof TypeError && error.name === "ContractError") throw error;
    throw new EvidenceStoreError(`evidence event must be JSON serializable: ${error.message}`, "INVALID_EVENT_PAYLOAD");
  }
}

/** Append-only JSONL event log with a local integrity chain; no update/delete API exists. */
export class JsonlEvidenceStore extends EvidenceStore {
  constructor({ path } = {}) {
    super();
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("JsonlEvidenceStore requires a path");
    this.path = path;
  }

  readRecords() {
    if (!existsSync(this.path)) return [];
    const text = readFileSync(this.path, "utf8");
    if (text.length === 0) return [];
    const lines = text.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const records = [];
    const ids = new Set();
    let previousHash = ZERO_HASH;

    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === "") throw new EvidenceStoreError(`blank evidence record at line ${index + 1}`);
      let record;
      try { record = JSON.parse(line); } catch {
        throw new EvidenceStoreError(`invalid JSON at evidence line ${index + 1}`, "INVALID_JSONL");
      }
      if (!record || record.schemaVersion !== 1 || !Number.isInteger(record.sequence) || record.sequence !== index + 1) {
        throw new EvidenceStoreError(`invalid sequence/schema at evidence line ${index + 1}`, "INVALID_SEQUENCE");
      }
      const event = canonicalEvent(record.event);
      if (ids.has(event.eventId)) throw new EvidenceStoreError(`duplicate event id ${event.eventId}`, "DUPLICATE_EVENT");
      ids.add(event.eventId);
      const body = { schemaVersion: 1, sequence: record.sequence, previousHash: record.previousHash, event };
      const expectedHash = digest(body);
      if (record.previousHash !== previousHash || record.hash !== expectedHash) {
        throw new EvidenceStoreError(`integrity chain mismatch at evidence line ${index + 1}`, "HASH_CHAIN_MISMATCH");
      }
      records.push(Object.freeze({ ...body, hash: expectedHash }));
      previousHash = expectedHash;
    }
    return records;
  }

  append(input) {
    const event = canonicalEvent(input);
    const records = this.readRecords();
    if (records.some((record) => record.event.eventId === event.eventId)) {
      throw new EvidenceStoreError(`duplicate event id ${event.eventId}`, "DUPLICATE_EVENT");
    }
    const previousHash = records.at(-1)?.hash ?? ZERO_HASH;
    const body = {
      schemaVersion: 1,
      sequence: records.length + 1,
      previousHash,
      event,
    };
    const record = Object.freeze({ ...body, hash: digest(body) });
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, { encoding: "utf8", flag: "a" });
    return record;
  }

  listAll() {
    return Object.freeze(this.readRecords().map(({ event }) => Object.freeze(event)));
  }

  listByTask(taskId) {
    if (typeof taskId !== "string" || taskId.trim() === "") throw new TypeError("listByTask requires a task id");
    return Object.freeze(this.listAll().filter((event) => event.taskId === taskId));
  }

  getById(eventId) {
    if (typeof eventId !== "string" || eventId.trim() === "") throw new TypeError("getById requires an event id");
    return this.readRecords().find(({ event }) => event.eventId === eventId)?.event ?? null;
  }

  getIntegrityCheckpoint() {
    const records = this.readRecords();
    return Object.freeze({ sequence: records.length, rootHash: records.at(-1)?.hash ?? ZERO_HASH });
  }

  getHashAtSequence(sequence) {
    if (!Number.isInteger(sequence) || sequence < 0) throw new TypeError("sequence must be a non-negative integer");
    if (sequence === 0) return ZERO_HASH;
    return this.readRecords()[sequence - 1]?.hash ?? null;
  }
}
