import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { GitHubSCMProvider } from "../src/adapters/github-scm-provider.js";
import { GitHubCIProvider } from "../src/adapters/github-ci-provider.js";
import { JsonlEvidenceStore } from "../src/adapters/jsonl-evidence-store.js";
import { JsonRuntimeCheckpointStore } from "../src/adapters/json-runtime-checkpoint-store.js";
import { LocalEvidenceCheckpointProvider } from "../src/adapters/local-evidence-checkpoint-provider.js";
import { LocalExecutionLeaseProvider } from "../src/adapters/local-execution-lease-provider.js";
import { LocalGitProvider } from "../src/adapters/local-git-provider.js";
import { MarkdownProjectionStore } from "../src/adapters/markdown-projection-store.js";
import { MarkdownTaskAdapter } from "../src/adapters/markdown-task-adapter.js";
import { RecoveryCoordinator } from "../src/core/recovery-coordinator.js";
import { RuntimeObserver } from "../src/core/runtime-observer.js";
import { LoopRuntime } from "../src/core/loop-runtime.js";
import { FakeCapabilityExecutor } from "../src/core/capability-executor.js";
import { makeReviewResult, makeValidationResult } from "../src/core/contracts.js";
import { makeActionResult } from "../src/core/runtime-contracts.js";
import { RuntimeRetryPolicy } from "../src/core/retry-policy.js";

const OWNER = process.env.LOOP_GITHUB_OWNER ?? "devricardo90";
const REPO = process.env.LOOP_GITHUB_REPO ?? "souza-loop-sandbox";
const REPOSITORY = `${OWNER}/${REPO}`;
const CI_IDENTITY = ".github/workflows/validate.yml";

export function renderAdditionSource(executionId) {
  if (typeof executionId !== "string" || !/^[A-Za-z0-9-]+$/.test(executionId)) throw new TypeError("executionId is invalid for sandbox source generation");
  return `// Synthetic sandbox candidate for execution ${executionId}.\nexport function add(a, b) {\n  if (!Number.isInteger(a) || !Number.isInteger(b)) throw new TypeError('integer inputs required');\n  return a + b;\n}\n`;
}

function git(cwd, args, timeout = 20000) {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true, timeout, killSignal: "SIGTERM",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).trim();
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "git command failed").slice(0, 1000);
    const timeoutFailure = error?.code === "ETIMEDOUT" || error?.killed === true;
    throw Object.assign(new Error(`git ${args[0]} failed: ${detail}`), {
      classification: timeoutFailure ? "TRANSIENT" : "EXTERNAL_BLOCK",
      retryable: timeoutFailure,
    });
  }
}

function actionResult(action, outputReference, now = new Date().toISOString()) {
  return makeActionResult({
    actionId: action.actionId,
    executionId: action.executionId,
    cycleId: action.cycleId,
    taskId: action.taskId,
    candidateRevision: action.candidateRevision,
    result: "SUCCEEDED",
    startedAt: now,
    finishedAt: now,
    provider: "microtest-003-controlled-capability",
    outputReference,
    retryable: false,
  });
}

function transient(message) {
  return Object.assign(new Error(message), { classification: "TRANSIENT", retryable: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const executionId = process.env.LOOP_EXECUTION_ID
    ?? `p6-${new Date().toISOString().replace(/[-:.TZ]/g, "")}-${randomUUID().slice(0, 8)}`;
  const branch = `loop/TASK-001/${executionId}`;
  const checkout = mkdtempSync(join(tmpdir(), "loop-p6-microtest-003-"));
  const stateDirectory = mkdtempSync(join(tmpdir(), "loop-p6-runtime-state-"));
  const clonePath = join(checkout, "sandbox");
  execFileSync("gh", ["repo", "clone", REPOSITORY, clonePath], {
    stdio: "ignore", windowsHide: true, timeout: 30000,
  });
  git(clonePath, ["config", "user.name", "Loop Sandbox Coder"]);
  git(clonePath, ["config", "user.email", "loop-sandbox-coder@users.noreply.github.com"]);
  git(clonePath, ["fetch", "origin", "main"]);
  git(clonePath, ["checkout", "main"]);
  const baseline = git(clonePath, ["rev-parse", "origin/main"]);
  const specText = readFileSync(join(clonePath, "specs", "TASK-001.md"), "utf8");
  const specDigest = sha256(specText);
  const specAuthorId = git(clonePath, ["show", "-s", "--format=%ae", baseline]);

  const tasks = new MarkdownTaskAdapter({ path: join(clonePath, "ROADMAP.md") });
  const selectedTask = tasks.listTasks().find((task) => task.id === "TASK-001");
  assert.ok(selectedTask, "sandbox task source must contain TASK-001");
  const scm = new GitHubSCMProvider({ owner: OWNER, repo: REPO, baseBranch: "main" });
  const repositoryFacts = scm.getRepositoryFacts();
  assert.equal(repositoryFacts.repository.toLowerCase(), REPOSITORY.toLowerCase());
  const ciProvider = new GitHubCIProvider({ owner: OWNER, repo: REPO, workflowIdentity: CI_IDENTITY });
  const localGit = new LocalGitProvider({ cwd: clonePath, baseRef: "origin/main", commandTimeoutMs: 15000 });
  const reviewFacts = new Map();
  const validationFacts = new Map();
  let observedCI = null;
  let candidateBranch = null;
  const reviewProvider = {
    getReviewResult(head) { return reviewFacts.get(head) ?? null; },
  };
  const validationProvider = {
    getValidationResult(taskId, head) { return validationFacts.get(`${taskId}:${head}`) ?? null; },
  };
  const gitProvider = {
    getRevision() {
      const revision = localGit.getRevision();
      return revision.branch === "main" ? null : revision;
    },
  };
  const contextProvider = () => ({
    specRevision: { head: baseline, authorId: specAuthorId },
    specDigest,
  });
  const recovery = new RecoveryCoordinator({
    taskSystem: tasks,
    gitProvider,
    scmProvider: scm,
    ciProvider,
    reviewProvider,
    validationProvider,
  });
  const evidenceStore = new JsonlEvidenceStore({ path: join(stateDirectory, "evidence.jsonl") });
  const evidenceCheckpointProvider = new LocalEvidenceCheckpointProvider({ path: join(stateDirectory, "evidence-checkpoint.json") });
  const projectionStore = new MarkdownProjectionStore({ directory: join(stateDirectory, "projections") });
  const observer = new RuntimeObserver({
    recoveryCoordinator: recovery,
    evidenceStore,
    evidenceCheckpointProvider,
    projectionStore,
    contextProvider,
  });

  const capabilities = {
    REQUEST_SPEC_REVIEW: async (action) => {
      const now = new Date().toISOString();
      reviewFacts.set(baseline, makeReviewResult({
        head: baseline, verdict: "CLEAN", independent: true, unresolvedFindings: 0,
        publishedAt: now, reviewerId: "phase6-independent-reviewer",
      }));
      return { outputReference: `spec-review:${baseline}` };
    },
    PREPARE_IMPLEMENTATION: async (action, context) => {
      await context.assertLeaseCurrent();
      candidateBranch = branch;
      const exists = git(clonePath, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
      if (exists) throw Object.assign(new Error("unique execution branch unexpectedly exists"), { classification: "INVARIANT_VIOLATION" });
      git(clonePath, ["checkout", "-b", branch]);
      mkdirSync(join(clonePath, "src"), { recursive: true });
      mkdirSync(join(clonePath, "test"), { recursive: true });
      writeFileSync(join(clonePath, "src", "add.js"), renderAdditionSource(executionId), "utf8");
      writeFileSync(join(clonePath, "test", "add.test.js"), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { add } from '../src/add.js';\n\ntest('add handles positive, zero, and negative integers', () => {\n  assert.equal(add(2, 3), 5);\n  assert.equal(add(0, 4), 4);\n  assert.equal(add(-2, 1), -1);\n});\n", "utf8");
      git(clonePath, ["add", "src/add.js", "test/add.test.js"]);
      git(clonePath, ["commit", "-m", "feat: implement TASK-001 integer addition"]);
      await context.assertLeaseCurrent();
      git(clonePath, ["push", "--set-upstream", "origin", branch]);
      return { outputReference: git(clonePath, ["rev-parse", "HEAD"]) };
    },
    CREATE_PULL_REQUEST: async (action, context) => {
      const pr = await scm.createPullRequest({
        branch, candidateSha: action.candidateRevision, taskId: "TASK-001", executionId,
        title: "TASK-001: deterministic addition helper",
        body: `Phase 6 controlled runtime lifecycle. Execution: ${executionId}.`,
        baseBranch: "main",
      }, context);
      return { outputReference: String(pr.number) };
    },
    RUN_TESTS: async (action) => {
      observedCI = ciProvider.getCIResult(action.candidateRevision);
      if (observedCI.status === "PASS" && observedCI.workflowIdentity === CI_IDENTITY
        && observedCI.repository?.toLowerCase() === REPOSITORY.toLowerCase()) {
        return { outputReference: `github-actions:${observedCI.runId}` };
      }
      if (observedCI.status === "FAIL") throw Object.assign(new Error("configured GitHub Actions workflow failed"), { classification: "PERMANENT" });
      throw transient(`configured GitHub Actions result is ${observedCI.status}`);
    },
    RUN_VALIDATION: async (action, context) => {
      const facts = context.observation.recovery.facts;
      const task = facts.task;
      const validation = makeValidationResult({
        head: action.candidateRevision,
        baseline: facts.revision.base,
        specDigest,
        acceptanceCriteriaDigest: task.acceptanceCriteriaDigest,
        result: "PASS",
        acProof: { total: task.acceptanceCriteria.length, proved: task.acceptanceCriteria.length },
        checkedAt: new Date().toISOString(),
        independent: true,
      });
      validationFacts.set(`${task.id}:${action.candidateRevision}`, validation);
      return { outputReference: `validation:${action.candidateRevision}` };
    },
    REQUEST_REVIEW: async (action) => {
      reviewFacts.set(action.candidateRevision, makeReviewResult({
        head: action.candidateRevision,
        verdict: "CLEAN",
        independent: true,
        unresolvedFindings: 0,
        publishedAt: new Date().toISOString(),
        reviewerId: "phase6-independent-reviewer",
      }));
      return { outputReference: `review:${action.candidateRevision}` };
    },
    PREPARE_MERGE: async (action, context) => {
      const facts = context.observation.recovery.facts;
      const pr = facts.pullRequest;
      if (!pr?.number) throw Object.assign(new Error("current execution pull request is not identified"), { classification: "INVARIANT_VIOLATION" });
      await context.assertLeaseCurrent();
      const merged = await scm.mergePullRequest({
        number: pr.number,
        expectedHead: action.candidateRevision,
        expectedBase: facts.revision.base,
        expectedSpecDigest: specDigest,
        expectedAcceptanceCriteriaDigest: facts.task.acceptanceCriteriaDigest,
        criterionCount: facts.task.acceptanceCriteria.length,
        taskId: "TASK-001",
        implementationAuthorId: facts.revision.authorId,
        requiredCIIdentity: CI_IDENTITY,
        ci: facts.ci,
        validation: facts.validation,
        review: facts.review,
        computedState: context.observation.computed.state,
        attemptedAt: new Date().toISOString(),
      }, context);
      return { outputReference: merged.mergeSha };
    },
    RUN_POST_MERGE_VALIDATION: async (action, context) => {
      const facts = context.observation.recovery.facts;
      const merge = facts.merge;
      const task = facts.task;
      const validation = makeValidationResult({
        head: merge.mergeCommit,
        baseline: action.candidateRevision,
        specDigest,
        acceptanceCriteriaDigest: task.acceptanceCriteriaDigest,
        result: "PASS",
        acProof: { total: task.acceptanceCriteria.length, proved: task.acceptanceCriteria.length },
        checkedAt: new Date().toISOString(),
        independent: true,
      });
      validationFacts.set(`${task.id}:${merge.mergeCommit}`, validation);
      return { outputReference: `post-merge-validation:${merge.mergeCommit}` };
    },
    WRITE_PROJECTIONS: async (action, context) => {
      projectionStore.write({ executionId, computed: context.observation.computed });
      return { outputReference: `projections:${executionId}` };
    },
  };

  capabilities.PREPARE_IMPLEMENTATION.reconcile = async (action) => {
    const ref = `refs/heads/${branch}`;
    const remote = git(clonePath, ["ls-remote", "--heads", "origin", ref]);
    if (!remote) return { status: "NOT_STARTED" };
    const remoteHead = remote.split(/\s+/)[0];
    const localBranch = git(clonePath, ["branch", "--show-current"]);
    if (localBranch !== branch) {
      const present = git(clonePath, ["branch", "--list", branch]);
      if (present) git(clonePath, ["checkout", branch]);
      else {
        git(clonePath, ["fetch", "origin", branch]);
        git(clonePath, ["checkout", "--track", "-b", branch, `origin/${branch}`]);
      }
    }
    if (git(clonePath, ["rev-parse", "HEAD"]) !== remoteHead) return { status: "UNKNOWN" };
    candidateBranch = branch;
    return { status: "COMPLETED", result: actionResult(action, remoteHead) };
  };
  capabilities.CREATE_PULL_REQUEST.reconcile = async (action) => {
    const found = scm.findPullRequest({ branch, baseBranch: "main", candidateSha: action.candidateRevision });
    return found?.headMatches
      ? { status: "COMPLETED", result: actionResult(action, String(found.number)) }
      : { status: "NOT_STARTED" };
  };
  capabilities.PREPARE_MERGE.reconcile = async (action) => {
    const fact = scm.getMergeFact("TASK-001", action.candidateRevision);
    return fact.status === "MERGED"
      ? { status: "COMPLETED", result: actionResult(action, fact.mergeCommit) }
      : { status: "NOT_STARTED" };
  };

  const executor = new FakeCapabilityExecutor({ capabilities, provider: "phase6-controlled-and-github" });
  const runtime = new LoopRuntime({
    observer,
    executor,
    evidenceStore,
    evidenceCheckpointProvider,
    checkpointStore: new JsonRuntimeCheckpointStore({ path: join(stateDirectory, "runtime-checkpoint") }),
    leaseProvider: new LocalExecutionLeaseProvider({ directory: join(stateDirectory, "leases"), defaultTtlMs: 90000 }),
    ownerId: `microtest-003:${executionId}`,
    leaseTtlMs: 90000,
    timeoutMs: 25000,
    retryPolicy: new RuntimeRetryPolicy({ maxAttempts: 12, baseDelayMs: 5000, maxDelayMs: 30000 }),
  });

  const cycles = [];
  let finalOutcome = null;
  for (let count = 0; count < 100; count += 1) {
    const cycle = await runtime.runCycle({ executionId, repository: REPOSITORY });
    cycles.push(cycle);
    finalOutcome = cycle.outcome;
    process.stdout.write(`${JSON.stringify({ cycle: cycle.cycleId, state: cycle.observation.computed.state, action: cycle.plannedAction.actionType, actionResult: cycle.actionResult?.result ?? null, nextState: cycle.nextComputed?.state ?? null, outcome: cycle.outcome })}\n`);
    if (cycle.outcome === "DONE") break;
    if (["BLOCKED_EXTERNAL", "BLOCKED_OWNER"].includes(cycle.outcome)) {
      throw new Error(`runtime stopped in ${cycle.outcome}: ${cycle.actionResult?.errorMessage ?? cycle.observation.computed.blockers.join("; ")}`);
    }
    if (cycle.outcome === "WAIT_RETRYABLE") {
      const eligibleAt = cycle.checkpoint?.retry?.nextEligibleAt;
      const waitMs = eligibleAt ? Math.max(1000, Date.parse(eligibleAt) - Date.now()) : 6000;
      await delay(Math.min(waitMs, 30000));
    }
  }
  const last = cycles.at(-1);
  if (last?.observation.computed.state !== "DONE" && last?.nextComputed?.state !== "DONE") {
    throw new Error(`Microtest 003 did not reach DONE within its cycle bound; outcome=${finalOutcome}`);
  }
  const candidateSha = git(clonePath, ["rev-parse", "HEAD"]);
  const pr = scm.findPullRequest({ branch, baseBranch: "main", candidateSha });
  assert.ok(pr?.headMatches, "the current execution PR must point at the exact candidate commit");
  const merge = scm.getMergeFact("TASK-001", candidateSha);
  assert.equal(merge.status, "MERGED");
  const finalCI = last.observation.recovery.facts.ci;
  assert.equal(finalCI?.status, "PASS", "the final runtime observation must contain real exact-head CI PASS");
  assert.equal(finalCI.head, candidateSha);
  assert.equal(finalCI.repository?.toLowerCase(), REPOSITORY.toLowerCase());
  assert.equal(finalCI.workflowIdentity, CI_IDENTITY);
  assert.ok(finalCI.runId, "the exact workflow run identity must be recorded");
  const main = scm.getBranchFacts("main");
  assert.equal(main.headSha, merge.mergeCommit, "sandbox main must resolve to the observed merge revision");
  assert.equal(last.nextComputed?.nextTaskId ?? last.observation.computed.nextTaskId, "TASK-002");
  const output = {
    result: "PASS",
    repository: REPOSITORY,
    executionId,
    taskId: "TASK-001",
    nextTaskId: "TASK-002",
    branch,
    pullRequestNumber: pr.number,
    pullRequestUrl: pr.url,
    candidateSha,
    ciIdentity: CI_IDENTITY,
    ciRunId: finalCI.runId,
    ciConclusion: finalCI.conclusion,
    mergeSha: merge.mergeCommit,
    mergedAt: merge.mergedAt,
    cycles: cycles.length,
    state: last.nextComputed?.state,
    checkout,
    localStateDirectory: stateDirectory,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = 1;
  });
}
