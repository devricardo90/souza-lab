import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseConfig, planText, runProcess, startMock, task, workspace } from "./controller-harness.js";
import { SqliteExecutionAttemptStore } from "../../src/adapters/sqlite-execution-attempt-store.js";
import { makeRepo } from "./git-repo.js";

/**
 * Real-process crash scenarios for CP-06. The Controller runs as bin/loop-controller.js; a crash is an abrupt process
 * death (SIGKILL / TerminateProcess) at a precise point; recovery is a brand new process on the same durable state and
 * the same real Git repository. Synthetic agent (ZERO model calls), local Jira mock, fake Google (a file).
 */
const TIMINGS = { instanceLeaseTtlMs: 15000, defaultWaitMs: 200, standbyPollMs: 300, idlePollMs: 500, blockedPollMs: 500 };

export async function createScenario() {
  const mock = await startMock();
  await mock.reset(); // legacySearch off: the mock only exposes issues the Loop created
  const ws = workspace();
  const repo = makeRepo();
  ws.setPlan(planText(1, task("TASK-001", "Only task")));
  const children = [];
  const ctx = {
    mock, ws, repo,
    async reset() { await mock.reset(); },
    spawn(name, extra = {}) {
      const path = join(ws.dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(baseConfig({ ws, port: mock.port, extra: { timings: TIMINGS, ownerId: name, git: { repoPath: repo.path }, ...extra } })), "utf8");
      const handle = runProcess(path);
      children.push(handle.child);
      return handle;
    },
    agentCalls: () => { try { return readFileSync(join(ws.dir, "agent-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    attempt() {
      const store = new SqliteExecutionAttemptStore({ path: join(ws.dir, "execution-attempts.sqlite") });
      try { const row = store.db.prepare("SELECT execution_id FROM execution_attempts").all(); return row.length === 0 ? null : store.get(row[0].execution_id); } finally { store.close(); }
    },
    workspacePath() { return join(ws.dir, "workspaces", readdirSync(join(ws.dir, "workspaces"))[0]); },
    commitsOnBranch: (branch) => Number(repo.run(["rev-list", "--count", `main..${branch}`])),
    died: (r) => r.signal !== null || r.code !== 0,
    async assertCompletedOnce(assert) {
      assert.equal(await mock.posts(/\/rest\/api\/3\/issue$/), 1, "one Jira issue");
      assert.equal(await mock.posts(/\/transitions$/), 1, "one Jira completion");
      assert.ok((await mock.issues()).every((i) => i.fields.status.name === "Done"));
    },
    cleanup() { for (const c of children.splice(0)) { try { c.kill(); } catch {} } mock.stop(); ws.cleanup(); repo.cleanup(); },
  };
  return ctx;
}
