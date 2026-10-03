/**
 * Explicit Jira dependency-link semantics. Pure: no I/O.
 *
 * The Loop models the semantic relation "TASK_A depends on TASK_B" (B is the blocker) independently of
 * Jira's raw inwardIssue/outwardIssue representation. A RelationshipConfig states, explicitly and with no
 * default, how that relation is expressed in ONE Jira issue-link type:
 *
 *   linkTypeName   the Jira issue link type (e.g. "Blocks")
 *   inwardLabel    the type's inward description  (e.g. "is blocked by")
 *   outwardLabel   the type's outward description (e.g. "blocks")
 *   dependentEnd   "inward" | "outward": the end of the POST /issueLink body occupied by the DEPENDENT issue.
 *                  LIVE-PROVEN (CP-08, run CP08MUS8I9PM, Jira Cloud scoped gateway): for "Blocks" the dependent is
 *                  POSTed as `outwardIssue` and the blocker as `inwardIssue`; Jira then renders the dependent's entry as
 *                  `inwardIssue: <blocker>` ("is blocked by") and the blocker's entry as `outwardIssue: <dependent>` ("blocks").
 *
 * From that single definition both directions are derived, so write, read, normalization and
 * reconciliation can never disagree:
 *   write: POST issueLink with the dependent at `dependentEnd` and the blocker at the opposite end
 *   read:  Jira lists, on each linked issue, the OTHER issue under the key of the OTHER issue's own POST end. So on the
 *          DEPENDENT issue the blocker appears under the key of the end opposite to `dependentEnd`
 *          (live: POST inward=X, outward=Y => X's entry shows `outwardIssue: Y`, Y's entry shows `inwardIssue: X`).
 * The labels are not used for logic; they are verified against Jira's own link-type definition
 * (verifyAgainstLinkTypes) so a configuration that does not match the Jira instance fails closed.
 * The direction convention was first hypothesised the other way round and DISPROVEN by the CP-08 live dependency
 * stage; the live-observed behaviour above is the source of truth.
 */

export class RelationshipConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "RelationshipConfigError";
    this.code = "RELATIONSHIP_CONFIG_INVALID";
    this.classification = "INVARIANT_VIOLATION";
    this.retryable = false;
  }
}

const END = new Set(["inward", "outward"]);
const text = (value) => typeof value === "string" && value.trim() !== "" && value.length <= 120 && !/[\r\n]/.test(value);

/** Fails closed: absent, partial or ambiguous configuration is never completed with a default. */
export function parseRelationshipConfig(config) {
  if (!config || typeof config !== "object") throw new RelationshipConfigError("relationship configuration is required (no implicit default direction)");
  const { linkTypeName, inwardLabel, outwardLabel, dependentEnd, linkTypeId = null } = config;
  for (const [name, value] of Object.entries({ linkTypeName, inwardLabel, outwardLabel })) {
    if (!text(value)) throw new RelationshipConfigError(`relationship.${name} is required`);
  }
  if (!END.has(dependentEnd)) throw new RelationshipConfigError('relationship.dependentEnd must be exactly "inward" or "outward"');
  if (linkTypeId !== null && !text(String(linkTypeId))) throw new RelationshipConfigError("relationship.linkTypeId is invalid");
  if (inwardLabel.trim() === outwardLabel.trim()) throw new RelationshipConfigError("inwardLabel and outwardLabel must differ; the direction would be ambiguous");
  return Object.freeze({
    linkTypeName: linkTypeName.trim(), linkTypeId: linkTypeId === null ? null : String(linkTypeId),
    inwardLabel: inwardLabel.trim(), outwardLabel: outwardLabel.trim(), dependentEnd,
  });
}

const otherEnd = (end) => (end === "inward" ? "outward" : "inward");

/** The POST /issueLink body expressing "dependent depends on blocker". */
export function linkBody(relationship, { blockerKey, dependentKey }) {
  const config = parseRelationshipConfig(relationship);
  if (typeof blockerKey !== "string" || typeof dependentKey !== "string" || blockerKey === "" || dependentKey === "" || blockerKey === dependentKey) {
    throw new RelationshipConfigError("a link needs two distinct issue keys");
  }
  const body = { type: config.linkTypeId ? { id: config.linkTypeId, name: config.linkTypeName } : { name: config.linkTypeName } };
  body[`${config.dependentEnd}Issue`] = { key: dependentKey };
  body[`${otherEnd(config.dependentEnd)}Issue`] = { key: blockerKey };
  return body;
}

/** The blocker key on a DEPENDENT issue's link entry, or null when the entry is not this relation. */
export function blockerOf(relationship, entry) {
  const config = parseRelationshipConfig(relationship);
  const type = entry?.type;
  if (!type || (type.name !== config.linkTypeName && !(config.linkTypeId && String(type.id) === config.linkTypeId))) return null;
  const key = entry?.[`${otherEnd(config.dependentEnd)}Issue`]?.key;
  return typeof key === "string" && key !== "" ? key : null;
}

/** Verifies the configuration against Jira's own link-type definitions (GET /issueLinkType). */
export function verifyAgainstLinkTypes(relationship, linkTypes) {
  const config = parseRelationshipConfig(relationship);
  if (!Array.isArray(linkTypes)) throw new RelationshipConfigError("Jira link types are unavailable");
  const matches = linkTypes.filter((type) => type?.name === config.linkTypeName || (config.linkTypeId && String(type?.id) === config.linkTypeId));
  if (matches.length !== 1) throw new RelationshipConfigError(`Jira link type "${config.linkTypeName}" matched ${matches.length} definitions (expected exactly 1)`);
  const [type] = matches;
  if (type.name !== config.linkTypeName) throw new RelationshipConfigError(`link type id ${config.linkTypeId} is named "${type.name}", not "${config.linkTypeName}"`);
  if (type.inward !== config.inwardLabel || type.outward !== config.outwardLabel) {
    throw new RelationshipConfigError(`configured labels ("${config.inwardLabel}" / "${config.outwardLabel}") do not match Jira ("${type.inward}" / "${type.outward}")`);
  }
  return config;
}

/** The classic "Blocks" link type with the live-proven mapping (dependent is the POSTed outwardIssue). Also the test configuration. */
export const SYNTHETIC_BLOCKS_RELATIONSHIP = Object.freeze({
  linkTypeName: "Blocks", inwardLabel: "is blocked by", outwardLabel: "blocks", dependentEnd: "outward",
});
