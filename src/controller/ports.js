/**
 * Narrow boundaries the Controller depends on. The Controller contains NO product intelligence:
 * it never reads source prose, never reasons about implementations, and never calls a model. Anything
 * that may one day cost model tokens lives behind AgentExecutor only.
 */

export const CONTROLLER_OUTCOMES = Object.freeze([
  "CONTINUE", "IDLE", "WAIT_SOURCE", "WAIT_JIRA", "WAIT_CI", "WAIT_REVIEW", "RETRY_EXTERNAL",
  "BLOCK_TASK", "BLOCK_GLOBAL", "OWNER_DECISION_REQUIRED", "COMPLETED",
]);

/** Outcomes after which the process waits (deterministic timers, zero model tokens) before the next cycle. */
export const WAITING_OUTCOMES = Object.freeze(["WAIT_SOURCE", "WAIT_JIRA", "WAIT_CI", "WAIT_REVIEW", "RETRY_EXTERNAL"]);

/**
 * The only place an implementation agent (Claude/Codex/Hermes, later) is reached. It receives a frozen
 * WorkPackage - never Google or Jira content, never credentials - and returns a structured result:
 *   { head, base, branch, authorId, changedFiles[] }
 */
export class AgentExecutor {
  async execute(_workPackage) { throw new Error(`${this.constructor.name}.execute is not implemented`); }
}

/**
 * Generic agent-execution capability contract (executor-neutral; Hermes, Claude, Codex or any other executor can implement it).
 * The Controller depends ONLY on this shape, never on a particular agent. Souza Loop owns every decision around it
 * (task selection, branch/worktree identity, exact-HEAD tracking, retry and correction limits, stale-evidence invalidation,
 * validation/review gates, merge eligibility, recovery, owner escalation); an executor only changes files in the workspace it is given.
 *
 *   execute(workPackage, { workspace, facts: null })                          implement the frozen work package
 *   resume(workPackage, { workspace, facts })                                  continue interrupted, uncommitted work (optional capability)
 *   correct(workPackage, { workspace, findings, round, facts })                address review findings with a NEW commit on the SAME branch (optional)
 *
 * Every capability returns an AgentResult (see validateAgentResult). workspace = { path, branch, baseSha }. The result is never
 * trusted: the Loop re-reads HEAD, trailers and cleanliness from Git. Recovery never relies on an agent's conversational memory:
 * the context is rebuilt from durable sources (Git, the work package, recorded findings).
 */
export function agentCapabilities(agent) {
  return Object.freeze({ execute: typeof agent?.execute === "function", resume: typeof agent?.resume === "function", correct: typeof agent?.correct === "function" });
}

export function validateAgentResult(value) {
  const bad = (message) => Object.assign(new Error(`invalid agent result: ${message}`), { code: "AGENT_RESULT_INVALID", classification: "EXTERNAL_BLOCK", retryable: false });
  if (!value || typeof value !== "object") throw bad("not an object");
  for (const field of ["head", "base"]) if (typeof value[field] !== "string" || !/^[0-9a-f]{40}$/.test(value[field])) throw bad(`${field} must be a 40-hex commit id`);
  for (const field of ["branch", "authorId"]) if (typeof value[field] !== "string" || value[field].trim() === "") throw bad(`${field} is required`);
  if (!Array.isArray(value.changedFiles) || value.changedFiles.some((f) => typeof f !== "string")) throw bad("changedFiles must be a string array");
  return Object.freeze({ head: value.head, base: value.base, branch: value.branch, authorId: value.authorId, changedFiles: Object.freeze([...value.changedFiles]) });
}

/**
 * Optional owner notification boundary. The Controller works with none configured. Events are emitted only
 * for conditions that need a human (NOTIFY_KINDS); a normal successful cycle never notifies.
 */
export const NOTIFY_KINDS = Object.freeze([
  "OWNER_DECISION_REQUIRED", "AUTH_INVALID", "AUTH_FORBIDDEN", "PERSISTENT_SOURCE_FAILURE",
  "UNRECOVERABLE_CONFLICT", "RETRY_EXHAUSTED", "REVIEW_OR_VALIDATION_FAILURE", "CONTROLLER_LEASE_LOST",
]);

export class NotifierPort {
  /** event: { kind, dedupeKey, taskId, detail, at } */
  async notify(_event) { throw new Error(`${this.constructor.name}.notify is not implemented`); }
}
export class NullNotifier extends NotifierPort { async notify() { return { delivered: false }; } }
export class FakeNotifier extends NotifierPort {
  constructor() { super(); this.events = []; }
  async notify(event) { this.events.push(Object.freeze({ ...event })); return { delivered: true }; }
}
