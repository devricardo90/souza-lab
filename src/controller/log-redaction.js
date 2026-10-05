/**
 * Credential-name detection and log scrubbing shared by the production profile and the Controller CLI.
 * Name-based by necessity (an environment variable carries no type), so it is deliberately broad; the production profile
 * additionally hands child processes an ALLOWLISTED environment instead of relying on this pattern to remove secrets.
 */
export const SECRET_NAME = /token|secret|passw|api[-_]?key|access[-_]?key|private[-_]?key|credential|authoriz|(^|_)auth(_|$)|session|(^|_)pat$|_key$|(^|_)key_/i;

const MIN_SECRET_LENGTH = 6;

/** Values that must never reach a log line: credential-looking variables, every LOOP_JIRA_* variable, and any explicitly passed-through name. */
export function secretValues(env = process.env, extraNames = []) {
  const extra = new Set(extraNames);
  return Object.entries(env)
    .filter(([name, value]) => typeof value === "string" && value.length >= MIN_SECRET_LENGTH && (SECRET_NAME.test(name) || /^LOOP_JIRA_/.test(name) || extra.has(name)))
    .map(([, value]) => value);
}

const escapeOnce = (text) => JSON.stringify(text).slice(1, -1);

/**
 * Replaces each secret value anywhere in the text in its raw form and in its JSON-escaped forms (quotes, backslashes), once
 * and twice: a message that embeds the value already JSON-encoded is encoded again when the log entry is serialized.
 * Longest variants go first so a shorter form can never leave a fragment of a longer one behind.
 */
export function scrubText(text, values) {
  let out = String(text);
  for (const value of values) {
    const once = escapeOnce(value);
    const variants = [...new Set([escapeOnce(once), once, value])].sort((a, b) => b.length - a.length);
    for (const variant of variants) out = out.split(variant).join("[REDACTED]");
  }
  return out;
}
