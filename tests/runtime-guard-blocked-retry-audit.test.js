import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { RuntimeObserver } from "../src/core/runtime-observer.js";
import { createGitHubScenario } from "./helpers/github-scenario.js";

/**
 * Core retry-identity fix (owner-approved after the CP-07 audit). Real Controller + LoopRuntime + real local Git + real
 * GitHubSCMProvider/GitHubCIProvider against the fake `gh api` backend; ZERO model calls.
 *
 * Mechanism (previously: EVIDENCE_EVENT_CONFLICT): a provider failure inside exactly the pre-execution (guard) observation of a
 * cycle makes the RecoveryCoordinator return PARTIAL facts, so the guard persists a BLOCKED `runtime-precondition-guard` result.
 *   - RETRYABLE provider failure => the BLOCKED result is recorded TRANSIENT/retryable and COUNTS as a consumed attempt, so the
 *     replan gets attempt+1, a new action id and a new `<actionId>:result` event id (the old event is never touched).
 *   - any other BLOCKED result (permanent provider failure, changed reliable facts, ...) stays terminal and is NOT counted.
 */
let s; let handle; let restore;
beforeEach(async () => { s = await createGitHubScenario(); });
afterEach(() => { restore?.(); restore = null; if (handle) { try { handle.close(); } catch {} handle = null; } s.cleanup(); });

/** Injects `count` consecutive provider failures into the guard observation of consecutive cycles. */
function injectGuardObservationFailures(h, count, { retryable = true } = {}) {
  const original = RuntimeObserver.prototype.observe;
  const perCycle = new Map(); let injected = 0; let armed = false;
  RuntimeObserver.prototype.observe = function patched(args) {
    const n = (perCycle.get(args.cycleId) ?? 0) + 1;
    perCycle.set(args.cycleId, n);
    armed = n === 2 && injected < count && /:cycle:/.test(args.cycleId);
    try { return original.call(this, args); } finally { armed = false; }
  };
  restore = () => { RuntimeObserver.prototype.observe = original; };
  const originalScope = h.lifecycle.scope.bind(h.lifecycle);
  h.lifecycle.scope = (wp) => {
    const scope = originalScope(wp);
    const ci = scope.ciProvider.getCIResult.bind(scope.ciProvider);
    scope.ciProvider.getCIResult = (head) => {
      if (armed) {
        injected += 1; armed = false;
        throw Object.assign(new Error(retryable ? "injected transient provider failure" : "injected permanent provider failure"), retryable
          ? { classification: "TRANSIENT", retryable: true, code: "GITHUB_CI_TIMEOUT" }
          : { classification: "EXTERNAL_BLOCK", retryable: false, code: "GITHUB_CI_REQUEST_FAILED" });
      }
      return ci(head);
    };
    return scope;
  };
  return () => injected;
}

async function cyclesUntil(h, predicate, max = 120) {
  const results = [];
  for (let i = 0; i < max; i += 1) {
    const r = await h.controller.cycle();
    results.push(r);
    if (predicate(r)) break;
  }
  return results;
}
const finished = (r) => r.outcome === "BLOCK_TASK" || r.outcome === "COMPLETED";

function evidence() {
  const root = join(s.ws.dir, "executions");
  const events = [];
  for (const dir of existsSync(root) ? readdirSync(root) : []) {
    const file = join(root, dir, "evidence.jsonl");
    if (existsSync(file)) for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) events.push(JSON.parse(line).event);
  }
  return events;
}
const results = () => evidence().filter((e) => e.eventType === "ACTION_RESULT");
const guardAborts = () => results().filter((e) => e.payload.provider === "runtime-precondition-guard");
const byLogicalAction = (list) => list.reduce((m, e) => m.set(e.payload.inputFingerprint, [...(m.get(e.payload.inputFingerprint) ?? []), e]), new Map());

function assertImmutableUniqueEvidence(aborts) {
  const ids = evidence().map((e) => e.eventId);
  assert.equal(new Set(ids).size, ids.length, "every evidence event id is unique (nothing was overwritten or duplicated)");
  assert.equal(new Set(aborts.map((e) => e.payload.actionId)).size, aborts.length, "every aborted attempt has its own action id");
  assert.equal(new Set(aborts.map((e) => e.eventId)).size, aborts.length, "every aborted attempt has its own result event id");
  for (const e of aborts) assert.equal(e.eventId, `${e.payload.actionId}:result`);
}

test("SINGLE FLAP: one transient failure at the guard is a retryable BLOCKED result; the replan gets attempt 2 / a new action id and the lifecycle completes with no conflict", async () => {
  handle = s.inProcess();
  await handle.controller.start();
  const injected = injectGuardObservationFailures(handle, 1);
  const run = await cyclesUntil(handle, finished);
  assert.equal(injected(), 1);
  assert.equal(run.at(-1).outcome, "COMPLETED", JSON.stringify(run.at(-1)));
  assert.ok(!run.some((r) => r.code === "EVIDENCE_EVENT_CONFLICT" || r.outcome === "BLOCK_TASK"));

  const aborts = guardAborts();
  assert.equal(aborts.length, 1);
  const [aborted] = aborts;
  assert.equal(aborted.payload.result, "BLOCKED");
  assert.equal(aborted.payload.retryable, true);
  assert.equal(aborted.payload.errorClass, "TRANSIENT");
  assert.equal(aborted.payload.attempt, 1);
  // same logical action, next attempt, independently evidenced and SUCCEEDED
  const sameAction = byLogicalAction(results()).get(aborted.payload.inputFingerprint);
  assert.deepEqual(sameAction.map((e) => [e.payload.attempt, e.payload.result]), [[1, "BLOCKED"], [2, "SUCCEEDED"]]);
  assert.notEqual(sameAction[0].eventId, sameAction[1].eventId);
  assertImmutableUniqueEvidence(aborts);
  // no duplicate external side effect
  assert.equal(s.fake.prs().length, 1);
  assert.equal(handle.agent.calls.length, 1);
  assert.equal(s.mainCommits(), 2);
  assert.equal(handle.agent.modelCalls, 0);
});

test("MULTIPLE FLAPS: attempts 1, 2 and 3 are retryable BLOCKED, attempt 4 succeeds; every attempt has a unique deterministic action/result identity", async () => {
  handle = s.inProcess();
  await handle.controller.start();
  const injected = injectGuardObservationFailures(handle, 3);
  const run = await cyclesUntil(handle, finished);
  assert.equal(injected(), 3);
  assert.equal(run.at(-1).outcome, "COMPLETED", JSON.stringify(run.at(-1)));

  const aborts = guardAborts();
  assert.equal(aborts.length, 3);
  const sameAction = byLogicalAction(results()).get(aborts[0].payload.inputFingerprint);
  assert.deepEqual(sameAction.map((e) => [e.payload.attempt, e.payload.result]), [[1, "BLOCKED"], [2, "BLOCKED"], [3, "BLOCKED"], [4, "SUCCEEDED"]]);
  assert.equal(new Set(sameAction.map((e) => e.payload.actionId)).size, 4);
  assertImmutableUniqueEvidence(aborts);
  assert.equal(s.fake.prs().length, 1, "no duplicate change object");
  assert.equal(handle.agent.calls.length, 1, "no duplicate agent execution");
  assert.equal(s.mainCommits(), 2, "exactly one merge");
});

test("TERMINAL BLOCKED stays terminal: a PERMANENT provider failure at the guard is not a consumed attempt, is never silently retried, and the task stays blocked", async () => {
  handle = s.inProcess();
  await handle.controller.start();
  const injected = injectGuardObservationFailures(handle, 1000, { retryable: false });
  const run = await cyclesUntil(handle, finished, 40);
  assert.ok(injected() >= 1);
  const last = run.at(-1);
  assert.equal(last.outcome, "BLOCK_TASK", JSON.stringify(last));

  const aborts = guardAborts();
  assert.ok(aborts.length >= 1);
  for (const e of aborts) {
    assert.equal(e.payload.errorClass, "INVARIANT_VIOLATION");
    assert.equal(e.payload.retryable, false);
    assert.equal(e.payload.attempt, 1, "no attempt inflation: terminal guard aborts are not counted");
  }
  assert.equal(Math.max(...results().map((e) => e.payload.attempt)), 1, "no attempt number above 1 was ever issued");
  assert.deepEqual(s.controllerRows().map((r) => r[1]), ["BLOCKED"]);
});

test("RESTART: a persisted retryable guard BLOCKED survives a Controller restart; the next attempt is attempt 2 with a new id, nothing collides, nothing is lost", async () => {
  handle = s.inProcess();
  await handle.controller.start();
  const injected = injectGuardObservationFailures(handle, 1);
  await cyclesUntil(handle, () => guardAborts().length >= 1, 60);
  assert.equal(injected(), 1);
  assert.equal(guardAborts().length, 1);
  const beforeIds = evidence().map((e) => e.eventId);

  // terminate the Controller (all in-memory state is lost) and restart it on the same durable stores
  restore(); restore = null;
  await handle.controller.stop().catch(() => {});
  handle.close(); handle = null;
  handle = s.inProcess();
  await handle.controller.start();
  const run = await cyclesUntil(handle, finished);
  assert.equal(run.at(-1).outcome, "COMPLETED", JSON.stringify(run.at(-1)));

  const after = evidence();
  for (const id of beforeIds) assert.ok(after.some((e) => e.eventId === id), `pre-restart evidence ${id} is preserved`);
  const aborts = guardAborts();
  assert.equal(aborts.length, 1, "no further abort after restart");
  const sameAction = byLogicalAction(results()).get(aborts[0].payload.inputFingerprint);
  assert.deepEqual(sameAction.map((e) => [e.payload.attempt, e.payload.result]), [[1, "BLOCKED"], [2, "SUCCEEDED"]]);
  assertImmutableUniqueEvidence(aborts);
  assert.equal(s.fake.prs().length, 1);
  assert.equal(s.mainCommits(), 2);
});
