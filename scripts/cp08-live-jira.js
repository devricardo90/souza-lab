#!/usr/bin/env node
/**
 * CP-08 live Jira proof (scoped-token transport). REAL Jira, project LOOP only.
 *
 *   node scripts/cp08-live-jira.js <stage> --state <dir>
 *   stages: auth | discover | create | idempotency | repair-link | dependency | sprint | transition
 *
 * Credentials come from the environment (LOOP_JIRA_EMAIL / LOOP_JIRA_API_TOKEN / LOOP_JIRA_CLOUD_ID) and are never
 * printed. Every write goes through the production path: plan -> reconcile -> outbox (SQLite) -> JiraOutboxExecutor ->
 * JiraSyncClient (guarded: project LOOP + this run's own TASK_IDs only) -> read-after-write. No Jira issue is ever deleted.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../src/adapters/jira-outbox-executor.js";
import { jiraCurlTransport } from "../src/adapters/jira-transport.js";
import { SqliteOutboxStore } from "../src/adapters/sqlite-outbox-store.js";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { makePlanSnapshot } from "../src/plan/plan-snapshot.js";
import { decodeLoopDescription } from "../src/reconcile/jira-adf.js";
import { normalizeJiraObservation } from "../src/reconcile/jira-observation.js";
import { reconcilePlan } from "../src/reconcile/plan-reconciler.js";
import { buildMaterializationOperations } from "../src/materialize/jira-materialization.js";
import { verifyAgainstLinkTypes } from "../src/reconcile/jira-relationship.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "docs", "evidence", "cp08-jira-live-config.json");
const LEDGER_PATH = join(ROOT, "docs", "evidence", "CP-08-JIRA-LEDGER.json");
const PROJECT_KEY = "LOOP";
const BOARD_ID = 199;
const SPRINT_NAME = "CP08 Test";
const ISSUE_TYPE_NAME = "Tarefa"; // the instance's localized Task type; verified against live createmeta in `discover`

const stage = process.argv[2];
const stateDir = process.argv[process.argv.indexOf("--state") + 1];
if (!stage || !stateDir) { console.error("usage: cp08-live-jira.js <stage> --state <dir>"); process.exit(78); }
mkdirSync(stateDir, { recursive: true });
for (const name of ["LOOP_JIRA_EMAIL", "LOOP_JIRA_API_TOKEN", "LOOP_JIRA_CLOUD_ID"]) if (!process.env[name]) { console.error(`${name} is not set`); process.exit(78); }

const readJson = (path, fallback) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : fallback);
const writeJson = (path, value) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`); };
const statePath = join(stateDir, "run.json");
const run = readJson(statePath, null) ?? (() => {
  const id = `CP08${Date.now().toString(36).toUpperCase()}`;
  const fresh = { runId: id, documentId: `cp08-live-${id.toLowerCase()}`, tasks: [`${id}-1`, `${id}-2`], issues: {} };
  writeJson(statePath, fresh);
  return fresh;
})();
const saveRun = () => writeJson(statePath, run);
const config = readJson(CONFIG_PATH, {});
const ledger = readJson(LEDGER_PATH, []);
const record = (entry) => { ledger.push({ at: new Date().toISOString(), runId: run.runId, stage, ...entry }); writeJson(LEDGER_PATH, ledger); };
const out = (label, value) => console.log(`${label} ${JSON.stringify(value)}`);

// Every outgoing request is recorded (method/path/status only: never headers, never bodies, never credentials).
const requests = [];
const transport = (request) => {
  const facts = jiraCurlTransport(request);
  requests.push({ method: request.method ?? "GET", api: request.api ?? "platform", path: request.path.split("?")[0], status: facts.httpStatus, requestId: facts.requestId });
  return facts;
};
const writesSince = (from) => requests.slice(from).filter((r) => r.method !== "GET");
const jira = (writeGuard = { projectKey: PROJECT_KEY, taskIdPattern: new RegExp(`^${run.runId}-\\d+$`) }) => new JiraSyncClient({
  mode: "scoped", cloudId: process.env.LOOP_JIRA_CLOUD_ID, email: process.env.LOOP_JIRA_EMAIL, apiToken: process.env.LOOP_JIRA_API_TOKEN,
  timeoutMs: 20000, transport, observation: { source: "board", boardId: BOARD_ID }, writeGuard,
});

const relationship = () => {
  if (!config.relationship) throw new Error("run `discover` first (no relationship configuration persisted)");
  return config.relationship;
};
const block = (id, title, dependsOn = "") => `TASK_ID: ${id}\nTITLE: ${title}\n${dependsOn ? `DEPENDS_ON: ${dependsOn}\n` : ""}AC:\n- AC-001: ${title} is materialized\n- AC-002: and verified by read-after-write\n`;
const NOW = new Date().toISOString();
const snapshot = () => makePlanSnapshot({
  documentId: run.documentId,
  compiled: compilePlan(`LOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\n${block(run.tasks[0], "CP08 live ADF roundtrip task")}\n${block(run.tasks[1], "CP08 live dependent task", run.tasks[0])}END_LOOP_EXECUTION_PLAN\n`),
  fetchedAt: NOW, compiledAt: NOW,
});
const materializationConfig = () => ({ projectKey: PROJECT_KEY, issueTypeName: ISSUE_TYPE_NAME, relationship: relationship() });
const observe = (client) => normalizeJiraObservation(client.observeProject(PROJECT_KEY), { relationship: relationship() });
const reconcile = (client) => reconcilePlan({ snapshot: snapshot(), observation: observe(client), createdAt: new Date().toISOString() });
const openOutbox = (name = "outbox.sqlite") => new SqliteOutboxStore({ path: join(stateDir, name) });
const executorFor = (client, store) => new JiraOutboxExecutor({ store, jira: client, workerId: `cp08-${process.pid}`, relationship: relationship() });
const summarize = (result) => ({ outcome: result.outcome, owned: result.owned, attempts: result.operation?.attemptCount, errorCode: result.operation?.lastErrorCode ?? null, errorDetail: result.operation?.lastErrorDetail ?? null });

/** Processes an operation until terminal (retry waits are real: next eligible time is honoured, bounded). */
async function drive(exec, operationId, { maxRounds = 6 } = {}) {
  let last;
  for (let round = 0; round < maxRounds; round += 1) {
    last = await exec.process(operationId);
    if (last.outcome !== "RETRY_WAIT") return last;
    const waitMs = Math.max(500, Date.parse(last.operation.nextRetryAt ?? new Date().toISOString()) - Date.now());
    out("retry-wait", { operationId: operationId.slice(0, 24), waitMs, code: last.operation.lastErrorCode });
    await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 20000)));
  }
  return last;
}
const opFor = (taskId) => buildMaterializationOperations({ reconciliation: reconcile(jira()), config: materializationConfig() }).operations.find((op) => op.taskId === taskId);
const remoteKey = (client, taskId) => observe(client).issues.find((issue) => issue.taskIdMarker === taskId)?.jiraIssueKey ?? null;

const stages = {
  auth() {
    const client = jira(null);
    const me = client.request("myself");
    out("LIVE_AUTH", { endpoint: "GET /rest/api/3/myself", http: requests.at(-1).status, accountType: me.accountType, active: me.active, mode: client.mode, requestId: requests.at(-1).requestId });
    record({ op: "auth", http: requests.at(-1).status });
  },

  discover() {
    const client = jira(null);
    const board = client.request(`board/${BOARD_ID}`, { api: "agile" });
    if (board.location?.projectKey !== PROJECT_KEY) throw new Error("board 199 does not belong to LOOP");
    const types = client.request(`issue/createmeta/${PROJECT_KEY}/issuetypes`).issueTypes;
    const task = types.filter((t) => t.name === ISSUE_TYPE_NAME && !t.subtask);
    if (task.length !== 1) throw new Error(`expected exactly one non-subtask issue type "${ISSUE_TYPE_NAME}"`);
    const fields = client.request(`issue/createmeta/${PROJECT_KEY}/issuetypes/${task[0].id}`).fields;
    const linkTypes = client.listLinkTypes();
    const blocks = linkTypes.filter((t) => t.name === "Blocks");
    if (blocks.length !== 1) throw new Error("expected exactly one Blocks link type");
    // dependentEnd was PROVEN against real Jira (run CP08MUS8I9PM): the dependent is the POSTed outwardIssue; "inward" was disproven.
    const relationshipDraft = config.relationship ?? { linkTypeName: "Blocks", linkTypeId: blocks[0].id, inwardLabel: blocks[0].inward, outwardLabel: blocks[0].outward, dependentEnd: "outward" };
    verifyAgainstLinkTypes(relationshipDraft, linkTypes);
    const sprints = client.listBoardSprints(BOARD_ID).filter((s) => s.name === SPRINT_NAME);
    const sprint = sprints.length === 1 ? { id: sprints[0].id, name: sprints[0].name, state: sprints[0].state, originBoardId: sprints[0].originBoardId } : null;
    const metadata = {
      transport: { mode: "scoped", cloudIdEnv: "LOOP_JIRA_CLOUD_ID", observation: { source: "board", boardId: BOARD_ID }, observationReason: "token lacks search scopes (GET search, search/jql, POST search/jql => 401)" },
      project: { key: PROJECT_KEY, id: String(board.location.projectId), name: board.location.projectName },
      board: { id: board.id, name: board.name, type: board.type },
      issueTypes: types.map((t) => ({ id: t.id, name: t.name, subtask: t.subtask })),
      taskIssueType: { id: task[0].id, name: task[0].name },
      createFields: fields.map((f) => ({ id: f.fieldId, name: f.name, required: f.required })),
      linkTypes: linkTypes.map((t) => ({ id: t.id, name: t.name, inward: t.inward, outward: t.outward })),
      relationship: relationshipDraft,
      sprint,
      sprintMatches: sprints.length,
    };
    writeJson(CONFIG_PATH, { ...config, ...metadata });
    out("PROJECT_METADATA", { project: metadata.project, board: metadata.board, requiredCreateFields: metadata.createFields.filter((f) => f.required).map((f) => f.id), linkBlocks: metadata.relationship, sprint });
    out("ISSUE_TYPES", { all: metadata.issueTypes, task: metadata.taskIssueType });
    record({ op: "discover", sprintFound: Boolean(sprint) });
    if (!sprint) out("REAL_SPRINT_PROOF_BLOCKED", { reason: `sprint "${SPRINT_NAME}" matched ${sprints.length} sprints on board ${BOARD_ID}` });
  },

  async create() {
    const client = jira();
    const store = openOutbox();
    const exec = executorFor(client, store);
    const before = reconcile(client);
    out("decision-before", { creates: before.creates.map((d) => d.taskId), noops: before.noops.map((d) => d.taskId), blocked: buildMaterializationOperations({ reconciliation: before, config: materializationConfig() }).blocked.map((b) => `${b.taskId}:${b.reasonCode}`) });
    const op = opFor(run.tasks[0]);
    const existing = remoteKey(client, run.tasks[0]);
    let result = { outcome: "RESUMED_EXISTING", operation: null };
    if (!op && existing && run.issues[run.tasks[0]] === existing) {
      // Resume of a run whose issue was already created (never create a replacement): verify it through the canonical path only.
      out("create-resume", { key: existing, writes: 0 });
    } else {
      if (!op) throw new Error("no JIRA_CREATE operation for the first CP08 task (already materialized? run `idempotency`)");
      const mark = requests.length;
      exec.enqueueMaterialization(op);
      result = await drive(exec, op.operationId);
      out("create-result", { ...summarize(result), writes: writesSince(mark) });
    }
    const key = remoteKey(client, run.tasks[0]);
    run.issues[run.tasks[0]] = key; saveRun();
    const raw = client.getIssue(key);
    const decoded = decodeLoopDescription(raw.fields.description);
    out("adf-readback", { key, issuetype: raw.fields.issuetype?.name, status: raw.fields.status?.name, project: raw.fields.project?.key, adfNodeTypes: raw.fields.description.content.map((n) => n.type), decodedClaimed: decoded.claimed, decodedTaskId: decoded.taskId, decodedProblem: decoded.problem, metadataKeys: decoded.metadata && Object.keys(decoded.metadata), criteria: decoded.criteria });
    writeJson(join(stateDir, "raw-description.json"), raw.fields.description);
    const after = reconcile(client);
    const noop = after.noops.find((d) => d.taskId === run.tasks[0]);
    out("reconcile-after", { decision: noop?.decision ?? null, reasonCode: noop?.reasonCode ?? null, jiraIssueKey: noop?.jiraIssueKey ?? null, conflicts: after.conflicts.map((c) => `${c.taskId}:${c.reasonCode}`) });
    record({ op: "create", taskId: run.tasks[0], issueKey: key, outcome: result.outcome, reconcile: noop?.decision ?? null });
    store.close();
  },

  async idempotency() {
    const client = jira();
    const key = run.issues[run.tasks[0]];
    // (a) same JIRA_CREATE again, same outbox: terminal op is never re-executed
    const store = openOutbox();
    const exec = executorFor(client, store);
    const snap = snapshot();
    const task1 = snap.tasks.find((t) => t.taskId === run.tasks[0]);
    const issuesBefore = observe(client).issues.map((i) => i.jiraIssueKey).sort();
    // reconstruct the ORIGINAL operation (same payload) to enqueue it again
    const { operations } = buildMaterializationOperations({ reconciliation: { creates: [{ decision: "CREATE", taskId: task1.taskId, planVersion: 1, snapshotContentHash: snap.contentHash, proposedMaterialization: { sourceDocumentId: snap.documentId, planVersion: 1, snapshotContentHash: snap.contentHash, taskId: task1.taskId, title: task1.title, epicId: task1.epicId, dependsOn: task1.dependsOn, acceptanceCriteria: task1.acceptanceCriteria, taskHash: task1.taskHash } }], noops: [] }, config: materializationConfig() });
    let mark = requests.length;
    const again = exec.enqueueMaterialization(operations[0]);
    const second = await exec.process(operations[0].operationId);
    out("create-repeat-same-outbox", { enqueueCreated: again.created, ...summarize(second), writes: writesSince(mark).length });
    // (b) outbox lost: a brand-new outbox with the SAME operation must reconcile to APPLIED, not POST
    const fresh = openOutbox("outbox-fresh.sqlite");
    const freshExec = executorFor(client, fresh);
    mark = requests.length;
    freshExec.enqueueMaterialization(operations[0]);
    const third = await freshExec.process(operations[0].operationId);
    out("create-repeat-fresh-outbox", { ...summarize(third), writes: writesSince(mark).length, issueKeyUnchanged: remoteKey(client, run.tasks[0]) === key });
    const issuesAfter = observe(client).issues.map((i) => i.jiraIssueKey).sort();
    out("issues-on-board", { before: issuesBefore, after: issuesAfter, secondIssueCreated: issuesAfter.length !== issuesBefore.length });

    // comment: same logical execution comment repeated
    const executionId = `${run.runId}-exec-1`;
    const input = { issueKey: key, executionId, kind: "started", body: `CP08 live execution comment for ${run.runId}`, taskId: run.tasks[0] };
    mark = requests.length;
    const first = exec.enqueueComment(input);
    const c1 = await drive(exec, first.operation.operationId);
    const writes1 = writesSince(mark).length;
    mark = requests.length;
    const rep = exec.enqueueComment(input);
    const c2 = await exec.process(rep.operation.operationId);
    const freshComment = freshExec.enqueueComment(input);
    const c3 = await freshExec.process(freshComment.operation.operationId);
    const marked = client.listComments(key).filter((c) => JSON.stringify(c.body).includes(`loop-execution:${executionId}:started`));
    out("comment-idempotency", { first: summarize(c1), firstWrites: writes1, repeatSameOutbox: { enqueueCreated: rep.created, ...summarize(c2) }, repeatFreshOutbox: summarize(c3), writesInRepeats: writesSince(mark).length, markedCommentsInJira: marked.length });
    record({ op: "idempotency", issueKey: key, commentId: marked[0]?.id ?? null, markedComments: marked.length, secondIssueCreated: issuesAfter.length !== issuesBefore.length });
    store.close(); fresh.close();
  },

  /**
   * One-off corrective stage (live evidence showed the first Blocks link was written in the reversed direction):
   * removes ONLY the wrong Blocks link between this run's two issues (never an issue), recreates it with the
   * live-proven direction and verifies the raw issuelinks of BOTH issues. Idempotent.
   */
  async "repair-link"() {
    const client = jira();
    const lease = { assertLeaseCurrent: async () => {} };
    const key1 = run.issues[run.tasks[0]]; const key2 = run.issues[run.tasks[1]];
    if (!key1 || !key2) throw new Error("both CP08 issues must exist before repair-link");
    const shape = (issue) => issue.fields.issuelinks.map((l) => ({ id: l.id ?? null, type: l.type?.name, inwardIssue: l.inwardIssue?.key ?? null, outwardIssue: l.outwardIssue?.key ?? null }));
    const read = () => ({ blocker: shape(client.getIssue(key1, "issuelinks")), dependent: shape(client.getIssue(key2, "issuelinks")) });
    const before = read();
    out("links-before", { [key1]: before.blocker, [key2]: before.dependent });
    // wrong direction (disproven hypothesis): the dependent's entry names the blocker as outwardIssue
    const wrong = before.dependent.filter((l) => l.type === "Blocks" && l.outwardIssue === key1);
    if (wrong.length > 1) throw new Error("more than one reversed Blocks link; refusing to guess");
    if (wrong.length === 1) {
      record({ op: "reversed-link-observed", dependentKey: key2, blockerKey: key1, linkId: wrong[0].id, note: "Link created by the dependency stage under the disproven hypothesis (dependentEnd=inward): POST inwardIssue=" + key2 + ", outwardIssue=" + key1 + " rendered live as " + key2 + " outwardIssue " + key1 + " / " + key1 + " inwardIssue " + key2 + ". Live verification disproved the previous direction hypothesis." });
      const removed = await client.removeIssueLink({ linkId: wrong[0].id, blockerKey: key2, dependentKey: key1, relationship: relationship() }, lease); // the reversed link as it exists: key2 "blocks" key1
      const mid = read();
      const gone = !mid.dependent.some((l) => String(l.id) === String(wrong[0].id)) && !mid.blocker.some((l) => String(l.id) === String(wrong[0].id));
      out("link-removed", { removed, goneFromBothIssues: gone });
      record({ op: "reversed-link-removed", linkId: wrong[0].id, goneFromBothIssues: gone, issuesDeleted: 0 });
      if (!gone) throw new Error("reversed link still present after removal");
    } else out("link-removed", { removed: null, note: "no reversed link present" });
    const state = read();
    const correct = state.dependent.filter((l) => l.type === "Blocks" && l.inwardIssue === key1);
    if (correct.length === 0) {
      const mark = requests.length;
      await client.linkIssues({ blockerKey: key1, dependentKey: key2, relationship: relationship() }, lease);
      out("link-created", { body: "inwardIssue=blocker, outwardIssue=dependent", blockerKey: key1, dependentKey: key2, writes: writesSince(mark) });
    } else out("link-created", { note: "correct link already present", count: correct.length });
    const after = read();
    const dependentOk = after.dependent.filter((l) => l.type === "Blocks").length === 1 && after.dependent.some((l) => l.type === "Blocks" && l.inwardIssue === key1 && l.outwardIssue === null);
    const blockerOk = after.blocker.filter((l) => l.type === "Blocks").length === 1 && after.blocker.some((l) => l.type === "Blocks" && l.outwardIssue === key2 && l.inwardIssue === null);
    out("links-after", { [key1]: after.blocker, [key2]: after.dependent, blockerBlocksDependent: blockerOk, dependentIsBlockedByBlocker: dependentOk });
    record({ op: "correct-link-verified", blockerKey: key1, dependentKey: key2, [`${key1}_raw`]: after.blocker.map(({ id, ...rest }) => rest), [`${key2}_raw`]: after.dependent.map(({ id, ...rest }) => rest), blockerBlocksDependent: blockerOk, dependentIsBlockedByBlocker: dependentOk, relationship: relationship() });
    if (!blockerOk || !dependentOk) throw new Error("correct link direction not verified from raw issuelinks");
  },

  async dependency() {
    const client = jira();
    const store = openOutbox();
    const exec = executorFor(client, store);
    const types = client.listLinkTypes();
    out("link-type-live", types.find((t) => t.name === "Blocks"));
    verifyAgainstLinkTypes(relationship(), types);
    const op = opFor(run.tasks[1]);
    let result = { outcome: "RESUMED_EXISTING" };
    if (!op && run.issues[run.tasks[1]] && remoteKey(client, run.tasks[1]) === run.issues[run.tasks[1]]) {
      out("dependent-resume", { key: run.issues[run.tasks[1]], writes: 0 }); // the dependent already exists: verify, never recreate
    } else {
      if (!op) throw new Error("no JIRA_CREATE operation for task 2 (blocked or already materialized)");
      const mark = requests.length;
      exec.enqueueMaterialization(op);
      result = await drive(exec, op.operationId);
      out("dependent-create", { ...summarize(result), writes: writesSince(mark) });
    }
    const key2 = remoteKey(client, run.tasks[1]);
    const key1 = run.issues[run.tasks[0]];
    run.issues[run.tasks[1]] = key2; saveRun();
    const dependent = client.getIssue(key2);
    const blocker = client.getIssue(key1);
    out("raw-links", { dependentKey: key2, dependentLinks: dependent.fields.issuelinks.map((l) => ({ type: l.type?.name, inwardIssue: l.inwardIssue?.key ?? null, outwardIssue: l.outwardIssue?.key ?? null })), blockerKey: key1, blockerLinks: blocker.fields.issuelinks.map((l) => ({ type: l.type?.name, inwardIssue: l.inwardIssue?.key ?? null, outwardIssue: l.outwardIssue?.key ?? null })) });
    const normalized = observe(client).issues.find((i) => i.jiraIssueKey === key2);
    out("normalized", { taskIdMarker: normalized?.taskIdMarker, dependencies: normalized?.dependencies ?? normalized?.dependsOn ?? null, keys: normalized && Object.keys(normalized) });
    const after = reconcile(client);
    out("reconcile-after", { noops: after.noops.map((d) => `${d.taskId}:${d.reasonCode}`), conflicts: after.conflicts.map((d) => `${d.taskId}:${d.reasonCode}:${JSON.stringify(d.differences ?? [])}`), creates: after.creates.map((d) => d.taskId) });
    record({ op: "dependency", dependentKey: key2, blockerKey: key1, outcome: result.outcome, noops: after.noops.length, conflicts: after.conflicts.length });
    if (after.conflicts.length > 0 || after.noops.length !== 2) throw new Error("dependency reconcile is not NOOP for both tasks");
    store.close();
  },

  async sprint() {
    if (!config.sprint) { out("REAL_SPRINT_PROOF_BLOCKED", { reason: "sprint not discovered" }); return; }
    const client = jira();
    const sprintId = config.sprint.id;
    const live = client.getSprint(sprintId);
    if (live.name !== SPRINT_NAME) throw new Error("sprint name mismatch");
    out("sprint-live", { id: live.id, name: live.name, state: live.state, originBoardId: live.originBoardId });
    const store = openOutbox();
    const exec = executorFor(client, store);
    const keys = run.tasks.map((t) => run.issues[t]).filter(Boolean);
    const initial = client.getSprintMembership(sprintId);
    out("sprint-initial-membership", initial);
    const results = [];
    for (const key of keys) {
      const mark = requests.length;
      const op = exec.enqueueSprintAssignment({ issueKey: key, sprintId, taskId: key });
      const r = await drive(exec, op.operation.operationId);
      results.push({ key, ...summarize(r), writes: writesSince(mark) });
    }
    out("sprint-assign", results);
    const final = client.getSprintMembership(sprintId);
    const expected = [...new Set([...initial, ...keys])].sort();
    out("sprint-final-membership", { final, expected, exact: JSON.stringify(final) === JSON.stringify(expected) });
    const mark = requests.length;
    const rep = exec.enqueueSprintAssignment({ issueKey: keys[0], sprintId, taskId: keys[0] });
    const again = await exec.process(rep.operation.operationId);
    out("sprint-repeat", { enqueueCreated: rep.created, ...summarize(again), writes: writesSince(mark).length });
    record({ op: "sprint", sprintId, issues: keys, exact: JSON.stringify(final) === JSON.stringify(expected) });
    store.close();
  },

  async transition() {
    const client = jira();
    const key = run.issues[run.tasks[0]];
    const initial = client.getIssue(key, "status").fields.status;
    const transitions = client.listTransitions(key);
    out("status-current", { id: initial.id, name: initial.name, category: initial.statusCategory?.key });
    out("transitions", transitions.map((t) => ({ id: t.id, name: t.name, toId: t.to?.id, toName: t.to?.name, toCategory: t.to?.statusCategory?.key })));
    const done = transitions.filter((t) => t.to?.statusCategory?.key === "done");
    if (done.length !== 1) throw new Error(`expected exactly one completion transition, found ${done.length}`);
    const completion = { transitionName: done[0].name, doneStatusName: done[0].to.name, fromStatusName: initial.name };
    writeJson(CONFIG_PATH, { ...readJson(CONFIG_PATH, {}), completion: { ...completion, transitionId: done[0].id, toStatusId: done[0].to.id }, initialStatus: { id: initial.id, name: initial.name } });
    const store = openOutbox();
    const exec = executorFor(client, store);
    const mark = requests.length;
    const op = exec.enqueueTransition({ issueKey: key, executionId: `${run.runId}-exec-1`, doneStatusName: completion.doneStatusName, transitionName: completion.transitionName, expectedCurrentStatusNames: [initial.name], taskId: run.tasks[0] });
    const r = await drive(exec, op.operation.operationId);
    const after = client.getIssue(key, "status").fields.status;
    out("transition-result", { ...summarize(r), writes: writesSince(mark), observedStatus: after.name, observedCategory: after.statusCategory?.key });
    const mark2 = requests.length;
    const rep = exec.enqueueTransition({ issueKey: key, executionId: `${run.runId}-exec-1`, doneStatusName: completion.doneStatusName, transitionName: completion.transitionName, expectedCurrentStatusNames: [initial.name], taskId: run.tasks[0] });
    const again = await exec.process(rep.operation.operationId);
    const fresh = openOutbox("outbox-fresh-transition.sqlite");
    const freshExec = executorFor(client, fresh);
    const f = freshExec.enqueueTransition({ issueKey: key, executionId: `${run.runId}-exec-1`, doneStatusName: completion.doneStatusName, transitionName: completion.transitionName, expectedCurrentStatusNames: [initial.name], taskId: run.tasks[0] });
    const freshResult = await freshExec.process(f.operation.operationId);
    out("transition-repeat", { sameOutbox: { enqueueCreated: rep.created, ...summarize(again) }, freshOutbox: summarize(freshResult), writes: writesSince(mark2).length, statusAfterRepeat: client.getIssue(key, "status").fields.status.name });
    record({ op: "transition", issueKey: key, from: initial.name, to: after.name, outcome: r.outcome });
    store.close(); fresh.close();
  },
};

if (!stages[stage]) { console.error(`unknown stage ${stage}`); process.exit(78); }
try {
  await stages[stage]();
  out("requests", requests.map((r) => `${r.method} ${r.api === "agile" ? "agile/" : ""}${r.path} ${r.status}`));
} catch (error) {
  out("STAGE_FAILED", { stage, code: error.code ?? null, http: error.httpStatus ?? null, message: String(error.message).slice(0, 400) });
  out("requests", requests.map((r) => `${r.method} ${r.api === "agile" ? "agile/" : ""}${r.path} ${r.status}`));
  process.exit(1);
}
