import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { makeTask } from "../core/contracts.js";
import { AgentExecutor } from "../controller/ports.js";

/**
 * Deterministic SYNTHETIC lifecycle for CP-05: stands in for Git/CI/review/merge facts and for an
 * implementation agent. All state is persisted to JSON files so a REAL process restart observes exactly
 * what the previous process left. Not evidence about real GitHub/CI/review behaviour.
 */

const BASE = "b".repeat(40);
const SPEC_DIGEST = "sha256-synthetic-controller-spec";
const REVIEW_TIME = "2026-09-30T08:00:00.000Z";
const sha1 = (text) => createHash("sha1").update(text, "utf8").digest("hex");

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}
function writeJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), "utf8");
  renameSync(temporary, path);
}

/** Fake agent: deterministic result from the work package; records every call durably (to prove no duplicate execution). */
export class SyntheticAgentExecutor extends AgentExecutor {
  constructor({ recordPath = null } = {}) {
    super();
    this.recordPath = recordPath;
    this.calls = [];
    this.modelCalls = 0; // by construction: this fake never contacts a model
  }

  async execute(workPackage) {
    this.calls.push(workPackage.taskId);
    if (this.recordPath) appendFileSync(this.recordPath, `${JSON.stringify({ taskId: workPackage.taskId, planVersion: workPackage.planBinding.planVersion, title: workPackage.title, seen: Object.keys(workPackage).sort() })}\n`);
    return {
      head: sha1(`head:${workPackage.taskId}:${workPackage.planBinding.taskHash}`), base: BASE,
      branch: `loop/${workPackage.taskId}/${workPackage.executionId}`, authorId: "synthetic-agent@example.invalid", changedFiles: [],
    };
  }
}

export class SyntheticLifecycle {
  constructor({ directory }) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true });
  }

  scope(workPackage) {
    const path = join(this.directory, `${workPackage.taskId}.json`);
    const read = () => readJson(path, { revision: null, ci: null, validation: null, review: null, merge: null, postMergeValidation: null, completed: false });
    const update = (patch) => { const next = { ...read(), ...patch }; writeJson(path, next); return next; };
    const task = makeTask({
      id: workPackage.taskId, title: workPackage.title, specPresent: true, specReviewed: true,
      acceptanceCriteria: workPackage.acceptanceCriteria.map(({ id, text }) => ({ id, description: text })), dependencies: [],
    });
    const proof = (head, baseline) => ({
      head, baseline, specDigest: SPEC_DIGEST, acceptanceCriteriaDigest: task.acceptanceCriteriaDigest, result: "PASS", independent: true,
      acProof: { total: task.acceptanceCriteria.length, proved: task.acceptanceCriteria.length },
    });
    const mergeHead = (head) => sha1(`merge:${head}`);
    return {
      baseHead: BASE,
      specDigest: SPEC_DIGEST,
      gitProvider: { getRevision: () => read().revision },
      ciProvider: { getCIResult: (head) => (read().ci?.head === head ? read().ci : null) },
      reviewProvider: {
        getReviewResult: (head) => (head === BASE
          ? { head, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: REVIEW_TIME, reviewerId: "spec-reviewer@example.invalid" }
          : read().review?.head === head ? read().review : null),
      },
      validationProvider: {
        getValidationResult: (_taskId, head) => {
          const state = read();
          return state.validation?.head === head ? state.validation : state.postMergeValidation?.head === head ? state.postMergeValidation : null;
        },
      },
      scmProvider: { getMergeFact: (_taskId, head) => (read().merge?.candidateHead === head ? read().merge : null) },
      isCompleted: () => read().completed === true,
      implementationResult: () => read().revision,
      actions: {
        recordImplementation: (result) => update({ revision: { head: result.head, base: result.base, branch: result.branch, authorId: result.authorId, dirty: false, changedFiles: [...result.changedFiles] } }),
        runTests: () => { const head = read().revision.head; update({ ci: { head, status: "PASS", checkedAt: REVIEW_TIME, runId: `ci-${head.slice(0, 8)}` } }); return `ci-${head.slice(0, 8)}`; },
        runValidation: (isPostMerge) => {
          const state = read();
          if (isPostMerge) update({ postMergeValidation: proof(mergeHead(state.revision.head), state.revision.head), completed: true });
          else update({ validation: proof(state.revision.head, BASE) });
          return isPostMerge ? "post-validation" : "validation";
        },
        requestReview: () => { const head = read().revision.head; update({ review: { head, verdict: "CLEAN", independent: true, unresolvedFindings: 0, publishedAt: "2026-09-30T09:00:00.000Z", reviewerId: "synthetic-reviewer@example.invalid" } }); return "review"; },
        prepareMerge: () => { const head = read().revision.head; update({ merge: { candidateHead: head, status: "MERGED", merged: true, mergeCommit: mergeHead(head), mergedAt: "2026-09-30T09:30:00.000Z" } }); return mergeHead(head); },
      },
    };
  }
}
