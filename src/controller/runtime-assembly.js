import { join } from "node:path";
import { LoopRuntime } from "../core/loop-runtime.js";
import { RecoveryCoordinator } from "../core/recovery-coordinator.js";
import { RuntimeObserver } from "../core/runtime-observer.js";
import { FakeCapabilityExecutor } from "../core/capability-executor.js";
import { JsonlEvidenceStore } from "../adapters/jsonl-evidence-store.js";
import { LocalEvidenceCheckpointProvider } from "../adapters/local-evidence-checkpoint-provider.js";
import { JsonRuntimeCheckpointStore } from "../adapters/json-runtime-checkpoint-store.js";
import { MarkdownProjectionStore } from "../adapters/markdown-projection-store.js";
import { WorkPackageTaskSystem } from "./work-package.js";
import { validateAgentResult } from "./ports.js";
import { makeActionResult } from "../core/runtime-contracts.js";

/**
 * Wires the EXISTING, unchanged LoopRuntime for one frozen WorkPackage. The Controller does not
 * re-implement any runtime logic: it only provides
 *   - a task source exposing exactly the WorkPackage's one task,
 *   - lifecycle providers (git/CI/review/validation/merge facts) from a LifecycleScope port,
 *   - a capability set where ONLY PREPARE_IMPLEMENTATION reaches the AgentExecutor.
 *
 * LifecycleScope port (per work package; real GitHub/CI backends later, synthetic in CP-05):
 *   gitProvider.getRevision(), scmProvider.getMergeFact(task, head), ciProvider.getCIResult(head),
 *   reviewProvider.getReviewResult(head), validationProvider.getValidationResult(task, head),
 *   isCompleted(), baseHead, specDigest, implementationResult(),
 *   actions: { recordImplementation(result), runTests(), runValidation(isPostMerge), requestReview(), prepareMerge() }
 *
 * Per-execution durable state lives in <directory>/<executionId>/ so a restarted process resumes the
 * same execution from its evidence log and runtime checkpoint.
 */

export function createWorkPackageRuntime({ workPackage, directory, scope, leaseProvider, ownerId, agentExecutor, executionRunner = null, clock = () => new Date().toISOString(), runtimeOptions = {} }) {
  const root = join(directory, workPackage.executionId);
  const evidenceStore = new JsonlEvidenceStore({ path: join(root, "evidence.jsonl") });
  const evidenceCheckpointProvider = new LocalEvidenceCheckpointProvider({ path: join(root, "evidence-root.json") });
  const projectionStore = new MarkdownProjectionStore({ directory: join(root, "projections") });
  const checkpointStore = new JsonRuntimeCheckpointStore({ path: join(root, "runtime-checkpoint.json") });
  const taskSystem = new WorkPackageTaskSystem({ workPackage, isCompleted: () => scope.isCompleted() });
  const recoveryCoordinator = new RecoveryCoordinator({
    taskSystem, gitProvider: scope.gitProvider, scmProvider: scope.scmProvider, ciProvider: scope.ciProvider,
    reviewProvider: scope.reviewProvider, validationProvider: scope.validationProvider,
  });
  const observer = new RuntimeObserver({
    recoveryCoordinator, evidenceStore, evidenceCheckpointProvider, projectionStore,
    contextProvider: () => ({ specRevision: { head: scope.baseHead }, specDigest: scope.specDigest }),
  });
  const done = (reference) => ({ outputReference: reference });
  const actions = scope.actions;
  const capabilities = {
    WRITE_PROJECTIONS: (_action, ctx) => projectionStore.write({ executionId: ctx.executionId, computed: ctx.observation.computed }),
    REQUEST_SPEC_REVIEW: async (_action, ctx) => done(actions.requestSpecReview ? await actions.requestSpecReview(ctx) : "spec-review-satisfied-by-base"),
    PREPARE_IMPLEMENTATION: async (_action, ctx) => {
      // Idempotent: an implementation already recorded for this work package is never produced twice.
      let result = scope.implementationResult();
      if (!result) {
        // With an ExecutionRunner the agent is only ever reached through the durable, crash-safe attempt protocol.
        result = executionRunner ? await executionRunner.ensureImplementation(workPackage) : validateAgentResult(await agentExecutor.execute(workPackage));
        actions.recordImplementation(result);
      } else if (actions.resumeCorrection) {
        // A durable result already exists, so PREPARE_IMPLEMENTATION can only be planned because the workspace is dirty: an
        // interrupted correction round. Resume it (never discard it).
        await actions.resumeCorrection(ctx);
      }
      return done(result.head);
    },
    RUN_TESTS: async (action, ctx) => done(await actions.runTests(ctx, action)),
    RUN_VALIDATION: async (action, ctx) => done(await actions.runValidation(ctx.observation.computed.state === "POST_MERGE_VALIDATION", ctx, action)),
    RUN_POST_MERGE_VALIDATION: async (action, ctx) => done(await actions.runValidation(true, ctx, action)),
    REQUEST_REVIEW: async (action, ctx) => done(await actions.requestReview(ctx, action)),
    PREPARE_MERGE: async (action, ctx) => done(await actions.prepareMerge(ctx, action)),
    ...(actions.createPullRequest ? { CREATE_PULL_REQUEST: async (action, ctx) => done(await actions.createPullRequest(ctx, action)) } : {}),
    COMPLETE: () => done("completed"),
    LOAD_TASK: () => done("task-loaded"),
    WAIT: () => done("waiting"),
    ESCALATE_OWNER: () => done("owner-block"),
    ESCALATE_EXTERNAL: () => done("external-block"),
  };
  // Reconcile-before-execute: an externally visible action that already happened (PR created, merge done) is recognized, not repeated.
  for (const [type, reconcile] of Object.entries(scope.reconcilers ?? {})) {
    capabilities[type].reconcile = async (action) => {
      const found = await reconcile(action);
      if (found.status !== "COMPLETED") return { status: found.status };
      const now = new Date().toISOString();
      return { status: "COMPLETED", result: makeActionResult({
        actionId: action.actionId, executionId: action.executionId, cycleId: action.cycleId, taskId: action.taskId, candidateRevision: action.candidateRevision,
        result: "SUCCEEDED", startedAt: now, finishedAt: now, provider: "remote-reconciliation", outputReference: found.output, retryable: false,
      }) };
    };
  }
  const executor = new FakeCapabilityExecutor({ capabilities, provider: "controller-runtime" });
  const runtime = new LoopRuntime({
    observer, executor, evidenceStore, evidenceCheckpointProvider, checkpointStore, leaseProvider,
    ownerId, clock, timeoutMs: 20000, leaseTtlMs: 120000, ...runtimeOptions,
  });
  return { runtime, evidenceStore, taskSystem };
}
