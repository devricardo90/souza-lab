import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { baseConfig, inProcessController, planText, runProcess, startMock, task, workspace } from "./controller-harness.js";
import { makeRepo } from "./git-repo.js";
import { createFakeGitHub, initFakeRemote } from "../../src/testing/fake-github.js";
import { SqliteExecutionAttemptStore } from "../../src/adapters/sqlite-execution-attempt-store.js";
import { SqliteGateFactStore } from "../../src/adapters/sqlite-gate-fact-store.js";
import { SqliteControllerStore } from "../../src/adapters/sqlite-controller-store.js";
import { readCalls } from "../../src/testing/deterministic-gates.js";

/**
 * CP-07 scenario harness: a REAL local git repository whose `origin` is a REAL bare repository (the fake GitHub's remote),
 * the REAL GitHubSCMProvider/GitHubCIProvider running against the fake `gh api` backend, a local Jira mock, a fake Google
 * (a file) and a synthetic agent/reviewer/validator (zero model calls). Used in-process and through bin/loop-controller.js.
 */
export const GH = { owner: "fake-owner", repo: "fake-repo", workflowIdentity: ".github/workflows/validate.yml", baseBranch: "main" };
const TIMINGS = { instanceLeaseTtlMs: 15000, defaultWaitMs: 200, standbyPollMs: 300, idlePollMs: 500, blockedPollMs: 500 };

export async function createGitHubScenario({ tasks = 1 } = {}) {
  const mock = await startMock();
  await mock.reset();
  const ws = workspace();
  const repo = makeRepo();
  const barePath = join(repo.root, "remote.git");
  initFakeRemote({ barePath, seedPath: repo.path });
  repo.run(["remote", "add", "origin", barePath]);
  const stateFile = join(ws.dir, "fake-github.json");
  const fake = createFakeGitHub({ barePath, stateFile, ...GH, workflowPath: GH.workflowIdentity });
  fake.setAutoCI({ pendingPolls: 1, outcome: "success" });
  ws.setPlan(tasks === 1 ? planText(1, task("TASK-001", "Only task")) : planText(1, ...Array.from({ length: tasks }, (_, i) => task(`TASK-00${i + 1}`, `Task ${i + 1}`, i > 0 ? `DEPENDS_ON: TASK-00${i}\n` : ""))));
  const children = [];
  const githubConfig = (extra = {}) => ({ ...GH, fake: { barePath, stateFile }, ...extra });
  const ctx = {
    mock, ws, repo, fake, barePath, stateFile,
    config: (extra = {}, github = {}) => baseConfig({ ws, port: mock.port, extra: { timings: TIMINGS, git: { repoPath: repo.path }, github: githubConfig(github), ...extra } }),
    spawn(name, extra = {}, github = {}) {
      const path = join(ws.dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(baseConfig({ ws, port: mock.port, extra: { timings: TIMINGS, ownerId: name, git: { repoPath: repo.path }, github: githubConfig(github), ...extra } })), "utf8");
      const handle = runProcess(path);
      children.push(handle.child);
      return handle;
    },
    inProcess({ clock, overrides = {}, extra = {}, github = {} } = {}) {
      return inProcessController({ ws, port: mock.port, clock, overrides, configExtra: { timings: TIMINGS, git: { repoPath: repo.path }, github: githubConfig(github), ...extra } });
    },
    died: (r) => r.signal !== null || r.code !== 0,
    agentCalls: () => { try { return readFileSync(join(ws.dir, "agent-calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } },
    reviewCalls: () => readCalls(join(ws.dir, "review-calls.jsonl")),
    validationCalls: () => readCalls(join(ws.dir, "validation-calls.jsonl")),
    attempt() {
      const store = new SqliteExecutionAttemptStore({ path: join(ws.dir, "execution-attempts.sqlite") });
      try { const rows = store.db.prepare("SELECT execution_id FROM execution_attempts").all(); return rows.length ? store.get(rows[0].execution_id) : null; } finally { store.close(); }
    },
    gate(fn) {
      const store = new SqliteGateFactStore({ path: join(ws.dir, "gate-facts.sqlite") });
      try { return fn(store); } finally { store.close(); }
    },
    controllerRows() {
      const store = new SqliteControllerStore({ path: join(ws.dir, "controller.sqlite") });
      try { return store.list().map((r) => [r.taskId, r.status]); } finally { store.close(); }
    },
    remoteHead: (branch) => fake.branchHead(branch),
    mainCommits: () => Number(repo.run(["--git-dir", barePath, "rev-list", "--count", "main"], repo.root)),
    cleanup() { for (const c of children.splice(0)) { try { c.kill(); } catch {} } mock.stop(); ws.cleanup(); repo.cleanup(); },
  };
  return ctx;
}
