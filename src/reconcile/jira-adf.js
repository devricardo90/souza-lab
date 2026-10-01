import { cleanText } from "./fingerprint.js";

/**
 * Deterministic codec between Loop-owned facts and a KNOWN, narrow Atlassian Document Format
 * (ADF) representation for Jira Cloud issue descriptions. Pure: no I/O.
 *
 * Loop-owned layout (what encodeLoopDescription writes and the ONLY shape decodeLoopDescription accepts):
 *
 *   doc(version 1)
 *     paragraph "LOOP_TASK_ID: RT-37"
 *     paragraph "LOOP_SOURCE_DOCUMENT: <document id>"
 *     paragraph "LOOP_PLAN_VERSION: 17"
 *     paragraph "LOOP_SNAPSHOT_HASH: <sha256>"
 *     paragraph "LOOP_TASK_HASH: <sha256>"
 *     heading(level 2) "Acceptance Criteria"
 *     bulletList
 *       listItem > paragraph "AC-001: text"
 *       ...
 *
 * We do NOT try to understand arbitrary rich Jira documents. A document is "claimed" by Loop only
 * if a TOP-LEVEL paragraph is exactly a `LOOP_TASK_ID: <id>` line. A claimed document that deviates
 * from the layout above (prose, marks, nested structures, unknown LOOP_ keys, duplicates, reordering
 * of the AC block, ...) fails closed with an explicit problem code, never a guess. Documents with no
 * such line are FOREIGN (not Loop-owned; identity unknown).
 */

export const ADF_PROBLEMS = Object.freeze([
  "ADF_NOT_A_DOCUMENT", "ADF_UNSUPPORTED_NODE", "ADF_UNSUPPORTED_MARKS", "ADF_UNSUPPORTED_PARAGRAPH", "ADF_UNKNOWN_LOOP_KEY",
  "ADF_DUPLICATE_METADATA", "ADF_MISSING_METADATA", "ADF_AC_STRUCTURE", "ADF_AC_MALFORMED", "ADF_AC_DUPLICATE", "ADF_MULTIPLE_TASK_MARKERS",
]);

const TASK_ID = /^[A-Z][A-Z0-9]*-\d+$/;
const EPIC_ID = /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/;
const META_KEYS = ["LOOP_TASK_ID", "LOOP_SOURCE_DOCUMENT", "LOOP_PLAN_VERSION", "LOOP_SNAPSHOT_HASH", "LOOP_TASK_HASH"];
const AC_ITEM = /^(AC-\d{2,}):\s*(.+)$/;

const text = (value) => ({ type: "text", text: value });
const paragraph = (value) => ({ type: "paragraph", content: [text(value)] });

export function encodeLoopDescription({ taskId, sourceDocumentId, planVersion, snapshotContentHash, taskHash, acceptanceCriteria }) {
  if (!TASK_ID.test(taskId ?? "")) throw new TypeError("a valid taskId is required to encode a Loop description");
  for (const [name, value] of Object.entries({ sourceDocumentId, snapshotContentHash, taskHash })) {
    if (typeof value !== "string" || value === "" || /[\r\n]/.test(value)) throw new TypeError(`${name} is required`);
  }
  if (!Number.isSafeInteger(planVersion) || planVersion < 1) throw new TypeError("planVersion must be a positive integer");
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0) throw new TypeError("acceptanceCriteria are required");
  return {
    type: "doc", version: 1,
    content: [
      paragraph(`LOOP_TASK_ID: ${taskId}`),
      paragraph(`LOOP_SOURCE_DOCUMENT: ${sourceDocumentId}`),
      paragraph(`LOOP_PLAN_VERSION: ${planVersion}`),
      paragraph(`LOOP_SNAPSHOT_HASH: ${snapshotContentHash}`),
      paragraph(`LOOP_TASK_HASH: ${taskHash}`),
      { type: "heading", attrs: { level: 2 }, content: [text("Acceptance Criteria")] },
      {
        type: "bulletList",
        content: [...acceptanceCriteria].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .map((ac) => ({ type: "listItem", content: [paragraph(`${ac.id}: ${cleanText(ac.text)}`)] })),
      },
    ],
  };
}

/** The single text of a node that is exactly one mark-free text node; otherwise a problem. */
function plainTextOf(node) {
  if (!Array.isArray(node.content) || node.content.length === 0) return { value: "" };
  if (node.content.length !== 1 || node.content[0]?.type !== "text") return { problem: "ADF_UNSUPPORTED_NODE" };
  const leaf = node.content[0];
  if (Array.isArray(leaf.marks) && leaf.marks.length > 0) return { problem: "ADF_UNSUPPORTED_MARKS" };
  return { value: typeof leaf.text === "string" ? leaf.text : "" };
}

/** Top-level paragraph lines only (used to find identity markers without interpreting the rest). */
export function adfTopLevelLines(doc) {
  if (!doc || doc.type !== "doc" || !Array.isArray(doc.content)) return null;
  const lines = [];
  for (const node of doc.content) {
    if (node?.type !== "paragraph" || !Array.isArray(node.content)) continue;
    if (node.content.length === 1 && node.content[0]?.type === "text" && typeof node.content[0].text === "string") lines.push(node.content[0].text.trim());
  }
  return lines;
}

/** Epic marker from an ADF (or null): only a clean top-level `LOOP_EPIC_ID: x` line counts. */
export function epicIdFromAdf(doc) {
  const found = new Set();
  for (const line of adfTopLevelLines(doc) ?? []) {
    const match = line.match(/^LOOP_EPIC_ID:[ \t]*(.*?)[ \t]*$/);
    if (match && EPIC_ID.test(match[1])) found.add(match[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * @returns {{ claimed: boolean, taskId: string|null, markerProblem: string|null,
 *             metadata: object|null, criteria: {id,text}[]|null, problem: string|null }}
 */
export function decodeLoopDescription(doc) {
  const foreign = { claimed: false, taskId: null, markerProblem: null, metadata: null, criteria: null, problem: "ADF_NOT_A_DOCUMENT" };
  if (!doc || doc.type !== "doc" || doc.version !== 1 || !Array.isArray(doc.content)) return foreign;

  // 1. identity: only clean top-level marker lines
  const markerValues = new Set();
  let badMarker = false;
  for (const line of adfTopLevelLines(doc) ?? []) {
    const match = line.match(/^LOOP_TASK_ID:[ \t]*(.*?)[ \t]*$/);
    if (!match) continue;
    if (TASK_ID.test(match[1])) markerValues.add(match[1]); else badMarker = true;
  }
  const claimed = markerValues.size > 0 || badMarker;
  if (!claimed) return { ...foreign, problem: null };
  if (badMarker || markerValues.size > 1) {
    return { claimed: true, taskId: null, markerProblem: badMarker ? "INVALID_MARKER" : "MULTIPLE_MARKERS", metadata: null, criteria: null, problem: "ADF_MULTIPLE_TASK_MARKERS" };
  }
  const taskId = [...markerValues][0];
  const invalid = (problem) => ({ claimed: true, taskId, markerProblem: null, metadata: null, criteria: null, problem });

  // 2. strict layout for everything else
  const metadata = {};
  let criteria = null;
  let sawHeading = false;
  for (const node of doc.content) {
    if (node?.type === "paragraph") {
      const { value, problem } = plainTextOf(node);
      if (problem) return invalid(problem);
      const line = value.trim();
      if (line === "") continue;
      const match = line.match(/^(LOOP_[A-Z_]+):[ \t]*(.*?)[ \t]*$/);
      if (!match) return invalid("ADF_UNSUPPORTED_PARAGRAPH");
      if (!META_KEYS.includes(match[1])) return invalid("ADF_UNKNOWN_LOOP_KEY");
      if (match[1] in metadata) return invalid("ADF_DUPLICATE_METADATA");
      metadata[match[1]] = match[2];
    } else if (node?.type === "heading") {
      const { value, problem } = plainTextOf(node);
      if (problem) return invalid(problem);
      if (node.attrs?.level !== 2 || value.trim() !== "Acceptance Criteria" || sawHeading) return invalid("ADF_AC_STRUCTURE");
      sawHeading = true;
    } else if (node?.type === "bulletList") {
      if (!sawHeading || criteria !== null || !Array.isArray(node.content) || node.content.length === 0) return invalid("ADF_AC_STRUCTURE");
      criteria = [];
      const seen = new Set();
      for (const item of node.content) {
        if (item?.type !== "listItem" || !Array.isArray(item.content) || item.content.length !== 1 || item.content[0]?.type !== "paragraph") return invalid("ADF_AC_STRUCTURE");
        const { value, problem } = plainTextOf(item.content[0]);
        if (problem) return invalid(problem);
        const match = value.trim().match(AC_ITEM);
        if (!match) return invalid("ADF_AC_MALFORMED");
        if (seen.has(match[1])) return invalid("ADF_AC_DUPLICATE");
        seen.add(match[1]);
        criteria.push({ id: match[1], text: cleanText(match[2]) });
      }
    } else {
      return invalid("ADF_UNSUPPORTED_NODE");
    }
  }
  for (const key of META_KEYS) if (!(key in metadata) || metadata[key] === "") return invalid("ADF_MISSING_METADATA");
  if (criteria === null) return invalid("ADF_AC_STRUCTURE");
  if (!/^[1-9]\d*$/.test(metadata.LOOP_PLAN_VERSION)) return invalid("ADF_MISSING_METADATA");
  return {
    claimed: true, taskId, markerProblem: null, problem: null,
    metadata: Object.freeze({
      sourceDocumentId: metadata.LOOP_SOURCE_DOCUMENT, planVersion: Number(metadata.LOOP_PLAN_VERSION),
      snapshotContentHash: metadata.LOOP_SNAPSHOT_HASH, taskHash: metadata.LOOP_TASK_HASH,
    }),
    criteria: criteria.sort((a, b) => (a.id < b.id ? -1 : 1)),
  };
}
