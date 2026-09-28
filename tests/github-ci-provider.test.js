import assert from "node:assert/strict";
import test from "node:test";
import { GitHubCIError, GitHubCIProvider } from "../src/adapters/github-ci-provider.js";

const SHA = "d".repeat(40);
const OTHER_SHA = "e".repeat(40);
const REPOSITORY = "owner/souza-loop-sandbox";
const WORKFLOW = ".github/workflows/validate.yml";

function runRecord(overrides = {}) {
  return {
    id: 934,
    name: "Validate",
    path: WORKFLOW,
    head_sha: SHA,
    status: "completed",
    conclusion: "success",
    created_at: "2026-09-28T10:00:00.000Z",
    updated_at: "2026-09-28T10:02:00.000Z",
    run_attempt: 1,
    repository: { full_name: REPOSITORY },
    ...overrides,
  };
}

function providerWith(runs) {
  const calls = [];
  const provider = new GitHubCIProvider({
    owner: "owner", repo: "souza-loop-sandbox", workflowIdentity: WORKFLOW,
    run: (args) => { calls.push(args); return JSON.stringify({ workflow_runs: runs }); },
  });
  return { provider, calls };
}

test("GitHub CI accepts only configured workflow success for the exact repository and SHA", () => {
  const unrelated = runRecord({ id: 1, path: ".github/workflows/lint.yml" });
  const wrongHead = runRecord({ id: 2, head_sha: OTHER_SHA });
  const { provider, calls } = providerWith([unrelated, wrongHead, runRecord()]);
  const result = provider.getCIResult(SHA);
  assert.deepEqual(result, {
    head: SHA, status: "PASS", checkedAt: "2026-09-28T10:02:00.000Z", runId: "934",
    repository: REPOSITORY, workflowIdentity: WORKFLOW, conclusion: "success",
  });
  assert.match(calls[0][1], new RegExp(encodeURIComponent(SHA)));
});

test("GitHub CI maps pending/failure/unknown conclusions without semantic guessing", () => {
  for (const [run, expected] of [
    [runRecord({ status: "queued", conclusion: null }), "PENDING"],
    [runRecord({ status: "in_progress", conclusion: null }), "PENDING"],
    [runRecord({ status: "completed", conclusion: "failure" }), "FAIL"],
    [runRecord({ status: "completed", conclusion: "timed_out" }), "FAIL"],
    [runRecord({ status: "completed", conclusion: "cancelled" }), "UNKNOWN"],
    [runRecord({ status: "completed", conclusion: "skipped" }), "UNKNOWN"],
    [runRecord({ status: "completed", conclusion: "neutral" }), "UNKNOWN"],
  ]) {
    const { provider } = providerWith([run]);
    assert.equal(provider.getCIResult(SHA).status, expected, `${run.status}/${run.conclusion}`);
  }
});

test("GitHub CI selects the newest matching run and ignores green runs for unrelated identity", () => {
  const oldPass = runRecord({ id: 10, created_at: "2026-09-28T09:00:00.000Z", updated_at: "2026-09-28T09:10:00.000Z" });
  const newerPending = runRecord({ id: 11, status: "in_progress", conclusion: null, created_at: "2026-09-28T10:00:00.000Z", updated_at: null });
  const { provider } = providerWith([oldPass, newerPending, runRecord({ id: 12, path: ".github/workflows/other.yml" })]);
  assert.equal(provider.getCIResult(SHA).status, "PENDING");

  const missing = providerWith([runRecord({ path: ".github/workflows/other.yml" })]).provider;
  const absent = missing.getCIResult(SHA);
  assert.equal(absent.status, "UNKNOWN");
  assert.equal(absent.runId, null);
});

test("GitHub CI fails closed on malformed success and reports provider timeout as retryable", () => {
  const missingTime = providerWith([runRecord({ updated_at: null })]).provider;
  assert.throws(() => missingTime.getCIResult(SHA), { code: "GITHUB_CI_INVALID_SCHEMA" });
  const malformed = new GitHubCIProvider({ owner: "owner", repo: "repo", workflowIdentity: WORKFLOW, run: () => "{}" });
  assert.throws(() => malformed.getCIResult(SHA), { code: "GITHUB_CI_INVALID_SCHEMA" });
  const timeout = new GitHubCIProvider({
    owner: "owner", repo: "repo", workflowIdentity: WORKFLOW,
    run: () => { throw Object.assign(new Error("request timed out"), { code: "ETIMEDOUT" }); },
  });
  assert.throws(() => timeout.getCIResult(SHA), (error) => error instanceof GitHubCIError && error.classification === "TRANSIENT" && error.retryable === true);
  assert.throws(() => timeout.getCIResult("not-a-sha"), TypeError);
});
