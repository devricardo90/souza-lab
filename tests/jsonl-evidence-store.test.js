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

test("F01 — modifying historical evidence content invalidates the chain", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    store.append(event("f01-e1", "TASK-001", { verdict: "REVIEWING" }));
    store.append(event("f01-e2", "TASK-001", { verdict: "DONE" }));
    const records = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    records[0].event.payload.verdict = "DONE";
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    assert.throws(() => store.listAll(), (error) => error.code === "HASH_CHAIN_MISMATCH");
    assert.throws(() => store.getById("f01-e1"), (error) => error.code === "HASH_CHAIN_MISMATCH");
  });
});

test("F02 — presenting E1, E3, E2 is rejected as reordered history", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    for (const id of ["f02-e1", "f02-e2", "f02-e3"]) store.append(event(id, "TASK-001"));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, `${lines[0]}\n${lines[2]}\n${lines[1]}\n`);
    assert.throws(() => store.listAll(), (error) => error.code === "INVALID_SEQUENCE");
    assert.throws(() => store.getById("f02-e1"), (error) => error.code === "INVALID_SEQUENCE");
  });
});

test("F03 — removing a valid final event is not detectable without an external checkpoint", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    for (const id of ["f03-e1", "f03-e2", "f03-e3", "f03-e4"]) store.append(event(id, "TASK-001"));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    writeFileSync(path, `${lines.slice(0, 3).join("\n")}\n`);
    assert.deepEqual(store.listAll().map(({ eventId }) => eventId), ["f03-e1", "f03-e2", "f03-e3"]);
  });
});

test("F04 — duplicate event IDs are rejected without overwriting prior evidence", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    store.append(event("f04-duplicate", "TASK-001", { value: 1 }));
    assert.throws(() => store.append(event("f04-duplicate", "TASK-001", { value: 2 })), (error) => error.code === "DUPLICATE_EVENT");
    assert.equal(store.listAll()[0].payload.value, 1);
  });
});

test("F05 — sequence gap 1, 2, 4 is rejected", () => {
  withStore((path) => {
    const store = new JsonlEvidenceStore({ path });
    for (const id of ["f05-e1", "f05-e2", "f05-e3"]) store.append(event(id, "TASK-001"));
    const records = readFileSync(path, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
    records[2].sequence = 4;
    writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
    assert.throws(() => store.listAll(), (error) => error.code === "INVALID_SEQUENCE");
  });
});
