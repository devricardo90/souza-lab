import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DOC, TWO_TASKS, drive, inProcessController, planText, startMock, steppingClock, task, workspace } from "./helpers/controller-harness.js";
import { FakeNotifier } from "../src/controller/ports.js";

/**
 * CP-05 Controller, in-process: real plan compiler/snapshot store, real reconciler, real SQLite outbox, real curl
 * transport to a local Jira mock, real LoopRuntime; fake Google, fake agent, synthetic lifecycle. SYNTHETIC evidence only.
 */
let mock; let ws; let handle;
before(async () => { mock = await startMock(); });
after(() => mock.stop());
beforeEach(async () => { cleanup(); await mock.reset(); ws = workspace(); });
const cleanup = () => { if (handle) { try { handle.close(); } catch {} handle = null; } if (ws) ws.cleanup(); };
after(cleanup);

const open = (opts = {}) => { handle = inProcessController({ ws, port: mock.port, ...opts }); return handle; };
const sequence = (log) => log.map((r) => `${r.phase}${r.taskId ? `:${r.taskId}` : ""}`);
const agentLines = () => readFileSync(join(ws.dir, "agent-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

test("TWO-TASK AUTONOMOUS RUN: TASK-001 -> LOCAL_DONE -> Jira completion via outbox -> REMOTE_DONE_CONFIRMED -> TASK-002 -> COMPLETED, no manual step", async () => {
  ws.setPlan(TWO_TASKS());
  const h = open();
  const started = await h.controller.start();
  assert.equal(started.owner, true);
  const { last, cycles } = await drive(h);
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));

  // each task was implemented exactly once, by the agent boundary only
  assert.deepEqual(agentLines().map((l) => l.taskId), ["TASK-001", "TASK-002"]);
  assert.deepEqual(h.agent.calls, ["TASK-001", "TASK-002"]);
  assert.equal(h.agent.modelCalls, 0);

  // the advancement rule: TASK-002 is only built AFTER TASK-001's remote completion was confirmed
  const seq = sequence(h.log);
  const idx = (needle) => seq.indexOf(needle);
  assert.ok(idx("LOCAL_DONE:TASK-001") >= 0 && idx("REMOTE_DONE_CONFIRMED:TASK-001") > idx("LOCAL_DONE:TASK-001"));
  assert.ok(idx("BUILD_WORK_PACKAGE:TASK-002") > idx("REMOTE_DONE_CONFIRMED:TASK-001"), seq.join(" > "));
  assert.ok(idx("REMOTE_DONE_CONFIRMED:TASK-002") > idx("BUILD_WORK_PACKAGE:TASK-002"));

  // durable state
  const rows = h.stores.controllerStore.list();
  assert.deepEqual(rows.map((r) => [r.taskId, r.status]), [["TASK-001", "REMOTE_DONE_CONFIRMED"], ["TASK-002", "REMOTE_DONE_CONFIRMED"]]);
  const ops = h.stores.outboxStore.list();
  assert.deepEqual(ops.map((o) => [o.action, o.taskId, o.status]).sort(), [
    ["JIRA_CREATE", "TASK-001", "CONFIRMED"], ["JIRA_CREATE", "TASK-002", "CONFIRMED"],
    ["JIRA_TRANSITION", "TASK-001", "CONFIRMED"], ["JIRA_TRANSITION", "TASK-002", "CONFIRMED"],
  ]);

  // Jira: two issues, both Done, TASK-002 linked as blocked by TASK-001's issue
  const issues = await mock.issues();
  assert.equal(issues.length, 2);
  assert.ok(issues.every((i) => i.fields.status.name === "Done"));
  const first = issues.find((i) => i.fields.summary === "First task");
  const second = issues.find((i) => i.fields.summary === "Second task");
  assert.deepEqual(second.fields.issuelinks, [{ type: { name: "Blocks" }, inwardIssue: { key: first.key } }]);
  assert.equal(await mock.posts(/\/rest\/api\/3\/issue$/), 2, "one create per task");
  assert.equal(await mock.posts(/\/transitions$/), 2, "one completion per task");

  // a successful run needs no Owner message
  assert.deepEqual(h.notifier.events, []);
  assert.ok(cycles < 120);
});
