import { makeWakeupRequest, ERROR_CLASSIFICATIONS } from "./runtime-contracts.js";

export class RuntimeRetryPolicy {
  constructor({ maxAttempts = 5, baseDelayMs = 1000, maxDelayMs = 60000 } = {}) {
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || !Number.isFinite(baseDelayMs) || baseDelayMs < 0) throw new TypeError("invalid retry policy configuration");
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
    this.maxDelayMs = maxDelayMs;
  }

  classify(error) {
    if (ERROR_CLASSIFICATIONS.includes(error?.classification)) return error.classification;
    if (error?.retryable === true) return "TRANSIENT";
    return "PERMANENT";
  }

  decide(error, action, { now = new Date().toISOString() } = {}) {
    const classification = this.classify(error);
    const attempt = action.attempt;
    if (classification === "TRANSIENT" && attempt < this.maxAttempts) {
      const delay = Math.min(this.maxDelayMs, this.baseDelayMs * (2 ** Math.max(0, attempt - 1)));
      const earliestRetryAt = new Date(Date.parse(now) + delay).toISOString();
      return Object.freeze({
        outcome: "WAIT_RETRYABLE",
        classification,
        attempt,
        maxAttempts: this.maxAttempts,
        nextEligibleAt: earliestRetryAt,
        lastFailure: String(error?.message ?? "transient capability failure"),
        wakeup: makeWakeupRequest({
          executionId: action.executionId,
          reason: `retry ${action.actionType} after transient failure`,
          earliestRetryAt,
          taskId: action.taskId,
          state: "WAIT_RETRYABLE",
        }),
      });
    }
    if (classification === "OWNER_REQUIRED") return Object.freeze({ outcome: "BLOCKED_OWNER", classification, attempt, lastFailure: String(error?.message ?? "owner decision required") });
    if (classification === "INVARIANT_VIOLATION") return Object.freeze({ outcome: "BLOCKED_EXTERNAL", classification, attempt, lastFailure: String(error?.message ?? "runtime invariant violated") });
    return Object.freeze({ outcome: "BLOCKED_EXTERNAL", classification: classification === "TRANSIENT" ? "EXTERNAL_BLOCK" : classification, attempt, maxAttempts: this.maxAttempts, lastFailure: String(error?.message ?? "external action failed") });
  }
}
