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

export function createWorkPackageRuntime({ workPackage, directory, scope, leaseProvider, ownerId, agentExecutor, clock = () => new Date().toISOString(), runtimeOptions = {} }) {
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
  const capabilities = {
    WRITE_PROJECTIONS: (_action, ctx) => projectionStore.write({ executionId: ctx.executionId, computed: ctx.observation.computed }),
    REQUEST_SPEC_REVIEW: () => done("spec-review-satisfied-by-base"),
    PREPARE_IMPLEMENTATION: async () => {
      // Idempotent: an implementation already recorded for this work package is never produced twice.
      let result = scope.implementationResult();
      if (!result) {
        result = validateAgentResult(await agentExecutor.execute(workPackage));
        scope.actions.recordImplementation(result);
      }
      return done(result.head);
    },
    RUN_TESTS: () => done(scope.actions.runTests()),
    RUN_VALIDATION: (_action, ctx) => done(scope.actions.runValidation(ctx.observation.computed.state === "POST_MERGE_VALIDATION")),
    RUN_POST_MERGE_VALIDATION: () => done(scope.actions.runValidation(true)),
    REQUEST_REVIEW: () => done(scope.actions.requestReview()),
    PREPARE_MERGE: () => done(scope.actions.prepareMerge()),
    COMPLETE: () => done("completed"),
    LOAD_TASK: () => done("task-loaded"),
    WAIT: () => done("waiting"),
    ESCALATE_OWNER: () => done("owner-block"),
    ESCALATE_EXTERNAL: () => done("external-block"),
  };
  const executor = new FakeCapabilityExecutor({ capabilities, provider: "controller-runtime" });
  const runtime = new LoopRuntime({
    observer, executor, evidenceStore, evidenceCheckpointProvider, checkpointStore, leaseProvider,
    ownerId, clock, timeoutMs: 20000, leaseTtlMs: 120000, ...runtimeOptions,
  });
  return { runtime, evidenceStore, taskSystem };
}
