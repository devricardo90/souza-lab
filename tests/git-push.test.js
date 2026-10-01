import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pushExactHead, PushError } from "../src/adapters/git-push.js";
import { makeRepo } from "./helpers/git-repo.js";

/** Exact-HEAD push with remote reconciliation, against a REAL local bare remote. */
function fixture(t) {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  const bare = join(repo.root, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", bare], { windowsHide: true });
  repo.run(["remote", "add", "origin", bare]);
  repo.run(["push", "-q", "origin", "main"]);
  repo.run(["checkout", "-q", "-b", "loop/T/e1"]);
  const remoteHead = async (branch) => { try { return execFileSync("git", ["--git-dir", bare, "rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); } catch { return null; } };
  const commit = (name, content = name) => { mkdirSync(join(repo.path, "impl"), { recursive: true }); writeFileSync(join(repo.path, "impl", name), `${content}\n`); repo.run(["add", "-A"]); repo.run(["commit", "-q", "-m", `add ${name}`]); return repo.head(); };
  const push = (over = {}) => pushExactHead({ workspacePath: repo.path, branch: "loop/T/e1", expectedHead: repo.head(), readRemoteHead: remoteHead, ...over });
  return { repo, bare, remoteHead, commit, push };
}

test("push: absent remote branch -> pushed, and CONFIRMED only because the remote head was read back", async (t) => {
  const f = fixture(t);
  const h1 = f.commit("a.txt");
  assert.equal(await f.remoteHead("loop/T/e1"), null);
  const result = await f.push();
  assert.deepEqual([result.pushed, result.confirmed, result.remoteHead, result.reason], [true, true, h1, "PUSHED_AND_CONFIRMED"]);
  assert.equal(await f.remoteHead("loop/T/e1"), h1);
});

test("push recovery: the remote already has the exact HEAD (crash after push) -> idempotent, no push command, still confirmed", async (t) => {
  const f = fixture(t);
  const h1 = f.commit("a.txt");
  f.repo.run(["push", "-q", "origin", "loop/T/e1"]); // the previous process pushed, then died before recording it
  let readCount = 0;
  const result = await f.push({ readRemoteHead: async (b) => { readCount += 1; return f.remoteHead(b); } });
  assert.deepEqual([result.pushed, result.confirmed, result.reason, readCount], [false, true, "ALREADY_AT_EXPECTED_HEAD", 1]);
  assert.equal(await f.remoteHead("loop/T/e1"), h1);
});

test("a correction commit (fast-forward) is pushed normally; a diverged remote is refused and left untouched (never force)", async (t) => {
  const f = fixture(t);
  const h1 = f.commit("a.txt");
  await f.push();
  const h2 = f.commit("b.txt");
  const forward = await f.push();
  assert.deepEqual([forward.pushed, forward.remoteHead], [true, h2]);
  // someone rewrote the remote branch to a commit that is NOT an ancestor of local HEAD
  const other = join(f.repo.root, "other");
  execFileSync("git", ["clone", "-q", f.bare, other], { windowsHide: true });
  const run = (...args) => execFileSync("git", args, { cwd: other, encoding: "utf8", windowsHide: true }).trim();
  run("checkout", "-q", "-B", "loop/T/e1", h1);
  writeFileSync(join(other, "foreign.txt"), "foreign\n");
  run("add", "-A"); run("-c", "user.name=X", "-c", "user.email=x@example.invalid", "commit", "-q", "-m", "foreign");
  const foreign = run("rev-parse", "HEAD");
  run("push", "-q", "--force", "origin", "loop/T/e1");
  f.commit("c.txt");
  await assert.rejects(f.push(), (e) => e instanceof PushError && e.code === "PUSH_REMOTE_DIVERGED" && e.classification === "OWNER_REQUIRED");
  assert.equal(await f.remoteHead("loop/T/e1"), foreign, "the remote branch was NOT overwritten");
});

test("push refuses when local facts are wrong: HEAD mismatch, branch mismatch, uncommitted work", async (t) => {
  const f = fixture(t);
  const h1 = f.commit("a.txt");
  f.commit("b.txt");
  await assert.rejects(f.push({ expectedHead: h1 }), { code: "PUSH_LOCAL_HEAD_MISMATCH" });
  await assert.rejects(f.push({ branch: "loop/T/other" }), { code: "PUSH_LOCAL_BRANCH_MISMATCH" });
  writeFileSync(join(f.repo.path, "dirty.txt"), "uncommitted\n");
  await assert.rejects(f.push(), { code: "PUSH_DIRTY_WORKSPACE" });
  await assert.rejects(f.push({ expectedHead: "abc" }), { code: "PUSH_INVALID_INPUT" });
  assert.equal(await f.remoteHead("loop/T/e1"), null, "nothing was pushed");
});

test("a push command is not confirmation: if the remote does not show the head afterwards, the push is UNCONFIRMED (transient)", async (t) => {
  const f = fixture(t);
  f.commit("a.txt");
  await assert.rejects(f.push({ readRemoteHead: async () => null }), (e) => e.code === "PUSH_UNCONFIRMED" && e.retryable === true);
});

test("a failing push command whose effect nevertheless landed is confirmed from the remote, not from the exit status", async (t) => {
  const f = fixture(t);
  const h1 = f.commit("a.txt");
  let reads = 0;
  const result = await f.push({ remote: "no-such-remote", readRemoteHead: async () => { reads += 1; return reads === 1 ? null : h1; } });
  assert.deepEqual([result.pushed, result.confirmed, result.reason], [true, true, "CONFIRMED_AFTER_COMMAND_ERROR"]);
  await assert.rejects(f.push({ remote: "no-such-remote", readRemoteHead: async () => null }), { code: "PUSH_FAILED" });
});

test("the push command never forces: only an explicit commit:ref refspec is used", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync(new URL("../src/adapters/git-push.js", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.ok(!/--force|"-f"|\+refs\/|\+\$\{/.test(text), "no force flag or forced refspec");
  assert.ok(/\$\{expectedHead\}:refs\/heads\/\$\{branch\}/.test(text));
});
