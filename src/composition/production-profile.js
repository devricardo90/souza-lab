import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JiraSyncClient } from "../adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../adapters/jira-outbox-executor.js";
import { LocalExecutionLeaseProvider } from "../adapters/local-execution-lease-provider.js";
import { SqliteControllerStore } from "../adapters/sqlite-controller-store.js";
import { SqliteOutboxStore } from "../adapters/sqlite-outbox-store.js";
import { SqlitePlanSnapshotStore } from "../adapters/sqlite-plan-snapshot-store.js";
import { SqliteGateFactStore } from "../adapters/sqlite-gate-fact-store.js";
import { SqliteExecutionAttemptStore } from "../adapters/sqlite-execution-attempt-store.js";
import { HermesAgentExecutor } from "../adapters/hermes-agent-executor.js";
import { WorkspaceCommandValidator } from "../adapters/workspace-command-validator.js";
import { CommandIndependentReviewer } from "../adapters/command-independent-reviewer.js";
import { InjectedGooglePlanGateway } from "../plan/google-plan-gateway.js";
import { PlanSourceSynchronizer } from "../plan/plan-source-sync.js";
import { parseRelationshipConfig } from "../reconcile/jira-relationship.js";
import { LoopController } from "../controller/loop-controller.js";
import { ExecutionRunner } from "../controller/execution-runner.js";
import { createWorkPackageRuntime } from "../controller/runtime-assembly.js";
import { composeGitHubLifecycle } from "../controller/production-composition.js";
import { NullNotifier } from "../controller/ports.js";

/**
 * CP-09 production composition: the existing deterministic LoopController wired to REAL boundaries only.
 *
 *   Jira (JiraSyncClient + outbox) -> LoopController -> HermesAgentExecutor (via the crash-safe ExecutionRunner)
 *   -> real Git workspaces + GitHub SCM/CI (composeGitHubLifecycle) -> command validator + command reviewer -> recovery
 *
 * This module (like src/controller/production-composition.js) never imports src/testing/. It is explicit and fail-closed:
 *   - every identity (Jira project/board/link semantics, repository, Hermes command/board/assignee, validation and review
 *     commands) must be supplied by configuration; nothing is defaulted to a project, path or fixture;
 *   - credentials come from the environment only; a config that carries a credential-looking key is rejected;
 *   - unknown keys are rejected, so no synthetic-only option can silently leak into production;
 *   - Google is not used: the plan is read from a local file (planSource.file).
 * Validation runs before anything is created, so a rejected config touches no state.
 */

export class ProductionProfileError extends Error {
  constructor(message) { super(message); this.name = "ProductionProfileError"; this.code = "CONFIG_INVALID"; }
}

const SECRET_KEY = /token|secret|password|passwd|api[-_]?key|credential|authorization/i;
const SCHEMA = {
  top: { required: ["profile", "workspaceDir", "workspaceId", "documentId", "planSource", "jira", "repository", "git", "github", "agent", "validation", "review"], optional: ["timings", "ownerId", "exitOnCompleted", "heartbeatWorker", "outboxClaimTtlMs"] },
  planSource: { required: ["file"], optional: [] },
  jira: { required: ["mode", "projectKey", "issueTypeName", "taskIdPattern", "observation", "relationship", "completion"], optional: ["site", "gatewayHost", "scheme", "timeoutMs"] },
  completion: { required: ["doneStatusName", "transitionName"], optional: ["expectedCurrentStatusNames"] },
  repository: { required: ["identity", "baseRef"], optional: [] },
  git: { required: ["repoPath"], optional: [] },
  github: { required: ["owner", "repo", "baseBranch", "workflowIdentity"], optional: ["maxCorrections", "timeoutMs"] },
  agent: { required: ["kind", "command", "board", "coderAssignee"], optional: ["pollMs", "maxPolls"] },
  validation: { required: ["command"], optional: ["args", "timeoutMs"] },
  review: { required: ["command"], optional: ["args", "timeoutMs"] },
};
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const bad = (message) => { throw new ProductionProfileError(message); };

function checkObject(value, path, schema) {
  const label = path === "" ? "production config" : `production config.${path}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (SECRET_KEY.test(key)) bad(`${label}.${key} looks like a credential; credentials come from the environment only`);
    if (!schema.required.includes(key) && !schema.optional.includes(key)) bad(`${label}.${key} is not a recognised production option`);
  }
  for (const key of schema.required) if (value[key] === undefined || value[key] === null || value[key] === "") bad(`${label}.${key} is required`);
}

/** Pure validation. Throws ProductionProfileError (code CONFIG_INVALID); returns a normalised, frozen config. */
export function validateProductionConfig(config, env = process.env) {
  if (!config || typeof config !== "object" || Array.isArray(config)) bad("production config must be an object");
  if (config.profile !== "production") bad('production config.profile must be exactly "production"');
  checkObject(config, "", SCHEMA.top);
  for (const key of ["workspaceDir", "workspaceId", "documentId"]) if (!nonEmpty(config[key])) bad(`production config.${key} must be a non-empty string`);
  checkObject(config.planSource, "planSource", SCHEMA.planSource);
  checkObject(config.jira, "jira", SCHEMA.jira);
  checkObject(config.jira.completion, "jira.completion", SCHEMA.completion);
  checkObject(config.repository, "repository", SCHEMA.repository);
  checkObject(config.git, "git", SCHEMA.git);
  checkObject(config.github, "github", SCHEMA.github);
  checkObject(config.agent, "agent", SCHEMA.agent);
  checkObject(config.validation, "validation", SCHEMA.validation);
  checkObject(config.review, "review", SCHEMA.review);

  for (const [path, value] of [["planSource.file", config.planSource.file], ["jira.projectKey", config.jira.projectKey], ["jira.issueTypeName", config.jira.issueTypeName], ["jira.taskIdPattern", config.jira.taskIdPattern],
    ["jira.completion.doneStatusName", config.jira.completion.doneStatusName], ["jira.completion.transitionName", config.jira.completion.transitionName],
    ["repository.identity", config.repository.identity], ["repository.baseRef", config.repository.baseRef], ["git.repoPath", config.git.repoPath],
    ["github.owner", config.github.owner], ["github.repo", config.github.repo], ["github.baseBranch", config.github.baseBranch], ["github.workflowIdentity", config.github.workflowIdentity],
    ["agent.command", config.agent.command], ["agent.board", config.agent.board], ["agent.coderAssignee", config.agent.coderAssignee],
    ["validation.command", config.validation.command], ["review.command", config.review.command]]) if (!nonEmpty(value)) bad(`production config.${path} must be a non-empty string`);
  if (!/^[A-Za-z0-9-]+$/.test(config.github.owner)) bad("production config.github.owner is not a valid GitHub owner");
  if (!/^[A-Za-z0-9._-]+$/.test(config.github.repo)) bad("production config.github.repo is not a valid GitHub repository name");
  if (!config.github.workflowIdentity.startsWith(".github/workflows/")) bad("production config.github.workflowIdentity must be a .github/workflows/ path");
  for (const key of ["timeoutMs", "maxCorrections"]) if (config.github[key] !== undefined && !(Number.isSafeInteger(config.github[key]) && config.github[key] > 0)) bad(`production config.github.${key} must be a positive integer`);
  if (config.agent.kind !== "hermes") bad('production config.agent.kind must be "hermes"');
  try { new RegExp(config.jira.taskIdPattern); } catch { bad("production config.jira.taskIdPattern is not a valid regular expression"); }
  if (!["classic", "scoped"].includes(config.jira.mode)) bad('production config.jira.mode must be "classic" or "scoped"');
  if (config.jira.mode === "classic" && !nonEmpty(config.jira.site)) bad("production config.jira.site is required for classic mode");
  if (config.jira.mode === "scoped" && !nonEmpty(env.LOOP_JIRA_CLOUD_ID)) bad("LOOP_JIRA_CLOUD_ID must be set in the environment for scoped Jira mode");
  const obs = config.jira.observation;
  if (!obs || !["search", "board"].includes(obs.source) || (obs.source === "board" && !Number.isSafeInteger(obs.boardId))) bad('production config.jira.observation must be { source: "search" } or { source: "board", boardId: <integer> }');
  try { parseRelationshipConfig(config.jira.relationship); } catch (error) { bad(`production config.jira.relationship is invalid: ${error.message}`); }
  for (const key of ["validation", "review"]) {
    const section = config[key];
    if (section.args !== undefined && (!Array.isArray(section.args) || section.args.some((a) => typeof a !== "string"))) bad(`production config.${key}.args must be an array of strings`);
    if (section.timeoutMs !== undefined && !(Number.isSafeInteger(section.timeoutMs) && section.timeoutMs > 0)) bad(`production config.${key}.timeoutMs must be a positive integer`);
  }
  for (const key of ["pollMs", "maxPolls"]) if (config.agent[key] !== undefined && !(Number.isSafeInteger(config.agent[key]) && config.agent[key] > 0)) bad(`production config.agent.${key} must be a positive integer`);
  // Environment contract: only variable NAMES are ever reported, never values.
  for (const name of ["LOOP_JIRA_EMAIL", "LOOP_JIRA_API_TOKEN"]) if (!nonEmpty(env[name])) bad(`${name} must be set in the environment`);
  return Object.freeze(structuredClone(config));
}

/** Environment handed to commands that run agent-authored code or reviewers: no credential-looking variable is passed on. */
export function sanitizedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_KEY.test(name) && !/^LOOP_JIRA_/.test(name)));
}

/**
 * overrides (tests only; each replaces a LOW-LEVEL transport or the clock, never a role): clock, jiraTransport, ghRun, hermesRun.
 * There is no override for the agent, reviewer or validator objects themselves: they are always the real classes.
 */
export function buildProductionController(rawConfig, env = process.env, overrides = {}) {
  const config = validateProductionConfig(rawConfig, env);
  const dir = config.workspaceDir;
  const clock = overrides.clock ?? (() => new Date().toISOString());
  const timings = { instanceLeaseTtlMs: 30000, defaultWaitMs: 1000, ...(config.timings ?? {}) };
  const ownerId = config.ownerId ?? `controller-${process.pid}`;
  const childEnv = sanitizedEnv(env);

  const planFile = config.planSource.file;
  const gateway = new InjectedGooglePlanGateway({ clock, transport: ({ documentId }) => ({ documentId, googleRevisionId: null, content: readFileSync(planFile, "utf8") }) });
  const planStore = new SqlitePlanSnapshotStore({ path: join(dir, "plans.sqlite"), clock });
  const outboxStore = new SqliteOutboxStore({ path: join(dir, "outbox.sqlite"), clock });
  const controllerStore = new SqliteControllerStore({ path: join(dir, "controller.sqlite"), clock });
  const attemptStore = new SqliteExecutionAttemptStore({ path: join(dir, "execution-attempts.sqlite"), clock });
  const gateStore = new SqliteGateFactStore({ path: join(dir, "gate-facts.sqlite"), clock });
  const close = () => { for (const store of [planStore, outboxStore, controllerStore, attemptStore, gateStore]) { try { store?.close(); } catch {} } };
  try {
    const planSynchronizer = new PlanSourceSynchronizer({ gateway, store: planStore, clock });
    const leaseProvider = new LocalExecutionLeaseProvider({ directory: join(dir, "leases"), clock, defaultTtlMs: timings.instanceLeaseTtlMs });
    const relationship = parseRelationshipConfig(config.jira.relationship);
    const jira = new JiraSyncClient({
      mode: config.jira.mode, observation: config.jira.observation, cloudId: config.jira.mode === "scoped" ? env.LOOP_JIRA_CLOUD_ID : null,
      site: config.jira.site, gatewayHost: config.jira.gatewayHost, scheme: config.jira.scheme ?? "https", email: env.LOOP_JIRA_EMAIL, apiToken: env.LOOP_JIRA_API_TOKEN,
      timeoutMs: config.jira.timeoutMs ?? 15000, writeGuard: { projectKey: config.jira.projectKey, taskIdPattern: new RegExp(config.jira.taskIdPattern) },
      ...(overrides.jiraTransport ? { transport: overrides.jiraTransport } : {}),
    });
    const outboxExecutor = new JiraOutboxExecutor({ store: outboxStore, jira, workerId: ownerId, claimTtlMs: config.outboxClaimTtlMs ?? 60000, clock, relationship });

    const agent = new HermesAgentExecutor({ command: config.agent.command, board: config.agent.board, coderAssignee: config.agent.coderAssignee, pollMs: config.agent.pollMs, maxPolls: config.agent.maxPolls, run: overrides.hermesRun ?? null });
    const validator = new WorkspaceCommandValidator({ command: config.validation.command, args: config.validation.args ?? [], timeoutMs: config.validation.timeoutMs, env: childEnv });
    const reviewer = new CommandIndependentReviewer({ command: config.review.command, args: config.review.args ?? [], timeoutMs: config.review.timeoutMs, env: childEnv });
    const executionRunner = new ExecutionRunner({ attemptStore, agent, repoPath: config.git.repoPath, workspacesDir: join(dir, "workspaces") });
    const lifecycle = composeGitHubLifecycle({ github: config.github, repoPath: config.git.repoPath, attemptStore, gateStore, reviewer, validator, agent, clock, run: overrides.ghRun ?? null });

    const controller = new LoopController({
      workspaceId: config.workspaceId, ownerId, leaseProvider, instanceLeaseTtlMs: timings.instanceLeaseTtlMs,
      documentId: config.documentId, planSynchronizer, planStore, jira, outboxStore, outboxExecutor, controllerStore,
      materialization: { projectKey: config.jira.projectKey, issueTypeName: config.jira.issueTypeName },
      completion: { expectedCurrentStatusNames: null, ...config.jira.completion },
      repository: config.repository, notifier: new NullNotifier(), clock, defaultWaitMs: timings.defaultWaitMs, relationship,
      heartbeatWorker: config.heartbeatWorker ?? !overrides.clock,
      runtimeFactory: (workPackage) => createWorkPackageRuntime({
        workPackage, directory: join(dir, "executions"), scope: lifecycle.scope(workPackage), leaseProvider, ownerId: config.workspaceId, agentExecutor: agent, executionRunner, clock,
      }),
    });
    return { controller, close, agent, reviewer, validator, jira, lifecycle, executionRunner, leaseProvider, outboxExecutor, stores: { planStore, outboxStore, controllerStore, attemptStore, gateStore } };
  } catch (error) { close(); throw error; }
}
