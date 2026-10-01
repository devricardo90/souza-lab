import { cleanText, planOwnedFingerprint } from "./fingerprint.js";
import { decodeLoopDescription, epicIdFromAdf } from "./jira-adf.js";
import { blockerOf, parseRelationshipConfig } from "./jira-relationship.js";

/**
 * Pure, read-only normalization of raw Jira issues into a model suitable for deterministic
 * comparison with a PlanSnapshot. No I/O. Jira summary/title is NEVER used as identity: an issue
 * belongs to a plan task only through an explicit marker line in its description:
 *
 *   LOOP_TASK_ID: RT-37        (task issues)
 *   LOOP_EPIC_ID: RT-E4        (Epic issues; lets a task's parent link be translated back to EPIC_ID)
 *
 * Dependencies are translated from Jira issue links back to TASK_ID markers; references that
 * cannot be translated are kept as explicit, typed `unresolved` entries instead of being dropped.
 *
 * Raw issue shape consumed (subset of the Jira REST shape):
 *   { key, fields: { summary, status:{name}, description, issuetype?:{name},
 *                    parent?:{key}, issuelinks?:[{type:{name}, inwardIssue?:{key}}] } }
 * `description` is either
 *   - an Atlassian Document Format object (Jira Cloud): ONLY the Loop-owned layout written by
 *     encodeLoopDescription is decoded (see jira-adf.js); anything else claimed by Loop fails closed
 *     as a remote-invalid acceptance-criteria problem, anything unclaimed is an unmarked foreign issue; or
 *   - a plain string (tests / non-Cloud providers): the LOOP_TASK_ID line + "Acceptance Criteria" block.
 */

const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const EPIC_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const AC_LINE = /^-\s+(AC-\d{2,})\s*:\s*(.+?)\s*$/;
const byKey = (a, b) => (a.jiraIssueKey < b.jiraIssueKey ? -1 : a.jiraIssueKey > b.jiraIssueKey ? 1 : 0);

export class JiraObservationError extends Error {
  constructor(message, code = "INVALID_JIRA_OBSERVATION") {
    super(message);
    this.name = "JiraObservationError";
    this.code = code;
  }
}

function markers(description, name, pattern) {
  const found = new Set();
  let invalid = false;
  const matcher = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`);
  for (const raw of String(description ?? "").normalize("NFC").replace(/\r\n?/g, "\n").split("\n")) {
    const match = raw.trim().match(matcher);
    if (!match) continue;
    if (pattern.test(match[1])) found.add(match[1]); else invalid = true;
  }
  if (invalid) return { id: null, problem: "INVALID_MARKER" };
  if (found.size > 1) return { id: null, problem: "MULTIPLE_MARKERS" };
  return { id: found.size === 1 ? [...found][0] : null, problem: null };
}

/** Acceptance criteria under a strict "Acceptance Criteria" heading; anything malformed is reported, never guessed. */
function parseAc(description) {
  if (typeof description !== "string") return { criteria: null, problem: "AC_MISSING" };
  const lines = description.replace(/\r\n?/g, "\n").split("\n");
  const heading = lines.findIndex((line) => line.trim() === "Acceptance Criteria");
  if (heading < 0) return { criteria: null, problem: "AC_MISSING" };
  const body = [];
  for (let i = heading + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "" && body.length > 0) break;
    if (lines[i].trim() !== "") body.push(lines[i].trim());
  }
  if (body.length === 0) return { criteria: null, problem: "AC_MISSING" };
  const criteria = [];
  const seen = new Set();
  for (const line of body) {
    const match = line.match(AC_LINE);
    if (!match) return { criteria: null, problem: "AC_MALFORMED" };
    if (seen.has(match[1])) return { criteria: null, problem: "AC_DUPLICATE" };
    seen.add(match[1]);
    criteria.push({ id: match[1], text: cleanText(match[2]) });
  }
  return { criteria: criteria.sort((a, b) => (a.id < b.id ? -1 : 1)), problem: null };
}

/**
 * `relationship` (see jira-relationship.js) is the ONLY definition of how "depends on" is expressed in Jira links. With no
 * relationship configured, an issue that has ANY link entries gets an explicit unresolved dependency (RELATIONSHIP_CONFIG_MISSING)
 * instead of a guessed direction, so reconciliation fails closed.
 */
export function normalizeJiraObservation(rawIssues, { relationship = null, epicIssueType = "Epic" } = {}) {
  const relation = relationship === null ? null : parseRelationshipConfig(relationship);
  if (!Array.isArray(rawIssues)) throw new JiraObservationError("raw Jira issues must be an array");
  const seenKeys = new Set();
  for (const raw of rawIssues) {
    if (typeof raw?.key !== "string" || raw.key === "") throw new JiraObservationError("Jira issue without a key");
    if (seenKeys.has(raw.key)) throw new JiraObservationError(`duplicate Jira issue key ${raw.key} in observation`, "DUPLICATE_ISSUE_KEY");
    seenKeys.add(raw.key);
  }
  const isEpic = (raw) => raw.fields?.issuetype?.name === epicIssueType;

  // Pass 1: identity markers for every issue, so links can be translated key -> stable id.
  const taskMarkerByKey = new Map();
  const epicIdByKey = new Map();
  const decodedByKey = new Map();
  for (const raw of rawIssues) {
    const description = raw.fields?.description;
    if (isEpic(raw)) {
      const id = typeof description === "string" ? markers(description, "LOOP_EPIC_ID", EPIC_ID).id : epicIdFromAdf(description);
      if (id) epicIdByKey.set(raw.key, id);
    } else if (description !== null && typeof description === "object") {
      const decoded = decodeLoopDescription(description);
      decodedByKey.set(raw.key, decoded);
      taskMarkerByKey.set(raw.key, { id: decoded.taskId, problem: decoded.markerProblem });
    } else {
      taskMarkerByKey.set(raw.key, markers(description, "LOOP_TASK_ID", TASK_ID));
    }
  }

  const issues = [];
  for (const raw of rawIssues) {
    if (isEpic(raw)) continue;
    const fields = raw.fields ?? {};
    const marker = taskMarkerByKey.get(raw.key);
    const problems = [];

    let epicId = null;
    let unresolvedEpicKey = null;
    const parentKey = fields.parent?.key;
    if (typeof parentKey === "string") {
      if (epicIdByKey.has(parentKey)) epicId = epicIdByKey.get(parentKey);
      else { unresolvedEpicKey = parentKey; problems.push(`epic:${parentKey}`); }
    }

    const dependsOn = new Set();
    const unresolved = [];
    for (const link of Array.isArray(fields.issuelinks) ? fields.issuelinks : []) {
      if (relation === null) {
        const other = link?.inwardIssue?.key ?? link?.outwardIssue?.key ?? "unknown";
        unresolved.push({ key: other, reason: "RELATIONSHIP_CONFIG_MISSING" });
        problems.push(`dependency:${other}:RELATIONSHIP_CONFIG_MISSING`);
        continue;
      }
      const blockerKey = blockerOf(relation, link); // the single, explicit read mapping
      if (blockerKey === null) continue;
      let reason = null;
      if (!seenKeys.has(blockerKey) || epicIdByKey.has(blockerKey)) reason = "UNKNOWN_ISSUE";
      else {
        const blocker = taskMarkerByKey.get(blockerKey);
        if (blocker?.id) dependsOn.add(blocker.id);
        else reason = blocker?.problem ? "AMBIGUOUS_MARKER" : "NO_MARKER";
      }
      if (reason) { unresolved.push({ key: blockerKey, reason }); problems.push(`dependency:${blockerKey}:${reason}`); }
    }
    unresolved.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

    const decoded = decodedByKey.get(raw.key);
    const ac = decoded === undefined ? parseAc(fields.description)
      : decoded.claimed ? { criteria: decoded.criteria, problem: decoded.problem }
        : { criteria: null, problem: "AC_MISSING" };
    if (ac.problem) problems.push(`ac:${ac.problem}`);
    const title = cleanText(fields.summary);
    const sortedDeps = [...dependsOn].sort();

    issues.push(Object.freeze({
      jiraIssueKey: raw.key,
      taskIdMarker: marker.id,
      markerProblem: marker.problem,
      title,
      status: typeof fields.status?.name === "string" ? fields.status.name : null,
      epic: Object.freeze({ epicId, unresolvedKey: unresolvedEpicKey }),
      dependencies: Object.freeze({ taskIds: Object.freeze(sortedDeps), unresolved: Object.freeze(unresolved.map((u) => Object.freeze(u))) }),
      acceptanceCriteria: ac.criteria === null ? null : Object.freeze(ac.criteria.map((c) => Object.freeze(c))),
      acceptanceCriteriaProblem: ac.problem,
      // audit-only facts about how Loop materialized the issue; NOT plan-owned, so NOT fingerprinted
      materialization: decoded?.metadata ?? null,
      // status is NOT part of the fingerprint: workflow state is Jira-owned
      observedFingerprint: planOwnedFingerprint({
        taskId: marker.id, title, epicId, dependsOn: sortedDeps, acceptanceCriteria: ac.criteria ?? [], problems,
      }),
    }));
  }
  issues.sort(byKey);
  return Object.freeze({ issues: Object.freeze(issues) });
}
