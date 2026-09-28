import { execFileSync } from "node:child_process";
import { CIProvider, makeCIResult } from "../core/contracts.js";

function redact(value) {
  return String(value ?? "").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
    .replace(/(authorization\s*:\s*(?:token|bearer)\s+)\S+/ig, "$1[REDACTED]");
}

export class GitHubCIError extends Error {
  constructor(message, code = "GITHUB_CI_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "GitHubCIError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

function runGh(args, { timeoutMs, gh }) {
  try {
    return execFileSync(gh, args, {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
      timeout: timeoutMs, killSignal: "SIGTERM",
    }).trim();
  } catch (error) {
    const timeout = error?.code === "ETIMEDOUT" || error?.killed === true;
    const detail = redact(error?.stderr ?? error?.message ?? "GitHub Actions query failed").slice(0, 1200);
    throw new GitHubCIError(`GitHub CI request failed: ${detail}`, timeout ? "GITHUB_CI_TIMEOUT" : "GITHUB_CI_REQUEST_FAILED", timeout ? "TRANSIENT" : "EXTERNAL_BLOCK");
  }
}

function fullSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

/** Reads only one explicitly configured workflow identity and exact commit SHA. */
export class GitHubCIProvider extends CIProvider {
  constructor({ owner, repo, workflowIdentity, gh = "gh", timeoutMs = 15000, run = runGh } = {}) {
    super();
    if (typeof owner !== "string" || !/^[A-Za-z0-9-]+$/.test(owner)) throw new TypeError("GitHub owner is required");
    if (typeof repo !== "string" || !/^[A-Za-z0-9._-]+$/.test(repo)) throw new TypeError("GitHub repository is required");
    if (typeof workflowIdentity !== "string" || !workflowIdentity.startsWith(".github/workflows/")) throw new TypeError("workflowIdentity must be the configured workflow path");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
    this.owner = owner;
    this.repo = repo;
    this.repository = `${owner}/${repo}`;
    this.workflowIdentity = workflowIdentity;
    this.gh = gh;
    this.timeoutMs = timeoutMs;
    this.run = run;
  }

  getCIResult(head) {
    if (!fullSha(head)) throw new TypeError("CI candidate must be a full commit SHA");
    const route = `repos/${this.repository}/actions/runs?head_sha=${encodeURIComponent(head)}&per_page=100`;
    let raw;
    try {
      raw = this.run(["api", route], { gh: this.gh, timeoutMs: this.timeoutMs });
    } catch (error) {
      if (error instanceof GitHubCIError) throw error;
      const timeout = error?.code === "ETIMEDOUT" || error?.killed === true;
      throw new GitHubCIError(redact(error?.message ?? "GitHub Actions query failed"), timeout ? "GITHUB_CI_TIMEOUT" : "GITHUB_CI_REQUEST_FAILED", timeout ? "TRANSIENT" : "EXTERNAL_BLOCK");
    }
    let response;
    try { response = JSON.parse(raw); }
    catch { throw new GitHubCIError("GitHub Actions response was malformed JSON", "GITHUB_CI_INVALID_JSON"); }
    if (!response || typeof response !== "object" || !Array.isArray(response.workflow_runs)) {
      throw new GitHubCIError("GitHub Actions response has an unexpected schema", "GITHUB_CI_INVALID_SCHEMA");
    }
    const runs = response.workflow_runs.filter((run) => run && run.path === this.workflowIdentity
      && run.head_sha === head && run.repository?.full_name?.toLowerCase() === this.repository.toLowerCase());
    runs.sort((left, right) => {
      const createdDelta = Date.parse(right.created_at ?? "") - Date.parse(left.created_at ?? "");
      if (Number.isFinite(createdDelta) && createdDelta !== 0) return createdDelta;
      return Number(right.run_attempt ?? 0) - Number(left.run_attempt ?? 0) || Number(right.id ?? 0) - Number(left.id ?? 0);
    });
    const selected = runs[0];
    if (!selected) {
      return makeCIResult({
        head, status: "UNKNOWN", repository: this.repository,
        workflowIdentity: this.workflowIdentity,
      });
    }
    if (!Number.isSafeInteger(selected.id) || selected.id < 1
      || typeof selected.status !== "string" || typeof selected.head_sha !== "string"
      || !fullSha(selected.head_sha) || typeof selected.path !== "string") {
      throw new GitHubCIError("matching workflow run has an unexpected schema", "GITHUB_CI_INVALID_SCHEMA");
    }
    const conclusion = typeof selected.conclusion === "string" ? selected.conclusion.toLowerCase() : null;
    let status = "UNKNOWN";
    if (["queued", "in_progress", "waiting", "requested", "pending"].includes(selected.status.toLowerCase())) status = "PENDING";
    else if (selected.status.toLowerCase() === "completed" && conclusion === "success") status = "PASS";
    else if (selected.status.toLowerCase() === "completed" && ["failure", "timed_out"].includes(conclusion)) status = "FAIL";
    let checkedAt = null;
    if (selected.updated_at != null) {
      if (typeof selected.updated_at !== "string" || !Number.isFinite(Date.parse(selected.updated_at))) {
        throw new GitHubCIError("matching workflow run has an invalid completion timestamp", "GITHUB_CI_INVALID_SCHEMA");
      }
      checkedAt = new Date(selected.updated_at).toISOString();
    }
    if (status === "PASS" && checkedAt === null) throw new GitHubCIError("successful workflow run is missing its completion timestamp", "GITHUB_CI_INVALID_SCHEMA");
    return makeCIResult({
      head: selected.head_sha.toLowerCase(),
      status,
      checkedAt,
      runId: String(selected.id),
      repository: this.repository,
      workflowIdentity: this.workflowIdentity,
      conclusion,
    });
  }
}
