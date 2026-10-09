/**
 * What the CP-10 live-proof reviewer shows its model. Kept separate from the stdin/stdout wrapper so it is testable without a model:
 * a candidate with a diff must put that exact diff in the request, and a candidate without one is represented explicitly as empty
 * (the wrapper then fails closed with a deterministic finding instead of asking a model to review nothing).
 */
export const MAX_DIFF = 60000;

export function isEmptyDiff(diff) { return typeof diff !== "string" || diff.trim() === ""; }

export function emptyDiffFinding(base, head) {
  return { id: "F-EMPTY-DIFF", source: "policy", summary: `The candidate ${head.slice(0, 8)} has an empty diff against the base ${base.slice(0, 8)}; the acceptance criteria cannot be satisfied by a change that adds nothing. Implement the task so the commit contains the required files.` };
}

export function buildReviewPrompt({ workPackage, base, head, diff }) {
  const body = diff.length > MAX_DIFF ? `${diff.slice(0, MAX_DIFF)}\n[diff truncated]` : diff;
  const criteria = (workPackage.acceptanceCriteria ?? []).map((c) => `- ${c.id}: ${c.text}`).join("\n");
  return `Task ${workPackage.taskId}: ${workPackage.title}\n\nAcceptance criteria:\n${criteria || "- (none)"}\n\nDiff under review (${base.slice(0, 8)}..${head.slice(0, 8)}):\n${body}`;
}
