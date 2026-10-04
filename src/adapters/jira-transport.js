import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

/**
 * Deterministic Jira HTTP transport boundary (CP-01).
 *
 * The transport only reports FACTS (HTTP status, body, relevant headers,
 * transport error, request id). It classifies them into stable codes but never
 * retries and never sleeps: whether and when to retry is decided by
 * RuntimeRetryPolicy / the controller, not here.
 *
 * Secret handling: the Authorization header and request body are handed to
 * curl through its config on STDIN (`-K -`). No credential file is ever
 * created, so there is nothing to clean up, nothing readable by other
 * processes on disk, and nothing in argv or the environment.
 */

export const JIRA_ERROR_CODES = Object.freeze([
  "AUTH_INVALID", "AUTH_FORBIDDEN", "ISSUE_NOT_FOUND", "STALE_STATE", "REQUEST_REJECTED",
  "RATE_LIMITED", "JIRA_UNAVAILABLE", "TRANSIENT_NETWORK_FAILURE", "INVALID_RESPONSE",
  "CONFIG_INVALID", "UNKNOWN_FAILURE",
]);

const TRANSIENT_CURL_EXITS = new Set([5, 6, 7, 18, 28, 35, 52, 55, 56, 92]);
const CONFIG_CURL_EXITS = new Set([1, 2, 3, 4, 27]);
const SITE = /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:\d{1,5})?$|^\[::1\](:\d{1,5})?$/;
const PATH = /^[A-Za-z0-9\-._~%/:@!$&'()*+,;=?]+$/;
const LOOPBACK = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;
const CLOUD_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;

export const JIRA_MODES = Object.freeze(["classic", "scoped"]);
export const JIRA_APIS = Object.freeze({ platform: "rest/api/3", agile: "rest/agile/1.0" });
export const SCOPED_GATEWAY_HOST = "api.atlassian.com";

export function redact(value) {
  return String(value ?? "")
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)\S+/ig, "$1[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{24,}={0,2}\b/g, "[REDACTED]");
}

function configInvalid(message) {
  return { httpStatus: 0, body: "", headers: {}, requestId: null, transportError: { code: "CONFIG_INVALID", curlExit: null, message } };
}

function cfgQuote(text) {
  return `"${String(text).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/\t/g, "\\t")}"`;
}

/** Pure function: everything that is safe to place in argv, plus the stdin
 * config (the only place a secret appears). Exported for the argv proof. */
/**
 * Explicit routing, never inferred from the token:
 *   classic  https://<site>/rest/api/3/<path>                                (site required)
 *   scoped   https://api.atlassian.com/ex/jira/<cloudId>/rest/api/3/<path>   (cloudId required; `site` unused)
 * `api` selects the REST family ("platform" = rest/api/3, "agile" = rest/agile/1.0) in either mode.
 * The scoped gateway host is only overridable (`gatewayHost`) to a loopback address, for tests.
 */
export function jiraBaseUrl({ mode = "classic", site, scheme = "https", cloudId, gatewayHost = SCOPED_GATEWAY_HOST, api = "platform" }) {
  if (!JIRA_MODES.includes(mode)) throw new TypeError(`Jira mode must be one of ${JIRA_MODES.join(", ")}`);
  if (!(api in JIRA_APIS)) throw new TypeError("Jira api family is invalid");
  let host;
  let prefix = "";
  if (mode === "scoped") {
    if (typeof cloudId !== "string" || !CLOUD_ID.test(cloudId)) throw new TypeError("Jira cloudId is required for scoped mode");
    if (typeof gatewayHost !== "string" || !SITE.test(gatewayHost) || (gatewayHost !== SCOPED_GATEWAY_HOST && !LOOPBACK.test(gatewayHost))) throw new TypeError("Jira scoped gateway host is invalid");
    host = gatewayHost;
    prefix = `/ex/jira/${cloudId}`;
  } else {
    if (typeof site !== "string" || !SITE.test(site)) throw new TypeError("Jira site is invalid");
    host = site;
  }
  if (scheme !== "https" && !(scheme === "http" && LOOPBACK.test(host))) throw new TypeError("Jira scheme must be https (http only for loopback)");
  return `${scheme}://${host}${prefix}/${JIRA_APIS[api]}/`;
}

export function buildCurlInvocation({ mode = "classic", site, cloudId, gatewayHost, api = "platform", scheme = "https", email, apiToken, path, query = "", method = "GET", body = null, timeoutMs = 15000, nonce }) {
  const base = jiraBaseUrl({ mode, site, scheme, cloudId, gatewayHost, api });
  if (typeof email !== "string" || email.trim() === "" || /[\r\n"]/.test(email)) throw new TypeError("Jira email is required");
  if (typeof apiToken !== "string" || apiToken.trim() === "" || /[\r\n]/.test(apiToken)) throw new TypeError("Jira API token is required");
  if (typeof path !== "string" || !PATH.test(path)) throw new TypeError("Jira request path is invalid");
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) throw new TypeError("Jira request method is invalid");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new TypeError("timeoutMs must be positive");
  const url = `${base}${path}${query ? `?${query}` : ""}`;
  const basic = Buffer.from(`${email}:${apiToken}`, "utf8").toString("base64");
  const config = [
    `header = ${cfgQuote(`Authorization: Basic ${basic}`)}`,
    `header = "Accept: application/json"`,
    `request = ${cfgQuote(method)}`,
  ];
  if (body !== null) {
    config.push(`header = "Content-Type: application/json"`);
    config.push(`data = ${cfgQuote(JSON.stringify(body))}`); // JSON always starts with { or [, never "@"
  }
  const maxSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const delimiter = `@@CP01-${nonce ?? randomBytes(8).toString("hex")}@@`;
  const argv = [
    "-q", "-K", "-", "--silent", "--show-error", "--no-progress-meter",
    "--max-time", String(maxSeconds), "--connect-timeout", String(Math.min(maxSeconds, 10)),
    "--proto", "=http,https", "--max-redirs", "0",
    "-o", "-", "-w", `\n${delimiter}%{json}\n${delimiter}%{header_json}`,
    url,
  ];
  return { argv, stdin: `${config.join("\n")}\n`, delimiter };
}

function headerValue(headerJson, name) {
  for (const [key, values] of Object.entries(headerJson ?? {})) {
    if (key.toLowerCase() === name) return Array.isArray(values) ? String(values[0]) : String(values);
  }
  return null;
}

/** Runs curl and returns structured facts. Never throws for request outcomes. */
export function jiraCurlTransport(request) {
  let invocation;
  try { invocation = buildCurlInvocation(request); }
  catch (error) { return configInvalid(redact(error.message)); }
  const timeoutMs = request.timeoutMs ?? 15000;
  const result = spawnSync("curl", invocation.argv, {
    input: invocation.stdin, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    windowsHide: true, timeout: timeoutMs + 3000, killSignal: "SIGKILL",
  });
  if (result.error) {
    const missing = result.error.code === "ENOENT";
    return {
      httpStatus: 0, body: "", headers: {}, requestId: null,
      transportError: {
        code: missing ? "CONFIG_INVALID" : result.error.code === "ETIMEDOUT" ? "TRANSIENT_NETWORK_FAILURE" : "UNKNOWN_FAILURE",
        curlExit: null, message: redact(missing ? "curl executable not found" : result.error.message),
      },
    };
  }
  const out = result.stdout ?? "";
  const hdrAt = out.lastIndexOf(invocation.delimiter);
  const factsAt = hdrAt < 2 ? -1 : out.lastIndexOf(`\n${invocation.delimiter}`, hdrAt - 2);
  if (factsAt < 0 || hdrAt <= factsAt) {
    return {
      httpStatus: 0, body: "", headers: {}, requestId: null,
      transportError: { code: "UNKNOWN_FAILURE", curlExit: result.status, message: redact(`curl produced no write-out facts: ${result.stderr ?? ""}`).slice(0, 300) },
    };
  }
  const body = out.slice(0, factsAt);
  let info; let headerJson;
  try {
    info = JSON.parse(out.slice(factsAt + 1 + invocation.delimiter.length, hdrAt).trim());
    headerJson = JSON.parse(out.slice(hdrAt + invocation.delimiter.length).trim() || "{}");
  } catch {
    return {
      httpStatus: 0, body: "", headers: {}, requestId: null,
      transportError: { code: "UNKNOWN_FAILURE", curlExit: result.status, message: "curl write-out facts were unparseable" },
    };
  }
  const exitcode = Number(info.exitcode ?? result.status ?? -1);
  const httpStatus = Number(info.http_code ?? 0);
  const headers = {
    retryAfter: headerValue(headerJson, "retry-after"),
    contentType: headerValue(headerJson, "content-type"),
  };
  const requestId = headerValue(headerJson, "x-arequestid") ?? headerValue(headerJson, "atl-traceid");
  let transportError = null;
  if (exitcode !== 0) {
    const code = TRANSIENT_CURL_EXITS.has(exitcode) ? "TRANSIENT_NETWORK_FAILURE" : CONFIG_CURL_EXITS.has(exitcode) ? "CONFIG_INVALID" : "UNKNOWN_FAILURE";
    transportError = { code, curlExit: exitcode, message: redact(info.errormsg ?? `curl exit ${exitcode}`).slice(0, 300) };
  }
  return { httpStatus: transportError ? 0 : httpStatus, body: transportError ? "" : body, headers, requestId, transportError };
}

export function isFacts(value) {
  return value !== null && typeof value === "object" && typeof value.httpStatus === "number" && "transportError" in value;
}

function parseRetryAfter(value, now = Date.now()) {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

/**
 * Pure classification of transport facts. `ok` means Jira accepted the
 * request with a usable 2xx response.
 */
export function classifyJiraFacts(facts, { expectJson = true, allowEmpty = false } = {}) {
  const base = { httpStatus: facts.httpStatus ?? 0, requestId: facts.requestId ?? null, retryAfterSeconds: null, transportFailed: false };
  const fail = (code, classification, message, extra = {}) => ({ ok: false, code, classification, message, ...base, ...extra });
  if (facts.transportError) {
    const { code, curlExit, message } = facts.transportError;
    const classification = code === "TRANSIENT_NETWORK_FAILURE" ? "TRANSIENT" : code === "CONFIG_INVALID" ? "INVARIANT_VIOLATION" : "EXTERNAL_BLOCK";
    return fail(JIRA_ERROR_CODES.includes(code) ? code : "UNKNOWN_FAILURE", classification, `transport failure (curl exit ${curlExit ?? "n/a"}): ${message}`, { transportFailed: true });
  }
  const status = facts.httpStatus;
  if (status >= 200 && status < 300) {
    const body = facts.body ?? "";
    if (body.trim() === "") {
      return allowEmpty || status === 204 ? { ok: true, code: "OK", ...base } : fail("INVALID_RESPONSE", "EXTERNAL_BLOCK", `HTTP ${status} carried no body`);
    }
    if (expectJson) {
      try { JSON.parse(body); } catch { return fail("INVALID_RESPONSE", "EXTERNAL_BLOCK", `HTTP ${status} returned malformed JSON`); }
    }
    return { ok: true, code: "OK", ...base };
  }
  if (status === 401) return fail("AUTH_INVALID", "EXTERNAL_BLOCK", "Jira rejected the credentials (HTTP 401)");
  if (status === 403) return fail("AUTH_FORBIDDEN", "EXTERNAL_BLOCK", "Jira denied permission (HTTP 403)");
  if (status === 404) return fail("ISSUE_NOT_FOUND", "EXTERNAL_BLOCK", "Jira resource not found (HTTP 404)");
  if (status === 409 || status === 412) return fail("STALE_STATE", "EXTERNAL_BLOCK", `Jira reported a state conflict (HTTP ${status})`);
  if (status === 429) return fail("RATE_LIMITED", "TRANSIENT", "Jira rate limited the request (HTTP 429)", { retryAfterSeconds: parseRetryAfter(facts.headers?.retryAfter) });
  if ([500, 502, 503, 504].includes(status)) return fail("JIRA_UNAVAILABLE", "TRANSIENT", `Jira is unavailable (HTTP ${status})`);
  if (status >= 400 && status < 500) return fail("REQUEST_REJECTED", "EXTERNAL_BLOCK", `Jira rejected the request (HTTP ${status})`);
  if (status >= 500) return fail("UNKNOWN_FAILURE", "EXTERNAL_BLOCK", `unclassified Jira server response (HTTP ${status})`);
  return fail("INVALID_RESPONSE", "EXTERNAL_BLOCK", `unexpected HTTP status ${status}`);
}

/** Copies classification facts onto an error so the controller can read them. */
export function annotateError(error, spec) {
  error.retryAfterSeconds = spec.retryAfterSeconds ?? null;
  error.httpStatus = spec.httpStatus ?? 0;
  error.requestId = spec.requestId ?? null;
  error.transportFailed = spec.transportFailed === true;
  return error;
}
