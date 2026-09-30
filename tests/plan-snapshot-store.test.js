import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePlan } from "../src/plan/plan-compiler.js";
import { InjectedGooglePlanGateway, PlanSourceUnavailableError } from "../src/plan/google-plan-gateway.js";
import { makePlanSnapshot, snapshotRef, taskBinding } from "../src/plan/plan-snapshot.js";
import { PlanSourceSynchronizer } from "../src/plan/plan-source-sync.js";
import { SqlitePlanSnapshotStore } from "../src/adapters/sqlite-plan-snapshot-store.js";

const DOC = "doc-roadmap-1";
const FIXED = "2026-09-30T12:00:00.000Z";
const task = (id, title, extra = "") => `TASK_ID: ${id}\nTITLE: ${title}\n${extra}AC:\n- AC-001: ${title} works\n`;
const source = (version, body = task("RT-1", "First")) => `Narrative.\nLOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: ${version}\n\n${body}\nEND_LOOP_EXECUTION_PLAN\n`;
const snap = (text, over = {}) => makePlanSnapshot({ documentId: DOC, compiled: compilePlan(text), googleRevisionId: "rev-abc", fetchedAt: FIXED, compiledAt: FIXED, ...over });

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "plan-store-"));
  const stores = [];
  t.after(() => { for (const s of stores) { try { s.close(); } catch {} } rmSync(dir, { recursive: true, force: true }); });
  const path = join(dir, "plans.sqlite");
  return { dir, path, open: () => { const s = new SqlitePlanSnapshotStore({ path, clock: () => FIXED }); stores.push(s); return s; } };
}

test("PlanSnapshot: immutable, identity = document_id + plan_version + content_hash, Google revision is metadata only", () => {
  const s = snap(source(3));
  assert.ok(Object.isFrozen(s) && Object.isFrozen(s.tasks) && Object.isFrozen(s.tasks[0].acceptanceCriteria));
  assert.throws(() => { "use strict"; s.planVersion = 9; }, TypeError);
  assert.deepEqual(snapshotRef(s), { documentId: DOC, planVersion: 3, contentHash: s.contentHash });
  assert.deepEqual(s.googleRevisionMetadata, { revisionId: "rev-abc" });
  // same content, different Google revision => same permanent identity
  assert.deepEqual(snapshotRef(snap(source(3), { googleRevisionId: "rev-zzz" })), snapshotRef(s));
  assert.equal(snap(source(3), { googleRevisionId: null }).googleRevisionMetadata, null);
  const t = s.tasks[0];
  assert.deepEqual([t.taskId, t.planVersion, t.snapshotContentHash, t.acceptanceCriteria[0].id], ["RT-1", 3, s.contentHash, "AC-001"]);
  assert.deepEqual(taskBinding(s, "RT-1"), { documentId: DOC, planVersion: 3, contentHash: s.contentHash, taskId: "RT-1", taskHash: t.taskHash });
  assert.throws(() => taskBinding(s, "RT-404"), { code: "TASK_NOT_IN_SNAPSHOT" });
  assert.throws(() => makePlanSnapshot({ documentId: DOC, compiled: { ...compilePlan(source(3)), contentHash: "0".repeat(64) }, fetchedAt: FIXED, compiledAt: FIXED }), { code: "HASH_MISMATCH" });
});

test("store: persist, load by identity, latest, duplicate idempotency, immutability", (t) => {
  const store = fixture(t).open();
  const s1 = snap(source(1));
  const first = store.persist(s1);
  assert.equal(first.created, true);
  assert.deepEqual(store.load(DOC, 1, s1.contentHash), s1);
  assert.deepEqual(store.latest(DOC), s1);
  assert.equal(store.latest("other-doc"), null);
  const dup = store.persist(snap(source(1), { fetchedAt: "2026-10-01T00:00:00.000Z", googleRevisionId: "other" }));
  assert.equal(dup.created, false);
  assert.equal(dup.snapshot.fetchedAt, FIXED, "the first persisted snapshot wins; metadata is never rewritten");
  assert.equal(store.listVersions(DOC).length, 1);
  assert.throws(() => store.db.exec("UPDATE plan_snapshots SET content_hash = content_hash"), /immutable/);
  assert.throws(() => store.db.exec("DELETE FROM plan_snapshots"), /never deleted/);
});

test("store: same plan_version with different content is a conflict; older versions are rejected; newer becomes latest", (t) => {
  const store = fixture(t).open();
  const v2 = snap(source(2));
  store.persist(v2);
  assert.throws(() => store.persist(snap(source(2, task("RT-1", "Changed")))), { code: "PLAN_VERSION_CONFLICT" });
  assert.throws(() => store.persist(snap(source(1))), { code: "PLAN_VERSION_REGRESSION" });
  assert.deepEqual(store.latest(DOC), v2, "a rejected snapshot changes nothing");
  const v3 = snap(source(3, task("RT-1", "Changed")));
  store.persist(v3);
  assert.deepEqual(store.latest(DOC), v3);
  assert.deepEqual(store.listVersions(DOC).map((v) => v.planVersion), [2, 3]);
  // the database itself forbids two hashes for one version, even if the JS guard were bypassed
  assert.throws(() => store.db.prepare(`INSERT INTO plan_snapshots VALUES (?,?,?,?,?,?,?,?,?)`).run(DOC, 2, "f".repeat(64), 1, "{}", null, FIXED, FIXED, FIXED), /UNIQUE|constraint/i);
});

test("store: integrity is verified on load; a tampered row is never served", (t) => {
  const { path, open } = fixture(t);
  const store = open();
  const s1 = snap(source(1));
  store.persist(s1);
  store.db.exec("DROP TRIGGER plan_snapshots_no_update"); // simulate out-of-band tampering, only to prove detection
  store.db.prepare("UPDATE plan_snapshots SET canonical_plan = replace(canonical_plan, 'First', 'Hacked')").run();
  assert.throws(() => store.latest(DOC), { code: "CORRUPT_SNAPSHOT" });
  assert.ok(path);
});

test("restart: snapshots persisted by a real child process are recovered after it is killed", (t) => {
  const fx = fixture(t);
  const { path } = fx;
  const script = `
    import { SqlitePlanSnapshotStore } from ${JSON.stringify(new URL("../src/adapters/sqlite-plan-snapshot-store.js", import.meta.url).href)};
    import { compilePlan } from ${JSON.stringify(new URL("../src/plan/plan-compiler.js", import.meta.url).href)};
    import { makePlanSnapshot } from ${JSON.stringify(new URL("../src/plan/plan-snapshot.js", import.meta.url).href)};
    const store = new SqlitePlanSnapshotStore({ path: ${JSON.stringify(path)} });
    store.persist(makePlanSnapshot({ documentId: ${JSON.stringify(DOC)}, compiled: compilePlan(${JSON.stringify(source(5))}), fetchedAt: ${JSON.stringify(FIXED)}, compiledAt: ${JSON.stringify(FIXED)} }));
    store.db.exec("BEGIN IMMEDIATE");
    store.db.prepare("INSERT INTO plan_snapshots VALUES ('doc-roadmap-1', 6, ?, 1, '{}', NULL, 'a', 'a', 'a')").run("b".repeat(64));
    process.kill(process.pid, "SIGKILL"); // die mid-transaction
  `;
  const child = spawnSync(process.execPath, ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8" });
  assert.ok(child.signal || child.status !== 0, "the child must die uncleanly");
  const store = fx.open();
  assert.equal(store.latest(DOC).planVersion, 5, "committed snapshot survives; the uncommitted one never appears");
  assert.deepEqual(store.listVersions(DOC).map((v) => v.planVersion), [5]);
  assert.equal(store.db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
});

// ---------- last-known-good / source failures ----------
function sync(t, transport) {
  const fx = fixture(t);
  const store = fx.open();
  const gateway = new InjectedGooglePlanGateway({ transport: (req) => transport.current(req), clock: () => FIXED });
  return { store, synchronizer: new PlanSourceSynchronizer({ gateway, store, clock: () => FIXED }), transport };
}
const ok = (text, revision = "rev-1") => ({ documentId: DOC, googleRevisionId: revision, fetchedAt: FIXED, content: text });

test("gateway: returns structured facts; revision id is optional; invalid transport output is unavailable, not trusted", async () => {
  const good = new InjectedGooglePlanGateway({ transport: () => ({ content: "x", googleRevisionId: "r1", fetchedAt: FIXED }), clock: () => FIXED });
  assert.deepEqual(await good.fetchPlan({ documentId: DOC }), { documentId: DOC, googleRevisionId: "r1", fetchedAt: FIXED, content: "x" });
  const noRev = new InjectedGooglePlanGateway({ transport: () => ({ content: "x" }), clock: () => FIXED });
  assert.equal((await noRev.fetchPlan({ documentId: DOC })).googleRevisionId, null);
  for (const bad of [null, {}, { content: 5 }, { content: "x", documentId: "other" }, { content: "x", fetchedAt: "nope" }]) {
    const gateway = new InjectedGooglePlanGateway({ transport: () => bad, clock: () => FIXED });
    await assert.rejects(gateway.fetchPlan({ documentId: DOC }), (error) => error instanceof PlanSourceUnavailableError && error.retryable === true);
  }
  await assert.rejects(new InjectedGooglePlanGateway({ transport: () => { throw new Error("503 from google"); } }).fetchPlan({ documentId: DOC }), PlanSourceUnavailableError);
  await assert.rejects(new InjectedGooglePlanGateway({ transport: async () => { throw new Error("socket hang up"); } }).fetchPlan({ documentId: DOC }), PlanSourceUnavailableError);
});

test("valid new plan -> ACCEPTED and becomes latest-known-good; unchanged refetch -> UNCHANGED; changed content with a new version -> ACCEPTED", async (t) => {
  const transport = { current: () => ok(source(1)) };
  const { synchronizer, store } = sync(t, transport);
  const first = await synchronizer.refresh({ documentId: DOC });
  assert.deepEqual([first.status, first.usable, first.snapshot.planVersion, first.created], ["ACCEPTED", true, 1, true]);
  const again = await synchronizer.refresh({ documentId: DOC });
  assert.deepEqual([again.status, again.created], ["UNCHANGED", false]);
  transport.current = () => ok(source(2, task("RT-1", "First") + "\n" + task("RT-2", "Second", "DEPENDS_ON: RT-1\n")), "rev-2");
  const next = await synchronizer.refresh({ documentId: DOC });
  assert.equal(next.status, "ACCEPTED");
  assert.deepEqual(store.latest(DOC).tasks.map((x) => x.taskId), ["RT-1", "RT-2"]);
  assert.equal(store.latest(DOC).googleRevisionMetadata.revisionId, "rev-2");
});

test("same TASK_ID with changed definition is the same task in a new snapshot (identity is stable, definition is not frozen)", async (t) => {
  const transport = { current: () => ok(source(1)) };
  const { synchronizer, store } = sync(t, transport);
  await synchronizer.refresh({ documentId: DOC });
  const old = store.latest(DOC);
  transport.current = () => ok(source(2, task("RT-1", "First, renamed")));
  await synchronizer.refresh({ documentId: DOC });
  const fresh = store.latest(DOC);
  assert.equal(fresh.tasks[0].taskId, old.tasks[0].taskId);
  assert.notEqual(fresh.contentHash, old.contentHash);
  assert.notEqual(fresh.tasks[0].taskHash, old.tasks[0].taskHash);
  // the WorkPackage binding made from the OLD snapshot still loads the OLD, unchanged definition
  const binding = taskBinding(old, "RT-1");
  const bound = store.load(binding.documentId, binding.planVersion, binding.contentHash);
  assert.equal(bound.tasks[0].title, "First");
});

test("invalid new plan -> SOURCE_INVALID, previous last-known-good retained and usable", async (t) => {
  const transport = { current: () => ok(source(1)) };
  const { synchronizer, store } = sync(t, transport);
  await synchronizer.refresh({ documentId: DOC });
  const good = store.latest(DOC);
  for (const [bad, expected] of [
    [source(2, "TASK_ID: RT-1\nTITLE: broken\n"), "MISSING_AC"],
    [source(2, task("RT-1", "a") + "\n" + task("RT-1", "b")), "DUPLICATE_TASK_ID"],
    ["narrative only", "NO_EXECUTABLE_SECTION"],
    [source(1, task("RT-1", "Sneaky change, same version")), "PLAN_VERSION_CONFLICT"],
  ]) {
    transport.current = () => ok(bad);
    const result = await synchronizer.refresh({ documentId: DOC });
    assert.equal(result.status, "SOURCE_INVALID", expected);
    assert.equal(result.errorCode, expected);
    assert.equal(result.usable, true);
    assert.deepEqual(result.snapshot, good);
    assert.deepEqual(store.latest(DOC), good, "a valid snapshot is never replaced by invalid input");
  }
});

test("a stale document presenting an older plan_version is SOURCE_INVALID (regression, or conflict when its content differs)", async (t) => {
  const transport = { current: () => ok(source(1)) };
  const { synchronizer, store } = sync(t, transport);
  await synchronizer.refresh({ documentId: DOC });
  transport.current = () => ok(source(2, task("RT-1", "Second")));
  await synchronizer.refresh({ documentId: DOC });
  for (const [text, code] of [[source(1, task("RT-1", "Different content at an old version")), "PLAN_VERSION_CONFLICT"], [source(1), "PLAN_VERSION_REGRESSION"], [source(0 + 1, task("RT-9", "Other")), "PLAN_VERSION_CONFLICT"]]) {
    transport.current = () => ok(text);
    const result = await synchronizer.refresh({ documentId: DOC });
    assert.deepEqual([result.status, result.errorCode], ["SOURCE_INVALID", code]);
    assert.equal(store.latest(DOC).planVersion, 2);
  }
});

test("Google unavailable with a previous snapshot -> SOURCE_UNAVAILABLE, previous work stays usable", async (t) => {
  const transport = { current: () => ok(source(1)) };
  const { synchronizer, store } = sync(t, transport);
  await synchronizer.refresh({ documentId: DOC });
  transport.current = () => { throw new Error("Google Docs API 503"); };
  const result = await synchronizer.refresh({ documentId: DOC });
  assert.deepEqual([result.status, result.usable, result.action, result.retryable], ["SOURCE_UNAVAILABLE", true, "CONTINUE", true]);
  assert.deepEqual(result.snapshot, store.latest(DOC));
});

test("Google unavailable with no previous snapshot -> WAIT, nothing usable, nothing invented", async (t) => {
  const transport = { current: () => { throw new Error("network down"); } };
  const { synchronizer, store } = sync(t, transport);
  const result = await synchronizer.refresh({ documentId: DOC });
  assert.deepEqual([result.status, result.usable, result.action, result.snapshot], ["SOURCE_UNAVAILABLE", false, "WAIT", null]);
  assert.equal(store.latest(DOC), null);
});

test("last-known-good survives restart: a new process-level store instance still serves it after source failure", async (t) => {
  const fx = fixture(t);
  const transport = { current: () => ok(source(4)) };
  const gateway = new InjectedGooglePlanGateway({ transport: (req) => transport.current(req), clock: () => FIXED });
  await new PlanSourceSynchronizer({ gateway, store: fx.open(), clock: () => FIXED }).refresh({ documentId: DOC });
  transport.current = () => { throw new Error("down"); };
  const restarted = new PlanSourceSynchronizer({ gateway, store: fx.open(), clock: () => FIXED });
  const result = await restarted.refresh({ documentId: DOC });
  assert.deepEqual([result.status, result.usable, result.snapshot.planVersion], ["SOURCE_UNAVAILABLE", true, 4]);
});

test("CP-03 control logic is deterministic: no model client, network, or Jira import in plan modules", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["../src/plan/plan-compiler.js", "../src/plan/plan-snapshot.js", "../src/plan/plan-source-sync.js", "../src/plan/google-plan-gateway.js", "../src/adapters/sqlite-plan-snapshot-store.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/anthropic|openai|fetch\(|\bllm\b|claude|googleapis|jira/i.test(text), `${file} must not reference a model, network client, Google API, or Jira`);
  }
});
