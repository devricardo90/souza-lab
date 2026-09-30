import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Jira write-path capabilities: execution-started / PR / merge comments and
 * the completion transition. Kept entirely separate from
 * JiraTaskSystemAdapter (the read path) per the read-first/write-second
 * staging this phase requires.
 *
 * Architecture note: this client is NOT wired into the ActionPlanner's
 * COMPLETE action. In the existing LoopRuntime, COMPLETE is a terminal
 * marker the runtime flips computed state to DONE on without invoking any
 * capability (see loop-runtime.js's COMPLETE branch) — the core has no
 * post-DONE side-effect hook, and adding one would be a LoopRuntime change,
 * which this phase must not make. Jira completion sync is therefore an
 * out-of-band step the orchestration script performs strictly after
 * `runtime.runUntilStop()` observes DONE, exactly like an external
 * notification worker would. This keeps Jira synchronization state fully
 * outside the State Engine's execution truth (see docs/evidence/PHASE-7 for
 * the write-up of this decision).
 */

function redact(value) {
  return String(value ?? "")
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)\S+/ig, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "[REDACTED]");
}

export class JiraSyncError extends Error {
  constructor(message, code = "JIRA_SYNC_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "JiraSyncError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

export function defaultJiraWriteTransport({ site, email, apiToken, path, method = "GET", body = null, timeoutMs = 15000 }) {
  const url = `https://${site}/rest/api/3/${path}`;
  const basic = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
  const configDir = mkdtempSync(join(tmpdir(), "loop-jira-curl-write-"));
  const configPath = join(configDir, "curl.cfg");
  const bodyPath = join(configDir, "body.json");
  try {
    const lines = [
      `header = "Authorization: Basic ${basic}"`,
      `header = "Accept: application/json"`,
      `header = "Content-Type: application/json"`,
      `request = "${method}"`,
      "silent", "show-error", "fail",
    ];
    if (body !== null) {
      writeFileSync(bodyPath, JSON.stringify(body), { mode: 0o600 });
      lines.push(`data = "@${bodyPath.replace(/\\/g, "\\\\")}"`);
    }
    writeFileSync(configPath, `${lines.join("\n")}\n`, { mode: 0o600 });
    const raw = execFileSync("curl", ["-K", configPath, "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: timeoutMs, killSignal: "SIGTERM",
    }).trim();
    return raw === "" ? null : raw;
  } finally {
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
  }
}

function call(transport, request) {
  try {
    return transport(request);
  } catch (error) {
    if (error instanceof JiraSyncError) throw error;
    const status = Number(error?.status ?? error?.httpStatus ?? NaN);
    const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true || error?.timeout === true;
    if (status === 401 || status === 403) throw new JiraSyncError(`Jira authentication failed: ${redact(error.message)}`, "JIRA_AUTH_FAILED", "EXTERNAL_BLOCK");
    throw new JiraSyncError(
      `Jira write request failed: ${redact(error?.message ?? "unknown transport error")}`,
      timedOut ? "JIRA_TIMEOUT" : "JIRA_REQUEST_FAILED",
      timedOut ? "TRANSIENT" : "EXTERNAL_BLOCK",
    );
  }
}

function decodeJson(raw, where) {
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch { throw new JiraSyncError(`${where} returned malformed JSON`, "JIRA_INVALID_JSON", "EXTERNAL_BLOCK"); }
}

function marker(executionId, kind) {
  return `<!-- loop-execution:${executionId}:${kind} -->`;
}

export class JiraSyncClient {
  constructor({ site, email, apiToken, timeoutMs = 15000, transport = defaultJiraWriteTransport } = {}) {
    if (typeof site !== "string" || site.trim() === "") throw new TypeError("Jira site is required");
    this.site = site;
    this.email = email;
    this.apiToken = apiToken;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  request(path, { method = "GET", body = null } = {}) {
    const raw = call(this.transport, {
      site: this.site, email: this.email, apiToken: this.apiToken, timeoutMs: this.timeoutMs, path, method, body,
    });
    return decodeJson(raw, `Jira ${method} ${path}`);
  }

  listComments(issueKey) {
    const response = this.request(`issue/${encodeURIComponent(issueKey)}/comment?maxResults=200`);
    if (!response || !Array.isArray(response.comments)) {
      throw new JiraSyncError(`${issueKey}: comment listing has an unexpected schema`, "JIRA_INVALID_SCHEMA");
    }
    return response.comments;
  }

  findMarkedComment(issueKey, markerText) {
    return this.listComments(issueKey).find((comment) => plainText(comment).includes(markerText)) ?? null;
  }

  /** Idempotent by marker: rediscovers a prior write instead of duplicating a comment
   * when a previous response was lost and the runtime retries (J17). */
  async addExecutionComment(issueKey, { executionId, kind, body }, context) {
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    const tag = marker(executionId, kind);
    const existing = this.findMarkedComment(issueKey, tag);
    if (existing) return { created: false, id: existing.id };
    await context.assertLeaseCurrent();
    const created = this.request(`issue/${encodeURIComponent(issueKey)}/comment`, {
      method: "POST",
      body: { body: adfParagraph(`${body}\n\n${tag}`) },
    });
    if (!created?.id) throw new JiraSyncError(`${issueKey}: Jira did not confirm the comment write`, "JIRA_WRITE_UNCONFIRMED", "TRANSIENT");
    return { created: true, id: created.id };
  }

  recordExecutionStarted(issueKey, { executionId }, context) {
    return this.addExecutionComment(issueKey, { executionId, kind: "started", body: `Loop execution ${executionId} started.` }, context);
  }

  recordPullRequestReference(issueKey, { executionId, prUrl }, context) {
    return this.addExecutionComment(issueKey, { executionId, kind: "pr", body: `Loop execution ${executionId} opened ${prUrl}.` }, context);
  }

  recordMergeReference(issueKey, { executionId, mergeSha, mergeUrl }, context) {
    return this.addExecutionComment(issueKey, { executionId, kind: "merge", body: `Loop execution ${executionId} merged ${mergeSha} (${mergeUrl}).` }, context);
  }

  /**
   * Jira is not execution truth (Phase 7 section 16/17): this may only be
   * called after the caller has independently observed computed state
   * DONE. It refuses otherwise rather than trusting a caller-supplied claim
   * uncritically about anything other than that one precondition.
   */
  async markTaskComplete(issueKey, { executionId, computedState, doneStatusName, transitionName }, context) {
    if (computedState !== "DONE") {
      throw new JiraSyncError("Jira completion may only be requested after computed Loop state is DONE", "JIRA_PREMATURE_COMPLETION", "INVARIANT_VIOLATION");
    }
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    const issue = this.request(`issue/${encodeURIComponent(issueKey)}?fields=status`);
    if (issue?.fields?.status?.name === doneStatusName) return { transitioned: false, alreadyDone: true };
    await context.assertLeaseCurrent();
    const transitions = this.request(`issue/${encodeURIComponent(issueKey)}/transitions`);
    const match = Array.isArray(transitions?.transitions) ? transitions.transitions.find((t) => t.name === transitionName) : null;
    if (!match) throw new JiraSyncError(`${issueKey}: configured completion transition "${transitionName}" is not available`, "JIRA_TRANSITION_NOT_FOUND", "EXTERNAL_BLOCK");
    await context.assertLeaseCurrent();
    this.request(`issue/${encodeURIComponent(issueKey)}/transitions`, { method: "POST", body: { transition: { id: match.id } } });
    return { transitioned: true, alreadyDone: false };
  }
}

function adfParagraph(text) {
  return { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}

function plainText(comment) {
  const body = comment?.body;
  if (typeof body === "string") return body;
  if (body && typeof body === "object") {
    try { return JSON.stringify(body); } catch { return ""; }
  }
  return "";
}
