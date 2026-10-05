import { spawn, spawnSync } from "node:child_process";
import { IndependentReviewer, validateReviewerOutput } from "../controller/gate-ports.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const WINDOWS = process.platform === "win32";
const UNAVAILABLE = Object.freeze({ verdict: "UNAVAILABLE", reviewerId: "command-reviewer-unavailable", findings: Object.freeze([]) });

/** Terminates the command and everything it started (process group on POSIX, taskkill /T on Windows). Never throws. */
function killTree(child) {
  try {
    if (WINDOWS) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch { try { child.kill(); } catch { /* already gone */ } }
}

/**
 * Production IndependentReviewer boundary that is agent-agnostic: one configured command (argv, no shell) receives a JSON
 * review request on stdin and must print one JSON reviewer output (the existing validateReviewerOutput contract) on stdout.
 * It contains no judgement of its own and calls no model. Any agent (Hermes, Claude, Codex, a script) can sit behind the command.
 *
 *   command could not run / non-zero exit / timeout / oversized output  -> UNAVAILABLE (a transient wait, never a verdict)
 *   exit 0 but stdout is not valid reviewer output                      -> fails closed with REVIEWER_OUTPUT_INVALID
 *
 * Trust boundary (explicit): the state engine and the merge gate compare the reviewer's DECLARED reviewerId with the commit
 * author id. They cannot verify that the command is genuinely a different agent from the implementer. The production profile
 * rejects a review command identical to the agent command, but choosing a truly independent reviewer is the Owner's responsibility.
 * stderr is never surfaced, so a reviewer command cannot leak secrets through this boundary.
 */
export class CommandIndependentReviewer extends IndependentReviewer {
  constructor({ command, args = [], timeoutMs = 600000, env = {}, spawnFn = spawn } = {}) {
    super();
    if (typeof command !== "string" || command.trim() === "") throw new TypeError("a review command is required");
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) throw new TypeError("review args must be an array of strings");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError("review timeoutMs must be a positive integer");
    Object.assign(this, { command, args: Object.freeze([...args]), timeoutMs, env, spawnFn });
  }

  reviewSpec(workPackage) { return this.invoke({ kind: "spec", workPackage }); }

  reviewImplementation({ workPackage, head, base, workspacePath, authorId, changedFiles }) {
    return this.invoke({ kind: "implementation", workPackage, head, base, workspacePath, authorId, changedFiles });
  }

  async invoke(request) {
    const raw = await this.exchange(JSON.stringify(request));
    if (raw === null) return UNAVAILABLE;
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    return validateReviewerOutput(parsed);
  }

  /** Resolves stdout of a successful run, or null when the reviewer could not produce an answer. Never rejects. */
  exchange(input) {
    return new Promise((resolve) => {
      let settled = false;
      let child = null;
      let timer = null;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (value === null && child) killTree(child);
        resolve(value);
      };
      try { child = this.spawnFn(this.command, [...this.args], { shell: false, windowsHide: true, detached: !WINDOWS, env: this.env, stdio: ["pipe", "pipe", "ignore"] }); }
      catch { return done(null); }
      const chunks = []; let size = 0;
      timer = setTimeout(() => done(null), this.timeoutMs);
      child.on("error", () => done(null));
      child.stdout.on("data", (chunk) => {
        if (settled) return;
        size += chunk.length;
        if (size > MAX_OUTPUT_BYTES) done(null); else chunks.push(chunk);
      });
      child.on("close", (code) => done(code === 0 ? Buffer.concat(chunks).toString("utf8") : null));
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
}
