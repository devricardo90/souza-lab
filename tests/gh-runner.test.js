import assert from "node:assert/strict";
import test from "node:test";
import { createTransientAwareGhRunner, redactGh } from "../src/adapters/gh-runner.js";
import { GitHubSCMError, GitHubSCMProvider } from "../src/adapters/github-scm-provider.js";
import { GitHubCIError, GitHubCIProvider } from "../src/adapters/github-ci-provider.js";

const failing = (stderr, extra = {}) => () => { throw Object.assign(new Error("Command failed"), { stderr, ...extra }); };
const runWith = (ErrorClass, exec) => createTransientAwareGhRunner({ ErrorClass, exec, sleep: () => {} });

test("network and server failures are TRANSIENT; auth, not-found and validation failures stay permanent (fail closed)", () => {
  const transient = [
    "Post \"https://api.github.com/graphql\": dial tcp 4.225.11.201:443: connectex: A connection attempt failed",
    "Get \"https://api.github.com/repos/o/r\": net/http: TLS handshake timeout", "read tcp: connection reset by peer", "i/o timeout",
    "gh: Bad Gateway (HTTP 502)", "gh: Service Unavailable (HTTP 503)", "gh: API rate limit exceeded for user (HTTP 403)", "HTTP 429 Too Many Requests",
  ];
  const permanent = ["gh: Bad credentials (HTTP 401)", "gh: Not Found (HTTP 404)", "gh: Validation Failed (HTTP 422)", "gh: Resource not accessible by integration (HTTP 403)"];
  for (const ErrorClass of [GitHubSCMError, GitHubCIError]) {
    for (const stderr of transient) assert.throws(() => runWith(ErrorClass, failing(stderr))(["api", "x"]), (e) => e instanceof ErrorClass && e.classification === "TRANSIENT" && e.retryable === true, stderr);
    for (const stderr of permanent) assert.throws(() => runWith(ErrorClass, failing(stderr))(["api", "x"]), (e) => e instanceof ErrorClass && e.classification === "EXTERNAL_BLOCK" && e.retryable === false, stderr);
  }
});

test("a process timeout is transient with the timeout code; secrets in stderr are redacted", () => {
  assert.throws(() => runWith(GitHubSCMError, failing("", { code: "ETIMEDOUT" }))(["api", "x"]), (e) => e.code === "GITHUB_TIMEOUT" && e.retryable === true);
  const ciRunner = createTransientAwareGhRunner({ ErrorClass: GitHubCIError, exec: failing("", { killed: true }), codePrefix: "GITHUB_CI", sleep: () => {} });
  assert.throws(() => ciRunner(["api", "x"]), (e) => e.code === "GITHUB_CI_TIMEOUT" && e.retryable === true);
  const leaked = "bad token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and Authorization: token abcdef";
  assert.ok(!redactGh(leaked).includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.throws(() => runWith(GitHubSCMError, failing(leaked))(["api", "x"]), (e) => !e.message.includes("ghp_abcdefghijklmnopqrstuvwxyz0123456789"));
  assert.equal(runWith(GitHubSCMError, () => "  ok \n")(["api", "x"]), "ok");
});

test("through the real providers: a transient gh failure is a retryable provider error (the runtime waits), an auth failure is a block", () => {
  const scm = new GitHubSCMProvider({ owner: "o", repo: "r", baseBranch: "main", run: runWith(GitHubSCMError, failing("dial tcp: connectex: failed")) });
  assert.throws(() => scm.getBranchFacts("b"), (e) => e.retryable === true && e.classification === "TRANSIENT");
  const ci = new GitHubCIProvider({ owner: "o", repo: "r", workflowIdentity: ".github/workflows/validate.yml", run: runWith(GitHubCIError, failing("i/o timeout")) });
  assert.throws(() => ci.getCIResult("a".repeat(40)), (e) => e.retryable === true);
  const denied = new GitHubSCMProvider({ owner: "o", repo: "r", baseBranch: "main", run: runWith(GitHubSCMError, failing("gh: Bad credentials (HTTP 401)")) });
  assert.throws(() => denied.getBranchFacts("b"), (e) => e.retryable === false);
});

test("bounded re-read: a transient READ is re-read up to the bound; a WRITE is never re-sent; permanent failures are not retried", () => {
  const transientErr = () => Object.assign(new Error("Command failed"), { stderr: "dial tcp: connectex: failed" });
  const flaky = (failures) => { const state = { calls: 0 }; const exec = () => { state.calls += 1; if (state.calls <= failures) throw transientErr(); return " ok "; }; return { state, exec }; };
  const slept = [];
  const make = (exec) => createTransientAwareGhRunner({ ErrorClass: GitHubSCMError, exec, sleep: (ms) => slept.push(ms) });

  const two = flaky(2);
  assert.equal(make(two.exec)(["api", "repos/o/r/pulls"]), "ok");
  assert.equal(two.state.calls, 3, "two transient failures are absorbed by the bounded re-read");
  assert.deepEqual(slept, [1000, 3000]);

  const three = flaky(3);
  assert.throws(() => make(three.exec)(["api", "repos/o/r/pulls"]), (e) => e.retryable === true);
  assert.equal(three.state.calls, 3, "the bound is 1 read + 2 re-reads");

  for (const writeArgs of [["api", "repos/o/r/pulls", "-X", "POST", "-F", "title=t"], ["api", "repos/o/r/pulls/1/merge", "-X", "PUT", "-F", "sha=abc"]]) {
    const write = flaky(1);
    assert.throws(() => make(write.exec)(writeArgs), (e) => e.retryable === true);
    assert.equal(write.state.calls, 1, "a write is never blindly re-sent");
  }

  let permanentCalls = 0;
  assert.throws(() => make(() => { permanentCalls += 1; throw Object.assign(new Error("x"), { stderr: "gh: Not Found (HTTP 404)" }); })(["api", "x"]), (e) => e.retryable === false);
  assert.equal(permanentCalls, 1);
});
