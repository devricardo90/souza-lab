import { execFileSync } from "node:child_process";
import { GitProvider, makeRevision } from "../core/contracts.js";

export class LocalGitError extends Error {
  constructor(message, code = "LOCAL_GIT_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "LocalGitError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

function runGit(args, { cwd, git = "git", commandTimeoutMs = 15000 }) {
  try {
    return execFileSync(git, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      windowsHide: true,
      timeout: commandTimeoutMs,
      killSignal: "SIGTERM",
    }).trimEnd();
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? "git command failed").trim();
    const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true;
    throw new LocalGitError(`git ${args[0]} failed in ${cwd}: ${detail}`, timedOut ? "GIT_COMMAND_TIMEOUT" : "GIT_COMMAND_FAILED", timedOut ? "TRANSIENT" : "EXTERNAL_BLOCK");
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
  constructor({ cwd = process.cwd(), baseRef = null, git = "git", execute = runGit, commandTimeoutMs = 15000 } = {}) {
    super();
    if (typeof cwd !== "string" || cwd.trim() === "") throw new TypeError("LocalGitProvider requires a working directory");
    this.cwd = cwd;
    this.baseRef = baseRef;
    this.git = git;
    this.execute = execute;
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1) throw new TypeError("commandTimeoutMs must be positive");
    this.commandTimeoutMs = commandTimeoutMs;
  }

  getRevision() {
    const options = { cwd: this.cwd, git: this.git, commandTimeoutMs: this.commandTimeoutMs };
    const root = this.execute(["rev-parse", "--show-toplevel"], options);
    const head = this.execute(["rev-parse", "--verify", "HEAD^{commit}"], { ...options, cwd: root });
    const branch = this.execute(["branch", "--show-current"], { ...options, cwd: root }) || null;
    const authorId = this.execute(["show", "-s", "--format=%ae", head], { ...options, cwd: root }) || null;
    const status = this.execute(["status", "--porcelain=v1", "-z", "--untracked-files=all"], { ...options, cwd: root });
    const workingPaths = porcelainPaths(status);

    let base = null;
    let committedPaths = [];
    if (this.baseRef !== null) {
      if (typeof this.baseRef !== "string" || this.baseRef.trim() === "" || this.baseRef.startsWith("-")) {
        throw new LocalGitError("baseRef must be a non-option local Git revision", "INVALID_BASE_REF");
      }
      base = this.execute(["merge-base", "--", this.baseRef, head], { ...options, cwd: root });
      const diff = this.execute(["diff", "--name-only", "--no-renames", base, head], { ...options, cwd: root });
      committedPaths = diff === "" ? [] : diff.split(/\r?\n/);
    }

    return makeRevision({
      head,
      base,
      branch,
      authorId,
      dirty: status.length > 0,
      changedFiles: [...new Set([...committedPaths, ...workingPaths])].sort(),
    });
  }
}
