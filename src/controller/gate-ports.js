/**
 * Boundaries for the two judgement gates of the development lifecycle. The Controller never judges code itself:
 * it only records what these ports return, bound to the exact head SHA, and decides deterministically what to do next.
 *
 * IndependentReviewer: must be independent of the implementation agent (the state engine additionally rejects a review
 * whose reviewerId equals the commit author). Returns
 *   { verdict: "CLEAN" | "FINDINGS" | "UNAVAILABLE", findings: [{id, summary}], reviewerId }
 *   UNAVAILABLE is never recorded as a verdict: it is a transient wait (retry with backoff).
 *
 * ValidationRunner: runs the authoritative validation for one EXACT head (the runner is told the head and must refuse to
 * validate a workspace whose HEAD differs). Returns { result: "PASS" | "FAIL", detail }.
 *
 * A real model-backed reviewer will implement IndependentReviewer later; nothing in the Controller depends on which.
 */

export class IndependentReviewer {
  async reviewSpec(_workPackage) { throw new Error(`${this.constructor.name}.reviewSpec is not implemented`); }
  async reviewImplementation(_request) { throw new Error(`${this.constructor.name}.reviewImplementation is not implemented`); }
}

export class ValidationRunner {
  async validate(_request) { throw new Error(`${this.constructor.name}.validate is not implemented`); }
  async validatePostMerge(_request) { throw new Error(`${this.constructor.name}.validatePostMerge is not implemented`); }
}

export const REVIEW_VERDICTS = Object.freeze(["CLEAN", "FINDINGS", "UNAVAILABLE"]);

export function validateReviewerOutput(value) {
  const bad = (m) => Object.assign(new Error(`invalid reviewer output: ${m}`), { code: "REVIEWER_OUTPUT_INVALID", classification: "EXTERNAL_BLOCK", retryable: false });
  if (!value || typeof value !== "object") throw bad("not an object");
  if (!REVIEW_VERDICTS.includes(value.verdict)) throw bad(`verdict ${value.verdict}`);
  if (typeof value.reviewerId !== "string" || value.reviewerId.trim() === "") throw bad("reviewerId is required");
  const findings = Array.isArray(value.findings) ? value.findings : [];
  if (value.verdict === "FINDINGS" && findings.length === 0) throw bad("FINDINGS needs at least one finding");
  if (value.verdict === "CLEAN" && findings.length > 0) throw bad("CLEAN cannot carry findings");
  return Object.freeze({ verdict: value.verdict, reviewerId: value.reviewerId, findings: Object.freeze(findings.map((f) => Object.freeze({ id: String(f.id ?? ""), summary: String(f.summary ?? "") }))) });
}
