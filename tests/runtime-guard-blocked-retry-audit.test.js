import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import { RuntimeObserver } from "../src/core/runtime-observer.js";
import { createGitHubScenario } from "./helpers/github-scenario.js";

/**
 * CP-07 closure, audit D (BLOCKED -> retry core limitation). REPRODUCTION ONLY: no core code is changed.
 *
 * Mechanism, reproduced deterministically with the real Controller + LoopRuntime + real Git + fake `gh`:
 *   1. a TRANSIENT provider failure is injected into exactly the pre-execution (guard) observation of a cycle;
 *   2. the RecoveryCoordinator then returns a PARTIAL fact set (later facts stay null), so the facts fingerprint differs
 *      from the planned one and the runtime records a BLOCKED "runtime-precondition-guard" ACTION_RESULT;
 *   3. BLOCKED is not counted by attemptFor() (only FAILED/WAITING are), so the next cycle plans the SAME actionId, and the
 *      event id `<actionId>:result` already holds the BLOCKED event => the second result differs => EVIDENCE_EVENT_CONFLICT.
 * The Controller turns that runtime error into a blocked task instead of crashing.
 */
let s; let handle; let restore;
beforeEach(async () => { s = await createGitHubScenario(); });
afterEach(() => { restore?.(); restore = null; if (handle) { try { handle.close(); } catch {} handle = null; } s.cleanup(); });

function injectGuardObservationFailures(h, count) {
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
      if (armed) { injected += 1; armed = false; throw Object.assign(new Error("injected transient provider failure"), { classification: "TRANSIENT", retryable: true, code: "GITHUB_CI_TIMEOUT" }); }
      return ci(head);
    };
    return scope;
  };
  return () => injected;
}

async function cyclesUntil(h, predicate, max = 80) {
  const results = [];
  for (let i = 0; i < max; i += 1) {
    const r = await h.controller.cycle();
    results.push(r);
    if (predicate(r)) break;
  }
  return results;
}

test("AUDIT D: a transient provider failure at the guard observation produces BLOCKED guard evidence, and the same-fingerprint retry hits EVIDENCE_EVENT_CONFLICT (controller blocks the task, no crash)", async () => {
  handle = s.inProcess();
  await handle.controller.start();
  const injected = injectGuardObservationFailures(handle, 2);
  const results = await cyclesUntil(handle, (r) => r.outcome === "BLOCK_TASK" || r.outcome === "COMPLETED");
  const last = results.at(-1);
  assert.ok(injected() >= 1, "the transient failure was injected into a guard observation");
  assert.equal(last.outcome, "BLOCK_TASK", JSON.stringify(last));
  assert.equal(last.code, "EVIDENCE_EVENT_CONFLICT");
});

test("AUDIT D (single flap): ONE transient failure at the guard observation is also fatal for that action id, because the BLOCKED result event already owns `<actionId>:result`", async () => {
  handle = s.inProcess();
  await handle.controller.start();
  const injected = injectGuardObservationFailures(handle, 1);
  const results = await cyclesUntil(handle, (r) => r.outcome === "BLOCK_TASK" || r.outcome === "COMPLETED");
  assert.equal(injected(), 1);
  const last = results.at(-1);
  // Recorded outcome of the audit (see CP-07 closure report): the retry cannot reuse the action id.
  assert.deepEqual({ outcome: last.outcome, code: last.code }, { outcome: "BLOCK_TASK", code: "EVIDENCE_EVENT_CONFLICT" });
});
