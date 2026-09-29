import { execFileSync } from "node:child_process";
import { SCMProvider, makeMergeFact, makePullRequestFact } from "../core/contracts.js";

function redact(value) {
  return String(value ?? "").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*(?:token|bearer)\s+)\S+/ig, "$1[REDACTED]");
}

function runGh(args, { timeoutMs = 15000, gh = "gh" } = {}) {
  try {
    return execFileSync(gh, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      timeout: timeoutMs,
      killSignal: "SIGTERM",
    }).trim();
  } catch (error) {
    const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true;
    const detail = redact(error?.stderr ?? error?.message ?? "GitHub CLI request failed").slice(0, 1200);
    throw new GitHubSCMError(`GitHub SCM request failed: ${detail}`, timedOut ? "GITHUB_TIMEOUT" : "GITHUB_REQUEST_FAILED", timedOut ? "TRANSIENT" : "EXTERNAL_BLOCK");
  }
}

function decodeJson(raw, operation) {
  try { return JSON.parse(raw); }
  catch { throw new GitHubSCMError(`${operation} returned malformed JSON`, "GITHUB_INVALID_JSON"); }
}

function object(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GitHubSCMError(`${where} has an unexpected response schema`, "GITHUB_INVALID_SCHEMA");
  return value;
}

function sha(value, where) {
  if (typeof value !== "string" || !/^[0-9a-f]{40}$/i.test(value)) throw new GitHubSCMError(`${where} is missing a full commit SHA`, "GITHUB_INVALID_SCHEMA");
  return value.toLowerCase();
}

function safeSegment(value, label) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("..") || /[\r\n]/.test(value)) {
    throw new TypeError(`${label} is invalid`);
  }
  return encodeURIComponent(value);
}

function toPullRequest(value) {
  const pr = object(value, "pull request");
  const head = object(pr.head, "pull request head");
  const base = object(pr.base, "pull request base");
  const user = object(pr.user, "pull request author");
  const mergedAtPresent = Object.hasOwn(pr, "merged_at");
  if (!Number.isSafeInteger(pr.number) || pr.number < 1
    || !["open", "closed"].includes(pr.state)
    || (typeof pr.merged !== "boolean" && (!mergedAtPresent || (pr.merged_at !== null && typeof pr.merged_at !== "string")))
    || typeof head.ref !== "string" || typeof base.ref !== "string"
    || typeof user.login !== "string") {
    throw new GitHubSCMError("pull request has an unexpected response schema", "GITHUB_INVALID_SCHEMA");
  }
  const merged = typeof pr.merged === "boolean" ? pr.merged : typeof pr.merged_at === "string";
  if ((pr.merged === false && typeof pr.merged_at === "string") || (pr.state === "open" && merged)) {
    throw new GitHubSCMError("pull request state contradicts its merge facts", "GITHUB_INVALID_SCHEMA");
  }
  return Object.freeze({
    number: pr.number,
    state: pr.state,
    merged,
    headSha: sha(head.sha, "pull request head"),
    headBranch: head.ref,
    baseBranch: base.ref,
    authorId: user.login,
    mergeable: typeof pr.mergeable === "boolean" ? pr.mergeable : null,
    mergedAt: pr.merged_at ?? null,
    mergeSha: pr.merge_commit_sha == null ? null : sha(pr.merge_commit_sha, "merge commit"),
    updatedAt: pr.updated_at ?? null,
    title: typeof pr.title === "string" ? pr.title : "",
    body: typeof pr.body === "string" ? pr.body : "",
    url: typeof pr.html_url === "string" ? pr.html_url : null,
  });
}

export class GitHubSCMError extends Error {
  constructor(message, code = "GITHUB_SCM_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "GitHubSCMError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

/** SCM adapter; GitHub CLI syntax and REST payloads remain behind this boundary. */
export class GitHubSCMProvider extends SCMProvider {
  constructor({ owner, repo, baseBranch = null, gh = "gh", timeoutMs = 15000, run = runGh } = {}) {
    super();
    if (typeof owner !== "string" || !/^[A-Za-z0-9-]+$/.test(owner)) throw new TypeError("GitHub owner is required");
    if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(repo)) throw new TypeError("GitHub repository is required");
    if (baseBranch !== null && (typeof baseBranch !== "string" || baseBranch.trim() === "")) throw new TypeError("baseBranch must be a non-empty string");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
    this.owner = owner;
    this.repo = repo;
    this.repository = `${owner}/${repo}`;
    this.baseBranch = baseBranch;
    this.gh = gh;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  api(path, args = []) {
    try {
      return this.run(["api", path, ...args], { gh: this.gh, timeoutMs: this.timeoutMs });
    } catch (error) {
      if (error instanceof GitHubSCMError) throw error;
      const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true;
      throw new GitHubSCMError(redact(error?.message ?? "GitHub request failed"), timedOut ? "GITHUB_TIMEOUT" : "GITHUB_REQUEST_FAILED", timedOut ? "TRANSIENT" : "EXTERNAL_BLOCK");
    }
  }

  getRepositoryFacts() {
    const value = object(decodeJson(this.api(`repos/${this.repository}`), "repository lookup"), "repository");
    if (value.full_name?.toLowerCase() !== this.repository.toLowerCase()
      || typeof value.default_branch !== "string" || !value.default_branch
      || typeof value.private !== "boolean") {
      throw new GitHubSCMError("repository response does not match the configured repository", "GITHUB_INVALID_SCHEMA");
    }
    return Object.freeze({ repository: value.full_name, defaultBranch: value.default_branch, private: value.private, url: value.html_url ?? null });
  }

  getBranchFacts(branch) {
    const encoded = safeSegment(branch, "branch");
    const value = object(decodeJson(this.api(`repos/${this.repository}/branches/${encoded}`), "branch lookup"), "branch");
    if (value.name !== branch) throw new GitHubSCMError("branch response does not match the requested branch", "GITHUB_INVALID_SCHEMA");
    const commit = object(value.commit, "branch commit");
    return Object.freeze({ repository: this.repository, branch, headSha: sha(commit.sha, "branch commit"), protected: value.protected === true });
  }

  listPullRequests({ state = "all", head = null, base = this.baseBranch } = {}) {
    if (!["open", "closed", "all"].includes(state)) throw new TypeError("pull request state is invalid");
    const query = [`state=${encodeURIComponent(state)}`, "per_page=100"];
    if (head !== null) query.push(`head=${encodeURIComponent(`${this.owner}:${head}`)}`);
    if (base !== null) query.push(`base=${encodeURIComponent(base)}`);
    const value = decodeJson(this.api(`repos/${this.repository}/pulls?${query.join("&")}`), "pull request discovery");
    if (!Array.isArray(value)) throw new GitHubSCMError("pull request discovery returned a non-array", "GITHUB_INVALID_SCHEMA");
    if (value.length === 100) throw new GitHubSCMError("pull request discovery reached the unpaginated result limit", "GITHUB_RESULT_LIMIT");
    return value.map(toPullRequest);
  }

  getPullRequest(number) {
    if (!Number.isSafeInteger(number) || number < 1) throw new TypeError("pull request number must be positive");
    return toPullRequest(decodeJson(this.api(`repos/${this.repository}/pulls/${number}`), "pull request lookup"));
  }

  findPullRequest({ branch, baseBranch = this.baseBranch, candidateSha = null } = {}) {
    const prs = this.listPullRequests({ state: "all", head: branch, base: baseBranch });
    if (prs.length > 1) throw new GitHubSCMError("multiple pull requests match the execution branch", "GITHUB_AMBIGUOUS_PULL_REQUEST");
    const pr = prs[0] ?? null;
    if (pr && candidateSha && pr.headSha !== sha(candidateSha, "authorized candidate")) {
      return Object.freeze({ ...pr, headMatches: false });
    }
    return pr ? Object.freeze({ ...pr, headMatches: true }) : null;
  }

  getPullRequestFact(taskId, candidateHead, executionId = null) {
    const expected = sha(candidateHead, "candidate HEAD");
    const markers = [`<!-- loop-task:${taskId} -->`];
    if (executionId !== null) markers.push(`<!-- loop-execution:${executionId} -->`);
    const taskPulls = this.listPullRequests({ state: "all", base: this.baseBranch })
      .filter((pr) => markers.every((marker) => pr.body.includes(marker)));
    if (taskPulls.length > 1) throw new GitHubSCMError("multiple task pull requests exist", "GITHUB_AMBIGUOUS_PULL_REQUEST");
    const pr = taskPulls[0];
    if (!pr) return makePullRequestFact({ status: "ABSENT", taskId, candidateHead: expected });
    const matches = pr.headSha === expected;
    const status = !matches ? "UNKNOWN" : pr.merged ? "MERGED" : pr.state === "closed" ? "CLOSED" : "OPEN";
    return makePullRequestFact({
      status, taskId, candidateHead: expected, headSha: pr.headSha,
      branch: pr.headBranch, number: pr.number, mergeable: pr.mergeable, url: pr.url,
    });
  }

  getMergeFact(taskId, candidateHead) {
    const expected = sha(candidateHead, "candidate HEAD");
    const prs = this.listPullRequests({ state: "all", base: this.baseBranch });
    const marker = `<!-- loop-task:${taskId} -->`;
    const taskPulls = prs.filter((pr) => pr.body.includes(marker));
    const exact = taskPulls.filter((pr) => pr.headSha === expected);
    if (exact.length > 1) throw new GitHubSCMError("multiple task pull requests match the candidate SHA", "GITHUB_AMBIGUOUS_PULL_REQUEST");
    if (exact.length === 0) {
      if (taskPulls.length > 0) return makeMergeFact({ status: "UNKNOWN", candidateHead: expected });
      return makeMergeFact({ status: "NOT_STARTED", candidateHead: expected });
    }
    const pr = exact[0];
    if (pr.merged) {
      if (!pr.mergeSha || !pr.mergedAt) throw new GitHubSCMError("merged pull request is missing merge identity or time", "GITHUB_INVALID_SCHEMA");
      return makeMergeFact({ status: "MERGED", candidateHead: expected, mergeCommit: pr.mergeSha, mergedAt: pr.mergedAt });
    }
    if (pr.state === "closed") return makeMergeFact({ status: "FAILED", candidateHead: expected });
    return makeMergeFact({ status: "NOT_STARTED", candidateHead: expected });
  }

  async createPullRequest({ branch, candidateSha, taskId, executionId, title, body = "", baseBranch = this.baseBranch, draft = false } = {}, context = {}) {
    const expected = sha(candidateSha, "candidate SHA");
    if (!taskId || !executionId || !title || !baseBranch) throw new TypeError("task, execution, title, and base branch are required");
    const existing = this.findPullRequest({ branch, baseBranch, candidateSha: expected });
    if (existing?.headMatches) return existing;
    if (existing) throw new GitHubSCMError("execution branch already has a pull request for a different candidate", "GITHUB_PR_HEAD_MISMATCH", "INVARIANT_VIOLATION");
    const remote = this.getBranchFacts(branch);
    if (remote.headSha !== expected) throw new GitHubSCMError("remote branch does not match the authorized candidate SHA", "GITHUB_BRANCH_HEAD_MISMATCH", "INVARIANT_VIOLATION");
    if (typeof context.assertLeaseCurrent !== "function") throw new GitHubSCMError("active execution lease is required to create a pull request", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    const requestBody = `${body.trim()}\n\n<!-- loop-task:${taskId} -->\n<!-- loop-execution:${executionId} -->`;
    const created = object(decodeJson(this.api(`repos/${this.repository}/pulls`, [
      "-X", "POST", "-F", `title=${title}`, "-F", `head=${branch}`, "-F", `base=${baseBranch}`,
      "-F", `body=${requestBody}`, "-F", `draft=${Boolean(draft)}`,
    ]), "pull request creation"), "created pull request");
    const pr = this.getPullRequest(created.number);
    if (pr.headSha !== expected || pr.headBranch !== branch || pr.baseBranch !== baseBranch) {
      throw new GitHubSCMError("created pull request does not identify the authorized branch and candidate", "GITHUB_PR_HEAD_MISMATCH", "INVARIANT_VIOLATION");
    }
    return pr;
  }

  async mergePullRequest({
    number, expectedHead, expectedBase, expectedSpecDigest, expectedAcceptanceCriteriaDigest,
    criterionCount, taskId, implementationAuthorId, requiredCIIdentity,
    ci, validation, review, computedState, attemptedAt = new Date().toISOString(),
  } = {}, context = {}) {
    const head = sha(expectedHead, "authorized candidate");
    if (computedState !== "READY_TO_MERGE"
      || ci?.status !== "PASS" || ci.head !== head || ci.repository?.toLowerCase() !== this.repository.toLowerCase()
      || ci.workflowIdentity !== requiredCIIdentity || typeof ci.runId !== "string" || !ci.runId
      || validation?.result !== "PASS" || validation.head !== head || validation.baseline !== expectedBase
      || validation.specDigest !== expectedSpecDigest
      || validation.acceptanceCriteriaDigest !== expectedAcceptanceCriteriaDigest
      || !Number.isInteger(criterionCount) || validation.acProof?.total !== criterionCount || validation.acProof?.proved !== criterionCount
      || validation.independent !== true
      || review?.verdict !== "CLEAN" || review.head !== head
      || review.independent !== true || review.unresolvedFindings !== 0
      || !review.publishedAt || Date.parse(review.publishedAt) >= Date.parse(attemptedAt)
      || (implementationAuthorId && review.reviewerId?.toLowerCase() === implementationAuthorId.toLowerCase())) {
      throw new GitHubSCMError("merge authorization facts are missing, stale, or unsafe", "GITHUB_MERGE_GATES_FAILED", "INVARIANT_VIOLATION");
    }
    if (typeof context.assertLeaseCurrent !== "function") throw new GitHubSCMError("active execution lease is required to merge", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    const first = this.getPullRequest(number);
    this.assertMergeable(first, head, taskId);
    const branch = this.getBranchFacts(first.headBranch);
    if (branch.headSha !== head) throw new GitHubSCMError("remote branch head changed before merge", "GITHUB_PR_HEAD_MISMATCH", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    const current = this.getPullRequest(number);
    this.assertMergeable(current, head, taskId);
    const latestBranch = this.getBranchFacts(current.headBranch);
    if (latestBranch.headSha !== head) throw new GitHubSCMError("remote branch head changed immediately before merge", "GITHUB_PR_HEAD_MISMATCH", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    const result = object(decodeJson(this.api(`repos/${this.repository}/pulls/${number}/merge`, [
      "-X", "PUT", "-F", `sha=${head}`, "-F", "merge_method=squash",
    ]), "pull request merge"), "merge response");
    if (result.merged !== true || typeof result.message !== "string") {
      throw new GitHubSCMError("GitHub did not confirm the merge", "GITHUB_MERGE_UNCONFIRMED", "TRANSIENT");
    }
    return Object.freeze({ merged: true, candidateHead: head, mergeSha: sha(result.sha, "merge response"), attemptedAt, message: result.message });
  }

  assertMergeable(pr, expectedHead, taskId) {
    if (pr.headSha !== expectedHead) throw new GitHubSCMError("pull request HEAD differs from the authorized candidate", "GITHUB_PR_HEAD_MISMATCH", "INVARIANT_VIOLATION");
    if (pr.state !== "open" || pr.merged) throw new GitHubSCMError("pull request is not open", "GITHUB_PR_NOT_OPEN", "INVARIANT_VIOLATION");
    if (!this.baseBranch || pr.baseBranch !== this.baseBranch) throw new GitHubSCMError("pull request base differs from the configured target branch", "GITHUB_PR_BASE_MISMATCH", "INVARIANT_VIOLATION");
    if (pr.mergeable !== true) throw new GitHubSCMError("pull request mergeability is not explicitly true", "GITHUB_MERGEABILITY_UNKNOWN", "INVARIANT_VIOLATION");
    if (!pr.body.includes(`<!-- loop-task:${taskId} -->`)) throw new GitHubSCMError("pull request task identity does not match", "GITHUB_TASK_ID_MISMATCH", "INVARIANT_VIOLATION");
  }
}
