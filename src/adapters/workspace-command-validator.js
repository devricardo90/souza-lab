import { spawnSync } from "node:child_process";
import { git } from "./git-workspace.js";
import { ValidationRunner } from "../controller/gate-ports.js";

/**
 * Production-capable validation: runs one configured command (argv, no shell) inside the execution workspace and reports
 * PASS only when it exits 0 AND the workspace is exactly at the head being validated with a clean tree. For post-merge
 * validation the same command runs in a detached checkout of the merge commit.
 *
 * Limitation (explicit): a command proves "the repository's own checks pass at this SHA"; mapping each acceptance
 * criterion to a dedicated check is not implemented, so a PASS marks all criteria proved and a FAIL marks none.
 */
export class WorkspaceCommandValidator extends ValidationRunner {
  constructor({ command, args = [], timeoutMs = 300000, env = process.env } = {}) {
    super();
    if (typeof command !== "string" || command.trim() === "") throw new TypeError("a validation command is required");
    Object.assign(this, { command, args, timeoutMs, env });
  }

  run(cwd) {
    const result = spawnSync(this.command, this.args, { cwd, encoding: "utf8", windowsHide: true, timeout: this.timeoutMs, env: this.env, shell: false });
    if (result.error) return { result: "FAIL", detail: `command could not run: ${result.error.code ?? result.error.message}` };
    return result.status === 0 ? { result: "PASS", detail: "command exited 0" } : { result: "FAIL", detail: `command exited ${result.status}: ${String(result.stderr ?? "").slice(-300)}` };
  }

  async validate({ workspacePath, head }) {
    const actual = git(workspacePath, ["rev-parse", "HEAD"]).trim();
    if (actual !== head) return { result: "FAIL", detail: `workspace HEAD ${actual} is not the head under validation ${head}` };
    if (git(workspacePath, ["status", "--porcelain=v1", "-uall"]).trim() !== "") return { result: "FAIL", detail: "workspace is not clean at the head under validation" };
    return this.run(workspacePath);
  }

  async validatePostMerge({ checkoutPath }) {
    return this.run(checkoutPath);
  }
}
