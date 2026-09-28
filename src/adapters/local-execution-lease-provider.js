import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync,
  renameSync, statSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { ExecutionLeaseProvider } from "../core/contracts.js";
import { makeExecutionLease } from "../core/runtime-contracts.js";

export class ExecutionLeaseUnavailableError extends Error {
  constructor(message, code = "EXECUTION_LEASE_UNAVAILABLE") {
    super(message);
    this.name = "ExecutionLeaseUnavailableError";
    this.code = code;
    this.classification = "TRANSIENT";
    this.retryable = true;
  }
}

export class StaleExecutionLeaseError extends Error {
  constructor(message, code = "STALE_EXECUTION_LEASE") {
    super(message);
    this.name = "StaleExecutionLeaseError";
    this.code = code;
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function lockOwnerAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function pauseSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function readLock(lockPath) {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf8"));
    if (!Number.isSafeInteger(raw.pid) || typeof raw.nonce !== "string") return null;
    return raw;
  } catch {
    return null;
  }
}

function reclaimDeadLock(lockPath) {
  const observed = readLock(lockPath);
  if (!observed) {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > 30000) unlinkSync(lockPath);
    } catch {}
    return;
  }
  if (lockOwnerAlive(observed.pid)) return;
  const quarantine = `${lockPath}.stale.${randomUUID()}`;
  try {
    renameSync(lockPath, quarantine);
    const moved = readLock(quarantine);
    if (moved?.nonce === observed.nonce) unlinkSync(quarantine);
    else if (!existsSync(lockPath)) renameSync(quarantine, lockPath);
    else unlinkSync(quarantine);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function withFileLock(lockPath, { timeoutMs }, operation) {
  mkdirSync(dirname(lockPath), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  const nonce = randomUUID();
  const temporary = `${lockPath}.${process.pid}.${nonce}.tmp`;
  let acquired = false;
  while (!acquired) {
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, nonce }), "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      linkSync(temporary, lockPath);
      acquired = true;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
      if (error?.code !== "EEXIST") throw error;
      reclaimDeadLock(lockPath);
      if (Date.now() >= deadline) throw new ExecutionLeaseUnavailableError("timed out acquiring the local execution lease lock", "LEASE_LOCK_TIMEOUT");
      pauseSync(10);
    }
  }
  try {
    return operation(() => {
      const current = readLock(lockPath);
      return current?.nonce === nonce && current.pid === process.pid;
    });
  } finally {
    try {
      const current = readLock(lockPath);
      if (current?.nonce === nonce && current.pid === process.pid) unlinkSync(lockPath);
    } catch {}
    try { unlinkSync(temporary); } catch {}
  }
}

function validateRequest(request, includeOwner = false) {
  for (const field of ["repository", "executionId", ...(includeOwner ? ["ownerId"] : [])]) {
    if (typeof request?.[field] !== "string" || request[field].trim() === "") throw new TypeError(`execution lease ${field} is required`);
  }
  if (includeOwner && (typeof request.taskId !== "string" || request.taskId.trim() === "")) throw new TypeError("execution lease taskId is required");
}

export class LocalExecutionLeaseProvider extends ExecutionLeaseProvider {
  constructor({ directory, clock = () => new Date().toISOString(), defaultTtlMs = 120000, lockTimeoutMs = 10000 } = {}) {
    super();
    if (typeof directory !== "string" || directory.trim() === "") throw new TypeError("lease directory is required");
    if (!Number.isSafeInteger(defaultTtlMs) || defaultTtlMs < 100) throw new TypeError("defaultTtlMs must be at least 100ms");
    if (!Number.isSafeInteger(lockTimeoutMs) || lockTimeoutMs < 1) throw new TypeError("lockTimeoutMs must be positive");
    this.directory = directory;
    this.clock = clock;
    this.defaultTtlMs = defaultTtlMs;
    this.lockTimeoutMs = lockTimeoutMs;
  }

  paths(request) {
    validateRequest(request);
    const key = digest({ repository: request.repository, executionId: request.executionId });
    return {
      state: join(this.directory, `${key}.json`),
      lock: join(this.directory, `${key}.lock`),
    };
  }

  readState(path) {
    if (!existsSync(path)) return { fencingToken: 0, lease: null };
    let value;
    try { value = JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { throw new StaleExecutionLeaseError(`lease state is unreadable: ${error.message}`, "CORRUPTED_LEASE_STATE"); }
    if (!Number.isSafeInteger(value?.fencingToken) || value.fencingToken < 0
      || (value.lease !== null && typeof value.lease !== "object")) {
      throw new StaleExecutionLeaseError("lease state schema is invalid", "CORRUPTED_LEASE_STATE");
    }
    return {
      fencingToken: value.fencingToken,
      lease: value.lease === null ? null : makeExecutionLease(value.lease),
    };
  }

  writeState(path, state, ownsLock) {
    if (!ownsLock()) throw new StaleExecutionLeaseError("lease lock authority was lost before durable write", "LEASE_LOCK_LOST");
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify(state)}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      if (!ownsLock()) throw new StaleExecutionLeaseError("lease lock authority was lost before publish", "LEASE_LOCK_LOST");
      renameSync(temporary, path);
    } finally {
      if (fd !== undefined) closeSync(fd);
      try { unlinkSync(temporary); } catch {}
    }
  }

  active(lease, now) {
    return lease !== null && Date.parse(lease.expiresAt) > Date.parse(now);
  }

  acquire({ repository, taskId, executionId, ownerId, ttlMs = this.defaultTtlMs }) {
    validateRequest({ repository, taskId, executionId, ownerId }, true);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 100) throw new TypeError("ttlMs must be at least 100ms");
    const paths = this.paths({ repository, executionId });
    return withFileLock(paths.lock, { timeoutMs: this.lockTimeoutMs }, (ownsLock) => {
      const state = this.readState(paths.state);
      const now = this.clock();
      if (this.active(state.lease, now)) {
        if (state.lease.ownerId === ownerId && state.lease.taskId === taskId) {
          const renewed = makeExecutionLease({
            ...state.lease,
            expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
          });
          this.writeState(paths.state, { fencingToken: state.fencingToken, lease: renewed }, ownsLock);
          return renewed;
        }
        throw new ExecutionLeaseUnavailableError(`execution lease is held by another owner until ${state.lease.expiresAt}`);
      }
      const acquiredAt = now;
      const lease = makeExecutionLease({
        repository, taskId, executionId, ownerId, leaseId: randomUUID(),
        fencingToken: state.fencingToken + 1,
        acquiredAt,
        expiresAt: new Date(Date.parse(acquiredAt) + ttlMs).toISOString(),
      });
      this.writeState(paths.state, { fencingToken: lease.fencingToken, lease }, ownsLock);
      return lease;
    });
  }

  renew(lease, { ttlMs = this.defaultTtlMs, taskId = lease?.taskId } = {}) {
    const paths = this.paths(lease ?? {});
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 100) throw new TypeError("ttlMs must be at least 100ms");
    return withFileLock(paths.lock, { timeoutMs: this.lockTimeoutMs }, (ownsLock) => {
      const state = this.readState(paths.state);
      this.assertMatches(state.lease, lease);
      const now = this.clock();
      if (!this.active(state.lease, now)) throw new StaleExecutionLeaseError("execution lease expired before renewal", "LEASE_EXPIRED");
      const renewed = makeExecutionLease({
        ...state.lease,
        taskId,
        expiresAt: new Date(Date.parse(now) + ttlMs).toISOString(),
      });
      this.writeState(paths.state, { fencingToken: state.fencingToken, lease: renewed }, ownsLock);
      return renewed;
    });
  }

  release(lease) {
    const paths = this.paths(lease ?? {});
    return withFileLock(paths.lock, { timeoutMs: this.lockTimeoutMs }, (ownsLock) => {
      const state = this.readState(paths.state);
      this.assertMatches(state.lease, lease);
      this.writeState(paths.state, { fencingToken: state.fencingToken, lease: null }, ownsLock);
      return true;
    });
  }

  inspect({ repository, executionId }) {
    const paths = this.paths({ repository, executionId });
    const state = this.readState(paths.state);
    const now = this.clock();
    return Object.freeze({
      fencingToken: state.fencingToken,
      active: this.active(state.lease, now),
      lease: state.lease,
      inspectedAt: now,
    });
  }

  assertCurrent(lease) {
    validateRequest(lease, true);
    const status = this.inspect(lease);
    this.assertMatches(status.lease, lease);
    if (!status.active) throw new StaleExecutionLeaseError("execution lease is expired", "LEASE_EXPIRED");
    return true;
  }

  assertMatches(current, presented) {
    if (!current || !presented || current.leaseId !== presented.leaseId
      || current.ownerId !== presented.ownerId || current.fencingToken !== presented.fencingToken
      || current.repository !== presented.repository || current.executionId !== presented.executionId) {
      throw new StaleExecutionLeaseError("execution lease owner or fencing token is stale");
    }
    return true;
  }
}
