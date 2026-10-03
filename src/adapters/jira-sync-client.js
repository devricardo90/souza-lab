import { decodeLoopDescription } from "../reconcile/jira-adf.js";
import { blockerOf, linkBody, parseRelationshipConfig, verifyAgainstLinkTypes } from "../reconcile/jira-relationship.js";
import { JIRA_MODES, annotateError, classifyJiraFacts, isFacts, jiraCurlTransport, redact } from "./jira-transport.js";

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

export class JiraSyncError extends Error {
  constructor(message, code = "JIRA_SYNC_ERROR", classification = "EXTERNAL_BLOCK") {
    super(message);
    this.name = "JiraSyncError";
    this.code = code;
    this.classification = classification;
    this.retryable = classification === "TRANSIENT";
  }
}

const MAX_FRONTIER_PROBE = 25;
export const OBSERVATION_SOURCES = Object.freeze(["search", "board"]);
export const defaultJiraWriteTransport = jiraCurlTransport;

function call(transport, request) {
  let result;
  try {
    result = transport(request);
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
  if (!isFacts(result)) return result;
  const spec = classifyJiraFacts(result, { allowEmpty: true });
  if (!spec.ok) throw annotateError(new JiraSyncError(`Jira write request failed: ${redact(spec.message)}`, spec.code, spec.classification), spec);
  return result.body === "" ? null : result.body;
}

function decodeJson(raw, where) {
  if (raw === null) return null;
  try { return JSON.parse(raw); }
  catch { throw new JiraSyncError(`${where} returned malformed JSON`, "JIRA_INVALID_JSON", "EXTERNAL_BLOCK"); }
}

export function executionMarker(executionId, kind) {
  return `<!-- loop-execution:${executionId}:${kind} -->`;
}

export class JiraSyncClient {
  // True private field: credentials never appear in JSON.stringify, Object.keys,
  // util.inspect, structuredClone, or logs of this client.
  #credentials;

  /** mode "classic" (default; `site` required) or "scoped" (`cloudId` required; routed via api.atlassian.com). Never inferred. */
  constructor({ site, email, apiToken, timeoutMs = 15000, transport = defaultJiraWriteTransport, scheme = "https", mode = "classic", cloudId = null, gatewayHost, observation = { source: "search" }, writeGuard = null } = {}) {
    if (writeGuard !== null && !(typeof writeGuard?.projectKey === "string" && writeGuard.taskIdPattern instanceof RegExp)) throw new TypeError("writeGuard must be { projectKey, taskIdPattern }");
    this.writeGuard = writeGuard ? Object.freeze({ ...writeGuard }) : null;
    if (!OBSERVATION_SOURCES.includes(observation?.source) || (observation.source === "board" && !Number.isSafeInteger(observation.boardId))) throw new TypeError("observation must be { source: \"search\" } or { source: \"board\", boardId }");
    this.observation = Object.freeze({ ...observation });
    if (!JIRA_MODES.includes(mode)) throw new TypeError(`Jira mode must be one of ${JIRA_MODES.join(", ")}`);
    if (mode === "scoped") { if (typeof cloudId !== "string" || cloudId.trim() === "") throw new TypeError("Jira cloudId is required for scoped mode"); }
    else if (typeof site !== "string" || site.trim() === "") throw new TypeError("Jira site is required");
    this.site = site ?? null;
    this.mode = mode;
    this.cloudId = cloudId;
    this.gatewayHost = gatewayHost;
    this.scheme = scheme;
    this.#credentials = Object.freeze({ email, apiToken });
    this.timeoutMs = timeoutMs;
    this.transport = transport;
  }

  request(path, { method = "GET", body = null, api = "platform" } = {}) {
    let raw;
    try {
      raw = call(this.transport, {
        mode: this.mode, cloudId: this.cloudId, gatewayHost: this.gatewayHost, api,
        site: this.site, scheme: this.scheme, email: this.#credentials.email, apiToken: this.#credentials.apiToken,
        timeoutMs: this.timeoutMs, path, method, body,
      });
    } catch (error) {
      if (error instanceof JiraSyncError && method !== "GET") {
        // A definite Jira rejection (4xx incl. 429) means the write was not applied;
        // a transport failure or 5xx leaves the outcome unknown.
        const definite = error.httpStatus >= 400 && error.httpStatus < 500 && !error.transportFailed;
        error.writeOutcome = definite ? "NOT_APPLIED" : "UNKNOWN";
      }
      throw error;
    }
    return decodeJson(raw, `Jira ${method} ${path}`);
  }

  /** Read-only: current Jira workflow status name (used for reconciliation). */
  getIssueStatusName(issueKey) {
    return this.request(`issue/${encodeURIComponent(issueKey)}?fields=status`)?.fields?.status?.name ?? null;
  }

  /**
   * Read-only full scan of a project's issues in the raw shape the pure observation layer consumes.
   * Deliberately a deterministic scan, not a text search: Jira search indexes can lag writes.
   */
  observeProject(projectKey, { pageSize = 100, maxIssues = 2000, include = [] } = {}) {
    if (typeof projectKey !== "string" || !/^[A-Z][A-Z0-9]*$/.test(projectKey)) throw new JiraSyncError("a valid Jira project key is required", "CONFIG_INVALID", "INVARIANT_VIOLATION");
    const fields = "summary,status,description,issuelinks,parent,issuetype";
    if (this.observation.source === "board") return this.observeBoard(projectKey, { pageSize, maxIssues, fields, include });
    const issues = [];
    let startAt = 0;
    for (;;) {
      const query = new URLSearchParams({ jql: `project = "${projectKey}" ORDER BY key ASC`, startAt: String(startAt), maxResults: String(pageSize), fields }).toString();
      const page = this.request(`search?${query}`);
      if (!page || !Array.isArray(page.issues)) throw new JiraSyncError("Jira search response is missing an issues array", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      issues.push(...page.issues);
      if (issues.length > maxIssues) throw new JiraSyncError("Jira project exceeds the supported scan limit", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      startAt += page.issues.length;
      if (page.issues.length === 0 || startAt >= Number(page.total ?? issues.length)) break;
    }
    return issues;
  }

  /**
   * Explicitly configured alternative for tokens whose scopes exclude the search endpoints: scans the issues of ONE
   * Scrum/Kanban board (agile API) after proving the board belongs to the requested project. Never selected implicitly.
   *
   * The board is index-backed and can LAG a write. Lag must never make an owned, just-created issue look absent (that
   * would justify a second create), so the board only enumerates candidates and two non-index reads close the gap:
   *   - `include`: keys the caller already knows exist (e.g. the key a create returned) are read canonically;
   *   - frontier probe: the keys directly after the highest known key are read canonically (GET issue/{key}) until Jira
   *     answers 404, so issues the board has not indexed yet are still observed (this also covers a lost create response).
   *     A frontier longer than MAX_FRONTIER_PROBE fails closed.
   */
  observeBoard(projectKey, { pageSize, maxIssues, fields, include = [] }) {
    const { boardId } = this.observation;
    const board = this.request(`board/${boardId}`, { api: "agile" });
    if (board?.location?.projectKey !== projectKey) throw new JiraSyncError(`board ${boardId} does not belong to project ${projectKey}`, "CONFIG_INVALID", "INVARIANT_VIOLATION");
    const issues = [];
    let startAt = 0;
    for (;;) {
      const query = new URLSearchParams({ startAt: String(startAt), maxResults: String(pageSize), fields }).toString();
      const page = this.request(`board/${boardId}/issue?${query}`, { api: "agile" });
      if (!page || !Array.isArray(page.issues)) throw new JiraSyncError("Jira board response is missing an issues array", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      issues.push(...page.issues);
      if (issues.length > maxIssues) throw new JiraSyncError("Jira board exceeds the supported scan limit", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      startAt += page.issues.length;
      // Pagination must be provable: a page with neither a numeric total nor a boolean isLast could silently truncate the scan.
      const hasTotal = Number.isFinite(page.total);
      if (!hasTotal && typeof page.isLast !== "boolean") throw new JiraSyncError("Jira board page carries neither a numeric total nor isLast; refusing to assume the scan is complete", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      if (page.issues.length === 0 || (hasTotal ? startAt >= page.total : page.isLast)) break;
    }
    // The board endpoint is used ONLY to enumerate candidate keys: its `description` is a rendered string, not canonical ADF.
    const keys = new Set();
    for (const issue of issues) {
      if (typeof issue?.key !== "string" || issue.key === "") throw new JiraSyncError("Jira board entry has no issue key (malformed response)", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      if (issue.key.startsWith(`${projectKey}-`)) keys.add(issue.key); // defence in depth: foreign-project issues are never observed
    }
    const own = new RegExp(`^${projectKey}-(\\d+)$`);
    for (const key of include) {
      if (typeof key !== "string" || !own.test(key)) throw new JiraSyncError(`include key ${key} is not an issue of project ${projectKey}`, "INVARIANT_VIOLATION", "INVARIANT_VIOLATION");
      keys.add(key);
    }
    const canonicalRead = (key) => {
      const canonical = this.request(`issue/${encodeURIComponent(key)}?fields=${fields}`);
      if (canonical?.key !== key || !canonical.fields || typeof canonical.fields !== "object") throw new JiraSyncError(`${key}: canonical issue response has an unexpected schema`, "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      return canonical;
    };
    const observed = [...keys].map(canonicalRead);
    // Frontier probe (see above): read the keys after the highest known one until Jira says 404.
    let next = Math.max(0, ...[...keys].map((key) => Number(own.exec(key)?.[1] ?? 0))) + 1;
    for (let probes = 0; ; probes += 1) {
      if (probes >= MAX_FRONTIER_PROBE) throw new JiraSyncError(`more than ${MAX_FRONTIER_PROBE} ${projectKey} issues exist beyond the board index; refusing to guess`, "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      let canonical;
      try { canonical = canonicalRead(`${projectKey}-${next}`); }
      catch (error) { if (error?.code === "ISSUE_NOT_FOUND") break; throw error; }
      observed.push(canonical);
      next += 1;
    }
    return observed;
  }

  /** Raw create. NOT idempotent by itself: callers (the outbox) reconcile before and verify after. */
  createIssue({ projectKey, issueTypeName, summary, description }, context) {
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    return Promise.resolve(context.assertLeaseCurrent()).then(() => {
      if (this.writeGuard && projectKey !== this.writeGuard.projectKey) throw new JiraSyncError(`write refused: project ${projectKey} is not ${this.writeGuard.projectKey}`, "WRITE_GUARD_VIOLATION", "INVARIANT_VIOLATION");
      const created = this.request("issue", {
        method: "POST",
        body: { fields: { project: { key: projectKey }, issuetype: { name: issueTypeName }, summary, description } },
      });
      if (!created?.key) throw new JiraSyncError("Jira did not confirm the issue creation", "JIRA_WRITE_UNCONFIRMED", "TRANSIENT");
      return { id: created.id ?? null, key: created.key };
    });
  }

  /** Read-only: one issue's raw fields (a plain GET; not index-backed). */
  getIssue(issueKey, fields = "summary,status,description,issuelinks,issuetype,project") {
    return this.request(`issue/${encodeURIComponent(issueKey)}?fields=${fields}`);
  }

  /** Read-only: the transitions Jira currently offers for an issue (ids and target statuses are Jira's, never assumed). */
  listTransitions(issueKey) {
    const response = this.request(`issue/${encodeURIComponent(issueKey)}/transitions`);
    if (!response || !Array.isArray(response.transitions)) throw new JiraSyncError(`${issueKey}: transitions response has an unexpected schema`, "INVALID_RESPONSE", "EXTERNAL_BLOCK");
    return response.transitions;
  }

  /** Read-only: agile sprint definition (id, name, state, originBoardId). */
  getSprint(sprintId) { return this.request(`sprint/${Number(sprintId)}`, { api: "agile" }); }

  /** Read-only: boards' sprints in the given states, paged. */
  listBoardSprints(boardId, states = "active,future,closed") {
    const sprints = [];
    for (let startAt = 0; ;) {
      const page = this.request(`board/${Number(boardId)}/sprint?state=${states}&startAt=${startAt}&maxResults=50`, { api: "agile" });
      if (!page || !Array.isArray(page.values)) throw new JiraSyncError("Jira sprint listing has an unexpected schema", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      sprints.push(...page.values);
      startAt += page.values.length;
      if (page.isLast !== false || page.values.length === 0) break;
    }
    return sprints;
  }

  /** Read-only: exact issue keys currently in a sprint (not a search: agile membership read). */
  getSprintMembership(sprintId) {
    const keys = [];
    for (let startAt = 0; ;) {
      const page = this.request(`sprint/${Number(sprintId)}/issue?startAt=${startAt}&maxResults=100&fields=summary`, { api: "agile" });
      if (!page || !Array.isArray(page.issues)) throw new JiraSyncError("Jira sprint membership has an unexpected schema", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
      keys.push(...page.issues.map((issue) => issue.key));
      startAt += page.issues.length;
      if (page.issues.length === 0 || startAt >= Number(page.total ?? startAt)) break;
    }
    return keys.sort();
  }

  /**
   * Fails closed before any write (CP-08). Every write target must be in the guarded project and either be created by
   * this very call or carry an unambiguous Loop ownership marker (a clean LOOP_TASK_ID line accepted by the guard's pattern).
   */
  assertWritable(issueKey, { created = false } = {}) {
    const guard = this.writeGuard;
    if (!guard) return;
    const refuse = (why) => { throw new JiraSyncError(`write refused for ${issueKey}: ${why}`, "WRITE_GUARD_VIOLATION", "INVARIANT_VIOLATION"); };
    if (typeof issueKey !== "string" || !issueKey.startsWith(`${guard.projectKey}-`)) refuse(`not in project ${guard.projectKey}`);
    if (created) return;
    const issue = this.getIssue(issueKey, "project,description");
    if (issue?.fields?.project?.key !== guard.projectKey) refuse(`project is not ${guard.projectKey}`);
    const decoded = decodeLoopDescription(issue?.fields?.description);
    if (!decoded.claimed || decoded.taskId === null || !guard.taskIdPattern.test(decoded.taskId)) refuse("no unambiguous Loop ownership marker");
  }

  /** Idempotent by membership: already in the sprint => no write. Verifies the exact membership after the write. */
  async assignToSprint(issueKey, sprintId, context) {
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    this.assertWritable(issueKey);
    const before = this.getSprintMembership(sprintId);
    if (before.includes(issueKey)) return { assigned: false, alreadyMember: true, before, after: before };
    await context.assertLeaseCurrent();
    this.request(`sprint/${Number(sprintId)}/issue`, { method: "POST", api: "agile", body: { issues: [issueKey] } });
    const after = this.getSprintMembership(sprintId);
    return { assigned: after.includes(issueKey), alreadyMember: false, before, after };
  }

  /** Read-only: Jira's own link type definitions (id, name, inward/outward descriptions). */
  listLinkTypes() {
    const response = this.request("issueLinkType");
    if (!response || !Array.isArray(response.issueLinkTypes)) throw new JiraSyncError("Jira link types response has an unexpected schema", "INVALID_RESPONSE", "EXTERNAL_BLOCK");
    return response.issueLinkTypes;
  }

  /** Fails closed (RELATIONSHIP_CONFIG_INVALID) unless the explicit relationship configuration matches Jira's link type. */
  verifyRelationship(relationship) {
    return verifyAgainstLinkTypes(relationship, this.listLinkTypes());
  }

  /**
   * Creates the dependency link "dependent depends on blocker" using ONLY the explicit relationship configuration
   * (no implicit direction). Additive; callers reconcile before and verify after.
   */
  async linkIssues({ blockerKey, dependentKey, relationship }, context) {
    const body = linkBody(parseRelationshipConfig(relationship), { blockerKey, dependentKey }); // throws RELATIONSHIP_CONFIG_INVALID before any request
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    await context.assertLeaseCurrent();
    this.assertWritable(blockerKey); this.assertWritable(dependentKey);
    this.request("issueLink", { method: "POST", body });
    return { blockerKey, dependentKey };
  }

  /**
   * Corrective removal of ONE issue link (CP-08 repair of a wrongly-directed link). It is NOT a generic delete primitive:
   * it REQUIRES a configured writeGuard, and before the DELETE it independently re-reads BOTH issues canonically
   * (GET issue/{key}) and requires all of:
   *   - both keys in the guarded project and carrying a Loop ownership marker accepted by the guard (this run's task set);
   *   - the exact link id on the DEPENDENT's entry and on the BLOCKER's entry (the same link seen from both ends);
   *   - the relationship's link type on both entries;
   *   - the expected pair and direction: per the explicit relationship mapping the dependent's entry names `blockerKey`
   *     as its blocker, and the blocker's entry names `dependentKey` under the dependent's own end.
   * `blockerKey`/`dependentKey` describe the link AS IT EXISTS (so a reversed link is removed by passing the reversed pair).
   * Any mismatch throws WRITE_GUARD_VIOLATION with nothing deleted. After the DELETE the link must be gone from both issues.
   * Issues are never deleted.
   */
  async removeIssueLink({ linkId, blockerKey, dependentKey, relationship }, context) {
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    const refuse = (why) => { throw new JiraSyncError(`link ${linkId} not removed (${blockerKey} blocks ${dependentKey}): ${why}`, "WRITE_GUARD_VIOLATION", "INVARIANT_VIOLATION"); };
    if (!this.writeGuard) refuse("removeIssueLink requires a configured writeGuard");
    const config = parseRelationshipConfig(relationship); // RELATIONSHIP_CONFIG_INVALID before any request
    if (typeof linkId !== "string" && typeof linkId !== "number") refuse("a link id is required");
    if (blockerKey === dependentKey) refuse("blocker and dependent must differ");
    await context.assertLeaseCurrent();
    this.assertWritable(blockerKey); this.assertWritable(dependentKey); // project + Loop ownership, from canonical reads
    const linksOf = (key) => {
      const links = this.getIssue(key, "issuelinks")?.fields?.issuelinks;
      return Array.isArray(links) ? links : [];
    };
    const find = (links) => links.find((link) => String(link?.id) === String(linkId)) ?? null;
    const sameType = (entry) => entry.type?.name === config.linkTypeName && (!config.linkTypeId || String(entry.type?.id ?? config.linkTypeId) === config.linkTypeId);
    const dependentEntry = find(linksOf(dependentKey));
    const blockerEntry = find(linksOf(blockerKey));
    if (!dependentEntry || !blockerEntry) refuse("the link id is not present on both issues");
    if (!sameType(dependentEntry) || !sameType(blockerEntry)) refuse(`the link is not of type ${config.linkTypeName}`);
    // direction: the dependent's entry names the blocker under the end opposite to dependentEnd (blockerOf), and nothing else
    if (blockerOf(config, dependentEntry) !== blockerKey) refuse("the dependent's entry does not name the expected blocker in the expected direction");
    const mirror = blockerEntry[`${config.dependentEnd}Issue`]?.key;
    const wrongSide = blockerEntry[`${config.dependentEnd === "inward" ? "outward" : "inward"}Issue`];
    if (mirror !== dependentKey || wrongSide) refuse("the blocker's entry does not name the expected dependent in the expected direction");
    await context.assertLeaseCurrent();
    this.request(`issueLink/${encodeURIComponent(String(linkId))}`, { method: "DELETE" });
    const gone = !find(linksOf(dependentKey)) && !find(linksOf(blockerKey));
    if (!gone) throw new JiraSyncError(`link ${linkId} still present after DELETE`, "JIRA_WRITE_UNCONFIRMED", "TRANSIENT");
    return { linkId: String(linkId), blockerKey, dependentKey, goneFromBothIssues: true };
  }

  /** The blocker issue key on a dependent issue's link entry per the explicit mapping (null if not this relation). */
  static blockerOf(relationship, entry) { return blockerOf(relationship, entry); }

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
    this.assertWritable(issueKey);
    const tag = executionMarker(executionId, kind);
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
  async markTaskComplete(issueKey, { executionId, computedState, doneStatusName, transitionName, expectedCurrentStatusNames = null }, context) {
    if (computedState !== "DONE") {
      throw new JiraSyncError("Jira completion may only be requested after computed Loop state is DONE", "JIRA_PREMATURE_COMPLETION", "INVARIANT_VIOLATION");
    }
    if (typeof context?.assertLeaseCurrent !== "function") throw new JiraSyncError("active execution lease is required to write to Jira", "LEASE_REQUIRED", "INVARIANT_VIOLATION");
    const statusPath = `issue/${encodeURIComponent(issueKey)}?fields=status`;
    await context.assertLeaseCurrent();
    this.assertWritable(issueKey);
    const before = this.request(statusPath)?.fields?.status?.name;
    if (before === doneStatusName) return { status: "CONFIRMED", transitioned: false, alreadyDone: true };
    if (Array.isArray(expectedCurrentStatusNames) && !expectedCurrentStatusNames.includes(before)) {
      throw new JiraSyncError(`${issueKey}: current Jira status "${before}" is not one of the expected states`, "STALE_STATE", "EXTERNAL_BLOCK");
    }
    await context.assertLeaseCurrent();
    const transitions = this.request(`issue/${encodeURIComponent(issueKey)}/transitions`);
    const match = Array.isArray(transitions?.transitions) ? transitions.transitions.find((t) => t.name === transitionName) : null;
    if (!match) throw new JiraSyncError(`${issueKey}: configured completion transition "${transitionName}" is not available`, "JIRA_TRANSITION_NOT_FOUND", "EXTERNAL_BLOCK");
    await context.assertLeaseCurrent();
    this.request(`issue/${encodeURIComponent(issueKey)}/transitions`, { method: "POST", body: { transition: { id: match.id } } });
    // A 2xx write is not proof. Read the issue again and require the exact desired state.
    const uncertain = (reason, observedStatus, cause = null) => ({
      status: "UNCERTAIN", transitioned: false, alreadyDone: false, reason, observedStatus, issueKey, executionId,
      ...(cause ? { cause } : {}),
    });
    let after;
    try { after = this.request(statusPath)?.fields?.status?.name ?? null; }
    catch (error) { return uncertain("POST_WRITE_READ_FAILED", null, error?.code ?? "UNKNOWN"); }
    if (after === doneStatusName) return { status: "CONFIRMED", transitioned: true, alreadyDone: false };
    return uncertain("POST_WRITE_STATE_MISMATCH", after);
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
