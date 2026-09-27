import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitProvider } from "../src/adapters/local-git-provider.js";
import { JsonlEvidenceStore } from "../src/adapters/jsonl-evidence-store.js";
import { MarkdownTaskAdapter, parseTasksMarkdown } from "../src/adapters/markdown-task-adapter.js";
import { RecoveryCoordinator } from "../src/core/recovery-coordinator.js";
import { computeState } from "../src/core/state-engine.js";
import { makeCIResult, makeReviewResult, makeValidationResult } from "../src/core/contracts.js";
import {
  FakeCIProvider,
  FakeReviewProvider,
  FakeSCMProvider,
  FakeValidationProvider,
} from "../src/testing/fake-providers.js";

const TASK_ID = "TASK-001";
const NEXT_TASK_ID = "TASK-002";
const WHEN = "2026-09-27T16:00:00.000Z";
const MERGE_HEAD = "dddddddddddddddddddddddddddddddddddddddd";

const ROADMAP = `# Microtest roadmap

- [ ] TASK-002 — Dependent work
  - spec: missing
  - depends_on: TASK-001
  - acceptance_criteria:
    - AC-01 — The dependency is complete

- [ ] TASK-001 — Current work
  - spec: reviewed
  - depends_on: none
  - acceptance_criteria:
    - AC-01 — The synthetic lifecycle reaches a computed result
`;

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function commit(cwd, message) {
  git(cwd, ["add", "--all"]);
  git(cwd, ["-c", "user.name=Microtest", "-c", "user.email=microtest@example.invalid", "commit", "-m", message]);
}

function createFixtureRepo(root) {
  git(root, ["init", "--initial-branch=main"]);
  git(root, ["config", "user.name", "Microtest"]);
  git(root, ["config", "user.email", "microtest@example.invalid"]);
  mkdirSync(join(root, "docs", "roadmap"), { recursive: true });
  mkdirSync(join(root, "docs", "specs"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "docs", "roadmap", "ROADMAP.md"), ROADMAP);
  const specPath = join(root, "docs", "specs", "TASK-001.md");
  writeFileSync(specPath, "# TASK-001 spec\n\nAC-01: The lifecycle resolves from evidence.\n");
  commit(root, "fixture baseline");
  const specHead = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-b", "feature/TASK-001"]);
  writeFileSync(join(root, "src", "candidate.txt"), "candidate A\n");
  commit(root, "candidate A");
  return { specHead, specPath };
}

function ciResult(head, status = "PASS") {
  return { head, status, checkedAt: "2026-09-27T14:00:00.000Z", runId: `ci-${head.slice(0, 7)}` };
}

function validationResult({ head, baseline, specDigest, total = 1, proved = total, result = "PASS" }) {
  return {
    taskId: TASK_ID, head, baseline, specDigest, result,
    acProof: { total, proved }, checkedAt: "2026-09-27T14:30:00.000Z", independent: true,
  };
}

function reviewResult(head, publishedAt = "2026-09-27T15:00:00.000Z") {
  return { head, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt, reviewerId: `review-${head.slice(0, 7)}` };
}

function buildCoordinator({ root, specHead, specDigest, ciStatus = "PASS", ciHead = null, validationHead = null, omitValidation = false, omitReview = false, merge = null, postMergeValidation = false, evidenceStore = null } = {}) {
  const taskSystem = new MarkdownTaskAdapter({ path: join(root, "docs", "roadmap", "ROADMAP.md") });
  const revision = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
  const currentCiHead = ciHead ?? revision.head;
  const currentValidationHead = validationHead ?? revision.head;
  const currentReviewHead = revision.head;
  const reviewResults = [reviewResult(specHead, "2026-09-27T13:00:00.000Z")];
  if (!omitReview) reviewResults.push(reviewResult(currentReviewHead));
  const validationResults = omitValidation ? [] : [validationResult({
    head: currentValidationHead, baseline: revision.base, specDigest,
  })];
  if (postMergeValidation && merge?.mergeCommit) {
    validationResults.push(validationResult({ head: merge.mergeCommit, baseline: revision.head, specDigest }));
  }

  return new RecoveryCoordinator({
    taskSystem,
    gitProvider: new LocalGitProvider({ cwd: root, baseRef: "main" }),
    scmProvider: new FakeSCMProvider({ mergeFacts: merge ? [merge] : [] }),
    ciProvider: new FakeCIProvider({ results: [ciResult(currentCiHead, ciStatus)] }),
    reviewProvider: new FakeReviewProvider({ results: reviewResults }),
    validationProvider: new FakeValidationProvider({ results: validationResults }),
    evidenceStore,
  });
}

function recoveryContext(specHead, specDigest, overrides = {}) {
  return {
    activeTaskId: TASK_ID,
    specRevision: { head: specHead },
    specDigest,
    now: WHEN,
    ...overrides,
  };
}

test("Microtest 001 executes Loop Base v0 architecture through all eight acceptance cases", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "souza-loop-microtest-001-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const { specHead, specPath } = createFixtureRepo(root);
  const specDigest = createHash("sha256").update(readFileSync(specPath)).digest("hex");

  await t.test("TEST 1 — deterministic task resolution and dependencies", () => {
    const tasks = parseTasksMarkdown(ROADMAP);
    const adapter = new MarkdownTaskAdapter({ path: join(root, "docs", "roadmap", "ROADMAP.md") });
    const first = adapter.resolveNextTask();
    assert.equal(first.taskId, TASK_ID);
    assert.deepEqual(first.skipped, [{ taskId: NEXT_TASK_ID, blockers: [TASK_ID] }]);
    assert.deepEqual(adapter.resolveNextTask({ additionalCompletedIds: [TASK_ID] }), {
      taskId: NEXT_TASK_ID,
      reason: "ELIGIBLE_TASK_FOUND",
      skipped: [],
    });
    assert.equal(tasks[0].id, NEXT_TASK_ID);
  });

  await t.test("TEST 2 — DONE is blocked by missing, red, unknown, and stale evidence", () => {
    const missing = buildCoordinator({ root, specHead, specDigest, omitValidation: true })
      .recover(recoveryContext(specHead, specDigest));
    assert.equal(missing.computed.state, "VALIDATING");

    for (const status of ["FAIL", "UNKNOWN"]) {
      const blocked = buildCoordinator({ root, specHead, specDigest, ciStatus: status, omitValidation: false })
        .recover(recoveryContext(specHead, specDigest));
      assert.equal(blocked.computed.state, "TESTING", `CI ${status} must block DONE`);
    }

    const candidate = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    const staleValidation = validationResult({ head: specHead, baseline: candidate.base, specDigest });
    class StaleValidationProvider extends FakeValidationProvider {
      getValidationResult() { return makeValidationResult(staleValidation); }
    }
    const taskSystem = new MarkdownTaskAdapter({ path: join(root, "docs", "roadmap", "ROADMAP.md") });
    const coordinator = new RecoveryCoordinator({
      taskSystem,
      gitProvider: new LocalGitProvider({ cwd: root, baseRef: "main" }),
      scmProvider: new FakeSCMProvider(),
      ciProvider: new FakeCIProvider({ results: [ciResult(candidate.head)] }),
      reviewProvider: new FakeReviewProvider({ results: [reviewResult(specHead), reviewResult(candidate.head)] }),
      validationProvider: new StaleValidationProvider(),
    });
    const stale = coordinator.recover(recoveryContext(specHead, specDigest));
    assert.equal(stale.computed.state, "VALIDATING");
    assert.match(stale.computed.blockers.join(" "), /stale/);
  });

  await t.test("TEST 3 — recovery resumes at the first unproved step after interruption", () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), "souza-loop-microtest-001-evidence-"));
    t.after(() => rmSync(evidenceRoot, { recursive: true, force: true }));
    const evidenceStore = new JsonlEvidenceStore({ path: join(evidenceRoot, "events.jsonl") });
    const recovered = buildCoordinator({ root, specHead, specDigest, omitValidation: true, evidenceStore })
      .recover(recoveryContext(specHead, specDigest, { eventId: "microtest-001-recovery-03" }));
    assert.equal(recovered.computed.state, "VALIDATING");
    assert.equal(recovered.firstUnprovedStep, "RUN_VALIDATION");
    assert.equal(evidenceStore.listByTask(TASK_ID).length, 1);
  });

  await t.test("TEST 4 — matching STATE and HANDOFF DONE projections cannot override REVIEWING", () => {
    const revision = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    const projection = { state: "DONE", taskId: TASK_ID, candidateHead: revision.head };
    const recovered = buildCoordinator({ root, specHead, specDigest, omitValidation: false, omitReview: true })
      .recover(recoveryContext(specHead, specDigest, { stateProjection: projection, handoffProjection: projection }));
    assert.equal(recovered.computed.derivedState, "REVIEWING");
    assert.equal(recovered.computed.state, "INCONSISTENT_STATE");
    assert.equal(recovered.firstUnprovedStep, "RECONCILE_INCONSISTENCY");
  });

  await t.test("TEST 5 — the valid path reaches DONE and selects the next task", () => {
    const revision = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    const merge = {
      candidateHead: revision.head, status: "MERGED", merged: true,
      mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T15:30:00.000Z",
    };
    const recovered = buildCoordinator({ root, specHead, specDigest, merge, postMergeValidation: true })
      .recover(recoveryContext(specHead, specDigest));
    assert.equal(recovered.computed.state, "DONE");
    assert.equal(recovered.firstUnprovedStep, "SELECT_NEXT_TASK");
    assert.equal(recovered.nextTaskId, NEXT_TASK_ID);
    assert.deepEqual(recovered.computed.blockers, []);
  });

  await t.test("TEST 6 — a review for HEAD A is stale after the candidate advances to HEAD B", () => {
    const revisionA = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    writeFileSync(join(root, "src", "candidate.txt"), "candidate B\n");
    commit(root, "candidate B supersedes A");
    const revisionB = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    assert.notEqual(revisionA.head, revisionB.head);
    const reviewA = makeReviewResult(reviewResult(revisionA.head));
    const stale = computeState({
      task: new MarkdownTaskAdapter({ path: join(root, "docs", "roadmap", "ROADMAP.md") }).listTasks().find(({ id }) => id === TASK_ID),
      completedTaskIds: [],
      specRevision: { head: specHead }, specReview: reviewResult(specHead), specDigest,
      revision: revisionB,
      ci: ciResult(revisionB.head),
      validation: validationResult({ head: revisionB.head, baseline: revisionB.base, specDigest }),
      review: reviewA,
      now: WHEN,
    });
    assert.equal(stale.state, "REVIEWING");
    assert.match(stale.blockers.join(" "), /review is stale/);
  });

  await t.test("TEST 7 — narrative DONE is rejected when computed facts say REVIEWING", () => {
    const recovered = buildCoordinator({ root, specHead, specDigest, omitReview: true })
      .recover(recoveryContext(specHead, specDigest, { narrativeClaim: "DONE" }));
    assert.equal(recovered.computed.state, "REVIEWING");
    assert.notEqual(recovered.computed.state, "DONE");
  });

  await t.test("TEST 8 — a clean review published after merge cannot authorize the merge", () => {
    const revision = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    const lateReviewProvider = new FakeReviewProvider({ results: [
      reviewResult(specHead, "2026-09-27T13:00:00.000Z"),
      reviewResult(revision.head, "2026-09-27T15:40:00.000Z"),
    ] });
    const taskSystem = new MarkdownTaskAdapter({ path: join(root, "docs", "roadmap", "ROADMAP.md") });
    const coordinator = new RecoveryCoordinator({
      taskSystem,
      gitProvider: new LocalGitProvider({ cwd: root, baseRef: "main" }),
      scmProvider: new FakeSCMProvider({ mergeFacts: [{
        candidateHead: revision.head, status: "MERGED", merged: true,
        mergeCommit: MERGE_HEAD, mergedAt: "2026-09-27T15:30:00.000Z",
      }] }),
      ciProvider: new FakeCIProvider({ results: [ciResult(revision.head)] }),
      reviewProvider: lateReviewProvider,
      validationProvider: new FakeValidationProvider({ results: [
        validationResult({ head: revision.head, baseline: revision.base, specDigest }),
        validationResult({ head: MERGE_HEAD, baseline: revision.head, specDigest }),
      ] }),
    });
    const rejected = coordinator.recover(recoveryContext(specHead, specDigest));
    assert.equal(rejected.computed.state, "INCONSISTENT_STATE");
    assert.match(rejected.computed.blockers.join(" "), /not published before merge/);
  });
});
