import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubSCMError, GitHubSCMProvider } from "../src/adapters/github-scm-provider.js";
import { GitHubCIError, GitHubCIProvider } from "../src/adapters/github-ci-provider.js";
import { LocalExecutionLeaseProvider } from "../src/adapters/local-execution-lease-provider.js";

const REPOSITORY = "owner/souza-loop-sandbox";
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const MERGE = "c".repeat(40);
const EXECUTION = "exec-g13";

function rawPR({ head = HEAD_A, base = "main", state = "open", merged = false, mergeable = true } = {}) {
  return {
    number: 4,
    state,
    merged,
    merged_at: merged ? "2026-09-29T10:29:00.000Z" : null,
    merge_commit_sha: merged ? MERGE : null,
    updated_at: "2026-09-29T10:00:00.000Z",
    title: "sandbox task",
    body: `<!-- loop-task:TASK-001 --> <!-- loop-execution:${EXECUTION} -->`,
    html_url: `https://github.com/${REPOSITORY}/pull/4`,
    user: { login: "coder" },
    head: { ref: "loop/TASK-001/exec", sha: head },
    base: { ref: base },
    mergeable,
  };
}

class SCMFixture {
  constructor() {
    this.pr = rawPR();
    this.branchSha = HEAD_A;
    this.branchExists = true;
    this.postCount = 0;
    this.putCount = 0;
    this.failNextPRRead = false;
    this.onSecondPRRead = null;
    this.prReads = 0;
    this.ambiguousMergeTimeout = false;
  }

  run = (args) => {
    const route = args[1];
    if (route.startsWith(`repos/${REPOSITORY}/pulls?`)) return JSON.stringify(this.pr ? [this.pr] : []);
    if (route === `repos/${REPOSITORY}/branches/loop%2FTASK-001%2Fexec`) {
      return JSON.stringify(this.branchExists
        ? { name: "loop/TASK-001/exec", commit: { sha: this.branchSha } }
        : { message: "Not Found" });
    }
    if (route === `repos/${REPOSITORY}/pulls` && args.includes("POST")) {
      this.postCount += 1;
      this.pr = rawPR();
      return JSON.stringify({ number: 4 });
    }
    if (route === `repos/${REPOSITORY}/pulls/4` && !args.includes("PUT")) {
      this.prReads += 1;
      this.onSecondPRRead?.(this.prReads, this);
      if (this.failNextPRRead) {
        this.failNextPRRead = false;
        throw Object.assign(new Error("network timeout after PR creation"), { code: "ETIMEDOUT" });
      }
      return JSON.stringify(this.pr);
    }
    if (route === `repos/${REPOSITORY}/pulls/4/merge` && args.includes("PUT")) {
      this.putCount += 1;
      if (this.ambiguousMergeTimeout) {
        this.pr = rawPR({ state: "closed", merged: true });
        throw Object.assign(new Error("merge response timed out after server commit"), { code: "ETIMEDOUT" });
      }
      this.pr = rawPR({ state: "closed", merged: true });
      return JSON.stringify({ merged: true, message: "merged", sha: MERGE });
    }
    throw new Error(`unexpected request ${args.join(" ")}`);
  };

  provider(overrides = {}) {
    return new GitHubSCMProvider({ owner: "owner", repo: "souza-loop-sandbox", baseBranch: "main", run: this.run, ...overrides });
  }
}

function auth(overrides = {}) {
  return {
    number: 4,
    expectedHead: HEAD_A,
    expectedBase: "base-sha",
    expectedSpecDigest: "spec-digest",
    expectedAcceptanceCriteriaDigest: "ac-digest",
    criterionCount: 1,
    taskId: "TASK-001",
    implementationAuthorId: "coder",
    requiredCIIdentity: ".github/workflows/validate.yml",
    ci: { repository: REPOSITORY, workflowIdentity: ".github/workflows/validate.yml", head: HEAD_A, status: "PASS", runId: "ci-17", checkedAt: "2026-09-29T10:20:00.000Z" },
    validation: { head: HEAD_A, baseline: "base-sha", specDigest: "spec-digest", acceptanceCriteriaDigest: "ac-digest", result: "PASS", independent: true, acProof: { total: 1, proved: 1 } },
    review: { head: HEAD_A, verdict: "CLEAN", independent: true, unresolvedFindings: 0, reviewerId: "independent", publishedAt: "2026-09-29T10:25:00.000Z" },
    computedState: "READY_TO_MERGE",
    attemptedAt: "2026-09-29T10:30:00.000Z",
    ...overrides,
  };
}

const leased = { assertLeaseCurrent: async () => true };

test("G01 authentication failure blocks without manufacturing SCM facts", () => {
  const provider = new GitHubSCMProvider({ owner: "owner", repo: "repo", run: () => { throw new Error("HTTP 401 authentication required"); } });
  assert.throws(() => provider.getRepositoryFacts(), (error) => error.classification === "EXTERNAL_BLOCK");
});

test("G02 GitHub timeout is classified transient and does not satisfy CI", () => {
  const scm = new GitHubSCMProvider({ owner: "owner", repo: "repo", run: () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
  assert.throws(() => scm.getRepositoryFacts(), (error) => error.classification === "TRANSIENT");
  const ci = new GitHubCIProvider({ owner: "owner", repo: "repo", workflowIdentity: ".github/workflows/validate.yml", run: () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
  assert.throws(() => ci.getCIResult(HEAD_A), (error) => error instanceof GitHubCIError && error.classification === "TRANSIENT");
});

test("G03 PR created before response loss is rediscovered without duplicate creation", async () => {
  const fixture = new SCMFixture();
  fixture.pr = null;
  fixture.failNextPRRead = true;
  const provider = fixture.provider();
  const input = { branch: "loop/TASK-001/exec", candidateSha: HEAD_A, taskId: "TASK-001", executionId: EXECUTION, title: "task", baseBranch: "main" };
  await assert.rejects(provider.createPullRequest(input, leased), { code: "GITHUB_TIMEOUT" });
  const found = await provider.createPullRequest(input, leased);
  assert.equal(found.number, 4);
  assert.equal(fixture.postCount, 1);
});

test("G04 pushed branch is discovered as the exact candidate before PR creation", async () => {
  const fixture = new SCMFixture();
  fixture.pr = null;
  const pr = await fixture.provider().createPullRequest({
    branch: "loop/TASK-001/exec", candidateSha: HEAD_A, taskId: "TASK-001", executionId: EXECUTION, title: "task", baseBranch: "main",
  }, leased);
  assert.equal(pr.headSha, HEAD_A);
  assert.equal(fixture.postCount, 1);
});

test("G05/G06 pending and failed required workflow states never become PASS", () => {
  const runFor = (status, conclusion) => new GitHubCIProvider({
    owner: "owner", repo: "souza-loop-sandbox", workflowIdentity: ".github/workflows/validate.yml",
    run: () => JSON.stringify({ workflow_runs: [{ id: 17, path: ".github/workflows/validate.yml", head_sha: HEAD_A, status, conclusion, updated_at: "2026-09-29T10:00:00Z", repository: { full_name: REPOSITORY } }] }),
  }).getCIResult(HEAD_A);
  assert.equal(runFor("in_progress", null).status, "PENDING");
  assert.equal(runFor("completed", "failure").status, "FAIL");
});

test("G07/G18 CI and review evidence for a prior SHA cannot authorize a changed PR head", async () => {
  const ci = new GitHubCIProvider({
    owner: "owner", repo: "souza-loop-sandbox", workflowIdentity: ".github/workflows/validate.yml",
    run: () => JSON.stringify({ workflow_runs: [{ id: 17, path: ".github/workflows/validate.yml", head_sha: HEAD_A, status: "completed", conclusion: "success", updated_at: "2026-09-29T10:20:00Z", repository: { full_name: REPOSITORY } }] }),
  });
  assert.equal(ci.getCIResult(HEAD_B).status, "UNKNOWN");
  const fixture = new SCMFixture();
  fixture.pr = rawPR({ head: HEAD_B });
  fixture.branchSha = HEAD_B;
  await assert.rejects(fixture.provider().mergePullRequest(auth(), leased), { code: "GITHUB_PR_HEAD_MISMATCH" });
  assert.equal(fixture.putCount, 0);
});

test("G08/G09 PR mutation after review or after planning aborts before merge", async () => {
  const fixture = new SCMFixture();
  fixture.onSecondPRRead = (count, state) => { if (count === 2) { state.pr = rawPR({ head: HEAD_B }); state.branchSha = HEAD_B; } };
  await assert.rejects(fixture.provider().mergePullRequest(auth(), leased), { code: "GITHUB_PR_HEAD_MISMATCH" });
  assert.equal(fixture.putCount, 0);
});

test("G10 two runtimes for one execution cannot both acquire the local durable lease", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-two-runtime-"));
  try {
    const leases = new LocalExecutionLeaseProvider({ directory: root, defaultTtlMs: 30000 });
    const ownerA = await leases.acquire({ repository: REPOSITORY, taskId: "TASK-001", executionId: "same-execution", ownerId: "runtime-a" });
    assert.throws(() => leases.acquire({ repository: REPOSITORY, taskId: "TASK-001", executionId: "same-execution", ownerId: "runtime-b" }), (error) => error.code === "EXECUTION_LEASE_UNAVAILABLE");
    assert.equal((await leases.inspect(ownerA)).active, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G11/G12 expired and stale fencing authority cannot reach GitHub merge", async () => {
  const root = mkdtempSync(join(tmpdir(), "p6-stale-lease-"));
  try {
    let now = "2026-09-29T10:00:00.000Z";
    const leases = new LocalExecutionLeaseProvider({ directory: root, clock: () => now, defaultTtlMs: 1000 });
    const first = await leases.acquire({ repository: REPOSITORY, taskId: "TASK-001", executionId: "fenced-execution", ownerId: "runtime-a", ttlMs: 1000 });
    now = "2026-09-29T10:00:02.000Z";
    const second = await leases.acquire({ repository: REPOSITORY, taskId: "TASK-001", executionId: "fenced-execution", ownerId: "runtime-b", ttlMs: 1000 });
    const fixture = new SCMFixture();
    await assert.rejects(fixture.provider().mergePullRequest(auth(), { assertLeaseCurrent: () => leases.assertCurrent(first) }));
    assert.equal(fixture.putCount, 0);
    assert.equal((await leases.inspect(second)).active, true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("G13 ambiguous merge timeout is reconciled from the merged PR and never repeated", async () => {
  const fixture = new SCMFixture();
  fixture.ambiguousMergeTimeout = true;
  const provider = fixture.provider();
  await assert.rejects(provider.mergePullRequest(auth(), leased), { code: "GITHUB_TIMEOUT" });
  assert.equal(provider.getMergeFact("TASK-001", HEAD_A).status, "MERGED");
  assert.equal(fixture.putCount, 1);
});

test("G14 merge success followed by process loss is recoverable from remote merge facts", async () => {
  const fixture = new SCMFixture();
  const provider = fixture.provider();
  const result = await provider.mergePullRequest(auth(), leased);
  assert.equal(result.mergeSha, MERGE);
  assert.equal(provider.getMergeFact("TASK-001", HEAD_A).status, "MERGED");
  assert.equal(fixture.putCount, 1);
});

test("G15 missing remote branch blocks PR creation", async () => {
  const fixture = new SCMFixture();
  fixture.pr = null;
  fixture.branchExists = false;
  await assert.rejects(fixture.provider().createPullRequest({
    branch: "loop/TASK-001/exec", candidateSha: HEAD_A, taskId: "TASK-001", executionId: EXECUTION, title: "task", baseBranch: "main",
  }, leased), { code: "GITHUB_INVALID_SCHEMA" });
  assert.equal(fixture.postCount, 0);
});

test("G16 unexpected GitHub response schema is rejected", () => {
  const provider = new GitHubSCMProvider({ owner: "owner", repo: "repo", run: () => "{\"unexpected\":true}" });
  assert.throws(() => provider.getRepositoryFacts(), { code: "GITHUB_INVALID_SCHEMA" });
});

test("G17 unrelated green workflow identity is not accepted", () => {
  const provider = new GitHubCIProvider({
    owner: "owner", repo: "souza-loop-sandbox", workflowIdentity: ".github/workflows/validate.yml",
    run: () => JSON.stringify({ workflow_runs: [{ id: 17, path: ".github/workflows/unrelated.yml", head_sha: HEAD_A, status: "completed", conclusion: "success", updated_at: "2026-09-29T10:20:00Z", repository: { full_name: REPOSITORY } }] }),
  });
  assert.equal(provider.getCIResult(HEAD_A).status, "UNKNOWN");
});

test("PR retargeting or missing mergeability fails closed before mutation", async () => {
  for (const pr of [rawPR({ base: "release" }), rawPR({ mergeable: null })]) {
    const fixture = new SCMFixture();
    fixture.pr = pr;
    await assert.rejects(fixture.provider().mergePullRequest(auth(), leased));
    assert.equal(fixture.putCount, 0);
  }
});
