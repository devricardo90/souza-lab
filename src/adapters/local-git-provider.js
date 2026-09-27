import { execFileSync } from "node:child_process";
import { GitProvider, makeRevision } from "../core/contracts.js";

export class LocalGitError extends Error {
  constructor(message, code = "LOCAL_GIT_ERROR") {
    super(message);
    this.name = "LocalGitError";
    this.code = code;
  }
}

function runGit(args, { cwd, git = "git" }) {
  try {
    return execFileSync(git, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trimEnd();
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "git command failed").trim();
    throw new LocalGitError(`git ${args[0]} failed in ${cwd}: ${detail}`, "GIT_COMMAND_FAILED");
  }
}

function porcelainPaths(output) {
  const tokens = output.split("\0").filter(Boolean);
  const paths = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record.length < 4) throw new LocalGitError("git status returned malformed porcelain output", "INVALID_GIT_OUTPUT");
    paths.push(record.slice(3));
    const status = record.slice(0, 2);
    if (status.includes("R") || status.includes("C")) index += 1;
  }
  return paths;
}

/** Read-only adapter over the local Git working copy; it never fetches or writes. */
export class LocalGitProvider extends GitProvider {
  constructor({ cwd = process.cwd(), baseRef = null, git = "git", execute = runGit } = {}) {
    super();
    if (typeof cwd !== "string" || cwd.trim() === "") throw new TypeError("LocalGitProvider requires a working directory");
    this.cwd = cwd;
    this.baseRef = baseRef;
    this.git = git;
    this.execute = execute;
  }

  getRevision() {
    const root = this.execute(["rev-parse", "--show-toplevel"], { cwd: this.cwd, git: this.git });
    const head = this.execute(["rev-parse", "--verify", "HEAD^{commit}"], { cwd: root, git: this.git });
    const branch = this.execute(["branch", "--show-current"], { cwd: root, git: this.git }) || null;
    const status = this.execute(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root, git: this.git });
    const workingPaths = porcelainPaths(status);

    let base = null;
    let committedPaths = [];
    if (this.baseRef !== null) {
      if (typeof this.baseRef !== "string" || this.baseRef.trim() === "" || this.baseRef.startsWith("-")) {
        throw new LocalGitError("baseRef must be a non-option local Git revision", "INVALID_BASE_REF");
      }
      base = this.execute(["merge-base", "--", this.baseRef, head], { cwd: root, git: this.git });
      const diff = this.execute(["diff", "--name-only", "--no-renames", base, head], { cwd: root, git: this.git });
      committedPaths = diff === "" ? [] : diff.split(/\r?\n/);
    }

    return makeRevision({
      head,
      base,
      branch,
      dirty: status.length > 0,
      changedFiles: [...new Set([...committedPaths, ...workingPaths])].sort(),
    });
  }
}
