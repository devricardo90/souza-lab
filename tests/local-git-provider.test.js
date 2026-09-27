import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalGitError, LocalGitProvider } from "../src/adapters/local-git-provider.js";

function git(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function withFixtureRepo(run) {
  const root = mkdtempSync(join(tmpdir(), "loop-local-git-"));
  try {
    git(root, ["init", "--initial-branch=main"]);
    writeFileSync(join(root, "tracked.txt"), "base\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["-c", "user.name=Loop Test", "-c", "user.email=loop@example.invalid", "commit", "-m", "baseline"]);
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("local Git adapter reports root, HEAD, branch, base diff and dirty files without a remote", () => {
  withFixtureRepo((root) => {
    const baseline = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-b", "feature/task-1"]);
    writeFileSync(join(root, "tracked.txt"), "feature\n");
    git(root, ["add", "tracked.txt"]);
    git(root, ["-c", "user.name=Loop Test", "-c", "user.email=loop@example.invalid", "commit", "-m", "candidate"]);
    writeFileSync(join(root, "tracked.txt"), "working change\n");
    mkdirSync(join(root, "new folder"));
    writeFileSync(join(root, "new folder", "untracked.txt"), "untracked\n");

    const beforeConfig = readFileSync(join(root, ".git", "config"), "utf8");
    const beforeIndex = readFileSync(join(root, ".git", "index"));
    const revision = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    const afterConfig = readFileSync(join(root, ".git", "config"), "utf8");
    const afterIndex = readFileSync(join(root, ".git", "index"));

    assert.match(revision.head, /^[0-9a-f]{40}$/i);
    assert.equal(revision.base, baseline);
    assert.equal(revision.branch, "feature/task-1");
    assert.equal(revision.dirty, true);
    assert.deepEqual(revision.changedFiles, ["new folder/untracked.txt", "tracked.txt"]);
    assert.equal(afterConfig, beforeConfig);
    assert.deepEqual(afterIndex, beforeIndex);
    assert.doesNotMatch(afterConfig, /\[remote /);
  });
});

test("local Git adapter reports a clean branch and no changes", () => {
  withFixtureRepo((root) => {
    const revision = new LocalGitProvider({ cwd: root, baseRef: "main" }).getRevision();
    assert.equal(revision.branch, "main");
    assert.equal(revision.dirty, false);
    assert.deepEqual(revision.changedFiles, []);
    assert.equal(revision.base, revision.head);
  });
});

test("local Git adapter fails closed outside a repository and on an invalid base ref", () => {
  const directory = mkdtempSync(join(tmpdir(), "loop-not-a-repo-"));
  try {
    assert.throws(() => new LocalGitProvider({ cwd: directory }).getRevision(), (error) => error instanceof LocalGitError && error.code === "GIT_COMMAND_FAILED");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }

  withFixtureRepo((root) => {
    assert.throws(() => new LocalGitProvider({ cwd: root, baseRef: "-exec=touch bad" }).getRevision(), /non-option local Git revision/);
    assert.throws(() => new LocalGitProvider({ cwd: root, baseRef: "missing-local-ref" }).getRevision(), /git merge-base failed/);
  });
});
