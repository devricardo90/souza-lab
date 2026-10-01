import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { git } from "../adapters/git-workspace.js";
import { IndependentReviewer, ValidationRunner } from "../controller/gate-ports.js";

/**
 * Deterministic offline stand-ins for the independent reviewer and the validator (tests only; ZERO model calls).
 * Every call is appended to a durable JSONL file so tests can count calls across process restarts.
 */

function append(path, entry) {
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(entry)}\n`);
}
export const readCalls = (path) => (existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

export class DeterministicReviewer extends IndependentReviewer {
  /** The first `findingsOnReviews` implementation reviews return FINDINGS; later ones are CLEAN. */
  constructor({ recordPath = null, findingsOnReviews = 0, unavailableFile = null, reviewerId = "independent-reviewer@example.invalid" } = {}) {
    super();
    Object.assign(this, { recordPath, findingsOnReviews, unavailableFile, reviewerId });
    this.modelCalls = 0;
  }

  async reviewSpec() {
    if (this.unavailableFile && existsSync(this.unavailableFile)) return { verdict: "UNAVAILABLE", reviewerId: this.reviewerId, findings: [] };
    append(this.recordPath, { kind: "spec" });
    return { verdict: "CLEAN", reviewerId: this.reviewerId, findings: [] };
  }

  async reviewImplementation({ head }) {
    if (this.unavailableFile && existsSync(this.unavailableFile)) return { verdict: "UNAVAILABLE", reviewerId: this.reviewerId, findings: [] };
    const previous = readCalls(this.recordPath).filter((c) => c.kind === "implementation").length;
    append(this.recordPath, { kind: "implementation", head });
    if (previous < this.findingsOnReviews) return { verdict: "FINDINGS", reviewerId: this.reviewerId, findings: [{ id: `F-${previous + 1}`, summary: `synthetic finding ${previous + 1} at ${head.slice(0, 8)}` }] };
    return { verdict: "CLEAN", reviewerId: this.reviewerId, findings: [] };
  }
}

export class DeterministicValidator extends ValidationRunner {
  constructor({ recordPath = null, failHeads = [] } = {}) {
    super();
    Object.assign(this, { recordPath, failHeads: new Set(failHeads) });
    this.modelCalls = 0;
  }

  async validate({ workspacePath, head }) {
    const actual = git(workspacePath, ["rev-parse", "HEAD"]).trim();
    append(this.recordPath, { kind: "validate", head, actual });
    if (actual !== head) return { result: "FAIL", detail: `workspace HEAD ${actual} is not the head under validation` };
    return this.failHeads.has(head) ? { result: "FAIL", detail: "configured to fail" } : { result: "PASS", detail: "deterministic pass" };
  }

  async validatePostMerge({ checkoutPath, mergeSha }) {
    const actual = git(checkoutPath, ["rev-parse", "HEAD"]).trim();
    append(this.recordPath, { kind: "post-merge", mergeSha, actual });
    return actual === mergeSha ? { result: "PASS", detail: "merge commit checked out" } : { result: "FAIL", detail: "checkout is not the merge commit" };
  }
}
