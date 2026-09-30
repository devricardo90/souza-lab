import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskSystemAdapter, makeTask } from "../core/contracts.js";
import { resolveNextTask } from "./markdown-task-adapter.js";

/**
 * Read-only Jira task source. Maps Jira issues into the same canonical
 * Task/AC/Dependency shapes the Markdown adapter produces, and reuses the
 * existing provider-neutral resolveNextTask resolver unchanged. Nothing in
 * this file is imported by the State Engine, LoopRuntime, ActionPlanner, or
 * the GitHub adapters; they remain unaware Jira exists.
 */

const ISSUE_KEY = /^[A-Z][A-Z0-9]*-\d+$/;
const AC_ID = /^AC-\d{2,}$/;
const AC_HEADING = /^Acceptance Criteria$/;
const AC_LINE = /^-\s+(AC-\d{2,})\s*:\s*(.+?)\s*$/;
const MAX_ISSUES = 1000;

export class JiraTaskSourceError extends Error {
  constructor(message, code = "JIRA_TASK_SOURCE_ERROR", classification = "INVARIANT_VIOLATION") {
    super(message);
    this.name = "JiraTaskSourceError";
    this.code = code;
    this.classification = classification;
    this.retryable = false;
  }
}

export class JiraAdapterError extends Error {
  constructor(message, code = "JIRA_ADAPTER_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "JiraAdapterError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

function redact(value) {
  return String(value ?? "")
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)\S+/ig, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "[REDACTED]");
}

/**
 * Synchronous transport so the adapter satisfies the existing synchronous
 * TaskSystemAdapter contract (RecoveryCoordinator/RuntimeObserver never
 * await taskSystem.listTasks()). Credentials are written to a mode-0600
 * curl config file and never placed in argv/env of a child process error,
 * mirroring why the GitHub adapters never leak a token: `gh` never receives
 * one as an argument either.
 */
export function defaultJiraTransport({ site, email, apiToken, path, query = "", timeoutMs = 15000 }) {
  if (typeof site !== "string" || site.trim() === "") throw new TypeError("Jira site is required");
  if (typeof email !== "string" || email.trim() === "") throw new TypeError("Jira email is required");
  if (typeof apiToken !== "string" || apiToken.trim() === "") throw new TypeError("Jira API token is required");
  const url = `https://${site}/rest/api/3/${path}${query ? `?${query}` : ""}`;
  const basic = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
  const configDir = mkdtempSync(join(tmpdir(), "loop-jira-curl-"));
  const configPath = join(configDir, "curl.cfg");
  try {
    writeFileSync(configPath, `header = "Authorization: Basic ${basic}"\nheader = "Accept: application/json"\nsilent\nshow-error\nfail\n`, { mode: 0o600 });
    return execFileSync("curl", ["-K", configPath, "--max-time", String(Math.ceil(timeoutMs / 1000)), url], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: timeoutMs, killSignal: "SIGTERM",
    }).trim();
  } finally {
    try { rmSync(configDir, { recursive: true, force: true }); } catch {}
  }
}

function call(transport, request) {
  try {
    return transport(request);
  } catch (error) {
    if (error instanceof JiraAdapterError) throw error;
    const status = Number(error?.status ?? error?.httpStatus ?? NaN);
    const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true || error?.timeout === true;
    if (status === 401 || status === 403) {
      throw new JiraAdapterError(`Jira authentication failed: ${redact(error.message)}`, "JIRA_AUTH_FAILED", "EXTERNAL_BLOCK");
    }
    throw new JiraAdapterError(
      `Jira request failed: ${redact(error?.message ?? "unknown transport error")}`,
      timedOut ? "JIRA_TIMEOUT" : "JIRA_REQUEST_FAILED",
      timedOut ? "TRANSIENT" : "EXTERNAL_BLOCK",
    );
  }
}

function decodeJson(raw, where) {
  try { return JSON.parse(raw); }
  catch { throw new JiraAdapterError(`${where} returned malformed JSON`, "JIRA_INVALID_JSON", "EXTERNAL_BLOCK"); }
}

function object(value, where) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new JiraAdapterError(`${where} has an unexpected response schema`, "JIRA_INVALID_SCHEMA", "EXTERNAL_BLOCK");
  }
  return value;
}

function mapStatus(rawStatus, statusMapping) {
  if (typeof rawStatus !== "string" || rawStatus.trim() === "") {
    throw new JiraTaskSourceError("Jira issue is missing its workflow status name", "JIRA_STATUS_MISSING");
  }
  const mapped = statusMapping[rawStatus];
  if (mapped !== "OPEN" && mapped !== "DONE") {
    throw new JiraTaskSourceError(`unknown Jira workflow status "${rawStatus}" is not present in the configured status mapping`, "JIRA_UNKNOWN_STATUS");
  }
  return mapped === "DONE";
}

/**
 * Parses a deterministic Acceptance Criteria block. Source is either a
 * dedicated custom-field string, or a strictly named "Acceptance Criteria"
 * section inside the plain-text issue description. Arbitrary prose is never
 * scanned for implied ACs; anything under the heading that is not a valid
 * "- AC-NNN: description" line fails closed.
 */
export function parseAcceptanceCriteria({ issueKey, descriptionText = null, customFieldText = null, acSource = "description" }) {
  const source = acSource === "field" ? customFieldText : extractSection(descriptionText);
  if (source === null) {
    throw new JiraTaskSourceError(`${issueKey}: acceptance criteria are required but no Acceptance Criteria section or field was found`, "JIRA_AC_MISSING");
  }
  const lines = source.replace(/\r\n/g, "\n").split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (lines.length === 0) {
    throw new JiraTaskSourceError(`${issueKey}: acceptance criteria section is empty`, "JIRA_AC_MISSING");
  }
  const criteria = [];
  const seen = new Set();
  for (const line of lines) {
    const match = line.match(AC_LINE);
    if (!match) throw new JiraTaskSourceError(`${issueKey}: malformed acceptance criterion line "${line}"`, "JIRA_AC_MALFORMED");
    const [, id, description] = match;
    if (!AC_ID.test(id)) throw new JiraTaskSourceError(`${issueKey}: invalid acceptance criterion id ${id}`, "JIRA_AC_MALFORMED");
    if (seen.has(id)) throw new JiraTaskSourceError(`${issueKey}: duplicate acceptance criterion id ${id}`, "JIRA_AC_DUPLICATE");
    seen.add(id);
    criteria.push({ id, description });
  }
  return criteria;
}

function extractSection(descriptionText) {
  if (typeof descriptionText !== "string") return null;
  const lines = descriptionText.replace(/\r\n/g, "\n").split("\n");
  const headingIndex = lines.findIndex((line) => AC_HEADING.test(line.trim()));
  if (headingIndex < 0) return null;
  const body = [];
  for (let index = headingIndex + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "" && body.length > 0) break;
    body.push(line);
  }
  return body.join("\n");
}

/**
 * Maps explicit Jira issue links of the configured link type into canonical
 * dependencies. Only the inward ("is blocked by") direction of the
 * configured relation becomes a dependency; every other link type or
 * direction is ignored rather than guessed at.
 */
export function mapDependencies(issue, { dependencyLinkType = "Blocks" } = {}) {
  const links = Array.isArray(issue.fields?.issuelinks) ? issue.fields.issuelinks : [];
  const dependencies = [];
  const seen = new Set();
  for (const link of links) {
    const typeName = link?.type?.name;
    if (typeName !== dependencyLinkType) continue;
    const blockedBy = link?.inwardIssue?.key;
    if (typeof blockedBy !== "string" || blockedBy.trim() === "") continue;
    if (seen.has(blockedBy)) continue;
    seen.add(blockedBy);
    dependencies.push({ taskId: blockedBy, requiresDone: true });
  }
  return dependencies;
}

function validateDependencyGraph(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency.taskId)) {
        throw new JiraTaskSourceError(`${task.id} depends on missing issue ${dependency.taskId}`, "JIRA_MISSING_DEPENDENCY");
      }
    }
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (taskId) => {
    if (visiting.has(taskId)) throw new JiraTaskSourceError(`dependency cycle includes ${taskId}`, "JIRA_DEPENDENCY_CYCLE");
    if (visited.has(taskId)) return;
    visiting.add(taskId);
    for (const dependency of byId.get(taskId).dependencies) visit(dependency.taskId);
    visiting.delete(taskId);
    visited.add(taskId);
  };
  for (const task of tasks) visit(task.id);
}

/**
 * Maps one Jira issue into the canonical Task contract. Jira-specific shape
 * (custom fields, issue links, ADF/plain-text description) stops here; the
 * State Engine only ever sees id/title/acceptanceCriteria/dependencies/
 * completed. Jira-only bookkeeping (project key, URL, raw status) is kept
 * out of the canonical Task and returned separately via `metadata`, so the
 * frozen object the runtime observes never carries Jira-specific fields.
 */
export function mapIssueToTask(issue, config) {
  const key = issue?.key;
  if (typeof key !== "string" || !ISSUE_KEY.test(key)) {
    throw new JiraTaskSourceError(`Jira issue key "${key}" is not a valid stable issue identity`, "JIRA_INVALID_ISSUE_KEY");
  }
  const fields = object(issue.fields, `${key}.fields`);
  const rawStatus = fields.status?.name;
  const completed = mapStatus(rawStatus, config.statusMapping);
  const summary = typeof fields.summary === "string" && fields.summary.trim() !== "" ? fields.summary.trim() : key;
  const acceptanceCriteria = parseAcceptanceCriteria({
    issueKey: key,
    descriptionText: typeof fields.description === "string" ? fields.description : null,
    customFieldText: config.acFieldId ? fields[config.acFieldId] ?? null : null,
    acSource: config.acSource,
  });
  const dependencies = mapDependencies(issue, config);
  const task = makeTask({
    id: key,
    title: summary,
    completed,
    specPresent: true,
    specReviewed: true,
    acceptanceCriteria,
    dependencies,
  });
  const metadata = Object.freeze({
    projectKey: config.projectKey,
    issueUrl: `https://${config.site}/browse/${key}`,
    rawStatus,
  });
  return { task, metadata };
}

export class JiraTaskSystemAdapter extends TaskSystemAdapter {
  constructor({
    site, email, apiToken, projectKey, statusMapping,
    dependencyLinkType = "Blocks", acSource = "description", acFieldId = null,
    timeoutMs = 15000, transport = defaultJiraTransport,
  } = {}) {
    super();
    if (typeof site !== "string" || site.trim() === "") throw new TypeError("Jira site is required");
    if (typeof projectKey !== "string" || !/^[A-Z][A-Z0-9]*$/.test(projectKey)) throw new TypeError("Jira projectKey is required");
    if (!statusMapping || typeof statusMapping !== "object") throw new TypeError("Jira statusMapping is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
    this.site = site;
    this.email = email;
    this.apiToken = apiToken;
    this.projectKey = projectKey;
    this.statusMapping = Object.freeze({ ...statusMapping });
    this.dependencyLinkType = dependencyLinkType;
    this.acSource = acSource;
    this.acFieldId = acFieldId;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.lastMetadata = new Map();
  }

  search(startAt) {
    const fields = ["summary", "status", "description", "issuelinks", ...(this.acFieldId ? [this.acFieldId] : [])].join(",");
    const query = new URLSearchParams({
      jql: `project = "${this.projectKey}" ORDER BY key ASC`,
      startAt: String(startAt),
      maxResults: "100",
      fields,
    }).toString();
    const raw = call(this.transport, {
      site: this.site, email: this.email, apiToken: this.apiToken, timeoutMs: this.timeoutMs,
      path: "search", query,
    });
    return object(decodeJson(raw, "Jira issue search"), "Jira search response");
  }

  fetchAllIssues() {
    const issues = [];
    let startAt = 0;
    for (;;) {
      const page = this.search(startAt);
      if (!Array.isArray(page.issues)) throw new JiraAdapterError("Jira search response is missing an issues array", "JIRA_INVALID_SCHEMA", "EXTERNAL_BLOCK");
      issues.push(...page.issues);
      if (issues.length > MAX_ISSUES) throw new JiraAdapterError("Jira project exceeds the supported unpaginated safety limit", "JIRA_RESULT_LIMIT", "EXTERNAL_BLOCK");
      const total = Number(page.total ?? issues.length);
      startAt += page.issues.length;
      if (page.issues.length === 0 || startAt >= total) break;
    }
    return issues;
  }

  /** Fresh read every call: nothing here is cached across observations, so
   * material Jira drift (status/AC/dependency edits) is always visible to
   * the existing executionFactsFingerprint precondition guard in LoopRuntime. */
  listTasks() {
    const issues = this.fetchAllIssues();
    const tasks = [];
    const metadata = new Map();
    const seenIds = new Set();
    for (const issue of issues) {
      const { task, metadata: issueMetadata } = mapIssueToTask(issue, {
        statusMapping: this.statusMapping, dependencyLinkType: this.dependencyLinkType,
        acSource: this.acSource, acFieldId: this.acFieldId, projectKey: this.projectKey, site: this.site,
      });
      if (seenIds.has(task.id)) throw new JiraTaskSourceError(`duplicate Jira issue key ${task.id} in normalized input`, "JIRA_DUPLICATE_ISSUE_KEY");
      seenIds.add(task.id);
      tasks.push(task);
      metadata.set(task.id, issueMetadata);
    }
    validateDependencyGraph(tasks);
    this.lastMetadata = metadata;
    return Object.freeze(tasks);
  }

  resolveNextTask({ additionalCompletedIds = [] } = {}) {
    const completed = new Set(additionalCompletedIds);
    const tasks = this.listTasks().map((task) => completed.has(task.id) && !task.completed
      ? makeTask({ ...task, completed: true })
      : task);
    return resolveNextTask(tasks);
  }

  /** Jira-only bookkeeping for a task, held by the adapter and never placed
   * on the canonical Task the State Engine observes. */
  getIssueMetadata(taskId) {
    return this.lastMetadata.get(taskId) ?? null;
  }
}
