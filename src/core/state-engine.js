import { LOOP_STATES, StateEngine, makeComputedState } from "./contracts.js";

export const FIRST_UNPROVED_STEP = Object.freeze({
  DISCOVER: "RESOLVE_TASK",
  SPEC_REQUIRED: "WRITE_SPEC",
  SPEC_REVIEW: "REVIEW_SPEC",
  READY_TO_IMPLEMENT: "START_IMPLEMENTATION",
  IMPLEMENTING: "CONTINUE_IMPLEMENTATION",
  TESTING: "RUN_TESTS",
  VALIDATING: "RUN_VALIDATION",
  REVIEWING: "REQUEST_OR_CONTINUE_REVIEW",
  READY_TO_MERGE: "MERGE",
  MERGING: "RECONCILE_MERGE",
  POST_MERGE_VALIDATION: "VALIDATE_MERGE",
  DONE: "SELECT_NEXT_TASK",
  WAIT_RETRYABLE: "RETRY_EXTERNAL",
  BLOCKED_OWNER: "REQUEST_OWNER_DECISION",
  BLOCKED_EXTERNAL: "RESOLVE_EXTERNAL_BLOCKER",
  INCONSISTENT_STATE: "RECONCILE_INCONSISTENCY",
});

function stateResult(state, blockers = []) {
  return { state, blockers };
}

function exactValidation(validation, { head, baseline, specDigest, acceptanceCriteriaDigest, criterionCount }) {
  return Boolean(
    validation
    && validation.result === "PASS"
    && validation.independent === true
    && validation.head === head
    && validation.baseline === baseline
    && typeof specDigest === "string"
    && specDigest.length > 0
    && validation.specDigest === specDigest
    && validation.acceptanceCriteriaDigest === acceptanceCriteriaDigest
    && validation.acProof.total === criterionCount
    && validation.acProof.proved === criterionCount,
  );
}

function cleanReview(review, head, authorId = null) {
  return Boolean(
    review
    && review.head === head
    && review.verdict === "CLEAN"
    && review.independent === true
    && review.unresolvedFindings === 0
    && typeof review.publishedAt === "string"
    && Number.isFinite(Date.parse(review.publishedAt))
    && (authorId == null || (typeof review.reviewerId === "string"
      && review.reviewerId.trim().toLowerCase() !== authorId.trim().toLowerCase())),
  );
}

function projectionDisagrees(projection, { derivedState, taskId, candidateHead }) {
  if (projection == null) return false;
  if (typeof projection !== "object" || Array.isArray(projection)) return true;
  if (!LOOP_STATES.includes(projection.state)) return true;
  if (projection.state !== derivedState) return true;
  if (projection.taskId !== undefined && projection.taskId !== taskId) return true;
  if (projection.candidateHead !== undefined && projection.candidateHead !== candidateHead) return true;
  return false;
}

function derive(facts = {}) {
  if (facts.ownerBlocked === true) return stateResult("BLOCKED_OWNER", ["owner decision is required"]);
  if (facts.externalBlocked === true) return stateResult("BLOCKED_EXTERNAL", ["external action is required"]);
  if (facts.retryableWait === true) return stateResult("WAIT_RETRYABLE", ["retryable external condition is unresolved"]);
  const task = facts.task ?? null;
  if (!task) return stateResult("DISCOVER", ["no eligible task is selected"]);
  if (task.dependencies.some((dependency) => dependency.requiresDone && !facts.completedTaskIds?.includes(dependency.taskId))) {
    return stateResult("DISCOVER", ["task dependency is not complete"]);
  }
  if (!task.specPresent) return stateResult("SPEC_REQUIRED", ["task spec is missing"]);
  if (!facts.specRevision || !cleanReview(facts.specReview, facts.specRevision.head, facts.specRevision.authorId)) {
    return stateResult("SPEC_REVIEW", ["independent CLEAN review evidence for the current spec revision is missing or stale"]);
  }

  const revision = facts.revision ?? null;
  if (!revision) return stateResult("READY_TO_IMPLEMENT");
  if (revision.dirty) return stateResult("IMPLEMENTING", ["working tree has uncommitted changes"]);

  const ci = facts.ci ?? null;
  if (!ci) return stateResult("TESTING", ["CI evidence is missing"]);
  if (ci.head !== revision.head) return stateResult("TESTING", ["CI evidence is stale for the candidate HEAD"]);
  if (ci.status === "PENDING") return stateResult("WAIT_RETRYABLE", ["CI is still running"]);
  if (ci.status !== "PASS") {
    const blocker = ci.status === "FAIL" ? "CI failed"
      : ci.status === "UNKNOWN" ? "CI result is unknown"
        : "CI status is unrecognized";
    return stateResult("TESTING", [blocker]);
  }

  const validation = facts.validation ?? null;
  const validationOkay = exactValidation(validation, {
    head: revision.head,
    baseline: revision.base,
    specDigest: facts.specDigest,
    acceptanceCriteriaDigest: task.acceptanceCriteriaDigest,
    criterionCount: task.acceptanceCriteria.length,
  });
  if (validation?.result === "PENDING") return stateResult("WAIT_RETRYABLE", ["authoritative validation is still running"]);
  if (!validationOkay) {
    const blockers = [];
    if (!validation) blockers.push("authoritative validation evidence is missing");
    else {
      if (validation.head !== revision.head) blockers.push("validation is stale for the candidate HEAD");
      if (validation.baseline !== revision.base) blockers.push("validation baseline does not match the candidate base");
      if (validation.specDigest !== facts.specDigest) blockers.push("validation is bound to a different or unknown spec");
      if (validation.acceptanceCriteriaDigest !== task.acceptanceCriteriaDigest) blockers.push("validation is bound to a different or unknown acceptance-criteria set");
      if (validation.acProof.proved !== task.acceptanceCriteria.length || validation.acProof.total !== task.acceptanceCriteria.length) blockers.push("validation does not prove every acceptance criterion");
      if (validation.independent !== true) blockers.push("validator is not independent");
      if (validation.result !== "PASS") blockers.push("authoritative validation did not pass");
    }
    return stateResult("VALIDATING", blockers);
  }

  const review = facts.review ?? null;
  const merge = facts.merge ?? null;
  if (merge && merge.candidateHead !== revision.head) return stateResult("INCONSISTENT_STATE", ["merge fact names a different candidate HEAD"]);

  if (merge?.status === "MERGED") {
    if (!cleanReview(review, revision.head, revision.authorId)) {
      return stateResult("INCONSISTENT_STATE", ["repository reports a merge without a CLEAN independent exact-head review"]);
    }
    const mergeTime = Date.parse(merge.mergedAt ?? "");
    const reviewTime = Date.parse(review.publishedAt);
    if (!Number.isFinite(mergeTime) || reviewTime >= mergeTime) {
      return stateResult("INCONSISTENT_STATE", ["CLEAN exact-head review was not published before merge"]);
    }
    const postMergeValidation = facts.postMergeValidation ?? null;
    if (postMergeValidation?.result === "PENDING") return stateResult("WAIT_RETRYABLE", ["post-merge validation is still running"]);
    const postMergeOkay = Boolean(
      postMergeValidation
      && postMergeValidation.result === "PASS"
      && postMergeValidation.independent === true
      && postMergeValidation.head === merge.mergeCommit
      && postMergeValidation.baseline === revision.head
      && postMergeValidation.specDigest === facts.specDigest
      && postMergeValidation.acceptanceCriteriaDigest === task.acceptanceCriteriaDigest
      && postMergeValidation.acProof.total === task.acceptanceCriteria.length
      && postMergeValidation.acProof.proved === task.acceptanceCriteria.length,
    );
    if (!postMergeOkay) {
      return stateResult("POST_MERGE_VALIDATION", [postMergeValidation ? "post-merge validation is missing, stale, partial, or failed" : "post-merge validation evidence is missing"]);
    }
    return stateResult("DONE");
  }

  if (review?.verdict === "PENDING") return stateResult("WAIT_RETRYABLE", ["independent review is still running"]);
  if (!cleanReview(review, revision.head, revision.authorId)) {
    const blockers = [];
    if (!review) blockers.push("independent review evidence is missing");
    else {
      if (review.head !== revision.head) blockers.push("review is stale for the candidate HEAD");
      if (review.independent !== true) blockers.push("reviewer is not independent");
      if (revision.authorId != null && (typeof review.reviewerId !== "string"
        || review.reviewerId.trim().toLowerCase() === revision.authorId.trim().toLowerCase())) {
        blockers.push("reviewer identity is missing or matches the implementation author");
      }
      if (review.verdict !== "CLEAN") blockers.push("review verdict is not CLEAN");
      if (review.unresolvedFindings !== 0) blockers.push("unresolved review findings remain");
      if (!review.publishedAt) blockers.push("review publication time is unknown");
    }
    return stateResult("REVIEWING", blockers);
  }

  if (!merge || merge.status === "NOT_STARTED" || merge.status === "FAILED") {
    return stateResult("READY_TO_MERGE", merge?.status === "FAILED" ? ["previous merge attempt failed"] : []);
  }
  if (merge.status === "PENDING" || merge.status === "UNKNOWN") {
    return stateResult("MERGING", [merge.status === "PENDING" ? "merge operation is unresolved" : "merge status is unknown"]);
  }
  return stateResult("INCONSISTENT_STATE", ["unrecognized merge transition"]);
}

/** Pure state derivation from provider facts; stored state and prose are projections only. */
export function computeState(facts = {}) {
  const result = derive(facts);
  const taskId = facts.task?.id ?? null;
  const candidateHead = facts.revision?.head ?? null;
  const projections = [facts.stateProjection, facts.handoffProjection].filter((projection) => projection != null);
  const projectionMismatch = projections
    .some((projection) => projectionDisagrees(projection, { derivedState: result.state, taskId, candidateHead }));
  const projectionInvalid = projections.some((projection) => typeof projection !== "object"
    || Array.isArray(projection) || !LOOP_STATES.includes(projection.state));
  const falseDoneProjection = projections.some((projection) => projection?.state === "DONE" && result.state !== "DONE");
  const projectionConflict = projections.length === 2 && (
    projections[0].state !== projections[1].state
    || (projections[0].taskId !== undefined && projections[1].taskId !== undefined && projections[0].taskId !== projections[1].taskId)
    || (projections[0].candidateHead !== undefined && projections[1].candidateHead !== undefined && projections[0].candidateHead !== projections[1].candidateHead)
  );
  const projectionInconsistent = projectionInvalid || falseDoneProjection || projectionConflict;
  const status = projectionInconsistent || (facts.task?.completed === true && result.state !== "DONE")
    ? "INCONSISTENT_STATE"
    : result.state;
  const blockers = [...result.blockers];
  if (projectionMismatch) blockers.push("persisted state or handoff is stale and must be regenerated");
  if (projectionConflict) blockers.push("persisted state and handoff contradict each other");
  if (falseDoneProjection) blockers.push("persisted projection claims DONE without computed completion evidence");
  if (projectionInvalid) blockers.push("persisted projection has an invalid state shape");
  if (facts.task?.completed === true && result.state !== "DONE") blockers.push("task source marks work complete without completion evidence");

  return makeComputedState({
    state: status,
    derivedState: result.state,
    taskId,
    candidateHead,
    nextTaskId: facts.nextTaskId ?? null,
    projectionMismatch,
    blockers,
    computedAt: facts.now ?? new Date().toISOString(),
  });
}

export class ComputedStateEngine extends StateEngine {
  compute(facts) {
    return computeState(facts);
  }

  recover(facts) {
    const computed = this.compute(facts);
    return Object.freeze({
      computed,
      firstUnprovedStep: FIRST_UNPROVED_STEP[computed.state],
    });
  }
}
