import assert from "node:assert/strict";
import test from "node:test";
import { JIRA_ERROR_CODES, classifyJiraFacts } from "../src/adapters/jira-transport.js";

const facts = (httpStatus, extra = {}) => ({ httpStatus, body: '{"a":1}', headers: {}, requestId: null, transportError: null, ...extra });

const TABLE = [
  [401, "AUTH_INVALID", "EXTERNAL_BLOCK"], [403, "AUTH_FORBIDDEN", "EXTERNAL_BLOCK"], [404, "ISSUE_NOT_FOUND", "EXTERNAL_BLOCK"],
  [409, "STALE_STATE", "EXTERNAL_BLOCK"], [412, "STALE_STATE", "EXTERNAL_BLOCK"], [400, "REQUEST_REJECTED", "EXTERNAL_BLOCK"],
  [422, "REQUEST_REJECTED", "EXTERNAL_BLOCK"], [429, "RATE_LIMITED", "TRANSIENT"], [500, "JIRA_UNAVAILABLE", "TRANSIENT"],
  [502, "JIRA_UNAVAILABLE", "TRANSIENT"], [503, "JIRA_UNAVAILABLE", "TRANSIENT"], [504, "JIRA_UNAVAILABLE", "TRANSIENT"],
  [501, "UNKNOWN_FAILURE", "EXTERNAL_BLOCK"], [302, "INVALID_RESPONSE", "EXTERNAL_BLOCK"], [0, "INVALID_RESPONSE", "EXTERNAL_BLOCK"],
];
for (const [status, code, classification] of TABLE) {
  test(`classify HTTP ${status} -> ${code}`, () => {
    const spec = classifyJiraFacts(facts(status));
    assert.equal(spec.ok, false);
    assert.equal(spec.code, code);
    assert.equal(spec.classification, classification);
    assert.ok(JIRA_ERROR_CODES.includes(spec.code));
  });
}

test("401 and 403 are distinct; 2xx is ok; 204 and empty-allowed bodies are ok", () => {
  assert.notEqual(classifyJiraFacts(facts(401)).code, classifyJiraFacts(facts(403)).code);
  assert.equal(classifyJiraFacts(facts(200)).ok, true);
  assert.equal(classifyJiraFacts(facts(204, { body: "" })).ok, true);
  assert.equal(classifyJiraFacts(facts(200, { body: "" })).code, "INVALID_RESPONSE");
  assert.equal(classifyJiraFacts(facts(200, { body: "" }), { allowEmpty: true }).ok, true);
  assert.equal(classifyJiraFacts(facts(200, { body: "nope" })).code, "INVALID_RESPONSE");
});

test("Retry-After is exposed as seconds (delta and HTTP-date); absent or garbage is null", () => {
  assert.equal(classifyJiraFacts(facts(429, { headers: { retryAfter: "30" } })).retryAfterSeconds, 30);
  assert.equal(classifyJiraFacts(facts(429, { headers: {} })).retryAfterSeconds, null);
  assert.equal(classifyJiraFacts(facts(429, { headers: { retryAfter: "soon" } })).retryAfterSeconds, null);
  const future = new Date(Date.now() + 60_000).toUTCString();
  const seconds = classifyJiraFacts(facts(429, { headers: { retryAfter: future } })).retryAfterSeconds;
  assert.ok(seconds >= 58 && seconds <= 61);
});

test("transport errors are flagged transportFailed and unknown codes fail closed", () => {
  const net = classifyJiraFacts({ httpStatus: 0, body: "", headers: {}, transportError: { code: "TRANSIENT_NETWORK_FAILURE", curlExit: 7, message: "refused" } });
  assert.deepEqual([net.code, net.classification, net.transportFailed], ["TRANSIENT_NETWORK_FAILURE", "TRANSIENT", true]);
  const cfg = classifyJiraFacts({ httpStatus: 0, body: "", headers: {}, transportError: { code: "CONFIG_INVALID", curlExit: null, message: "x" } });
  assert.equal(cfg.code, "CONFIG_INVALID");
  const weird = classifyJiraFacts({ httpStatus: 0, body: "", headers: {}, transportError: { code: "SOMETHING_NEW", curlExit: 99, message: "x" } });
  assert.deepEqual([weird.code, weird.classification], ["UNKNOWN_FAILURE", "EXTERNAL_BLOCK"]);
});
