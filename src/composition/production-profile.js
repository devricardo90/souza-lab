import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
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
import { SECRET_NAME } from "../controller/log-redaction.js";

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
 *   - unknown keys are rejected at every level, so no synthetic-only option can silently leak into production;
 *   - every optional value is type- and range-checked, and a constructor rejection is reported as CONFIG_INVALID;
 *   - the plan file, the local clone and the three executables must exist at startup;
 *   - Google is not used: the plan is read from a local file (planSource.file).
 * Validation runs before anything is created, so a rejected config touches no state.
 */

export class ProductionProfileError extends Error {
  constructor(message) { super(message); this.name = "ProductionProfileError"; this.code = "CONFIG_INVALID"; }
}

const SCHEMA = {
  top: { required: ["profile", "workspaceDir", "workspaceId", "documentId", "planSource", "jira", "repository", "git", "github", "agent", "validation", "review"], optional: ["timings", "ownerId", "exitOnCompleted", "heartbeatWorker", "outboxClaimTtlMs", "passEnv"] },
  planSource: { required: ["file"], optional: [] },
  jira: { required: ["mode", "projectKey", "issueTypeName", "taskIdPattern", "observation", "relationship", "completion"], optional: ["site", "gatewayHost", "scheme", "timeoutMs"] },
  observation: { required: ["source"], optional: ["boardId"] },
  relationship: { required: ["linkTypeName", "inwardLabel", "outwardLabel", "dependentEnd"], optional: ["linkTypeId"] },
  completion: { required: ["doneStatusName", "transitionName"], optional: ["expectedCurrentStatusNames"] },
  repository: { required: ["identity", "baseRef"], optional: [] },
  git: { required: ["repoPath"], optional: [] },
  github: { required: ["owner", "repo", "baseBranch", "workflowIdentity"], optional: ["timeoutMs"] },
  agent: { required: ["kind", "command", "board", "coderAssignee"], optional: ["pollMs", "maxPolls"] },
  validation: { required: ["command"], optional: ["args", "timeoutMs"] },
  review: { required: ["command"], optional: ["args", "timeoutMs"] },
  timings: { required: [], optional: ["instanceLeaseTtlMs", "defaultWaitMs", "idlePollMs", "standbyPollMs", "blockedPollMs"] },
};
const nonEmpty = (v) => typeof v === "string" && v.trim() !== "";
const posInt = (v) => Number.isSafeInteger(v) && v > 0;
const bad = (message) => { throw new ProductionProfileError(message); };
const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[::1\]|::1)(:\d+)?$/i;

function checkObject(value, path, schema) {
  const label = path === "" ? "production config" : `production config.${path}`;
  if (!value || typeof value !== "object" || Array.isArray(value)) bad(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (SECRET_NAME.test(key)) bad(`${label}.${key} looks like a credential; credentials come from the environment only`);
    if (!schema.required.includes(key) && !schema.optional.includes(key)) bad(`${label}.${key} is not a recognised production option`);
  }
  for (const key of schema.required) if (value[key] === undefined || value[key] === null || value[key] === "") bad(`${label}.${key} is required`);
}
const optional = (obj, key, path, check, what) => { if (obj[key] !== undefined && !check(obj[key])) bad(`production config.${path}${key} must be ${what}`); };

/** Pure validation. Throws ProductionProfileError (code CONFIG_INVALID); returns a normalised, frozen config. */
export function validateProductionConfig(config, env = process.env) {
  if (!config || typeof config !== "object" || Array.isArray(config)) bad("production config must be an object");
  if (config.profile !== "production") bad('production config.profile must be exactly "production"');
  checkObject(config, "", SCHEMA.top);
  for (const key of ["workspaceDir", "workspaceId", "documentId"]) if (!nonEmpty(config[key])) bad(`production config.${key} must be a non-empty string`);
  checkObject(config.planSource, "planSource", SCHEMA.planSource);
  checkObject(config.jira, "jira", SCHEMA.jira);
  checkObject(config.jira.observation, "jira.observation", SCHEMA.observation);
  checkObject(config.jira.relationship, "jira.relationship", SCHEMA.relationship);
  checkObject(config.jira.completion, "jira.completion", SCHEMA.completion);
  checkObject(config.repository, "repository", SCHEMA.repository);
  checkObject(config.git, "git", SCHEMA.git);
  checkObject(config.github, "github", SCHEMA.github);
  checkObject(config.agent, "agent", SCHEMA.agent);
  checkObject(config.validation, "validation", SCHEMA.validation);
  checkObject(config.review, "review", SCHEMA.review);
  if (config.timings !== undefined) checkObject(config.timings, "timings", SCHEMA.timings);

  for (const [path, value] of [["planSource.file", config.planSource.file], ["jira.projectKey", config.jira.projectKey], ["jira.issueTypeName", config.jira.issueTypeName], ["jira.taskIdPattern", config.jira.taskIdPattern],
    ["jira.completion.doneStatusName", config.jira.completion.doneStatusName], ["jira.completion.transitionName", config.jira.completion.transitionName],
    ["repository.identity", config.repository.identity], ["repository.baseRef", config.repository.baseRef], ["git.repoPath", config.git.repoPath],
    ["github.owner", config.github.owner], ["github.repo", config.github.repo], ["github.baseBranch", config.github.baseBranch], ["github.workflowIdentity", config.github.workflowIdentity],
    ["agent.command", config.agent.command], ["agent.board", config.agent.board], ["agent.coderAssignee", config.agent.coderAssignee],
    ["validation.command", config.validation.command], ["review.command", config.review.command]]) if (!nonEmpty(value)) bad(`production config.${path} must be a non-empty string`);

  // top-level optionals
  optional(config, "ownerId", "", nonEmpty, "a non-empty string");
  optional(config, "exitOnCompleted", "", (v) => typeof v === "boolean", "a boolean");
  optional(config, "heartbeatWorker", "", (v) => typeof v === "boolean", "a boolean");
  optional(config, "outboxClaimTtlMs", "", posInt, "a positive integer");
  optional(config, "passEnv", "", (v) => Array.isArray(v) && v.every((n) => typeof n === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(n) && !/^LOOP_JIRA_/.test(n)), "an array of environment variable names (never LOOP_JIRA_*)");
  for (const key of SCHEMA.timings.optional) optional(config.timings ?? {}, key, "timings.", (v) => Number.isSafeInteger(v) && v >= (key === "instanceLeaseTtlMs" ? 100 : 1), key === "instanceLeaseTtlMs" ? "an integer of at least 100" : "a positive integer");

  // GitHub identity (the providers also reject these, but as TypeErrors)
  if (!/^[A-Za-z0-9-]+$/.test(config.github.owner)) bad("production config.github.owner is not a valid GitHub owner");
  if (!/^[A-Za-z0-9._-]+$/.test(config.github.repo)) bad("production config.github.repo is not a valid GitHub repository name");
  if (!config.github.workflowIdentity.startsWith(".github/workflows/")) bad("production config.github.workflowIdentity must be a .github/workflows/ path");
  optional(config.github, "timeoutMs", "github.", posInt, "a positive integer");

  // agent / validation / review
  if (config.agent.kind !== "hermes") bad('production config.agent.kind must be "hermes"');
  for (const key of ["pollMs", "maxPolls"]) optional(config.agent, key, "agent.", posInt, "a positive integer");
  for (const key of ["validation", "review"]) {
    const section = config[key];
    optional(section, "args", `${key}.`, (v) => Array.isArray(v) && v.every((a) => typeof a === "string"), "an array of strings");
    optional(section, "timeoutMs", `${key}.`, posInt, "a positive integer");
  }
  if (config.review.command === config.agent.command) bad("production config.review.command must not be the same executable as agent.command: the reviewer must be independent of the implementer");

  // Jira
  const { jira } = config;
  try { new RegExp(jira.taskIdPattern); } catch { bad("production config.jira.taskIdPattern is not a valid regular expression"); }
  if (!["classic", "scoped"].includes(jira.mode)) bad('production config.jira.mode must be "classic" or "scoped"');
  if (jira.mode === "classic" && !nonEmpty(jira.site)) bad("production config.jira.site is required for classic mode");
  if (jira.mode === "scoped" && !nonEmpty(env.LOOP_JIRA_CLOUD_ID)) bad("LOOP_JIRA_CLOUD_ID must be set in the environment for scoped Jira mode");
  optional(jira, "site", "jira.", nonEmpty, "a non-empty string");
  optional(jira, "gatewayHost", "jira.", nonEmpty, "a non-empty string");
  optional(jira, "timeoutMs", "jira.", posInt, "a positive integer");
  optional(jira, "scheme", "jira.", (v) => v === "https" || v === "http", '"https" or "http"');
  if (jira.scheme === "http") {
    // credentials must never cross a network in cleartext: plain http is accepted only for a loopback endpoint (a local mock/proxy)
    const hosts = jira.mode === "classic" ? [jira.site] : [jira.gatewayHost ?? ""];
    if (!hosts.every((h) => nonEmpty(h) && LOOPBACK.test(h))) bad('production config.jira.scheme "http" is allowed only for a loopback host; use "https"');
  }
  const obs = jira.observation;
  if (!["search", "board"].includes(obs.source) || (obs.source === "board" && !Number.isSafeInteger(obs.boardId)) || (obs.source === "search" && obs.boardId !== undefined)) bad('production config.jira.observation must be { source: "search" } or { source: "board", boardId: <integer> }');
  try { parseRelationshipConfig(jira.relationship); } catch (error) { bad(`production config.jira.relationship is invalid: ${error.message}`); }
  optional(jira.completion, "expectedCurrentStatusNames", "jira.completion.", (v) => v === null || (Array.isArray(v) && v.every(nonEmpty)), "null or an array of non-empty strings");

  // Environment contract: only variable NAMES are ever reported, never values.
  for (const name of ["LOOP_JIRA_EMAIL", "LOOP_JIRA_API_TOKEN"]) if (!nonEmpty(env[name])) bad(`${name} must be set in the environment`);
  return Object.freeze(structuredClone(config));
}

/** True when `command` names an existing file (absolute or relative path) or is found on PATH (honouring PATHEXT on Windows). */
export function executableExists(command, env = process.env) {
  const isFile = (path) => { try { return statSync(path).isFile(); } catch { return false; } };
  if (isAbsolute(command) || /[\\/]/.test(command)) return isFile(command);
  const exts = process.platform === "win32" ? ["", ...String(env.PATHEXT ?? env.Pathext ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
  for (const dir of String(env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) for (const ext of exts) if (isFile(join(dir, command + ext))) return true;
  return false;
}

/** Startup facts the configuration depends on. Fail closed here rather than at the first cycle. */
function assertEnvironmentReady(config, env) {
  try { if (!statSync(config.planSource.file).isFile()) bad("production config.planSource.file is not a file"); } catch (error) { if (error instanceof ProductionProfileError) throw error; bad("production config.planSource.file does not exist"); }
  try { if (!statSync(config.git.repoPath).isDirectory()) bad("production config.git.repoPath is not a directory"); } catch (error) { if (error instanceof ProductionProfileError) throw error; bad("production config.git.repoPath does not exist"); }
  for (const [path, command] of [["agent.command", config.agent.command], ["validation.command", config.validation.command], ["review.command", config.review.command]]) {
    if (!executableExists(command, env)) bad(`production config.${path} is not an existing executable`);
  }
}

/** Variables a child process (agent-authored validation, the reviewer) may inherit: an ALLOWLIST plus the owner's explicit passEnv. */
const BASE_ENV_NAMES = ["PATH", "PATHEXT", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ", "TERM", "USER", "USERNAME"];
export function childEnvironment(env = process.env, passEnv = []) {
  const allowed = new Set([...BASE_ENV_NAMES, ...passEnv].map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(env).filter(([name, value]) => typeof value === "string" && allowed.has(name.toUpperCase()) && !/^LOOP_JIRA_/.test(name)));
}

/**
 * overrides (tests only; each replaces a LOW-LEVEL transport or the clock, never a role): clock, jiraTransport, ghRun, hermesRun.
 * There is no override for the agent, reviewer or validator objects themselves: they are always the real classes.
 */
export function buildProductionController(rawConfig, env = process.env, overrides = {}) {
  const config = validateProductionConfig(rawConfig, env);
  assertEnvironmentReady(config, env);
  const dir = config.workspaceDir;
  const clock = overrides.clock ?? (() => new Date().toISOString());
  const timings = { instanceLeaseTtlMs: 30000, defaultWaitMs: 1000, ...(config.timings ?? {}) };
  const ownerId = config.ownerId ?? `controller-${process.pid}`;
  const childEnv = childEnvironment(env, config.passEnv ?? []);

  const opened = [];
  const open = (store) => { opened.push(store); return store; };
  const close = () => { for (const store of opened.splice(0)) { try { store.close(); } catch { /* best effort */ } } };
  try {
    const planFile = config.planSource.file;
    const gateway = new InjectedGooglePlanGateway({ clock, transport: ({ documentId }) => ({ documentId, googleRevisionId: null, content: readFileSync(planFile, "utf8") }) });
    const planStore = open(new SqlitePlanSnapshotStore({ path: join(dir, "plans.sqlite"), clock }));
    const outboxStore = open(new SqliteOutboxStore({ path: join(dir, "outbox.sqlite"), clock }));
    const controllerStore = open(new SqliteControllerStore({ path: join(dir, "controller.sqlite"), clock }));
    const attemptStore = open(new SqliteExecutionAttemptStore({ path: join(dir, "execution-attempts.sqlite"), clock }));
    const gateStore = open(new SqliteGateFactStore({ path: join(dir, "gate-facts.sqlite"), clock }));
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
    const lifecycle = composeGitHubLifecycle({ github: { ...config.github }, repoPath: config.git.repoPath, attemptStore, gateStore, reviewer, validator, agent, clock, run: overrides.ghRun ?? null });

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
  } catch (error) {
    close();
    // a constructor rejecting a value (for example a lease TTL or worker id) is a configuration problem, not an internal error
    if (error instanceof TypeError) throw new ProductionProfileError(`production configuration rejected by a component: ${error.message}`);
    throw error;
  }
}
