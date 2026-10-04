import { TaskSystemAdapter, makeTask } from "../core/contracts.js";
import { resolveNextTask } from "./markdown-task-adapter.js";
import { blockerOf, parseRelationshipConfig } from "../reconcile/jira-relationship.js";
import { JIRA_MODES, annotateError, classifyJiraFacts, isFacts, jiraCurlTransport, redact } from "./jira-transport.js";

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

function adfTextNode(node, issueKey) {
  if (!node || node.type !== "text" || typeof node.text !== "string" || Object.keys(node).some((key) => !["type", "text"].includes(key))) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF node`, "JIRA_ADF_UNSUPPORTED");
  return node.text;
}

export function normalizeAdfDescription(description, issueKey = "Jira issue") {
  if (!description || typeof description !== "object" || Array.isArray(description) || description.type !== "doc" || description.version !== 1 || !Array.isArray(description.content) || Object.keys(description).some((key) => !["type", "version", "content"].includes(key))) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF document`, "JIRA_ADF_UNSUPPORTED");
  const lines = [];
  for (const node of description.content) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF node`, "JIRA_ADF_UNSUPPORTED");
    if (node.type === "paragraph") {
      if (!Array.isArray(node.content) || node.content.length !== 1 || Object.keys(node).some((key) => !["type", "content"].includes(key))) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF paragraph`, "JIRA_ADF_UNSUPPORTED");
      lines.push(adfTextNode(node.content[0], issueKey));
    } else if (node.type === "bulletList") {
      if (!Array.isArray(node.content) || Object.keys(node).some((key) => !["type", "content"].includes(key))) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF bullet list`, "JIRA_ADF_UNSUPPORTED");
      for (const item of node.content) {
        if (!item || item.type !== "listItem" || !Array.isArray(item.content) || item.content.length !== 1 || Object.keys(item).some((key) => !["type", "content"].includes(key))) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF list item`, "JIRA_ADF_UNSUPPORTED");
        const paragraph = item.content[0];
        if (!paragraph || paragraph.type !== "paragraph" || !Array.isArray(paragraph.content) || paragraph.content.length !== 1 || Object.keys(paragraph).some((key) => !["type", "content"].includes(key))) throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF list paragraph`, "JIRA_ADF_UNSUPPORTED");
        lines.push(`- ${adfTextNode(paragraph.content[0], issueKey)}`);
      }
    } else throw new JiraTaskSourceError(`${issueKey}: unsupported Jira ADF node type ${node.type ?? "unknown"}`, "JIRA_ADF_UNSUPPORTED");
  }
  return lines.join("\n");
}

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

export const defaultJiraTransport = jiraCurlTransport;

function call(transport, request) {
  let result;
  try {
    result = transport(request);
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
  if (!isFacts(result)) return result;
  const spec = classifyJiraFacts(result);
  if (!spec.ok) throw annotateError(new JiraAdapterError(`Jira request failed: ${redact(spec.message)}`, spec.code, spec.classification), spec);
  return result.body;
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
 * Maps explicit Jira issue links into canonical dependencies using ONLY the explicit relationship
 * configuration (jira-relationship.js): there is no implicit link type or direction. An issue that has link
 * entries while no relationship is configured fails closed (RELATIONSHIP_CONFIG_INVALID) instead of guessing.
 */
export function mapDependencies(issue, { relationship = null } = {}) {
  const links = Array.isArray(issue.fields?.issuelinks) ? issue.fields.issuelinks : [];
  if (relationship === null) {
    if (links.length > 0) throw new JiraTaskSourceError(`${issue.key}: issue links found but no relationship configuration is set (no implicit direction)`, "RELATIONSHIP_CONFIG_INVALID");
    return [];
  }
  const relation = parseRelationshipConfig(relationship);
  const dependencies = [];
  const seen = new Set();
  for (const link of links) {
    const blockedBy = blockerOf(relation, link);
    if (blockedBy === null) continue;
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
  const descriptionText = typeof fields.description === "string"
    ? fields.description
    : fields.description && typeof fields.description === "object"
      ? normalizeAdfDescription(fields.description, key)
      : null;
  const acceptanceCriteria = parseAcceptanceCriteria({
    issueKey: key,
    descriptionText,
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
  // Credentials live in a true private field: absent from JSON.stringify,
  // Object.keys/getOwnPropertyNames, util.inspect, structuredClone and logs.
  #credentials;

  constructor({
    site, email, apiToken, projectKey, statusMapping,
    relationship = null, acSource = "description", acFieldId = null,
    timeoutMs = 15000, transport = defaultJiraTransport, scheme = "https", mode = "classic", cloudId = null, gatewayHost,
  } = {}) {
    super();
    if (!JIRA_MODES.includes(mode)) throw new TypeError(`Jira mode must be one of ${JIRA_MODES.join(", ")}`);
    if (mode === "scoped") { if (typeof cloudId !== "string" || cloudId.trim() === "") throw new TypeError("Jira cloudId is required for scoped mode"); }
    else if (typeof site !== "string" || site.trim() === "") throw new TypeError("Jira site is required");
    if (typeof projectKey !== "string" || !/^[A-Z][A-Z0-9]*$/.test(projectKey)) throw new TypeError("Jira projectKey is required");
    if (!statusMapping || typeof statusMapping !== "object") throw new TypeError("Jira statusMapping is required");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
    this.site = site ?? null;
    this.mode = mode;
    this.cloudId = cloudId;
    this.gatewayHost = gatewayHost;
    this.scheme = scheme;
    this.#credentials = Object.freeze({ email, apiToken });
    this.projectKey = projectKey;
    this.statusMapping = Object.freeze({ ...statusMapping });
    this.relationship = relationship === null ? null : parseRelationshipConfig(relationship);
    this.acSource = acSource;
    this.acFieldId = acFieldId;
    this.timeoutMs = timeoutMs;
    this.transport = transport;
    this.lastMetadata = new Map();
  }

  search(nextPageToken = null) {
    const fields = ["summary", "status", "description", "issuelinks", ...(this.acFieldId ? [this.acFieldId] : [])].join(",");
    const query = new URLSearchParams({
      jql: `project = "${this.projectKey}" ORDER BY key ASC`,
      maxResults: "100",
      fields,
    }).toString();
    const pageQuery = nextPageToken === null ? query : `${query}&nextPageToken=${encodeURIComponent(nextPageToken)}`;
    const raw = call(this.transport, {
      mode: this.mode, cloudId: this.cloudId, gatewayHost: this.gatewayHost,
      site: this.site, scheme: this.scheme, email: this.#credentials.email, apiToken: this.#credentials.apiToken, timeoutMs: this.timeoutMs,
      path: "search/jql", query: pageQuery,
    });
    return object(decodeJson(raw, "Jira issue search"), "Jira search response");
  }

  fetchAllIssues() {
    const issues = [];
    let nextPageToken = null;
    const seenTokens = new Set();
    for (;;) {
      const page = this.search(nextPageToken);
      if (!Array.isArray(page.issues)) throw new JiraAdapterError("Jira search response is missing an issues array", "JIRA_INVALID_SCHEMA", "EXTERNAL_BLOCK");
      if (typeof page.isLast !== "boolean") throw new JiraAdapterError("Jira search response has malformed pagination", "JIRA_INVALID_SCHEMA", "EXTERNAL_BLOCK");
      issues.push(...page.issues);
      if (issues.length > MAX_ISSUES) throw new JiraAdapterError("Jira project exceeds the supported unpaginated safety limit", "JIRA_RESULT_LIMIT", "EXTERNAL_BLOCK");
      if (page.isLast) {
        if (page.nextPageToken !== undefined && page.nextPageToken !== null) throw new JiraAdapterError("Jira search response has inconsistent final pagination", "JIRA_INVALID_SCHEMA", "EXTERNAL_BLOCK");
        break;
      }
      if (page.issues.length === 0 || typeof page.nextPageToken !== "string" || page.nextPageToken === "" || seenTokens.has(page.nextPageToken)) throw new JiraAdapterError("Jira search response has malformed pagination", "JIRA_INVALID_SCHEMA", "EXTERNAL_BLOCK");
      seenTokens.add(page.nextPageToken);
      nextPageToken = page.nextPageToken;
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
        statusMapping: this.statusMapping, relationship: this.relationship,
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
