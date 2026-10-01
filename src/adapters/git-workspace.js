import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Real local Git facts and isolated per-execution workspaces (CP-06). Every fact comes from `git` itself, never
 * from an agent narrative.
 *
 * Isolation: each execution gets its OWN git worktree on its OWN branch, created from a recorded base SHA. A
 * restart knows exactly where to look (path + branch are persisted before the agent runs), and ownership is never
 * inferred from arbitrary changes in the main working tree. An ownership marker lives in the worktree's private
 * git dir (outside the working tree, so it never shows up as an untracked change).
 *
 * Nothing here ever resets, cleans, checks out over, or deletes work.
 */

export class GitError extends Error {
  constructor(message, code = "GIT_ERROR") {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.classification = "EXTERNAL_BLOCK";
    this.retryable = false;
  }
}

export const EXECUTION_TRAILERS = Object.freeze({ execution: "Loop-Execution-Id", task: "Loop-Task-Id" });
export const CLASSIFICATIONS = Object.freeze([
  "NO_IMPLEMENTATION_PRESENT", "IMPLEMENTATION_PRESENT_UNVERIFIED", "COMMITTED_IMPLEMENTATION_PRESENT", "AMBIGUOUS_EXECUTION_STATE",
]);

export function git(cwd, args, { allowFailure = false, input } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, input, stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).replace(/\r\n/g, "\n");
  } catch (error) {
    if (allowFailure) return null;
    throw new GitError(`git ${args.join(" ")} failed: ${String(error.stderr ?? error.message).trim().slice(0, 300)}`);
  }
}

const trim = (text) => (text ?? "").trim();

/** Resolves a ref to a full commit SHA in the given repository. */
export function resolveSha(repoPath, ref) {
  const sha = trim(git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`], { allowFailure: true }));
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new GitError(`cannot resolve ${ref} to a commit`, "BASE_REF_UNRESOLVED");
  return sha;
}

function markerPath(workspacePath) {
  const gitDir = resolve(workspacePath, trim(git(workspacePath, ["rev-parse", "--git-dir"])));
  return join(gitDir, "loop-execution.json");
}

/**
 * Creates (or re-attaches to) the isolated worktree for one execution. Idempotent: an existing worktree on the expected
 * branch with a matching marker is reused untouched; anything else is refused rather than overwritten.
 */
export function ensureWorkspace({ repoPath, workspacesDir, executionId, taskId, baseSha, branch }) {
  mkdirSync(workspacesDir, { recursive: true });
  const path = resolve(workspacesDir, executionId);
  if (existsSync(path)) {
    const marker = readMarker(path);
    if (!marker || marker.executionId !== executionId || marker.taskId !== taskId || marker.baseSha !== baseSha) {
      throw new GitError(`workspace ${path} exists but is not owned by execution ${executionId}`, "WORKSPACE_NOT_OWNED");
    }
    return { path, branch, baseSha, reused: true };
  }
  git(repoPath, ["worktree", "add", "-b", branch, path, baseSha]);
  writeFileSync(markerPath(path), JSON.stringify({ executionId, taskId, baseSha, branch }), "utf8");
  return { path, branch, baseSha, reused: false };
}

export function readMarker(workspacePath) {
  try { return JSON.parse(readFileSync(markerPath(workspacePath), "utf8")); } catch { return null; }
}

function parseTrailers(message) {
  const trailers = {};
  for (const line of message.split("\n")) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9-]*):\s*(.+?)\s*$/);
    if (match && Object.values(EXECUTION_TRAILERS).includes(match[1])) trailers[match[1]] = match[2];
  }
  return trailers;
}

/**
 * Observes the execution workspace. Read-only. Facts: base SHA, current HEAD, branch, commits since base (with
 * trailers), tracked changes, untracked files.
 */
export function inspectWorkspace({ workspacePath, baseSha, branch, executionId, taskId }) {
  if (!workspacePath || !existsSync(workspacePath)) return { present: false, reason: "WORKSPACE_MISSING" };
  const marker = readMarker(workspacePath);
  const facts = { present: true, path: workspacePath, baseSha, expectedBranch: branch };
  facts.markerMatches = Boolean(marker && marker.executionId === executionId && marker.taskId === taskId && marker.baseSha === baseSha);
  facts.branch = trim(git(workspacePath, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFailure: true })) || null;
  facts.head = trim(git(workspacePath, ["rev-parse", "HEAD"], { allowFailure: true })) || null;
  facts.baseIsAncestor = git(workspacePath, ["merge-base", "--is-ancestor", baseSha, "HEAD"], { allowFailure: true }) !== null;
  const revs = facts.baseIsAncestor ? trim(git(workspacePath, ["rev-list", "--reverse", `${baseSha}..HEAD`])).split("\n").filter(Boolean) : [];
  facts.commits = revs.map((sha) => {
    const message = git(workspacePath, ["show", "-s", "--format=%B", sha]);
    return {
      sha, trailers: parseTrailers(message), authorEmail: trim(git(workspacePath, ["show", "-s", "--format=%ae", sha])),
      files: trim(git(workspacePath, ["diff-tree", "--no-commit-id", "--name-only", "-r", sha])).split("\n").filter(Boolean),
    };
  });
  const status = git(workspacePath, ["status", "--porcelain=v1", "-uall"]).split("\n").filter(Boolean);
  facts.trackedChanges = status.filter((line) => !line.startsWith("??")).map((line) => line.slice(3));
  facts.untracked = status.filter((line) => line.startsWith("??")).map((line) => line.slice(3));
  return facts;
}

/**
 * Deterministic classification of what happened around an agent invocation. Pure function of git facts.
 *   NO_IMPLEMENTATION_PRESENT          clean workspace, no commits since base: safe to retry the same execution
 *   IMPLEMENTATION_PRESENT_UNVERIFIED  uncommitted work exists: preserve it; resume, never restart from a clean baseline
 *   COMMITTED_IMPLEMENTATION_PRESENT   commit(s) carrying THIS execution's trailers, tree clean: the work is done
 *   AMBIGUOUS_EXECUTION_STATE          anything else (missing/foreign workspace, wrong branch, foreign commits, dirty+committed)
 */
export function classifyExecution(facts, { executionId, taskId }) {
  const reasons = [];
  if (!facts.present) return { classification: "AMBIGUOUS_EXECUTION_STATE", reasons: [facts.reason ?? "WORKSPACE_MISSING"] };
  if (!facts.markerMatches) reasons.push("OWNERSHIP_MARKER_MISMATCH");
  if (facts.branch !== facts.expectedBranch) reasons.push("BRANCH_MISMATCH");
  if (!facts.baseIsAncestor) reasons.push("BASE_NOT_ANCESTOR");
  const mine = (commit) => commit.trailers[EXECUTION_TRAILERS.execution] === executionId && commit.trailers[EXECUTION_TRAILERS.task] === taskId;
  if (facts.commits.some((commit) => !mine(commit))) reasons.push("FOREIGN_COMMIT");
  const dirty = facts.trackedChanges.length + facts.untracked.length > 0;
  if (reasons.length > 0) return { classification: "AMBIGUOUS_EXECUTION_STATE", reasons };
  if (facts.commits.length > 0) {
    if (dirty) return { classification: "AMBIGUOUS_EXECUTION_STATE", reasons: ["COMMITTED_AND_UNCOMMITTED_WORK"] };
    return { classification: "COMMITTED_IMPLEMENTATION_PRESENT", reasons: [] };
  }
  return dirty ? { classification: "IMPLEMENTATION_PRESENT_UNVERIFIED", reasons: [] } : { classification: "NO_IMPLEMENTATION_PRESENT", reasons: [] };
}

/** Agent-result-shaped facts derived purely from git (used when the agent never reported). */
export function resultFromGit(facts) {
  const last = facts.commits.at(-1);
  return {
    head: facts.head, base: facts.baseSha, branch: facts.branch, authorId: last.authorEmail,
    changedFiles: [...new Set(facts.commits.flatMap((commit) => commit.files))].sort(),
  };
}
