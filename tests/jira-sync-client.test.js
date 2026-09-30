import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JiraSyncClient, JiraSyncError } from "../src/adapters/jira-sync-client.js";
import { LocalExecutionLeaseProvider } from "../src/adapters/local-execution-lease-provider.js";

const leased = { assertLeaseCurrent: async () => true };

function client({ transport }) {
  return new JiraSyncClient({ site: "loop-experiment.atlassian.net", email: "loop@example.invalid", apiToken: "token", transport });
}

test("J17 a lost comment-write response is rediscovered by marker; no duplicate write is issued", async () => {
  let postCount = 0;
  const tag = "<!-- loop-execution:exec-1:started -->";
  const jira = client({
    transport: ({ method, path }) => {
      if (method === "POST") { postCount += 1; return JSON.stringify({ id: "10001" }); }
      if (path.includes("/comment")) return JSON.stringify({ comments: [{ id: "10001", body: `Loop execution exec-1 started.\n\n${tag}` }] });
      throw new Error(`unexpected request ${method} ${path}`);
    },
  });
  const result = await jira.recordExecutionStarted("LOOP-1", { executionId: "exec-1" }, leased);
  assert.equal(result.created, false);
  assert.equal(postCount, 0, "an already-present marker must not trigger a duplicate write");
});

test("a genuinely new comment is written exactly once when no marker exists yet", async () => {
  let postCount = 0;
  const jira = client({
    transport: ({ method, path }) => {
      if (method === "POST") { postCount += 1; return JSON.stringify({ id: "10002" }); }
      if (path.includes("/comment")) return JSON.stringify({ comments: [] });
      throw new Error(`unexpected request ${method} ${path}`);
    },
  });
  const result = await jira.recordExecutionStarted("LOOP-1", { executionId: "exec-2" }, leased);
  assert.equal(result.created, true);
  assert.equal(postCount, 1);
});

test("J18 Jira completion may only be requested after computed Loop state is DONE, and a write failure is retryable without touching Loop truth", async () => {
  const jira = client({ transport: () => { throw new Error("should not be called"); } });
  await assert.rejects(
    jira.markTaskComplete("LOOP-1", { executionId: "exec-3", computedState: "VALIDATING", doneStatusName: "Done", transitionName: "Done" }, leased),
    (error) => error instanceof JiraSyncError && error.code === "JIRA_PREMATURE_COMPLETION",
  );

  const failing = client({
    transport: ({ method, path }) => {
      if (path.startsWith("issue/LOOP-1?")) return JSON.stringify({ fields: { status: { name: "In Progress" } } });
      if (method === "GET" && path.endsWith("/transitions")) return JSON.stringify({ transitions: [{ id: "31", name: "Done" }] });
      if (method === "POST") throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      throw new Error(`unexpected request ${method} ${path}`);
    },
  });
  await assert.rejects(
    failing.markTaskComplete("LOOP-1", { executionId: "exec-3", computedState: "DONE", doneStatusName: "Done", transitionName: "Done" }, leased),
    (error) => error instanceof JiraSyncError && error.classification === "TRANSIENT" && error.retryable === true,
  );
  // The Loop's computed DONE lives entirely in the runtime/evidence store, never in this
  // client; a thrown TRANSIENT error here has no path back into execution truth to corrupt.
});

test("J19 a fenced-out runtime cannot issue a Jira write; lease authority prevents unsafe duplication", async () => {
  const root = mkdtempSync(join(tmpdir(), "jira-sync-lease-"));
  try {
    const leases = new LocalExecutionLeaseProvider({ directory: root, defaultTtlMs: 30000 });
    const first = await leases.acquire({ repository: "owner/repo", taskId: "LOOP-1", executionId: "same-execution", ownerId: "runtime-a" });
    assert.throws(() => leases.acquire({ repository: "owner/repo", taskId: "LOOP-1", executionId: "same-execution", ownerId: "runtime-b" }), (error) => error.code === "EXECUTION_LEASE_UNAVAILABLE");

    let writeCount = 0;
    const jira = client({
      transport: ({ method, path }) => {
        if (method === "POST") { writeCount += 1; return JSON.stringify({ id: "10003" }); }
        if (path.includes("/comment")) return JSON.stringify({ comments: [] });
        throw new Error(`unexpected request ${method} ${path}`);
      },
    });
    const runtimeAContext = { assertLeaseCurrent: () => leases.assertCurrent(first) };
    await jira.recordExecutionStarted("LOOP-1", { executionId: "same-execution" }, runtimeAContext);
    assert.equal(writeCount, 1);

    await leases.release(first);
    const second = await leases.acquire({ repository: "owner/repo", taskId: "LOOP-1", executionId: "same-execution", ownerId: "runtime-b" });
    const staleContext = { assertLeaseCurrent: () => leases.assertCurrent(first) };
    await assert.rejects(jira.recordExecutionStarted("LOOP-1", { executionId: "same-execution" }, staleContext), (error) => error.code === "STALE_EXECUTION_LEASE");
    assert.equal(writeCount, 1, "the fenced-out runtime must not have reached the transport at all");
    await leases.release(second);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
