import assert from "node:assert/strict";
import test from "node:test";
import {
  JiraAdapterError, JiraTaskSourceError, JiraTaskSystemAdapter,
  mapDependencies, mapIssueToTask, parseAcceptanceCriteria,
} from "../src/adapters/jira-task-adapter.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";
import { RecoveryCoordinator } from "../src/core/recovery-coordinator.js";
import { FakeCIProvider, FakeGitProvider, FakeReviewProvider, FakeSCMProvider, FakeValidationProvider } from "../src/testing/fake-providers.js";

const SITE = "loop-experiment.atlassian.net";
const PROJECT = "LOOP";
const STATUS_MAPPING = Object.freeze({ "To Do": "OPEN", "In Progress": "OPEN", "Done": "DONE" });

function issue({ key = "LOOP-1", status = "To Do", summary = "Task", description = null, issuelinks = [], customField = null } = {}) {
  return {
    key,
    fields: {
      summary, status: { name: status }, description,
      issuelinks, ...(customField !== null ? { customfield_10050: customField } : {}),
    },
  };
}

function searchResponse(issues) {
  return JSON.stringify({ issues, isLast: true, nextPageToken: null });
}

function adapter({ transport, ...overrides } = {}) {
  return new JiraTaskSystemAdapter({
    site: SITE, email: "loop@example.invalid", apiToken: "token", projectKey: PROJECT,
    statusMapping: STATUS_MAPPING, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP, transport, ...overrides,
  });
}

const AC_BLOCK = "Some prose.\n\nAcceptance Criteria\n\n- AC-001: first observable condition\n- AC-002: second observable condition\n";

test("J01 Jira authentication failure blocks without manufacturing tasks", () => {
  const jira = adapter({ transport: () => { throw Object.assign(new Error("HTTP 401 unauthorized"), { status: 401 }); } });
  assert.throws(() => jira.listTasks(), (error) => error instanceof JiraAdapterError && error.code === "JIRA_AUTH_FAILED" && error.classification === "EXTERNAL_BLOCK");
});

test("J02 Jira timeout/network failure is classified transient (WAIT_RETRYABLE)", () => {
  const jira = adapter({ transport: () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
  assert.throws(() => jira.listTasks(), (error) => error instanceof JiraAdapterError && error.classification === "TRANSIENT" && error.retryable === true);
});

test("J03 malformed Jira response fails closed", () => {
  const jira = adapter({ transport: () => "not json" });
  assert.throws(() => jira.listTasks(), { code: "JIRA_INVALID_JSON" });
});

test("J04 unknown Jira workflow status fails closed", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ status: "Blocked-Unmapped", description: AC_BLOCK })]) });
  assert.throws(() => jira.listTasks(), (error) => error instanceof JiraTaskSourceError && error.code === "JIRA_UNKNOWN_STATUS");
});

test("J05 duplicate Jira issue key in normalized input is rejected", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ description: AC_BLOCK }), issue({ description: AC_BLOCK })]) });
  assert.throws(() => jira.listTasks(), { code: "JIRA_DUPLICATE_ISSUE_KEY" });
});

test("J06 malformed acceptance-criteria section is rejected", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ description: "Acceptance Criteria\n\n- not a valid line\n" })]) });
  assert.throws(() => jira.listTasks(), { code: "JIRA_AC_MALFORMED" });
});

test("J07 duplicate acceptance-criteria ids are rejected", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ description: "Acceptance Criteria\n\n- AC-001: one\n- AC-001: duplicate\n" })]) });
  assert.throws(() => jira.listTasks(), { code: "JIRA_AC_DUPLICATE" });
});

test("J08 missing acceptance-criteria ids are rejected when required", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ description: "No AC section here." })]) });
  assert.throws(() => jira.listTasks(), { code: "JIRA_AC_MISSING" });
});

test("J09 unknown dependency relation is never silently treated as a dependency", () => {
  const linked = issue({
    key: "LOOP-2", description: AC_BLOCK,
    issuelinks: [{ type: { name: "Relates" }, inwardIssue: { key: "LOOP-1" } }],
  });
  const dependencies = mapDependencies(linked, { relationship: SYNTHETIC_BLOCKS_RELATIONSHIP });
  assert.deepEqual(dependencies, []);
});

test("J10 dependency pointing to a missing issue fails closed", () => {
  const jira = adapter({
    transport: () => searchResponse([issue({
      key: "LOOP-2", description: AC_BLOCK,
      issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "LOOP-999" } }],
    })]),
  });
  assert.throws(() => jira.listTasks(), { code: "JIRA_MISSING_DEPENDENCY" });
});

test("J11 a dependency cycle rejects the task graph", () => {
  const a = issue({ key: "LOOP-1", description: AC_BLOCK, issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "LOOP-2" } }] });
  const b = issue({ key: "LOOP-2", description: AC_BLOCK, issuelinks: [{ type: { name: "Blocks" }, inwardIssue: { key: "LOOP-1" } }] });
  const jira = adapter({ transport: () => searchResponse([a, b]) });
  assert.throws(() => jira.listTasks(), { code: "JIRA_DEPENDENCY_CYCLE" });
});

test("J14 a Jira title change preserves stable issue-key identity and an unchanged AC digest", () => {
  const original = mapIssueToTask(issue({ description: AC_BLOCK, summary: "Original title" }), { statusMapping: STATUS_MAPPING, projectKey: PROJECT, site: SITE, acSource: "description" });
  const retitled = mapIssueToTask(issue({ description: AC_BLOCK, summary: "Completely different title" }), { statusMapping: STATUS_MAPPING, projectKey: PROJECT, site: SITE, acSource: "description" });
  assert.equal(original.task.id, retitled.task.id);
  assert.equal(original.task.acceptanceCriteriaDigest, retitled.task.acceptanceCriteriaDigest);
  assert.notEqual(original.task.title, retitled.task.title);
});

test("J15 Jira acceptance-criteria content changes the AC digest, invalidating prior validation", () => {
  const before = mapIssueToTask(issue({ description: AC_BLOCK }), { statusMapping: STATUS_MAPPING, projectKey: PROJECT, site: SITE, acSource: "description" });
  const changed = mapIssueToTask(issue({ description: "Acceptance Criteria\n\n- AC-001: a materially different condition\n- AC-002: second observable condition\n" }), { statusMapping: STATUS_MAPPING, projectKey: PROJECT, site: SITE, acSource: "description" });
  assert.notEqual(before.task.acceptanceCriteriaDigest, changed.task.acceptanceCriteriaDigest);
});

test("J20 canonical resolution is requested in explicit key order, independent of Jira backlog rank", () => {
  let capturedQuery = null;
  const jira = adapter({
    transport: (request) => { capturedQuery = request.query; return searchResponse([issue({ description: AC_BLOCK })]); },
  });
  jira.listTasks();
  assert.match(new URLSearchParams(capturedQuery).get("jql"), /ORDER BY key ASC/);
});

test("ADF description normalizes paragraphs and bullet Acceptance Criteria", () => {
  const description = {
    type: "doc", version: 1, content: [
      { type: "paragraph", content: [{ type: "text", text: "Some prose." }] },
      { type: "paragraph", content: [{ type: "text", text: "Acceptance Criteria" }] },
      { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "AC-001: condition" }] }] }] },
    ],
  };
  const result = mapIssueToTask(issue({ description }), { statusMapping: STATUS_MAPPING, projectKey: PROJECT, site: SITE, acSource: "description" });
  assert.deepEqual(result.task.acceptanceCriteria, [{ id: "AC-001", description: "condition" }]);
});

test("unsupported ADF description fails closed", () => {
  const description = { type: "doc", version: 1, content: [{ type: "codeBlock", content: [{ type: "text", text: "unsafe" }] }] };
  assert.throws(() => mapIssueToTask(issue({ description }), { statusMapping: STATUS_MAPPING, projectKey: PROJECT, site: SITE, acSource: "description" }), { code: "JIRA_ADF_UNSUPPORTED" });
});

test("enhanced search pagination requires a valid nextPageToken", () => {
  let calls = 0;
  const jira = adapter({ transport: (request) => {
    calls += 1;
    assert.equal(request.path, "search/jql");
    return calls === 1 ? JSON.stringify({ issues: [issue({ description: AC_BLOCK })], isLast: false, nextPageToken: "page-2" }) : JSON.stringify({ issues: [], isLast: true });
  } });
  assert.equal(jira.listTasks().length, 1);
  assert.equal(calls, 2);
});

test("custom-field acceptance criteria source is honored when configured", () => {
  const jira = adapter({
    acSource: "field", acFieldId: "customfield_10050",
    transport: () => searchResponse([issue({ customField: "- AC-001: from the dedicated field\n" })]),
  });
  const [task] = jira.listTasks();
  assert.equal(task.acceptanceCriteria.length, 1);
  assert.equal(task.acceptanceCriteria[0].id, "AC-001");
});

test("parseAcceptanceCriteria rejects an empty Acceptance Criteria section", () => {
  assert.throws(() => parseAcceptanceCriteria({ issueKey: "LOOP-1", descriptionText: "Acceptance Criteria\n\n" }), { code: "JIRA_AC_MISSING" });
});

function recoveryHarness(jira, { revision = null, merge = null, validation = null, review = null, ci = null } = {}) {
  return new RecoveryCoordinator({
    taskSystem: jira,
    gitProvider: new FakeGitProvider({ revision }),
    scmProvider: new FakeSCMProvider({ mergeFacts: merge ? [merge] : [] }),
    ciProvider: new FakeCIProvider({ results: ci ? [ci] : [] }),
    reviewProvider: new FakeReviewProvider({ results: review ? [review] : [] }),
    validationProvider: new FakeValidationProvider({ results: validation ? [validation] : [] }),
  });
}

test("J12 a Jira task disappearing mid-execution fails closed instead of silently switching tasks", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ key: "LOOP-2", description: AC_BLOCK })]) });
  const recovery = recoveryHarness(jira);
  assert.throws(() => recovery.recover({ activeTaskId: "LOOP-1" }), (error) => error.code === "ACTIVE_TASK_MISSING");
});

test("J13 Jira status Done does not manufacture computed DONE without completion evidence", () => {
  const jira = adapter({ transport: () => searchResponse([issue({ key: "LOOP-1", status: "Done", description: AC_BLOCK })]) });
  const recovery = recoveryHarness(jira);
  const result = recovery.recover({ activeTaskId: "LOOP-1" });
  assert.notEqual(result.computed.state, "DONE");
  assert.ok(result.computed.blockers.some((blocker) => blocker.includes("marks work complete without completion evidence")));
});
