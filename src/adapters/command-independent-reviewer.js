import { spawn } from "node:child_process";
import { IndependentReviewer, validateReviewerOutput } from "../controller/gate-ports.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const UNAVAILABLE = Object.freeze({ verdict: "UNAVAILABLE", reviewerId: "command-reviewer-unavailable", findings: Object.freeze([]) });

/**
 * Production IndependentReviewer boundary that is agent-agnostic: one configured command (argv, no shell) receives a JSON
 * review request on stdin and must print one JSON reviewer output (the existing validateReviewerOutput contract) on stdout.
 * It contains no judgement of its own and calls no model. Any agent (Hermes, Claude, Codex, a script) can sit behind the command.
 *
 *   command could not run / non-zero exit / timeout / oversized output  -> UNAVAILABLE (a transient wait, never a verdict)
 *   exit 0 but stdout is not valid reviewer output                      -> fails closed with REVIEWER_OUTPUT_INVALID
 *
 * Independence (reviewerId must differ from the commit author) is enforced downstream by the state engine and the merge gate.
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
      const done = (value) => { if (!settled) { settled = true; resolve(value); } };
      let child;
      try { child = this.spawnFn(this.command, [...this.args], { shell: false, windowsHide: true, env: this.env, stdio: ["pipe", "pipe", "ignore"] }); }
      catch { return done(null); }
      const chunks = []; let size = 0;
      const timer = setTimeout(() => { try { child.kill(); } catch {} done(null); }, this.timeoutMs);
      child.on("error", () => { clearTimeout(timer); done(null); });
      child.stdout.on("data", (chunk) => { size += chunk.length; if (size > MAX_OUTPUT_BYTES) { try { child.kill(); } catch {} clearTimeout(timer); done(null); } else chunks.push(chunk); });
      child.on("close", (code) => { clearTimeout(timer); done(code === 0 ? Buffer.concat(chunks).toString("utf8") : null); });
      child.stdin.on("error", () => {});
      child.stdin.end(input);
    });
  }
}
