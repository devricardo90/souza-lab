import { execFileSync } from "node:child_process";

/**
 * `gh` command runner for the GitHub SCM/CI providers (their own `run` injection point), with transient-failure
 * classification the providers' built-in runner lacks: it treats only a PROCESS timeout as transient, so a dropped connection
 * ("dial tcp ... connectex", i/o timeout, TLS handshake timeout, connection reset), a 5xx, or a rate limit would permanently
 * BLOCK a task. For an unattended service those are exactly the failures that must be retried with backoff.
 *
 * Authentication failures (401/403 without a rate-limit message), 404 and 422 stay non-transient (fail closed).
 * Secrets in stderr are redacted.
 */
export const TRANSIENT_PATTERNS = Object.freeze([
  /dial tcp/i, /connectex/i, /i\/o timeout/i, /TLS handshake timeout/i, /connection (?:reset|refused|aborted)/i, /EOF/,
  /timeout/i, /temporary failure in name resolution/i, /no such host/i, /network is unreachable/i,
  /HTTP 50[0234]/, /HTTP 429/, /rate limit/i, /secondary rate/i, /try again/i, /server error/i, /bad gateway/i, /service unavailable/i, /gateway time-?out/i,
]);

export const redactGh = (value) => String(value ?? "").replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[REDACTED]")
  .replace(/(authorization\s*:\s*(?:token|bearer)\s+)\S+/ig, "$1[REDACTED]");

const WRITE_FLAGS = new Set(["--method", "-X", "-f", "-F", "--field", "--raw-field", "--input"]);
export const isReadOnlyGhCall = (args) => args[0] === "api" && !args.some((a) => WRITE_FLAGS.has(a) || /^--method=/.test(a));
const blockingSleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Bounded read re-read rule: a TRANSIENT failure of a READ-ONLY call (GET) is re-read up to `readRetries` more times with a
 * fixed short backoff before it surfaces. Why: one failed read inside a multi-fact observation yields a PARTIAL fact set
 * (the RecoveryCoordinator leaves every later fact null), which changes the facts fingerprint between planning and the
 * runtime precondition guard and aborts the planned action. Writes (POST/PUT/PATCH) are never re-sent here: their
 * reconciliation is the capability's job (read-back), not blind repetition.
 */
/** @param ErrorClass GitHubSCMError or GitHubCIError (the provider re-throws its own error type unchanged). */
export function createTransientAwareGhRunner({ ErrorClass, exec = execFileSync, codePrefix = "GITHUB", readRetries = 2, backoffMs = [1000, 3000], sleep = blockingSleep } = {}) {
  if (typeof ErrorClass !== "function") throw new TypeError("ErrorClass is required");
  return function run(args, options = {}) {
    const attempts = isReadOnlyGhCall(args) ? readRetries + 1 : 1;
    for (let attempt = 1; ; attempt += 1) {
      try { return runOnce(args, options); }
      catch (error) {
        if (attempt >= attempts || error?.classification !== "TRANSIENT") throw error;
        sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
      }
    }
  };
  function runOnce(args, { timeoutMs = 15000, gh = "gh" } = {}) {
    try {
      return exec(gh, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true, timeout: timeoutMs, killSignal: "SIGTERM" }).trim();
    } catch (error) {
      const detail = redactGh(error?.stderr ?? error?.message ?? "GitHub request failed").slice(0, 1200);
      const timedOut = error?.code === "ETIMEDOUT" || error?.killed === true;
      const transient = timedOut || TRANSIENT_PATTERNS.some((pattern) => pattern.test(detail));
      throw new ErrorClass(`GitHub request failed: ${detail}`, timedOut ? `${codePrefix}_TIMEOUT` : `${codePrefix}_REQUEST_FAILED`, transient ? "TRANSIENT" : "EXTERNAL_BLOCK");
    }
  }
}
