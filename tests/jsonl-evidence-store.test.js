import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EvidenceStoreError, JsonlEvidenceStore } from "../src/adapters/jsonl-evidence-store.js";

function withStore(run) {
  const root = mkdtempSync(join(tmpdir(), "loop-evidence-"));
  try { run(join(root, "events", "evidence.jsonl")); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

function event(eventId, taskId, payload = {}) {
  return { eventId, eventType: "STATE_COMPUTED", occurredAt: "2026-09-27T12:00:00.000Z", taskId, revisionHead: "abcdef0", payload };
}

test("evidence events append in sequence and can be read by task", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    const first = store.append(event("e-1", "TASK-001", { state: "REVIEWING" }));
    const second = store.append(event("e-2", "TASK-002", { state: "TESTING" }));
    assert.equal(first.sequence, 1);
    assert.equal(second.sequence, 2);
    assert.equal(second.previousHash, first.hash);
    assert.deepEqual(store.listByTask("TASK-001").map(({ eventId }) => eventId), ["e-1"]);
    assert.deepEqual(store.listAll().map(({ eventId }) => eventId), ["e-1", "e-2"]);
    assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 2);
  });
});

test("store rejects duplicate ids and exposes no update/delete operation", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    store.append(event("e-1", "TASK-001"));
    assert.throws(() => store.append(event("e-1", "TASK-001")), (error) => error instanceof EvidenceStoreError && error.code === "DUPLICATE_EVENT");
    assert.equal("update" in store, false);
    assert.equal("delete" in store, false);
    assert.throws(() => store.listByTask(" "), /requires a task id/);
  });
});

test("store fails closed on invalid, truncated, reordered, or altered history", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    store.append(event("e-1", "TASK-001", { state: "REVIEWING" }));
    store.append(event("e-2", "TASK-001", { state: "DONE" }));
    const original = readFileSync(path, "utf8");

    const lines = original.trimEnd().split("\n");
    const changed = JSON.parse(lines[0]);
    changed.event.payload.state = "DONE";
    writeFileSync(path, `${JSON.stringify(changed)}\n${lines[1]}\n`);
    assert.throws(() => store.listAll(), (error) => error instanceof EvidenceStoreError && error.code === "HASH_CHAIN_MISMATCH");

    writeFileSync(path, `${lines[1]}\n${lines[0]}\n`);
    assert.throws(() => store.listAll(), (error) => error instanceof EvidenceStoreError && error.code === "INVALID_SEQUENCE");

    writeFileSync(path, `${lines[0]}\nnot-json\n`);
    assert.throws(() => store.listAll(), /invalid JSON/);

    writeFileSync(path, `${lines[0]}\n`);
    assert.throws(() => store.append(event("e-1", "TASK-001")), /duplicate event id/);
  });
});
