import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalExecutionLeaseProvider, ExecutionLeaseUnavailableError, StaleExecutionLeaseError } from "../src/adapters/local-execution-lease-provider.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function leaseProvider(directory, clock) {
  return new LocalExecutionLeaseProvider({ directory, ...(clock ? { clock } : {}), defaultTtlMs: 100 });
}

const request = (ownerId) => ({
  repository: "owner/repository",
  taskId: "TASK-001",
  executionId: "execution-001",
  ownerId,
});

test("P6-A — lease ownership is durable, expires, and advances the fencing token", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loop-lease-expiry-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  let now = Date.parse("2026-09-28T10:00:00.000Z");
  const clock = () => new Date(now).toISOString();
  const firstProvider = leaseProvider(directory, clock);
  const first = firstProvider.acquire(request("runtime-A"));
  assert.equal(first.fencingToken, 1);
  assert.equal(firstProvider.assertCurrent(first), true);
  assert.throws(() => leaseProvider(directory, clock).acquire(request("runtime-B")), ExecutionLeaseUnavailableError);

  const renewed = firstProvider.renew(first, { ttlMs: 200 });
  assert.equal(renewed.fencingToken, first.fencingToken);
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(first.expiresAt));
  now += 201;

  const restartedProvider = leaseProvider(directory, clock);
  const second = restartedProvider.acquire(request("runtime-B"));
  assert.equal(second.fencingToken, 2);
  assert.throws(() => firstProvider.assertCurrent(first), StaleExecutionLeaseError);
  assert.throws(() => firstProvider.renew(first), StaleExecutionLeaseError);
  assert.throws(() => firstProvider.release(first), StaleExecutionLeaseError);
  assert.equal(restartedProvider.assertCurrent(second), true);
  restartedProvider.release(second);

  const third = leaseProvider(directory, clock).acquire(request("runtime-C"));
  assert.equal(third.fencingToken, 3);
});

test("P6-A — two independent processes cannot own the same execution lease", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "loop-lease-process-race-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const moduleUrl = pathToFileURL(join(ROOT, "src", "adapters", "local-execution-lease-provider.js")).href;
  const script = `
    import { LocalExecutionLeaseProvider } from ${JSON.stringify(moduleUrl)};
    const provider = new LocalExecutionLeaseProvider({ directory: process.argv[1], defaultTtlMs: 5000 });
    const request = { repository: "owner/repository", taskId: "TASK-001", executionId: "race-001", ownerId: process.argv[2] };
    try {
      const lease = provider.acquire(request);
      process.stdout.write(JSON.stringify({ status: "ACQUIRED", fencingToken: lease.fencingToken }) + "\\n");
      process.stdin.once("data", () => { provider.release(lease); process.exit(0); });
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: "CONTENDED", code: error.code }) + "\\n");
      process.exit(error instanceof Error ? 0 : 1);
    }
  `;
  const start = (ownerId) => spawn(process.execPath, ["--input-type=module", "-e", script, directory, ownerId], {
    cwd: ROOT, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const children = [start("runtime-A"), start("runtime-B")];
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null) child.kill();
    }
  });

  const readFirstLine = (child) => new Promise((resolve, reject) => {
    let output = "";
    const timeout = setTimeout(() => reject(new Error("lease child did not report within 5 seconds")), 5000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const lineEnd = output.indexOf("\n");
      if (lineEnd >= 0) {
        clearTimeout(timeout);
        resolve(JSON.parse(output.slice(0, lineEnd)));
      }
    });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("exit", (code) => {
      if (!output.includes("\n")) {
        clearTimeout(timeout);
        reject(new Error(`lease child exited ${code} before reporting: ${output}`));
      }
    });
  });
  const outcomes = await Promise.all(children.map(readFirstLine));
  assert.deepEqual(outcomes.map((item) => item.status).sort(), ["ACQUIRED", "CONTENDED"]);
  assert.equal(outcomes.filter((item) => item.status === "ACQUIRED").length, 1);
  for (const child of children) child.stdin.end("release\n");
  await Promise.all(children.map((child) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("lease child did not exit after release")), 5000);
    child.once("exit", (code) => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`lease child exit ${code}`)); });
  })));
});
