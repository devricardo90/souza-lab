import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { TWO_TASKS, inProcessController, startMock, workspace } from "./helpers/controller-harness.js";
import { FakeNotifier } from "../src/controller/ports.js";

/** Persistent-source-failure alert state must survive Controller restarts (streak lives in controller SQLite). */
let mock; let ws; let flag; const notifiers = [];
before(async () => { mock = await startMock(); });
after(() => { mock.stop(); if (ws) ws.cleanup(); });
beforeEach(async () => { if (ws) ws.cleanup(); await mock.reset(); ws = workspace(); flag = join(ws.dir, "google-down.flag"); notifiers.length = 0; });

/** One "process": a fresh Controller over the same durable workspace; runs exactly one cycle, then stops (lease released). */
async function oneCycleProcess() {
  const notifier = new FakeNotifier();
  notifiers.push(notifier);
  const h = inProcessController({ ws, port: mock.port, overrides: { notifier }, configExtra: { unavailableFile: flag } });
  try {
    await h.controller.start();
    const result = await h.controller.cycle();
    return { result, state: h.stores.controllerStore.sourceFailureState("doc-controller-1") };
  } finally { await h.controller.stop(); h.close(); }
}
const alerts = () => notifiers.flatMap((n) => n.events).filter((e) => e.kind === "PERSISTENT_SOURCE_FAILURE");
const down = () => writeFileSync(flag, "down");
const up = () => rmSync(flag, { force: true });

test("failure #1, restart, failure #2, restart, failure #3 -> exactly one persistent-source alert; a normal transient failure alerts nothing", async () => {
  // no plan file at all: Google unavailable and no snapshot (WAIT_SOURCE), still counted as a source failure
  const a = await oneCycleProcess();
  assert.deepEqual([a.result.outcome, a.state.consecutive, alerts().length], ["WAIT_SOURCE", 1, 0], "one transient failure is not an alert");
  const b = await oneCycleProcess();
  assert.deepEqual([b.state.consecutive, alerts().length], [2, 0], "the streak survived the restart");
  const c = await oneCycleProcess();
  assert.deepEqual([c.state.consecutive, c.state.alerted, alerts().length], [3, true, 1], "the third failure alerts");
  const d = await oneCycleProcess();
  assert.deepEqual([d.state.consecutive, alerts().length], [4, 1], "no duplicate alert after another restart");
  const e = await oneCycleProcess();
  assert.equal(alerts().length, 1);
  assert.equal(e.state.consecutive, 5);
});

test("a successful refresh resets the persisted streak; a later streak alerts again exactly once", async () => {
  ws.setPlan(TWO_TASKS());
  const ok = await oneCycleProcess(); // success: nothing to reset yet
  assert.equal(ok.state, null);
  down();
  assert.equal((await oneCycleProcess()).state.consecutive, 1);
  assert.equal((await oneCycleProcess()).state.consecutive, 2);
  up();
  const recovered = await oneCycleProcess(); // success ends the streak
  assert.deepEqual([recovered.state.consecutive, recovered.state.alerted, recovered.state.streakId], [0, false, 2]);
  assert.equal(alerts().length, 0, "two failures then recovery never alerted");
  down();
  await oneCycleProcess(); await oneCycleProcess();
  assert.equal(alerts().length, 0, "the streak restarted from zero");
  const third = await oneCycleProcess();
  assert.deepEqual([third.state.consecutive, third.state.streakId, alerts().length], [3, 2, 1], "the new streak alerts once");
  assert.notEqual(alerts()[0].dedupeKey, undefined);
  await oneCycleProcess();
  assert.equal(alerts().length, 1);
});
