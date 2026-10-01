import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JiraSyncClient } from "../adapters/jira-sync-client.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../reconcile/jira-relationship.js";
import { JiraOutboxExecutor } from "../adapters/jira-outbox-executor.js";
import { LocalExecutionLeaseProvider } from "../adapters/local-execution-lease-provider.js";
import { SqliteControllerStore } from "../adapters/sqlite-controller-store.js";
import { SqliteOutboxStore } from "../adapters/sqlite-outbox-store.js";
import { SqlitePlanSnapshotStore } from "../adapters/sqlite-plan-snapshot-store.js";
import { LoopController } from "../controller/loop-controller.js";
import { createWorkPackageRuntime } from "../controller/runtime-assembly.js";
import { FakeNotifier } from "../controller/ports.js";
import { InjectedGooglePlanGateway } from "../plan/google-plan-gateway.js";
import { PlanSourceSynchronizer } from "../plan/plan-source-sync.js";
import { SyntheticAgentExecutor, SyntheticLifecycle } from "./synthetic-lifecycle.js";
import { SyntheticGitAgent } from "./synthetic-git-agent.js";
import { SqliteExecutionAttemptStore } from "../adapters/sqlite-execution-attempt-store.js";
import { ExecutionRunner } from "../controller/execution-runner.js";

/**
 * Composition of the Controller from SYNTHETIC providers (fake Google, fake agent, fake lifecycle) plus
 * REAL plan compiler / snapshot store / reconciler / outbox / Jira transport (against whatever Jira
 * endpoint is configured; a local mock in CP-05). Used by the child-process tests and as the pattern a
 * production composition will follow. Credentials come from the environment, never from argv or config.
 */

export class SyntheticProfileError extends Error {
  constructor(message) { super(message); this.name = "SyntheticProfileError"; this.code = "CONFIG_INVALID"; }
}

export function buildSyntheticController(config, env = process.env, overrides = {}) {
  for (const field of ["workspaceDir", "documentId", "planFile", "jira", "repository"]) if (!config?.[field]) throw new SyntheticProfileError(`config.${field} is required`);
  if (!env.LOOP_JIRA_EMAIL || !env.LOOP_JIRA_API_TOKEN) throw new SyntheticProfileError("LOOP_JIRA_EMAIL and LOOP_JIRA_API_TOKEN must be set in the environment");
  const dir = config.workspaceDir;
  const clock = overrides.clock ?? (() => new Date().toISOString());
  const timings = { instanceLeaseTtlMs: 30000, defaultWaitMs: 1000, ...(config.timings ?? {}) };

  const gateway = new InjectedGooglePlanGateway({
    clock,
    transport: ({ documentId }) => {
      if (config.unavailableFile && existsSync(config.unavailableFile)) throw new Error("synthetic Google outage");
      return { documentId, googleRevisionId: null, content: readFileSync(config.planFile, "utf8") };
    },
  });
  const planStore = new SqlitePlanSnapshotStore({ path: join(dir, "plans.sqlite"), clock });
  const planSynchronizer = new PlanSourceSynchronizer({ gateway, store: planStore, clock });
  const outboxStore = new SqliteOutboxStore({ path: join(dir, "outbox.sqlite"), clock });
  const controllerStore = new SqliteControllerStore({ path: join(dir, "controller.sqlite"), clock });
  const leaseProvider = new LocalExecutionLeaseProvider({ directory: join(dir, "leases"), clock, defaultTtlMs: timings.instanceLeaseTtlMs });
  const jira = new JiraSyncClient({ site: config.jira.site, scheme: config.jira.scheme ?? "https", email: env.LOOP_JIRA_EMAIL, apiToken: env.LOOP_JIRA_API_TOKEN, timeoutMs: config.jira.timeoutMs ?? 5000 });
  const ownerId = config.ownerId ?? `controller-${process.pid}`;
  const relationship = config.jira.relationship === undefined ? SYNTHETIC_BLOCKS_RELATIONSHIP : config.jira.relationship; // explicit synthetic "Blocks" mapping; a real profile must supply its own
  const outboxExecutor = new JiraOutboxExecutor({ store: outboxStore, jira, workerId: ownerId, claimTtlMs: config.outboxClaimTtlMs ?? 60000, clock, relationship });
  const lifecycle = new SyntheticLifecycle({ directory: join(dir, "lifecycle") });
  // config.git switches the agent boundary to a REAL Git workspace with durable execution attempts (CP-06).
  const attemptStore = config.git ? new SqliteExecutionAttemptStore({ path: join(dir, "execution-attempts.sqlite"), clock }) : null;
  const agent = overrides.agent ?? (config.git
    ? new SyntheticGitAgent({ recordPath: config.agentRecordPath ?? join(dir, "agent-calls.jsonl"), crashAt: config.agentCrashAt ?? null, crashMarkerDir: dir })
    : new SyntheticAgentExecutor({ recordPath: config.agentRecordPath ?? join(dir, "agent-calls.jsonl") }));
  const notifier = overrides.notifier ?? new FakeNotifier();

  const counts = new Map();
  const faultPoints = {};
  if (config.crashAt) {
    faultPoints[config.crashAt.point] = () => {
      counts.set(config.crashAt.point, (counts.get(config.crashAt.point) ?? 0) + 1);
      if (counts.get(config.crashAt.point) >= (config.crashAt.count ?? 1)) process.kill(process.pid, "SIGKILL"); // abrupt, unclean death
    };
  }
  Object.assign(faultPoints, overrides.faultPoints ?? {});
  const executionRunner = config.git ? new ExecutionRunner({ attemptStore, agent, repoPath: config.git.repoPath, workspacesDir: join(dir, "workspaces"), faultPoints: { ...faultPoints } }) : null;

  const controller = new LoopController({
    workspaceId: config.workspaceId ?? "synthetic", ownerId, leaseProvider, instanceLeaseTtlMs: timings.instanceLeaseTtlMs,
    documentId: config.documentId, planSynchronizer, planStore, jira, outboxStore, outboxExecutor, controllerStore,
    materialization: { projectKey: config.jira.projectKey, issueTypeName: config.jira.issueTypeName ?? "Task" },
    completion: { doneStatusName: "Done", transitionName: "Done", expectedCurrentStatusNames: null },
    repository: config.repository, notifier, clock, faultPoints, defaultWaitMs: timings.defaultWaitMs, relationship,
    runtimeFactory: overrides.runtimeFactory ?? ((workPackage) => createWorkPackageRuntime({
      workPackage, directory: join(dir, "executions"), scope: lifecycle.scope(workPackage), leaseProvider, ownerId: config.workspaceId ?? "synthetic", agentExecutor: agent, executionRunner, clock,
    })),
  });
  const close = () => { for (const store of [planStore, outboxStore, controllerStore, attemptStore]) { try { store?.close(); } catch {} } };
  return { controller, close, agent, notifier, stores: { planStore, outboxStore, controllerStore, attemptStore }, leaseProvider, outboxExecutor, jira };
}
