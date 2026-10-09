import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOC, steppingClock } from "./helpers/controller-harness.js";
import { createGitHubScenario } from "./helpers/github-scenario.js";
import { FakeHermes, HERMES_SIM_IDENTITY } from "./helpers/fake-hermes.js";
import { buildProductionController } from "../src/composition/production-profile.js";
import { HermesAgentExecutor } from "../src/adapters/hermes-agent-executor.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";

/**
 * CP-10, deterministic half: the REAL production composition (buildProductionController: Jira client + outbox, LoopController,
 * HermesAgentExecutor, ExecutionRunner, real Git workspaces, GitHub SCM/CI providers, command validator, command reviewer) driven end to end.
 * Only the outermost transports are fakes: the Jira mock server (loopback http), a fake `gh` backed by a real bare git repository,
 * a fake `hermes` CLI that makes REAL git commits, and gate scripts that run as separate child processes. Zero model calls.
 * The live proof (real Jira, Hermes, GitHub) is scripts/cp10-live-proof.js.
 */
const GATES = fileURLToPath(new URL("./helpers/cp10-gates.js", import.meta.url));
const SECRET = "cp10-sentinel-secret-7c1e9a52d0b34f68";
const PATH_ENV = Object.fromEntries(["PATH", "Path", "PATHEXT"].filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n]]));
const ENV = Object.freeze({ ...PATH_ENV, LOOP_JIRA_EMAIL: "cp10-test@example.invalid", LOOP_JIRA_API_TOKEN: SECRET });
const STOPS = new Set(["COMPLETED", "OWNER_DECISION_REQUIRED", "BLOCK_TASK", "BLOCK_GLOBAL"]);

let scenario = null; let built = [];
afterEach(() => { for (const b of built.splice(0)) { try { b.close(); } catch { /* closed */ } } if (scenario) { scenario.cleanup(); scenario = null; } });

/** One production-composed controller over a fresh scenario. mode = reviewer script mode. */
async function setup({ mode = "findings-then-clean", maxCorrections = 3, hermes = new FakeHermes(), clock = null } = {}) {
  scenario = await createGitHubScenario();
  const s = scenario;
  const gates = join(s.ws.dir, "gates");
  const config = () => ({
    profile: "production", workspaceDir: join(s.ws.dir, "prod-state"), workspaceId: "ws-cp10", documentId: DOC, planSource: { file: s.ws.planFile },
    jira: {
      mode: "classic", site: `127.0.0.1:${s.mock.port}`, scheme: "http", projectKey: "LOOP", issueTypeName: "Task", taskIdPattern: "^TASK-\\d+$",
      observation: { source: "search" }, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP, completion: { doneStatusName: "Done", transitionName: "Done" }, timeoutMs: 10000,
    },
    repository: { identity: "fake-owner/fake-repo", baseRef: "main" }, git: { repoPath: s.repo.path },
    github: { owner: "fake-owner", repo: "fake-repo", baseBranch: "main", workflowIdentity: ".github/workflows/validate.yml", maxCorrections },
    agent: { kind: "hermes", command: "git", board: "cp10-board", coderAssignee: "coder" },
    validation: { command: process.execPath, args: [GATES, "validate", gates] },
    review: { command: process.execPath, args: [GATES, "review", gates, mode] },
    timings: { instanceLeaseTtlMs: 600000, defaultWaitMs: 200 }, heartbeatWorker: false,
  });
  const build = () => { const b = buildProductionController(config(), ENV, { hermesRun: hermes.run, ghRun: s.fake.run, ...(clock ? { clock: clock.clock } : {}) }); built.push(b); return b; };
  const logs = (name) => (existsSync(join(gates, `${name}.jsonl`)) ? readFileSync(join(gates, `${name}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
  return { s, hermes, build, logs, gates, clock };
}

/** Drives cycle() until a stop outcome. A stepping clock (if any) is advanced on every waiting outcome. */
async function drive(b, { clock = null, maxCycles = 400, started = false } = {}) {
  if (!started) { const start = await b.controller.start(); assert.equal(start.owner, true); }
  const results = [];
  for (let i = 0; i < maxCycles; i += 1) {
    const r = await b.controller.cycle();
    results.push(r);
    if (STOPS.has(r.outcome)) return { last: r, results };
    if (clock && ["WAIT_CI", "WAIT_REVIEW", "WAIT_JIRA", "WAIT_SOURCE", "RETRY_EXTERNAL", "IDLE"].includes(r.outcome)) clock.advance(5000);
  }
  throw new Error(`no stop outcome in ${maxCycles} cycles; last=${JSON.stringify(results.at(-1))}`);
}

/** All durable execution evidence text for the (single) execution, for asserting WHY the loop stopped. */
function evidenceText(s, b) {
  const a = attemptOf(b); const dir = join(s.ws.dir, "prod-state", "executions", a.executionId);
  return readdirSync(dir, { recursive: true }).filter((f) => /[.](jsonl|json|md)$/.test(f)).map((f) => readFileSync(join(dir, f), "utf8")).join("\n");
}
const attemptOf = (b) => { const store = b.stores.attemptStore; const row = store.db.prepare("SELECT execution_id FROM execution_attempts").get(); return store.get(row.execution_id); };
/** The protocol sequence of one finished run with every SHA/id normalized, for the determinism comparison. */
function sequenceOf({ s, hermes, b, logs, results, last }) {
  const a = attemptOf(b); const h1 = a.agentResult.head; const h2 = mergedHead(s);
  const norm = (head) => (head === h1 ? "H1" : head === h2 ? "H2" : "MERGE");
  return {
    outcome: last.outcome,
    hermes: hermes.created.map((t) => t.key.replace(a.executionId, "EXEC").replace(h1.slice(0, 12), "H1")),
    reviews: logs("reviews").filter((r) => r.kind === "implementation").map((r) => norm(r.head)),
    validations: logs("validations").map((v) => norm(v.head)),
    phases: results.map((r) => `${r.phase}:${r.outcome}`),
  };
}
let firstSequence = null;
const mergedHead = (s) => s.fake.prs()[0]?.mergedHeadSha ?? null;
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const commitsAbove = (cwd, from, to) => git(cwd, ["rev-list", "--count", `${from}..${to}`]);
const correctionTasks = (hermes) => hermes.created.filter((t) => /-correct-/.test(t.key));
const execTasks = (hermes) => hermes.created.filter((t) => /-execute$/.test(t.key));

test("LIVE-PROOF-A shape (clean path) + 12 (secrets): Jira task -> production controller -> Hermes -> branch -> PR -> validation -> independent CLEAN review -> merge -> post-merge -> Jira done; no duplicate writes, no secrets", async () => {
  const { s, hermes, build, logs } = await setup({ mode: "clean" });
  const b = build();
  const { last, results } = await drive(b);
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));
  const a = attemptOf(b);
  assert.equal(execTasks(hermes).length, 1, "Hermes implemented once");
  assert.equal(correctionTasks(hermes).length, 0, "no correction was needed");
  assert.equal(a.agentResult.authorId, HERMES_SIM_IDENTITY, "the implementer's identity comes from Git");
  const h1 = a.agentResult.head;
  assert.equal(mergedHead(s), h1, "the reviewed, validated head is the merged head");
  assert.deepEqual(logs("reviews").filter((r) => r.kind === "implementation").map((r) => r.head), [h1]);
  b.stores.gateStore.db.prepare("SELECT 1").get();
  assert.equal(b.stores.gateStore.getReview(a.executionId, h1).verdict, "CLEAN");
  assert.equal(b.stores.gateStore.getReview(a.executionId, h1).reviewerId, "cp10-reviewer@example.invalid");
  assert.equal(b.stores.gateStore.postMergeValidated(a.executionId, "TASK-001"), true);
  assert.deepEqual(s.fake.prs().length, 1, "one pull request");
  assert.deepEqual(b.stores.controllerStore.list().map((r) => [r.taskId, r.status]), [["TASK-001", "REMOTE_DONE_CONFIRMED"]]);
  assert.equal(await s.mock.posts(/\/rest\/api\/3\/issue$/), 1, "exactly one Jira issue was created");
  assert.equal(await s.mock.posts(/\/transitions$/), 1, "exactly one completion transition");
  // 12. no Jira credential reaches the agent, the reviewer, the validator or any controller output
  const everything = JSON.stringify({ bodies: hermes.bodies, argv: hermes.argv, reviews: logs("reviews"), validations: logs("validations"), results });
  assert.ok(!everything.includes(SECRET), "the Jira token appears nowhere a child process or agent could see it");
  assert.ok(!everything.includes(ENV.LOOP_JIRA_EMAIL));
  for (const entry of [...logs("reviews"), ...logs("validations")]) assert.ok(!entry.envNames.some((n) => /^LOOP_JIRA_|TOKEN|SECRET|PASSWORD/i.test(n)), "the child environment is clean");
  assert.ok(b.agent instanceof HermesAgentExecutor);
});

test("LIVE-PROOF-B shape + 1/2/3/4/5/6 (finding -> correction -> new HEAD -> revalidation -> re-review -> CLEAN -> merge): the old review never authorizes the new head", async () => {
  const { s, hermes, build, logs } = await setup({ mode: "findings-then-clean" });
  const b = build();
  const { last, results } = await drive(b);
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));
  const a = attemptOf(b);
  const h1 = a.agentResult.head; const h2 = mergedHead(s);
  firstSequence = sequenceOf({ s, hermes, b, logs, results, last });
  assert.notEqual(h1, h2, "the merged head is the corrected commit (1/2)");
  assert.equal(commitsAbove(a.workspacePath, h1, h2), "1", "exactly one correction commit on top of H1, history not rewritten (2)");
  // 1. FINDINGS triggered a correction, delivered to the SAME agent with the finding text and the reviewed head
  const [correction] = correctionTasks(hermes);
  assert.equal(correctionTasks(hermes).length, 1);
  assert.match(correction.key, new RegExp(`^loop-${a.executionId}-correct-1-${h1.slice(0, 12)}$`), "the key is bound to the round (the count of FINDINGS reviews so far) and the reviewed head");
  const body = hermes.bodies.at(-1);
  assert.match(body, /F-1: no test covers the new behaviour/);
  assert.ok(body.includes(h1) && body.includes(a.branch) && body.includes(a.workspacePath), "the correction targets the same branch/worktree");
  // 3. stale evidence: H1's FINDINGS stay bound to H1; H2 has its own review; the merge used H2's CLEAN only
  const gate = b.stores.gateStore;
  assert.equal(gate.getReview(a.executionId, h1).verdict, "FINDINGS");
  assert.equal(gate.getReview(a.executionId, h2).verdict, "CLEAN");
  assert.notEqual(gate.getReview(a.executionId, h1).head, gate.getReview(a.executionId, h2).head);
  assert.equal(gate.getValidation(a.executionId, "TASK-001", h1).result, "PASS");
  assert.equal(gate.getValidation(a.executionId, "TASK-001", h2).result, "PASS");
  // 4. + 5. validation and review both reran on the NEW exact head, in order
  assert.deepEqual(logs("validations").map((v) => v.head).slice(0, 2), [h1, h2], "validation ran for H1 then again for H2 (4)");
  assert.deepEqual(logs("reviews").filter((r) => r.kind === "implementation").map((r) => r.head), [h1, h2], "the independent reviewer ran for H1 then again for H2 (5)");
  // 6. CLEAN closes the loop: nothing further is asked of Hermes, one PR followed the branch, one squash merge
  assert.equal(hermes.created.length, 2, "one execute task + one correction task, never more (6)");
  assert.equal(s.fake.prs().length, 1);
  assert.equal(s.mainCommits(), 2);
  assert.equal(gate.findingsCount(a.executionId), 1);
  assert.equal(gate.postMergeValidated(a.executionId, "TASK-001"), true);
  assert.equal(s.fake.branchHead(a.branch), h2, "the remote branch carries the corrected head");
  assert.deepEqual(b.stores.controllerStore.list().map((r) => [r.taskId, r.status]), [["TASK-001", "REMOTE_DONE_CONFIRMED"]]);
});

test("7. bounded correction: persistent FINDINGS stop at the configured bound with OWNER_DECISION_REQUIRED; nothing is merged and no further Hermes task is created", async () => {
  const { s, hermes, build, logs } = await setup({ mode: "always-findings", maxCorrections: 2 });
  const b = build();
  const { last } = await drive(b);
  assert.equal(last.outcome, "OWNER_DECISION_REQUIRED", JSON.stringify(last));
  assert.equal(correctionTasks(hermes).length, 2, "exactly maxCorrections correction rounds, then fail closed");
  assert.equal(logs("reviews").filter((r) => r.kind === "implementation").length, 3, "the third FINDINGS review ended the loop");
  assert.equal(mergedHead(s), null, "nothing was merged");
  assert.equal(s.mainCommits(), 1, "main was not changed");
  // a further cycle changes nothing: the stop is stable, not an endless loop
  const before = hermes.created.length;
  for (let i = 0; i < 5; i += 1) assert.equal((await b.controller.cycle()).outcome, "OWNER_DECISION_REQUIRED");
  assert.equal(hermes.created.length, before);
});

test("8. a finding that genuinely needs the owner stops with OWNER_DECISION_REQUIRED at once: no correction round, no merge", async () => {
  const { s, hermes, build } = await setup({ mode: "owner-decision" });
  const b = build();
  const { last } = await drive(b);
  assert.equal(last.outcome, "OWNER_DECISION_REQUIRED", JSON.stringify(last));
  assert.match(String(last.detail), /BLOCKED_OWNER/);
  assert.match(evidenceText(s, b), /review finding needs an owner decision: F-OWNER/, "the durable evidence records why the loop stopped");
  assert.equal(correctionTasks(hermes).length, 0, "an owner-decision finding is never sent back to the implementer");
  assert.equal(mergedHead(s), null);
  const a = attemptOf(b);
  assert.equal(b.stores.gateStore.getFindings(a.executionId, a.agentResult.head)[0].ownerDecision, true, "the finding's class is durable");
});

test("9. implementer and reviewer must be independent: a review by the implementation author's own identity is never recorded or accepted", async () => {
  const { s, hermes, build } = await setup({ mode: "same-as-author" });
  const b = build();
  const { last } = await drive(b);
  assert.equal(last.outcome, "OWNER_DECISION_REQUIRED", JSON.stringify(last));
  assert.match(String(last.detail), /BLOCKED_OWNER/);
  assert.match(evidenceText(s, b), /is not independent of the implementation author/, "the durable evidence records why the loop stopped");
  const a = attemptOf(b);
  assert.equal(b.stores.gateStore.getReview(a.executionId, a.agentResult.head), null, "no evidence was recorded from a non-independent review");
  assert.equal(mergedHead(s), null);
  assert.equal(correctionTasks(hermes).length, 0);
});

test("10a. crash/restart BEFORE the correction worked: a new controller re-attaches to the SAME Hermes task; one correction commit, one task", async () => {
  const clock = steppingClock();
  const hermes = new FakeHermes({ failures: [{ key: /-correct-/, when: "before" }] });
  const { s, build, logs } = await setup({ mode: "findings-then-clean", hermes, clock });
  const first = build();
  await first.controller.start();
  let waiting = null;
  for (let i = 0; i < 200 && !waiting; i += 1) {
    const r = await first.controller.cycle();
    if (hermes.failures[0].times === 0) waiting = r; // the correction's first poll failed: the controller "died" here
    else if (STOPS.has(r.outcome)) throw new Error(`stopped early: ${JSON.stringify(r)}`);
    if (!waiting) clock.advance(5000);
  }
  assert.ok(waiting, "the injected failure fired during the correction");
  const a = attemptOf(first);
  const h1 = a.agentResult.head;
  assert.equal(git(a.workspacePath, ["rev-parse", "HEAD"]), h1, "the crash happened before any correction commit");
  await first.controller.stop(); first.close();
  // restart: a brand-new controller over the same durable state
  const second = build();
  const { last } = await drive(second, { clock });
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));
  assert.equal(correctionTasks(hermes).length, 1, "the restarted controller did not create a second correction task");
  assert.ok(hermes.deduped >= 1, "it re-attached to the existing task through the idempotency key");
  const h2 = mergedHead(s);
  assert.equal(commitsAbove(a.workspacePath, h1, h2), "1", "exactly one correction commit");
  assert.deepEqual(logs("reviews").filter((r) => r.kind === "implementation").map((r) => r.head), [h1, h2]);
  assert.equal(s.fake.prs().length, 1);
});

test("10b. crash/restart AFTER the correction committed (response lost): the restarted controller reviews the new head and does not ask Hermes again", async () => {
  const clock = steppingClock();
  const hermes = new FakeHermes({ failures: [{ key: /-correct-/, when: "after" }] });
  const { s, build, logs } = await setup({ mode: "findings-then-clean", hermes, clock });
  const first = build();
  await first.controller.start();
  for (let i = 0; i < 200 && hermes.failures[0].times > 0; i += 1) { const r = await first.controller.cycle(); if (STOPS.has(r.outcome)) throw new Error(JSON.stringify(r)); clock.advance(5000); }
  assert.equal(hermes.failures[0].times, 0, "the injected failure fired after the worker committed");
  const a = attemptOf(first);
  const h1 = a.agentResult.head;
  const h2 = git(a.workspacePath, ["rev-parse", "HEAD"]);
  assert.notEqual(h1, h2, "the correction commit exists in Git even though the controller never saw the result");
  await first.controller.stop(); first.close();
  const second = build();
  const { last } = await drive(second, { clock });
  assert.equal(last.outcome, "COMPLETED", JSON.stringify(last));
  assert.equal(correctionTasks(hermes).length, 1, "Hermes was not asked a second time");
  assert.equal(mergedHead(s), h2);
  assert.equal(commitsAbove(a.workspacePath, h1, h2), "1");
  assert.deepEqual(logs("reviews").filter((r) => r.kind === "implementation").map((r) => r.head), [h1, h2]);
});

test("11. the production composition is deterministic: the same scenario run again yields the identical protocol sequence", async () => {
  assert.ok(firstSequence, "the findings-path test ran first and recorded its sequence");
  const { s, hermes, build, logs } = await setup({ mode: "findings-then-clean" });
  const b = build();
  const { last, results } = await drive(b);
  const second = sequenceOf({ s, hermes, b, logs, results, last });
  assert.deepEqual(second, firstSequence);
  assert.equal(second.outcome, "COMPLETED");
  assert.deepEqual(second.reviews, ["H1", "H2"]);
});
