import assert from "node:assert/strict";
import test from "node:test";
import { GitHubSCMError, GitHubSCMProvider } from "../src/adapters/github-scm-provider.js";

const HEAD = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const MERGE = "c".repeat(40);
const TASK = "TASK-001";
const REPOSITORY = "owner/souza-loop-sandbox";

function rawPull({ head = HEAD, state = "open", merged = false, mergeable = true, number = 7, base = "main" } = {}) {
  return {
    number,
    state,
    merged,
    merged_at: merged ? "2026-09-28T11:00:00.000Z" : null,
    merge_commit_sha: merged ? MERGE : null,
    updated_at: "2026-09-28T10:00:00.000Z",
    html_url: `https://github.com/${REPOSITORY}/pull/${number}`,
    title: "TASK-001 test helper",
    body: `controlled sandbox change <!-- loop-task:${TASK} --> <!-- loop-execution:exec-1 -->`,
    user: { login: "coder" },
    head: { sha: head, ref: "loop/TASK-001/exec-1" },
    base: { ref: base },
    mergeable,
  };
}

class GitHubFixture {
  constructor() {
    this.pr = rawPull();
    this.branchSha = HEAD;
    this.calls = [];
    this.prReads = 0;
    this.onPrRead = null;
    this.created = false;
    this.mergeResponse = { merged: true, message: "Pull Request successfully merged", sha: MERGE };
  }

  run = (args) => {
    this.calls.push(args);
    const route = args[1];
    if (route === `repos/${REPOSITORY}`) return JSON.stringify({ full_name: REPOSITORY, default_branch: "main", private: true, html_url: `https://github.com/${REPOSITORY}` });
    if (route === `repos/${REPOSITORY}/branches/loop%2FTASK-001%2Fexec-1`) {
      return JSON.stringify({ name: "loop/TASK-001/exec-1", protected: false, commit: { sha: this.branchSha } });
    }
    if (route.startsWith(`repos/${REPOSITORY}/pulls?`)) return JSON.stringify(this.pr ? [this.pr] : []);
    if (route === `repos/${REPOSITORY}/pulls` && args.includes("POST")) {
      this.created = true;
      this.pr = rawPull();
      return JSON.stringify(this.pr);
    }
    if (route === `repos/${REPOSITORY}/pulls/7/merge` && args.includes("PUT")) return JSON.stringify(this.mergeResponse);
    if (route === `repos/${REPOSITORY}/pulls/7`) {
      this.prReads += 1;
      this.onPrRead?.(this.prReads, this);
      return JSON.stringify(this.pr);
    }
    throw new Error(`unexpected fixture request ${args.join(" ")}`);
  };

  provider(overrides = {}) {
    return new GitHubSCMProvider({ owner: "owner", repo: "souza-loop-sandbox", baseBranch: "main", run: this.run, ...overrides });
  }
}

function mergeAuthorization(overrides = {}) {
  return {
    number: 7,
    expectedHead: HEAD,
    expectedBase: "BASE",
    expectedSpecDigest: "spec-digest",
    expectedAcceptanceCriteriaDigest: "ac-digest",
    criterionCount: 1,
    taskId: TASK,
    implementationAuthorId: "coder",
    requiredCIIdentity: ".github/workflows/validate.yml",
    computedState: "READY_TO_MERGE",
    attemptedAt: "2026-09-28T10:30:00.000Z",
    ci: { repository: REPOSITORY, workflowIdentity: ".github/workflows/validate.yml", head: HEAD, status: "PASS", runId: "run-99", checkedAt: "2026-09-28T10:20:00.000Z" },
    validation: { head: HEAD, baseline: "BASE", specDigest: "spec-digest", acceptanceCriteriaDigest: "ac-digest", result: "PASS", independent: true, acProof: { total: 1, proved: 1 } },
    review: { head: HEAD, verdict: "CLEAN", independent: true, unresolvedFindings: 0, reviewerId: "reviewer", publishedAt: "2026-09-28T10:25:00.000Z" },
    ...overrides,
  };
}

test("GitHub SCM provider normalizes repository, branch, PR and merge facts", () => {
  const fixture = new GitHubFixture();
  const provider = fixture.provider();
  assert.deepEqual(provider.getRepositoryFacts(), {
    repository: REPOSITORY, defaultBranch: "main", private: true, url: `https://github.com/${REPOSITORY}`,
  });
  assert.equal(provider.getBranchFacts("loop/TASK-001/exec-1").headSha, HEAD);
  assert.equal(provider.getPullRequestFact(TASK, HEAD).status, "OPEN");
  assert.equal(provider.getPullRequestFact(TASK, HEAD, "different-execution").status, "ABSENT");
  assert.equal(provider.getPullRequestFact(TASK, HEAD_B).status, "UNKNOWN");
  assert.equal(provider.getMergeFact(TASK, HEAD).status, "NOT_STARTED");
  fixture.pr = rawPull({ state: "closed", merged: true });
  assert.deepEqual(provider.getMergeFact(TASK, HEAD), {
    status: "MERGED", merged: true, candidateHead: HEAD, mergeCommit: MERGE, mergedAt: "2026-09-28T11:00:00.000Z",
  });
  assert.equal(provider.getMergeFact(TASK, HEAD_B).status, "UNKNOWN");
  fixture.pr = null;
  assert.equal(provider.getPullRequestFact(TASK, HEAD).status, "ABSENT");
});

test("GitHub REST PR-list shape with omitted merged boolean is normalized from state and merged_at", () => {
  const fixture = new GitHubFixture();
  fixture.pr = { ...rawPull(), merged: undefined };
  assert.equal(fixture.provider().getPullRequestFact(TASK, HEAD, "exec-1").status, "OPEN");
  fixture.pr = { ...rawPull({ state: "closed", merged: true }), merged: undefined };
  assert.equal(fixture.provider().getPullRequestFact(TASK, HEAD, "exec-1").status, "MERGED");
});

test("GitHub PR creation rediscovers by branch/head and requires a current lease before mutation", async () => {
  const fixture = new GitHubFixture();
  const provider = fixture.provider();
  const input = { branch: "loop/TASK-001/exec-1", candidateSha: HEAD, taskId: TASK, executionId: "exec-1", title: "TASK-001 test helper", baseBranch: "main" };
  fixture.pr = null;
  await assert.rejects(provider.createPullRequest(input), { code: "LEASE_REQUIRED" });
  assert.equal(fixture.created, false);
  fixture.pr = rawPull();
  const existing = await provider.createPullRequest(input, { assertLeaseCurrent: async () => {} });
  assert.equal(existing.number, 7);
  assert.equal(fixture.created, false);

  fixture.pr = null;
  const created = await provider.createPullRequest(input, { assertLeaseCurrent: async () => {} });
  assert.equal(created.headSha, HEAD);
  assert.equal(fixture.created, true);
});

test("GitHub merge requires exact-head CI identity, validation, independent review and lease", async () => {
  const fixture = new GitHubFixture();
  const provider = fixture.provider();
  const request = mergeAuthorization();
  await assert.rejects(provider.mergePullRequest(request), { code: "LEASE_REQUIRED" });
  assert.equal(fixture.calls.some((args) => args.includes("PUT")), false);
  const result = await provider.mergePullRequest(request, { assertLeaseCurrent: async () => {} });
  assert.deepEqual(result, { merged: true, candidateHead: HEAD, mergeSha: MERGE, attemptedAt: request.attemptedAt, message: fixture.mergeResponse.message });
  const mergeCall = fixture.calls.find((args) => args[1] === `repos/${REPOSITORY}/pulls/7/merge`);
  assert.ok(mergeCall.includes(`sha=${HEAD}`));
});

test("GitHub merge aborts on stale PR HEAD, unknown mergeability, or unrelated green CI", async () => {
  const fixture = new GitHubFixture();
  const provider = fixture.provider();
  const context = { assertLeaseCurrent: async () => {} };

  fixture.onPrRead = (count, state) => { if (count === 2) state.pr = rawPull({ head: HEAD_B }); };
  await assert.rejects(provider.mergePullRequest(mergeAuthorization(), context), { code: "GITHUB_PR_HEAD_MISMATCH" });
  assert.equal(fixture.calls.some((args) => args.includes("PUT")), false);

  fixture.prReads = 0;
  fixture.onPrRead = null;
  fixture.pr = rawPull({ mergeable: null });
  await assert.rejects(provider.mergePullRequest(mergeAuthorization(), context), { code: "GITHUB_MERGEABILITY_UNKNOWN" });
  assert.equal(fixture.calls.some((args) => args.includes("PUT")), false);

  fixture.pr = rawPull();
  await assert.rejects(provider.mergePullRequest(mergeAuthorization({ ci: { ...mergeAuthorization().ci, workflowIdentity: "unrelated.yml" } }), context), { code: "GITHUB_MERGE_GATES_FAILED" });
  assert.equal(fixture.calls.some((args) => args.includes("PUT")), false);
});

test("GitHub merge rejects a PR retargeted away from the configured base branch", async () => {
  const fixture = new GitHubFixture();
  fixture.pr = rawPull({ base: "release" });
  await assert.rejects(
    fixture.provider().mergePullRequest(mergeAuthorization(), { assertLeaseCurrent: async () => {} }),
    { code: "GITHUB_PR_BASE_MISMATCH" },
  );
  assert.equal(fixture.calls.some((args) => args.includes("PUT")), false);
});

test("GitHub SCM errors and malformed responses fail closed with retry classification", () => {
  const timeout = new GitHubSCMProvider({ owner: "owner", repo: "repo", run: () => { throw Object.assign(new Error("network timed out"), { code: "ETIMEDOUT" }); } });
  assert.throws(() => timeout.getRepositoryFacts(), (error) => error instanceof GitHubSCMError && error.classification === "TRANSIENT");
  const malformed = new GitHubSCMProvider({ owner: "owner", repo: "repo", run: () => "not-json" });
  assert.throws(() => malformed.getRepositoryFacts(), { code: "GITHUB_INVALID_JSON" });
});
