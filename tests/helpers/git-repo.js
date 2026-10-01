import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A real temporary Git repository (never touches the project repo). Local only, no remote, no network. */
export function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), "loop-git-"));
  const path = join(root, "repo");
  const run = (args, cwd = path) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "-b", "main", path], { windowsHide: true });
  run(["config", "user.name", "Test Owner"]);
  run(["config", "user.email", "owner@example.invalid"]);
  run(["config", "core.autocrlf", "false"]);
  writeFileSync(join(path, "README.md"), "baseline\n");
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "baseline"]);
  return {
    root, path, run,
    head: () => run(["rev-parse", "HEAD"]),
    cleanup: () => {
      // worktrees hold files open on Windows only while a process runs; retry briefly
      for (let i = 0; i < 5; i += 1) { try { rmSync(root, { recursive: true, force: true }); return; } catch { /* retry */ } }
    },
  };
}
