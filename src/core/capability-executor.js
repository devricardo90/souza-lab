import { ACTION_RECONCILIATION, makeActionResult } from "./runtime-contracts.js";

export class CapabilityExecutor {
  async reconcile(_action, _context) {
    throw new Error(`${this.constructor.name}.reconcile is not implemented`);
  }

  async execute(_action, _context) {
    throw new Error(`${this.constructor.name}.execute is not implemented`);
  }
}

export class FakeCapabilityExecutor extends CapabilityExecutor {
  constructor({ capabilities = {}, provider = "fake-capabilities" } = {}) {
    super();
    this.capabilities = Object.freeze({ ...capabilities });
    this.provider = provider;
    this.completed = new Map();
    this.pending = new Map();
    this.calls = [];
  }

  async reconcile(action, context) {
    const key = context?.idempotencyKey ?? action.actionId;
    const result = this.completed.get(key);
    if (result) return Object.freeze({ status: "COMPLETED", result: this.rebind(result, action) });
    if (this.pending.has(key)) return Object.freeze({ status: "IN_PROGRESS" });
    const capability = this.capabilities[action.actionType];
    if (typeof capability?.reconcile === "function") {
      const value = await capability.reconcile(action, context);
      if (!ACTION_RECONCILIATION.includes(value?.status)) throw new TypeError("capability returned invalid reconciliation status");
      return value;
    }
    return Object.freeze({ status: "NOT_STARTED" });
  }

  async execute(action, context) {
    const key = context?.idempotencyKey ?? action.actionId;
    const prior = this.completed.get(key);
    if (prior) return this.rebind(prior, action);
    const pending = this.pending.get(key);
    if (pending) return this.rebind(await pending, action);
    const capability = this.capabilities[action.actionType];
    if (typeof capability !== "function") throw Object.assign(new Error(`capability ${action.actionType} is unavailable`), { classification: "EXTERNAL_BLOCK" });
    this.calls.push(action.actionType);
    const startedAt = new Date().toISOString();
    const operation = (async () => {
      const output = await capability(action, context);
      return makeActionResult({
        actionId: action.actionId,
        executionId: action.executionId,
        cycleId: action.cycleId,
        taskId: action.taskId,
        candidateRevision: action.candidateRevision,
        result: "SUCCEEDED",
        startedAt,
        finishedAt: new Date().toISOString(),
        provider: this.provider,
        outputReference: output?.outputReference ?? action.actionId,
        value: output?.value ?? output ?? null,
        retryable: false,
      });
    })();
    this.pending.set(key, operation);
    try {
      const result = await operation;
      this.completed.set(key, result);
      return this.rebind(result, action);
    } finally {
      this.pending.delete(key);
    }
  }

  rebind(result, action) {
    return makeActionResult({
      ...result,
      actionId: action.actionId,
      executionId: action.executionId,
      cycleId: action.cycleId,
      taskId: action.taskId,
      candidateRevision: action.candidateRevision,
    });
  }
}

async function callWithTimeout(invoke, context, timeoutMs, operation) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new TypeError("capability timeout must be positive");
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      invoke({ ...context, signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(Object.assign(new Error(`capability ${operation} timed out after ${timeoutMs}ms`), { classification: "TRANSIENT", retryable: true, code: "CAPABILITY_TIMEOUT" }));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function executeWithTimeout(executor, action, context, timeoutMs) {
  return callWithTimeout((signalContext) => executor.execute(action, signalContext), context, timeoutMs, "execution");
}

export async function reconcileWithTimeout(executor, action, context, timeoutMs) {
  return callWithTimeout((signalContext) => executor.reconcile(action, signalContext), context, timeoutMs, "reconciliation");
}
