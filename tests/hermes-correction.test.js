import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HermesAgentExecutor, HermesExecutorError } from "../src/adapters/hermes-agent-executor.js";
import { ensureWorkspace } from "../src/adapters/git-workspace.js";
import { agentCapabilities, AgentExecutor } from "../src/controller/ports.js";
import { validateReviewerOutput } from "../src/controller/gate-ports.js";

/** HermesAgentExecutor.correct(): the generic correction capability, proven against a real Git workspace with a scripted `hermes` CLI. */
const wp = { executionId: "exec-c1", taskId: "task-c1", workPackageId: "wp-c1", title: "t", acceptanceCriteria: [{ id: "AC-1", text: "works" }], repository: { identity: "repo" } };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const AUTHOR = ["-c", "user.name=Agent", "-c", "user.email=agent@example.invalid"];
const trailers = `\n\nLoop-Execution-Id: ${wp.executionId}\nLoop-Task-Id: ${wp.taskId}`;

/** A repo whose workspace already holds the implementation commit H1 (as after a recorded agent result). */
function repoWithImplementation() {
  const root = mkdtempSync(join(tmpdir(), "hermes-corr-"));
  git(root, ["init", "-q", "-b", "main"]); git(root, ["config", "user.email", "o@example.invalid"]); git(root, ["config", "user.name", "Owner"]);
  writeFileSync(join(root, "base"), "base\n"); git(root, ["add", "."]); git(root, ["commit", "-qm", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]); const branch = "loop/task-c1/exec-c1";
  const ws = ensureWorkspace({ repoPath: root, workspacesDir: join(root, ".ws"), executionId: wp.executionId, taskId: wp.taskId, baseSha, branch });
  writeFileSync(join(ws.path, "impl"), "v1\n"); git(ws.path, ["add", "."]); git(ws.path, [...AUTHOR, "commit", "-qm", `impl${trailers}`]);
  return { root, workspace: { path: ws.path, baseSha, branch }, h1: git(ws.path, ["rev-parse", "HEAD"]) };
}
const findings = [{ id: "F-1", summary: "add a test" }, { id: "F-2", summary: "line\n--flag $HOME ☃" }];
const ctx = (r, extra = {}) => ({ workspace: r.workspace, findings, round: 0, facts: null, ...extra });

/** Scripted hermes: records create calls (with the body-file content), dedupes on key, runs `work(workspace)` once, reports done. */
function cli(work) {
  const state = { creates: [], tasks: new Map(), works: 0 };
  const run = async (args) => {
    if (args.includes("create")) {
      const key = args[args.indexOf("--idempotency-key") + 1];
      if (!state.tasks.has(key)) { state.tasks.set(key, `h-${state.tasks.size + 1}`); state.creates.push({ args, key, body: readFileSync(args[args.indexOf("--body-file") + 1], "utf8"), workspace: args[args.indexOf("--workspace") + 1] }); }
      return { stdout: JSON.stringify({ id: state.tasks.get(key) }) };
    }
    if (state.works === 0 && work) { state.works += 1; await work(state); }
    return { stdout: JSON.stringify({ status: "done" }) };
  };
  return { run, state };
}
const commitFix = (r, { amend = false, trailer = true, dirty = false } = {}) => () => {
  writeFileSync(join(r.workspace.path, "impl"), `fix-${Math.random()}\n`); git(r.workspace.path, ["add", "."]);
  git(r.workspace.path, [...AUTHOR, "commit", ...(amend ? ["--amend"] : []), "-qm", `fix${trailer ? trailers : ""}`]);
  if (dirty) writeFileSync(join(r.workspace.path, "untracked"), "x");
};

test("correct() is a generic capability: advertised through agentCapabilities, absent from a bare AgentExecutor", () => {
  assert.deepEqual(agentCapabilities(new HermesAgentExecutor()), { execute: true, resume: true, correct: true });
  assert.deepEqual(agentCapabilities(new AgentExecutor()), { execute: true, resume: false, correct: false });
  assert.deepEqual(agentCapabilities(null), { execute: false, resume: false, correct: false });
});

test("a correction produces a NEW owned, clean commit on top of the reviewed head; the result comes from Git", async () => {
  const r = repoWithImplementation();
  const { run } = cli(commitFix(r));
  const result = await new HermesAgentExecutor({ pollMs: 0, run }).correct(wp, ctx(r));
  assert.notEqual(result.head, r.h1);
  assert.equal(result.head, git(r.workspace.path, ["rev-parse", "HEAD"]));
  assert.equal(git(r.workspace.path, ["rev-list", "--count", `${r.h1}..${result.head}`]), "1");
  assert.equal(result.branch, r.workspace.branch);
  assert.equal(result.base, r.workspace.baseSha);
});

test("the Hermes task carries the findings as data (private body file), the reviewed head, the same workspace/branch, a round+head-bound key and the trailers", async () => {
  const r = repoWithImplementation();
  const { run, state } = cli(commitFix(r));
  await new HermesAgentExecutor({ pollMs: 0, run, board: "b1", coderAssignee: "coder-1" }).correct(wp, ctx(r, { round: 2 }));
  const [create] = state.creates;
  assert.equal(create.key, `loop-${wp.executionId}-correct-2-${r.h1.slice(0, 12)}`);
  assert.equal(create.workspace, `dir:${r.workspace.path}`);
  assert.ok(create.args.includes("b1") && create.args.includes("coder-1"));
  assert.ok(!create.args.some((a) => a.includes("add a test")), "findings never travel in argv");
  assert.match(create.body, /Correction round 2./);
  assert.match(create.body, /- F-1: add a test/);
  assert.ok(create.body.includes("line\n--flag $HOME ☃"), "hostile finding text is preserved verbatim");
  assert.ok(create.body.includes(r.h1) && create.body.includes(r.workspace.branch));
  assert.ok(create.body.includes(`Loop-Execution-Id: ${wp.executionId} and Loop-Task-Id: ${wp.taskId}.`));
  assert.match(create.body, /never amend, rebase, reset, force/);
  assert.ok(!/Recovery scope/.test(create.body));
});

test("an interrupted correction is resumed, not discarded: the body says to preserve existing uncommitted work", async () => {
  const r = repoWithImplementation();
  writeFileSync(join(r.workspace.path, "half-done"), "keep me");
  const { run, state } = cli(async () => { git(r.workspace.path, ["add", "-A"]); git(r.workspace.path, [...AUTHOR, "commit", "-qm", `fix${trailers}`]); });
  await new HermesAgentExecutor({ pollMs: 0, run }).correct(wp, ctx(r, { facts: { dirty: true } }));
  assert.match(state.creates[0].body, /Recovery scope: .*preserve and build on all existing uncommitted work/);
  assert.equal(readFileSync(join(r.workspace.path, "half-done"), "utf8"), "keep me");
});

test("restart safety: after a lost response, a second call for the same round and head re-attaches to the SAME task (one create, one commit)", async () => {
  const r = repoWithImplementation();
  const base = cli(commitFix(r));
  let failFirstShow = true;
  const run = async (args) => {
    if (!args.includes("create") && failFirstShow) { failFirstShow = false; throw Object.assign(new Error("connection lost"), { code: "ECONNRESET" }); }
    return base.run(args);
  };
  const e = new HermesAgentExecutor({ pollMs: 0, run });
  await assert.rejects(e.correct(wp, ctx(r)), (error) => error.code === "HERMES_COMMAND_FAILED" && error.retryable === true);
  const result = await e.correct(wp, ctx(r));
  assert.equal(base.state.creates.length, 1, "the second call attached to the existing task through the idempotency key");
  assert.equal(git(r.workspace.path, ["rev-list", "--count", `${r.h1}..${result.head}`]), "1");
});

for (const [name, work, code] of [
  ["done without any new commit", null, "HERMES_CORRECTION_INCOMPLETE"],
  ["a commit without the execution trailers (foreign commit)", (r) => commitFix(r, { trailer: false }), "HERMES_CORRECTION_INCOMPLETE"],
  ["history rewritten with --amend (not a fast-forward of the reviewed head)", (r) => commitFix(r, { amend: true }), "HERMES_CORRECTION_INCOMPLETE"],
  ["a new commit but uncommitted leftovers", (r) => commitFix(r, { dirty: true }), "HERMES_CORRECTION_INCOMPLETE"],
]) {
  test(`a correction is rejected: ${name}`, async () => {
    const r = repoWithImplementation();
    const { run } = cli(work ? work(r) : null);
    await assert.rejects(new HermesAgentExecutor({ pollMs: 0, run }).correct(wp, ctx(r)), (error) => error.code === code && error.classification === "TASK_FAILURE");
  });
}

test("correct() fails closed on bad input: no findings, no workspace; and Hermes errors keep their classification", async () => {
  const r = repoWithImplementation();
  const e = new HermesAgentExecutor({ pollMs: 0, run: cli(null).run });
  await assert.rejects(e.correct(wp, ctx(r, { findings: [] })), TypeError);
  await assert.rejects(e.correct(wp, { findings }), TypeError);
  await assert.rejects(e.correct(null, ctx(r)), TypeError);
  const blocked = async (args) => (args.includes("create") ? { stdout: JSON.stringify({ id: "h-9" }) } : { stdout: JSON.stringify({ status: "blocked" }) });
  await assert.rejects(new HermesAgentExecutor({ pollMs: 0, run: blocked }).correct(wp, ctx(r)), (error) => error.code === "HERMES_BLOCKED");
  const down = async () => { throw Object.assign(new Error("x"), { code: "ENOENT" }); };
  await assert.rejects(new HermesAgentExecutor({ run: down }).correct(wp, ctx(r)), (error) => error.code === "HERMES_UNAVAILABLE" && error.retryable === true && error.classification === "TRANSIENT");
});

test("a reviewer finding may declare ownerDecision; absent means repairable, and the flag survives validation", () => {
  const out = validateReviewerOutput({ verdict: "FINDINGS", reviewerId: "r", findings: [{ id: "a", summary: "fix it" }, { id: "b", summary: "decide", ownerDecision: true }, { id: "c", summary: "x", ownerDecision: "yes" }] });
  assert.equal("ownerDecision" in out.findings[0], false);
  assert.equal(out.findings[1].ownerDecision, true);
  assert.equal("ownerDecision" in out.findings[2], false, "only a literal true counts");
});
