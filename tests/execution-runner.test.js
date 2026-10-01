import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { makeWorkPackage } from "../src/controller/work-package.js";
import { ExecutionRunner } from "../src/controller/execution-runner.js";
import { AgentExecutor } from "../src/controller/ports.js";
import { SqliteExecutionAttemptStore, ATTEMPT_TRANSITIONS } from "../src/adapters/sqlite-execution-attempt-store.js";
import { SyntheticGitAgent } from "../src/testing/synthetic-git-agent.js";
import { resolveSha } from "../src/adapters/git-workspace.js";
import { makeRepo } from "./helpers/git-repo.js";

/** Execution-attempt store + ExecutionRunner with REAL Git. Crashes are simulated in-process here; real process kills are in execution-crash-process.test.js. */
const STAMP = "2026-10-02T12:00:00.000Z";
const snapshot = makePlanSnapshot({ documentId: "doc-1", compiled: compilePlan("LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\nTASK_ID: TASK-001\nTITLE: Only task\nAC:\n- AC-001: it works\nEND_LOOP_EXECUTION_PLAN\n"), fetchedAt: STAMP, compiledAt: STAMP });
const WP = makeWorkPackage({ snapshot, taskId: "TASK-001", repository: { identity: "synthetic/repo", baseRef: "main" } });

/** Simulated process crash: a fault hook that throws a recognizable error; the next runner/agent instance is a "restart". */
class Crash extends Error {}
const crashAt = (name) => ({ [name]: () => { throw new Crash(name); } });

function fixture(t) {
  const repo = makeRepo();
  const dir = mkdtempSync(join(tmpdir(), "exec-runner-"));
  const dbPath = join(dir, "attempts.sqlite");
  const stores = [];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); repo.cleanup(); });
  const open = () => { const s = new SqliteExecutionAttemptStore({ path: dbPath, clock: () => STAMP }); stores.push(s); return s; };
  const runner = ({ agent, faultPoints = {}, attemptStore = open() } = {}) => new ExecutionRunner({ attemptStore, agent, repoPath: repo.path, workspacesDir: join(dir, "ws"), faultPoints });
  const agent = (opts = {}) => new SyntheticGitAgent({ recordPath: join(dir, "calls.jsonl"), crashMarkerDir: dir, ...opts });
  const calls = () => { try { return readFileSync(join(dir, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  return { repo, dir, open, runner, agent, calls, workspace: join(dir, "ws", WP.executionId) };
}

// ---------- attempt store ----------
test("attempt store: PREPARED is persisted once with workspace identity; idempotent; identity conflicts rejected; durable across reopen", (t) => {
  const { open, repo } = fixture(t);
  const base = resolveSha(repo.path, "main");
  const spec = { executionId: "e1", taskId: "T-1", workPackageId: "wp1", planBinding: { planVersion: 1 }, repositoryIdentity: "r", baseSha: base, workspacePath: "/ws/e1", branch: "loop/T-1/e1" };
  const store = open();
  assert.equal(store.prepare(spec).created, true);
  assert.equal(store.prepare(spec).created, false);
  assert.throws(() => store.prepare({ ...spec, workspacePath: "/elsewhere" }), { code: "EXECUTION_IDENTITY_CONFLICT" });
  const reopened = open();
  const attempt = reopened.get("e1");
  assert.deepEqual([attempt.status, attempt.workspacePath, attempt.branch, attempt.baseSha, attempt.agentInvocations, attempt.agentResult], ["PREPARED", "/ws/e1", "loop/T-1/e1", base, 0, null]);
});

test("attempt store: every transition outside the model is rejected by the database; results are write-once; terminal states are final; nothing is deleted", (t) => {
  const { open, repo } = fixture(t);
  const base = resolveSha(repo.path, "main");
  const store = open();
  let n = 0;
  const make = (state) => {
    const id = `e${n++}`;
    store.prepare({ executionId: id, taskId: "T-1", workPackageId: `wp${id}`, planBinding: {}, repositoryIdentity: "r", baseSha: base, workspacePath: `/ws/${id}`, branch: `b${id}` });
    const path = { PREPARED: [], AGENT_RUNNING: ["AGENT_RUNNING"], RECOVERY_REQUIRED: ["AGENT_RUNNING", "RECOVERY_REQUIRED"], IMPLEMENTATION_PRESENT: ["AGENT_RUNNING", "IMPLEMENTATION_PRESENT"], FAILED: ["AGENT_RUNNING", "FAILED"] }[state];
    let from = "PREPARED";
    for (const to of path) { store.transition(id, from, to); from = to; }
    return id;
  };
  for (const from of ["PREPARED", "AGENT_RUNNING", "RECOVERY_REQUIRED", "IMPLEMENTATION_PRESENT", "FAILED"]) {
    for (const to of ["PREPARED", "AGENT_RUNNING", "RECOVERY_REQUIRED", "IMPLEMENTATION_PRESENT", "FAILED", "AGENT_RESULT_RECORDED"]) {
      if (from === to || to === "AGENT_RESULT_RECORDED") continue;
      const id = make(from);
      const sql = () => store.db.prepare("UPDATE execution_attempts SET status = ? WHERE execution_id = ?").run(to, id);
      if (ATTEMPT_TRANSITIONS[from].includes(to) && to !== "AGENT_RESULT_RECORDED") sql(); else assert.throws(sql, /invalid execution attempt transition|constraint/i, `${from} -> ${to}`);
    }
  }
  const id = make("AGENT_RUNNING");
  const result = { head: "a".repeat(40) };
  assert.equal(store.recordResult(id, "AGENT_RUNNING", result, "AGENT").status, "AGENT_RESULT_RECORDED");
  assert.throws(() => store.db.prepare("UPDATE execution_attempts SET agent_result = '{}' WHERE execution_id = ?").run(id), /never replaced|invalid execution attempt transition/);
  assert.throws(() => store.transition(id, "AGENT_RESULT_RECORDED", "AGENT_RUNNING"), /invalid execution attempt transition/);
  assert.throws(() => store.db.prepare("UPDATE execution_attempts SET workspace_path = '/x' WHERE execution_id = ?").run(id), /immutable|invalid/);
  assert.throws(() => store.db.prepare("DELETE FROM execution_attempts").run(), /never deleted/);
  assert.throws(() => store.db.prepare("UPDATE execution_attempts SET status = 'AGENT_RESULT_RECORDED' WHERE execution_id = ?").run(make("PREPARED")), /constraint|invalid/i, "a result status without a result is impossible");
});

test("attempt store counts agent invocations durably", (t) => {
  const { open, repo } = fixture(t);
  const store = open();
  store.prepare({ executionId: "e", taskId: "T", workPackageId: "w", planBinding: {}, repositoryIdentity: "r", baseSha: resolveSha(repo.path, "main"), workspacePath: "/w", branch: "b" });
  store.transition("e", "PREPARED", "AGENT_RUNNING");
  store.transition("e", "AGENT_RUNNING", "RECOVERY_REQUIRED");
  store.transition("e", "RECOVERY_REQUIRED", "AGENT_RUNNING");
  assert.equal(open().get("e").agentInvocations, 2);
});

// ---------- runner: crash windows (simulated) ----------
test("A: crash after PREPARED, before the agent -> restart runs the agent exactly once", async (t) => {
  const c = fixture(t);
  await assert.rejects(c.runner({ agent: c.agent(), faultPoints: crashAt("after_attempt_prepared") }).ensureImplementation(WP), Crash);
  assert.equal(c.calls().length, 0);
  assert.equal(c.open().get(WP.executionId).status, "PREPARED");
  const agent = c.agent();
  const result = await c.runner({ agent }).ensureImplementation(WP);
  assert.deepEqual(c.calls().map((x) => x.mode), ["execute"]);
  assert.equal(c.open().get(WP.executionId).status, "AGENT_RESULT_RECORDED");
  assert.match(result.head, /^[0-9a-f]{40}$/);
});

test("B: agent started, changed nothing, died -> restart classifies NO_IMPLEMENTATION_PRESENT and safely retries the SAME execution", async (t) => {
  const c = fixture(t);
  await assert.rejects(c.runner({ agent: c.agent(), faultPoints: crashAt("after_agent_running_persisted") }).ensureImplementation(WP), Crash);
  assert.equal(c.open().get(WP.executionId).status, "AGENT_RUNNING");
  assert.equal(c.calls().length, 0, "the agent had not produced anything yet");
  const result = await c.runner({ agent: c.agent() }).ensureImplementation(WP);
  const attempt = c.open().get(WP.executionId);
  assert.deepEqual([attempt.status, attempt.agentInvocations, attempt.resultSource, attempt.classification], ["AGENT_RESULT_RECORDED", 2, "AGENT", "NO_IMPLEMENTATION_PRESENT"]);
  assert.deepEqual(c.calls().map((x) => x.mode), ["execute"], "one successful implementation");
  assert.equal(c.repo.run(["rev-list", "--count", `main..${attempt.branch}`]), "1");
  assert.ok(result.head);
});

test("C: uncommitted work exists, no durable result -> preserved byte for byte, NOT reimplemented from a clean baseline; the recoverable executor resumes", async (t) => {
  const c = fixture(t);
  const file = join(c.workspace, "impl", "TASK-001.txt");
  // the agent died after writing files but before committing (simulated by writing exactly what execute() writes, then 'crashing')
  await assert.rejects(c.runner({ agent: new (class extends SyntheticGitAgent { async execute(wp, ctx) { mkdirSync(join(ctx.workspace.path, "impl"), { recursive: true }); writeFileSync(join(ctx.workspace.path, "impl", `${wp.taskId}.txt`), "partial work by the first agent\n"); throw new Crash("agent died"); } })({ recordPath: join(c.dir, "calls.jsonl") }) }).ensureImplementation(WP), Crash);
  const before = readFileSync(file, "utf8");
  assert.equal(before, "partial work by the first agent\n");
  const agent = c.agent();
  await c.runner({ agent }).ensureImplementation(WP);
  const attempt = c.open().get(WP.executionId);
  assert.deepEqual([attempt.status, attempt.resultSource, attempt.classification], ["AGENT_RESULT_RECORDED", "AGENT_RESUME", "IMPLEMENTATION_PRESENT_UNVERIFIED"]);
  assert.deepEqual(c.calls().map((x) => x.mode), ["resume"], "the fresh-implementation path was NOT taken");
  assert.equal(c.calls()[0].preservedBytes, Buffer.byteLength(before));
  assert.ok(readFileSync(file, "utf8").startsWith(before), "the earlier work survived inside the final implementation");
  assert.equal(c.repo.run(["rev-list", "--count", `main..${attempt.branch}`]), "1");
});

test("C2: uncommitted work and a NON-recoverable executor -> OWNER_DECISION_REQUIRED, nothing discarded", async (t) => {
  const c = fixture(t);
  class Plain extends AgentExecutor { async execute() { throw new Crash("died"); } }
  const dirty = join(c.workspace, "impl", "TASK-001.txt");
  const partial = new (class extends Plain { async execute(wp, ctx) { mkdirSync(join(ctx.workspace.path, "impl"), { recursive: true }); writeFileSync(dirty, "unsaved\n"); throw new Crash("died"); } })();
  await assert.rejects(c.runner({ agent: partial }).ensureImplementation(WP), Crash);
  await assert.rejects(c.runner({ agent: new Plain() }).ensureImplementation(WP), (e) => e.code === "EXECUTION_OWNER_DECISION_REQUIRED" && e.classification === "OWNER_REQUIRED");
  assert.equal(readFileSync(dirty, "utf8"), "unsaved\n", "no reset, no clean");
  assert.equal(c.open().get(WP.executionId).status, "IMPLEMENTATION_PRESENT");
});

test("D: durable result persisted, consumer dies before reading it -> restart returns the stored result with ZERO second agent calls", async (t) => {
  const c = fixture(t);
  await assert.rejects(c.runner({ agent: c.agent(), faultPoints: crashAt("after_agent_result_recorded") }).ensureImplementation(WP), Crash);
  assert.equal(c.calls().length, 1);
  const stored = c.open().get(WP.executionId);
  assert.equal(stored.status, "AGENT_RESULT_RECORDED");
  const recovered = await c.runner({ agent: c.agent() }).ensureImplementation(WP);
  assert.equal(c.calls().length, 1, "no second agent call");
  assert.deepEqual({ ...recovered }, { ...stored.agentResult });
});

test("E: agent committed, died before reporting -> Git reconciliation adopts the commit; no second implementation", async (t) => {
  const c = fixture(t);
  const dying = new (class extends SyntheticGitAgent { async execute(wp, ctx) { await super.execute(wp, ctx); throw new Crash("died after commit"); } })({ recordPath: join(c.dir, "calls.jsonl") });
  await assert.rejects(c.runner({ agent: dying }).ensureImplementation(WP), Crash);
  const result = await c.runner({ agent: c.agent() }).ensureImplementation(WP);
  const attempt = c.open().get(WP.executionId);
  assert.deepEqual([attempt.status, attempt.resultSource, attempt.classification], ["AGENT_RESULT_RECORDED", "GIT_RECONCILIATION", "COMMITTED_IMPLEMENTATION_PRESENT"]);
  assert.deepEqual(c.calls().map((x) => x.mode), ["execute"], "only the original (crashed) invocation ever ran");
  assert.equal(c.repo.run(["rev-list", "--count", `main..${attempt.branch}`]), "1");
  assert.equal(result.head, c.repo.run(["rev-parse", attempt.branch]));
  assert.deepEqual(result.changedFiles, ["impl/TASK-001.txt"]);
});

test("ambiguous state (a foreign commit in the execution branch) -> OWNER_DECISION_REQUIRED, no agent call, workspace untouched", async (t) => {
  const c = fixture(t);
  await assert.rejects(c.runner({ agent: c.agent(), faultPoints: crashAt("after_agent_running_persisted") }).ensureImplementation(WP), Crash);
  writeFileSync(join(c.workspace, "foreign.txt"), "someone else's work\n");
  c.repo.run(["add", "-A"], c.workspace);
  c.repo.run(["-c", "user.name=X", "-c", "user.email=x@example.invalid", "commit", "-q", "-m", "foreign commit without trailers"], c.workspace);
  const headBefore = c.repo.run(["rev-parse", "HEAD"], c.workspace);
  await assert.rejects(c.runner({ agent: c.agent() }).ensureImplementation(WP), (e) => e.code === "EXECUTION_OWNER_DECISION_REQUIRED" && e.reasons.includes("FOREIGN_COMMIT"));
  assert.equal(c.calls().length, 0);
  assert.equal(c.repo.run(["rev-parse", "HEAD"], c.workspace), headBefore, "history untouched");
  assert.equal(readFileSync(join(c.workspace, "foreign.txt"), "utf8"), "someone else's work\n");
  assert.equal(c.open().get(WP.executionId).status, "RECOVERY_REQUIRED");
});

test("the agent's narrative is not trusted: a result whose head disagrees with Git is refused and the workspace is preserved", async (t) => {
  const c = fixture(t);
  const lying = new (class extends SyntheticGitAgent { async execute(wp, ctx) { const r = await super.execute(wp, ctx); return { ...r, head: "f".repeat(40) }; } })({ recordPath: join(c.dir, "calls.jsonl") });
  await assert.rejects(c.runner({ agent: lying }).ensureImplementation(WP), (e) => e.code === "EXECUTION_OWNER_DECISION_REQUIRED");
  const attempt = c.open().get(WP.executionId);
  assert.deepEqual([attempt.status, attempt.agentResult], ["RECOVERY_REQUIRED", null]);
  assert.equal(c.repo.run(["rev-list", "--count", `main..${attempt.branch}`]), "1", "the real commit is still there");
});

test("every recovery decision is deterministic code: runner/store/workspace sources reference no model", () => {
  for (const file of ["../src/controller/execution-runner.js", "../src/adapters/git-workspace.js", "../src/adapters/sqlite-execution-attempt-store.js", "../src/testing/synthetic-git-agent.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/anthropic|openai|\bllm\b|claude|codex|hermes|Math\.random|fetch\(/i.test(text), file);
  }
});
