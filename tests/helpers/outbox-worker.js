import { SqliteOutboxStore } from "../../src/adapters/sqlite-outbox-store.js";
import { JiraSyncClient } from "../../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../../src/adapters/jira-outbox-executor.js";

/**
 * Real-process worker for the outbox crash / concurrency tests. Config is one JSON argv.
 * crashAt terminates THIS process abruptly (SIGKILL / TerminateProcess) at a fault point,
 * so the parent test observes genuine unclean process death, not a recreated JS object.
 */
const cfg = JSON.parse(process.argv[2]);
const kill = () => process.kill(process.pid, "SIGKILL");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (cfg.command === "uncommitted-tx") {
  const store = new SqliteOutboxStore({ path: cfg.dbPath });
  store.db.exec("BEGIN IMMEDIATE");
  store.db.prepare(`INSERT INTO outbox_operations (operation_id, target_system, target_object, action, task_id, desired_state, payload_digest, status, created_at, updated_at)
    VALUES ('uncommitted-op','JIRA','L-1','JIRA_COMMENT','L-1','{}','d','PENDING','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`).run();
  console.log("READY");
  setInterval(() => {}, 1000); // hold the open transaction until the parent kills us
} else {
  const store = new SqliteOutboxStore({ path: cfg.dbPath });
  const jira = new JiraSyncClient({ site: `127.0.0.1:${cfg.port}`, scheme: "http", email: "w@example.invalid", apiToken: "worker-token-0123456789", timeoutMs: 3000 });
  const faultPoints = {};
  if (cfg.crashAt) faultPoints[cfg.crashAt] = () => kill();
  if (cfg.sleepBeforeWriteMs) {
    const previous = faultPoints.beforeRemoteWrite;
    faultPoints.beforeRemoteWrite = async (op) => { await sleep(cfg.sleepBeforeWriteMs); if (previous) await previous(op); };
  }
  const offset = cfg.clockOffsetMs ?? 0;
  const executor = new JiraOutboxExecutor({
    store, jira, workerId: cfg.workerId, claimTtlMs: cfg.claimTtlMs ?? 120000, faultPoints,
    clock: () => new Date(Date.now() + offset).toISOString(),
  });
  if (cfg.startAt) while (Date.now() < cfg.startAt) { /* barrier: release all workers together */ }
  let out;
  if (cfg.command === "enqueue-spec") { const r = executor.enqueueMaterialization(cfg.spec); out = { created: r.created, conflict: r.conflict === true }; }
  else if (cfg.command === "enqueue") out = executor[cfg.op.type === "comment" ? "enqueueComment" : "enqueueTransition"](cfg.op.input);
  else if (cfg.command === "process") { const r = await executor.process(cfg.operationId); out = { owned: r.owned, outcome: r.outcome, status: r.operation?.status }; }
  else if (cfg.command === "recover") out = (await executor.recover()).map((r) => ({ owned: r.owned, outcome: r.outcome, recovered: r.recovered }));
  console.log(JSON.stringify(out));
  store.close();
}
