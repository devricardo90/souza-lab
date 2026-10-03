import assert from "node:assert/strict";
import test from "node:test";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { encodeLoopDescription } from "../src/reconcile/jira-adf.js";

/** CP-08 corrective link removal: guarded, exact, and never deletes an issue. Offline stub: SYNTHETIC evidence. */
const facts = (body, httpStatus = 200) => ({ httpStatus, body: body === null ? "" : JSON.stringify(body), headers: {}, requestId: "r", transportError: null });
const owned = (taskId) => encodeLoopDescription({ taskId, sourceDocumentId: "d", planVersion: 1, snapshotContentHash: "h", taskHash: "t", acceptanceCriteria: [{ id: "AC-001", text: "x" }] });
const guard = { projectKey: "LOOP", taskIdPattern: /^CP08[A-Z0-9]*-\d+$/ };
const lease = { assertLeaseCurrent: async () => {} };

function fixture(links2) {
  const calls = [];
  const transport = (r) => {
    calls.push(`${r.method ?? "GET"} ${r.path}`);
    if (r.method === "DELETE") return facts(null, 204);
    const m = /^issue\/([^?]+)\?fields=(.*)$/.exec(r.path);
    if (m) {
      const key = m[1];
      const fields = { project: { key: key.startsWith("RCC") ? "RCC" : "LOOP" }, description: owned(`CP08ABC-${key.split("-")[1]}`), issuelinks: key === "LOOP-2" ? links2 : [] };
      return facts({ key, fields });
    }
    return facts({}, 404);
  };
  return { calls, client: new JiraSyncClient({ mode: "scoped", cloudId: "11111111-2222-3333-4444-555555555555", email: "a@example.invalid", apiToken: "token-0123456789-abcdefghij", transport, writeGuard: guard }) };
}
const reversed = [{ id: "10001", type: { name: "Blocks" }, outwardIssue: { key: "LOOP-1" } }];
const writes = (calls) => calls.filter((c) => !c.startsWith("GET"));

test("removes exactly the identified link and nothing else (DELETE issueLink/{id}; no issue endpoint is ever written)", async () => {
  const { client, calls } = fixture(reversed);
  await client.removeIssueLink({ linkId: "10001", issueKey: "LOOP-2", otherKey: "LOOP-1", typeName: "Blocks" }, lease);
  assert.deepEqual(writes(calls), ["DELETE issueLink/10001"]);
});

test("fails closed, with zero writes: wrong id, wrong type, wrong counterpart, foreign project", async () => {
  for (const args of [
    { linkId: "99999", issueKey: "LOOP-2", otherKey: "LOOP-1", typeName: "Blocks" },
    { linkId: "10001", issueKey: "LOOP-2", otherKey: "LOOP-1", typeName: "Relates" },
    { linkId: "10001", issueKey: "LOOP-2", otherKey: "LOOP-9", typeName: "Blocks" },
    { linkId: "10001", issueKey: "RCC-2", otherKey: "LOOP-1", typeName: "Blocks" },
  ]) {
    const { client, calls } = fixture(reversed);
    await assert.rejects(client.removeIssueLink(args, lease), (e) => e.code === "WRITE_GUARD_VIOLATION", JSON.stringify(args));
    assert.deepEqual(writes(calls), [], "nothing was deleted");
  }
});

test("an active lease is required", async () => {
  const { client } = fixture(reversed);
  await assert.rejects(client.removeIssueLink({ linkId: "10001", issueKey: "LOOP-2", otherKey: "LOOP-1", typeName: "Blocks" }, {}), (e) => e.code === "LEASE_REQUIRED");
});
