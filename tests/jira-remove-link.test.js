import assert from "node:assert/strict";
import test from "node:test";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { encodeLoopDescription } from "../src/reconcile/jira-adf.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";

/**
 * CP-08 corrective link removal: guarded, exact, and never deletes an issue. It is not a generic delete primitive:
 * every guard has a negative test and each refusal proves ZERO writes. Offline stub: SYNTHETIC evidence.
 */
const facts = (body, httpStatus = 200) => ({ httpStatus, body: body === null ? "" : JSON.stringify(body), headers: {}, requestId: "r", transportError: null });
const owned = (taskId) => encodeLoopDescription({ taskId, sourceDocumentId: "d", planVersion: 1, snapshotContentHash: "h", taskHash: "t", acceptanceCriteria: [{ id: "AC-001", text: "x" }] });
const guard = { projectKey: "LOOP", taskIdPattern: /^CP08[A-Z0-9]*-\d+$/ };
const lease = { assertLeaseCurrent: async () => {} };
const REL = SYNTHETIC_BLOCKS_RELATIONSHIP; // dependentEnd "outward": the blocker is the POSTed inwardIssue

// Jira's live rendering (CP-08): LOOP-1 blocks LOOP-2 => LOOP-1's entry shows outwardIssue LOOP-2, LOOP-2's entry shows inwardIssue LOOP-1.
const correct = () => ({ "LOOP-1": [{ id: "10245", type: { name: "Blocks", id: "10000" }, outwardIssue: { key: "LOOP-2" } }], "LOOP-2": [{ id: "10245", type: { name: "Blocks", id: "10000" }, inwardIssue: { key: "LOOP-1" } }], "LOOP-3": [] });
// The reversed link the disproven hypothesis wrote live: LOOP-2 blocks LOOP-1.
const reversed = () => ({ "LOOP-1": [{ id: "10244", type: { name: "Blocks", id: "10000" }, inwardIssue: { key: "LOOP-2" } }], "LOOP-2": [{ id: "10244", type: { name: "Blocks", id: "10000" }, outwardIssue: { key: "LOOP-1" } }], "LOOP-3": [] });

function fixture({ links = reversed(), projects = {}, descriptions = {}, keepAfterDelete = false, writeGuard = guard } = {}) {
  const calls = [];
  const transport = (r) => {
    calls.push(`${r.method ?? "GET"} ${r.path}`);
    if (r.method === "DELETE") {
      const id = decodeURIComponent(r.path.split("/").pop());
      if (!keepAfterDelete) for (const key of Object.keys(links)) links[key] = links[key].filter((l) => String(l.id) !== id);
      return facts(null, 204);
    }
    const m = /^issue\/([^?]+)\?fields=(.*)$/.exec(r.path);
    if (m && m[1] in links) {
      const key = m[1];
      const description = key in descriptions ? descriptions[key] : owned(`CP08ABC-${key.split("-")[1]}`);
      return facts({ key, fields: { project: { key: projects[key] ?? "LOOP" }, description, issuelinks: links[key] } });
    }
    return facts({}, 404);
  };
  const client = new JiraSyncClient({ mode: "scoped", cloudId: "11111111-2222-3333-4444-555555555555", email: "a@example.invalid", apiToken: "token-0123456789-abcdefghij", transport, ...(writeGuard ? { writeGuard } : {}) });
  return { calls, links, client };
}
const writes = (calls) => calls.filter((c) => !c.startsWith("GET"));
const REVERSED_ARGS = { linkId: "10244", blockerKey: "LOOP-2", dependentKey: "LOOP-1", relationship: REL };

test("removes exactly the identified reversed link (DELETE issueLink/{id}), verifies it is gone from both issues, deletes no issue", async () => {
  const { client, calls, links } = fixture();
  const result = await client.removeIssueLink(REVERSED_ARGS, lease);
  assert.deepEqual(writes(calls), ["DELETE issueLink/10244"]);
  assert.equal(result.goneFromBothIssues, true);
  assert.deepEqual([links["LOOP-1"], links["LOOP-2"]], [[], []]);
});

async function refused(args, options, code = "WRITE_GUARD_VIOLATION", label = JSON.stringify(args)) {
  const { client, calls } = fixture(options);
  await assert.rejects(client.removeIssueLink(args, lease), (e) => e.code === code, label);
  assert.deepEqual(writes(calls), [], `${label}: nothing was deleted`);
}

test("guard: a client without a writeGuard cannot remove any link", async () => {
  await refused(REVERSED_ARGS, { writeGuard: null });
});

test("guard: project must be LOOP (key prefix and the canonical project field)", async () => {
  await refused({ ...REVERSED_ARGS, blockerKey: "RCC-2" }, {});
  await refused(REVERSED_ARGS, { projects: { "LOOP-2": "RCC" } });
  await refused(REVERSED_ARGS, { projects: { "LOOP-1": "RCC" } });
});

test("guard: both issues must be Loop-owned by THIS run's task set (no marker, or a foreign task id, on either end)", async () => {
  const human = { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "written by a human" }] }] };
  await refused(REVERSED_ARGS, { descriptions: { "LOOP-2": null } });
  await refused(REVERSED_ARGS, { descriptions: { "LOOP-1": human } });
  await refused(REVERSED_ARGS, { descriptions: { "LOOP-2": owned("OTHERRUN-2") } });
  await refused(REVERSED_ARGS, { descriptions: { "LOOP-1": owned("OTHERRUN-1") } });
});

test("guard: the exact link id must exist on BOTH issues", async () => {
  await refused({ ...REVERSED_ARGS, linkId: "99999" }, {});
  const onlyOne = reversed(); onlyOne["LOOP-1"] = [];
  await refused(REVERSED_ARGS, { links: onlyOne });
  const otherOne = reversed(); otherOne["LOOP-2"] = [];
  await refused(REVERSED_ARGS, { links: otherOne });
});

test("guard: the link type must match the relationship on both ends (name and id)", async () => {
  for (const [side, type] of [["LOOP-2", { name: "Relates", id: "10001" }], ["LOOP-1", { name: "Relates", id: "10001" }], ["LOOP-2", { name: "Blocks", id: "77777" }]]) {
    const links = reversed(); links[side] = links[side].map((l) => ({ ...l, type }));
    await refused({ ...REVERSED_ARGS, relationship: { ...REL, linkTypeId: "10000" } }, { links });
  }
});

test("guard: the expected blocker/dependent pair must match (a different owned issue is not accepted)", async () => {
  await refused({ ...REVERSED_ARGS, blockerKey: "LOOP-3" }, {});
  await refused({ ...REVERSED_ARGS, dependentKey: "LOOP-3" }, {});
  await refused({ ...REVERSED_ARGS, blockerKey: "LOOP-2", dependentKey: "LOOP-2" }, {});
});

test("guard: the expected direction must match (the CORRECT link cannot be removed as if it were the reversed one, and vice versa)", async () => {
  await refused(REVERSED_ARGS, { links: correct() }); // existing link is LOOP-1 blocks LOOP-2 but the caller claims LOOP-2 blocks LOOP-1
  await refused({ linkId: "10245", blockerKey: "LOOP-2", dependentKey: "LOOP-1", relationship: REL }, { links: correct() });
  await refused({ linkId: "10244", blockerKey: "LOOP-1", dependentKey: "LOOP-2", relationship: REL }, {}); // claims the correct pair for the reversed link
  const mixed = reversed(); mixed["LOOP-1"] = mixed["LOOP-1"].map((l) => ({ ...l, inwardIssue: undefined, outwardIssue: { key: "LOOP-2" } })); // the two ends disagree
  await refused(REVERSED_ARGS, { links: mixed });
});

test("guard: relationship config, lease and link id are required; an unremoved link is reported, never assumed gone", async () => {
  await refused({ ...REVERSED_ARGS, relationship: undefined }, {}, "RELATIONSHIP_CONFIG_INVALID");
  await refused({ ...REVERSED_ARGS, linkId: undefined }, {});
  const { client, calls } = fixture();
  await assert.rejects(client.removeIssueLink(REVERSED_ARGS, {}), (e) => e.code === "LEASE_REQUIRED");
  assert.deepEqual(writes(calls), []);
  const stuck = fixture({ keepAfterDelete: true });
  await assert.rejects(stuck.client.removeIssueLink(REVERSED_ARGS, lease), (e) => e.code === "JIRA_WRITE_UNCONFIRMED");
});
