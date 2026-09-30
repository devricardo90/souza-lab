import { createHash } from "node:crypto";

/**
 * Fingerprints over PLAN-OWNED facts only: task id, title, epic, dependencies (by TASK_ID),
 * acceptance criteria. Deliberately excluded: Jira workflow status, comments, timestamps,
 * Jira internal id / issue key, CI state, Git HEAD - none of those are desired-plan identity.
 *
 * The canonical shape is identical to the PlanSnapshot task hash (taskHash), so a remote issue
 * that is semantically equal to the plan task produces an equal fingerprint.
 */

const sortedStringify = (value) => JSON.stringify(value, (_key, v) => (v && typeof v === "object" && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]])) : v));

/** Safe text normalization shared with the plan compiler: NFC, NBSP/zero-width, whitespace runs collapsed. */
export function cleanText(value) {
  return String(value ?? "").normalize("NFC")
    .replace(/[​‌‍⁠﻿]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Problems (unresolvable remote references) are included only when present, so a clean issue hashes exactly like the plan. */
export function planOwnedFingerprint({ taskId, title, epicId = null, dependsOn = [], acceptanceCriteria = [], problems = null }) {
  const canonical = {
    taskId, epicId, title,
    dependsOn: [...new Set(dependsOn)].sort(),
    acceptanceCriteria: acceptanceCriteria.map(({ id, text }) => ({ id, text })).sort(byId),
  };
  if (problems && problems.length > 0) canonical.problems = [...problems].sort();
  return createHash("sha256").update(sortedStringify(canonical), "utf8").digest("hex");
}

export { sortedStringify };
