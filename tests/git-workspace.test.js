import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLASSIFICATIONS, EXECUTION_TRAILERS, classifyExecution, ensureWorkspace, inspectWorkspace, readMarker, resolveSha, resultFromGit } from "../src/adapters/git-workspace.js";
import { makeRepo } from "./helpers/git-repo.js";

const IDS = { executionId: "exec-abc", taskId: "TASK-001" };

function fixture(t) {
  const repo = makeRepo();
  t.after(() => repo.cleanup());
  const baseSha = resolveSha(repo.path, "main");
  const branch = "loop/TASK-001/exec-abc";
  const ws = ensureWorkspace({ repoPath: repo.path, workspacesDir: join(repo.root, "ws"), ...IDS, baseSha, branch });
  const facts = () => inspectWorkspace({ workspacePath: ws.path, baseSha, branch, ...IDS });
  const classify = () => classifyExecution(facts(), IDS);
  const commit = (message, files = { "impl/a.txt": "work\n" }, trailers = true) => {
    for (const [name, content] of Object.entries(files)) { mkdirSync(join(ws.path, "impl"), { recursive: true }); writeFileSync(join(ws.path, name), content); }
    repo.run(["add", "-A"], ws.path);
    const body = trailers ? `${message}\n\n${EXECUTION_TRAILERS.execution}: ${IDS.executionId}\n${EXECUTION_TRAILERS.task}: ${IDS.taskId}\n` : message;
    repo.run(["-c", "user.name=A", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", body], ws.path);
  };
  return { repo, baseSha, branch, ws, facts, classify, commit };
}

test("isolated workspace: own worktree + own branch from the recorded base SHA; the main working tree is never touched", (t) => {
  const { repo, ws, baseSha, branch } = fixture(t);
  assert.equal(repo.run(["rev-parse", "--abbrev-ref", "HEAD"], ws.path), branch);
  assert.equal(repo.run(["rev-parse", "HEAD"], ws.path), baseSha);
  assert.notEqual(ws.path, repo.path);
  assert.equal(repo.run(["rev-parse", "--abbrev-ref", "HEAD"]), "main", "main working tree stays on main");
  writeFileSync(join(ws.path, "scratch.txt"), "agent work\n");
  assert.equal(repo.run(["status", "--porcelain"]), "", "changes in the execution workspace never appear in the main working tree");
  assert.deepEqual(readMarker(ws.path), { ...IDS, baseSha, branch });
  assert.equal(repo.run(["status", "--porcelain=v1", "-uall"], ws.path), "?? scratch.txt", "the ownership marker lives outside the working tree: only the agent's file shows up");
  assert.ok(existsSync(ws.path));
});

test("ensureWorkspace is idempotent for the owner and refuses a path it does not own (nothing is overwritten)", (t) => {
  const { repo, ws, baseSha, branch } = fixture(t);
  writeFileSync(join(ws.path, "keep.txt"), "important\n");
  const again = ensureWorkspace({ repoPath: repo.path, workspacesDir: join(repo.root, "ws"), ...IDS, baseSha, branch });
  assert.equal(again.reused, true);
  assert.equal(readFileSync(join(ws.path, "keep.txt"), "utf8"), "important\n", "re-attaching preserved the uncommitted file");
  assert.throws(() => ensureWorkspace({ repoPath: repo.path, workspacesDir: join(repo.root, "ws"), executionId: "exec-abc", taskId: "TASK-999", baseSha, branch }), { code: "WORKSPACE_NOT_OWNED" });
  assert.throws(() => resolveSha(repo.path, "no-such-ref"), { code: "BASE_REF_UNRESOLVED" });
});

test("classification: clean workspace -> NO_IMPLEMENTATION_PRESENT", (t) => {
  const { classify, facts } = fixture(t);
  assert.deepEqual(classify(), { classification: "NO_IMPLEMENTATION_PRESENT", reasons: [] });
  const f = facts();
  assert.deepEqual([f.commits.length, f.trackedChanges.length, f.untracked.length, f.markerMatches, f.baseIsAncestor], [0, 0, 0, true, true]);
});

test("classification: uncommitted work (untracked or tracked) -> IMPLEMENTATION_PRESENT_UNVERIFIED, and inspection preserves it", (t) => {
  const { ws, classify, facts } = fixture(t);
  writeFileSync(join(ws.path, "new.txt"), "untracked work\n");
  assert.equal(classify().classification, "IMPLEMENTATION_PRESENT_UNVERIFIED");
  assert.deepEqual(facts().untracked, ["new.txt"]);
  writeFileSync(join(ws.path, "README.md"), "modified tracked\n");
  assert.deepEqual(facts().trackedChanges, ["README.md"]);
  assert.equal(classify().classification, "IMPLEMENTATION_PRESENT_UNVERIFIED");
  assert.equal(readFileSync(join(ws.path, "new.txt"), "utf8"), "untracked work\n", "classification never alters the workspace");
  assert.equal(readFileSync(join(ws.path, "README.md"), "utf8"), "modified tracked\n");
});

test("classification: commits carrying THIS execution's trailers with a clean tree -> COMMITTED_IMPLEMENTATION_PRESENT; the result comes from Git", (t) => {
  const { commit, classify, facts, baseSha, branch } = fixture(t);
  commit("feat: implement");
  assert.equal(classify().classification, "COMMITTED_IMPLEMENTATION_PRESENT");
  const result = resultFromGit(facts());
  assert.deepEqual([result.head, result.base, result.branch, result.authorId, result.changedFiles], [facts().head, baseSha, branch, "a@example.invalid", ["impl/a.txt"]]);
});

const AMBIGUOUS = {
  "a commit without this execution's trailers (foreign work in the branch)": (c) => c.commit("someone else", { "x.txt": "x\n" }, false),
  "a commit carrying a different execution id": (c) => { c.repo.run(["add", "-A"], c.ws.path); writeFileSync(join(c.ws.path, "y.txt"), "y\n"); c.repo.run(["add", "-A"], c.ws.path); c.repo.run(["-c", "user.name=A", "-c", "user.email=a@example.invalid", "commit", "-q", "-m", `m\n\n${EXECUTION_TRAILERS.execution}: exec-OTHER\n${EXECUTION_TRAILERS.task}: TASK-001\n`], c.ws.path); },
  "committed work plus uncommitted work": (c) => { c.commit("feat"); writeFileSync(join(c.ws.path, "extra.txt"), "more\n"); },
  "HEAD moved to a different branch": (c) => { c.repo.run(["checkout", "-q", "-b", "other"], c.ws.path); },
};
for (const [name, mutate] of Object.entries(AMBIGUOUS)) {
  test(`classification fails closed: ${name} -> AMBIGUOUS_EXECUTION_STATE`, (t) => {
    const context = fixture(t);
    mutate(context);
    const { classification, reasons } = context.classify();
    assert.equal(classification, "AMBIGUOUS_EXECUTION_STATE");
    assert.ok(reasons.length > 0);
  });
}

test("classification: a missing workspace or a tampered ownership marker is ambiguous", (t) => {
  const { facts, ws, baseSha, branch } = fixture(t);
  assert.deepEqual(classifyExecution(inspectWorkspace({ workspacePath: join(ws.path, "..", "nope"), baseSha, branch, ...IDS }), IDS), { classification: "AMBIGUOUS_EXECUTION_STATE", reasons: ["WORKSPACE_MISSING"] });
  const other = { ...IDS, taskId: "TASK-002" };
  assert.deepEqual(classifyExecution(inspectWorkspace({ workspacePath: ws.path, baseSha, branch, ...other }), other).reasons, ["OWNERSHIP_MARKER_MISMATCH"]);
  assert.ok(facts().present);
});

test("the classification vocabulary is closed", () => {
  assert.deepEqual([...CLASSIFICATIONS].sort(), ["AMBIGUOUS_EXECUTION_STATE", "COMMITTED_IMPLEMENTATION_PRESENT", "IMPLEMENTATION_PRESENT_UNVERIFIED", "NO_IMPLEMENTATION_PRESENT"]);
});
