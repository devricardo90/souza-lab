import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN, ENV, TWO_TASKS, runProcess, startMock, workspace } from "./helpers/controller-harness.js";
import { buildProductionController, childEnvironment, executableExists, validateProductionConfig, ProductionProfileError } from "../src/composition/production-profile.js";
import { buildControllerForProfile } from "../src/controller/profile-selector.js";
import { scrubText, secretValues } from "../src/controller/log-redaction.js";
import { JiraSyncClient } from "../src/adapters/jira-sync-client.js";
import { JiraOutboxExecutor } from "../src/adapters/jira-outbox-executor.js";
import { HermesAgentExecutor } from "../src/adapters/hermes-agent-executor.js";
import { WorkspaceCommandValidator } from "../src/adapters/workspace-command-validator.js";
import { CommandIndependentReviewer } from "../src/adapters/command-independent-reviewer.js";
import { GitHubLifecycle } from "../src/controller/github-lifecycle.js";
import { LoopController } from "../src/controller/loop-controller.js";
import { SyntheticAgentExecutor } from "../src/testing/synthetic-lifecycle.js";
import { SyntheticGitAgent } from "../src/testing/synthetic-git-agent.js";
import { DeterministicReviewer, DeterministicValidator } from "../src/testing/deterministic-gates.js";
import { SYNTHETIC_BLOCKS_RELATIONSHIP } from "../src/reconcile/jira-relationship.js";

/**
 * CP-09: the production composition. Deterministic: no live Jira, Hermes or GitHub; the only I/O is local temp files, SQLite and
 * (for the CLI tests) a local Jira mock and a child process. Live proof of the whole chain belongs to CP-10.
 */
const SECRET = "sentinel-secret-value-9f8e7d6c5b4a";
const PATH_ENV = Object.fromEntries(["PATH", "Path", "PATHEXT"].filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]]));
const PROD_ENV = Object.freeze({ ...PATH_ENV, LOOP_JIRA_EMAIL: "prod-test@example.invalid", LOOP_JIRA_API_TOKEN: SECRET });
let ws; let mock;
before(async () => { mock = await startMock(); });
after(() => { mock.stop(); });
beforeEach(() => { if (ws) ws.cleanup(); ws = workspace(); ws.setPlan(TWO_TASKS()); });
after(() => { if (ws) ws.cleanup(); });

// Existing executables that are never invoked by these tests: the agent is the current node binary, the reviewer is "git" found on PATH (a different real binary).
const prodConfig = (extra = {}, site = "jira.example.invalid") => ({
  profile: "production", workspaceDir: join(ws.dir, "state"), workspaceId: "ws-prod", documentId: "doc-prod",
  planSource: { file: ws.planFile },
  jira: {
    mode: "classic", site, scheme: "https", projectKey: "PRJ", issueTypeName: "Task", taskIdPattern: "^TASK-\\d+$",
    observation: { source: "search" }, relationship: SYNTHETIC_BLOCKS_RELATIONSHIP,
    completion: { doneStatusName: "Done", transitionName: "Done" },
  },
  repository: { identity: "example/repo", baseRef: "main" },
  git: { repoPath: ws.dir },
  github: { owner: "example", repo: "repo", baseBranch: "main", workflowIdentity: ".github/workflows/validate.yml" },
  agent: { kind: "hermes", command: process.execPath, board: "board-x", coderAssignee: "coder-x" },
  validation: { command: process.execPath, args: ["-e", "process.exit(0)"] },
  review: { command: "git", args: ["--version"] },
  ...extra,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const withJira = (patch) => ({ ...prodConfig(), jira: { ...prodConfig().jira, ...patch } });
const build = (config = prodConfig(), env = PROD_ENV, overrides = {}) => buildProductionController(config, env, overrides);
const rejects = (config, env = PROD_ENV, pattern = null) => {
  assert.throws(() => validateProductionConfig(config, env), (error) => error instanceof ProductionProfileError && error.code === "CONFIG_INVALID" && (pattern === null || pattern.test(error.message)), `validate: ${pattern}`);
  const dir = config && typeof config === "object" ? config.workspaceDir : null;
  const existed = typeof dir === "string" ? existsSync(dir) : false;
  assert.throws(() => buildProductionController(config, env), (error) => error.code === "CONFIG_INVALID");
  if (typeof dir === "string" && !existed) assert.ok(!existsSync(dir), "a rejected configuration must not create any state");
};

test("1. production composition builds with valid injected configuration", () => {
  const built = build();
  try { assert.ok(built.controller instanceof LoopController); assert.equal(typeof built.close, "function"); } finally { built.close(); }
});

test("2. the correct real adapters are wired and receive the configured identities", () => {
  const built = build();
  try {
    assert.ok(built.jira instanceof JiraSyncClient);
    assert.equal(built.jira.writeGuard.projectKey, "PRJ");
    assert.ok(built.jira.writeGuard.taskIdPattern.test("TASK-001") && !built.jira.writeGuard.taskIdPattern.test("OTHER-1"));
    assert.ok(built.outboxExecutor instanceof JiraOutboxExecutor);
    assert.equal(built.controller.jira, built.jira);
    assert.ok(built.lifecycle instanceof GitHubLifecycle);
    assert.equal(built.lifecycle.scm.repository, "example/repo");
    assert.equal(built.lifecycle.ci.repository, "example/repo");
    assert.equal(built.lifecycle.ci.workflowIdentity, ".github/workflows/validate.yml");
    assert.equal(built.lifecycle.reviewer, built.reviewer);
    assert.equal(built.lifecycle.validator, built.validator);
    assert.ok(built.validator instanceof WorkspaceCommandValidator);
    assert.ok(built.reviewer instanceof CommandIndependentReviewer);
    for (const name of ["planStore", "outboxStore", "controllerStore", "attemptStore", "gateStore"]) assert.ok(built.stores[name], name);
    assert.equal(built.controller.materialization.projectKey, "PRJ");
    assert.equal(built.controller.completion.transitionName, "Done");
  } finally { built.close(); }
});

test("3. HermesAgentExecutor is the agent in production mode, shared by the runner and the lifecycle", () => {
  const built = build();
  try {
    assert.ok(built.agent instanceof HermesAgentExecutor);
    assert.equal(built.agent.board, "board-x");
    assert.equal(built.agent.coderAssignee, "coder-x");
    assert.equal(built.agent.command, process.execPath);
    assert.equal(built.executionRunner.agent, built.agent);
    assert.equal(built.lifecycle.agent, built.agent);
  } finally { built.close(); }
});

test("4. no synthetic executor, reviewer or validator is used in production mode (instances and static scan)", () => {
  const built = build();
  try {
    assert.ok(!(built.agent instanceof SyntheticAgentExecutor) && !(built.agent instanceof SyntheticGitAgent));
    assert.ok(!(built.reviewer instanceof DeterministicReviewer) && !(built.validator instanceof DeterministicValidator));
  } finally { built.close(); }
  for (const file of ["../src/composition/production-profile.js", "../src/adapters/command-independent-reviewer.js", "../src/controller/log-redaction.js"]) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(imports.every((spec) => !/testing\//.test(spec)), `${file} imports a testing module`);
    assert.ok(!/Synthetic|Deterministic(Reviewer|Validator)|createFakeGitHub|FakeNotifier/.test(text), `${file} names a synthetic/fake provider`);
  }
});

test("5. every missing required production option fails closed, and a rejected config creates no state", () => {
  const required = [
    "workspaceDir", "workspaceId", "documentId", "planSource", "jira", "repository", "git", "github", "agent", "validation", "review",
    "planSource.file", "jira.mode", "jira.projectKey", "jira.issueTypeName", "jira.taskIdPattern", "jira.observation", "jira.relationship", "jira.completion",
    "jira.observation.source", "jira.relationship.linkTypeName", "jira.relationship.dependentEnd",
    "jira.completion.doneStatusName", "jira.completion.transitionName", "repository.identity", "repository.baseRef", "git.repoPath",
    "github.owner", "github.repo", "github.baseBranch", "github.workflowIdentity", "agent.kind", "agent.command", "agent.board", "agent.coderAssignee", "validation.command", "review.command",
  ];
  for (const path of required) {
    const config = clone(prodConfig()); const parts = path.split("."); let node = config;
    for (const part of parts.slice(0, -1)) node = node[part];
    delete node[parts.at(-1)];
    rejects(config, PROD_ENV, null);
  }
  for (const name of ["LOOP_JIRA_EMAIL", "LOOP_JIRA_API_TOKEN"]) {
    const env = { ...PROD_ENV }; delete env[name];
    rejects(prodConfig(), env, new RegExp(name));
  }
  rejects(withJira({ mode: "scoped", site: undefined }), PROD_ENV, /LOOP_JIRA_CLOUD_ID/);
});

test("6. invalid configuration fails closed: profile, unknown or synthetic-only keys at every level, relationship, pattern, observation, agent kind, commands", () => {
  rejects({ ...prodConfig(), profile: "synthetic" }, PROD_ENV, /profile/);
  rejects({ ...prodConfig(), profile: undefined }, PROD_ENV, /profile/);
  rejects({ ...prodConfig(), planFile: "x" }, PROD_ENV, /planFile/);
  rejects({ ...prodConfig(), agentRecordPath: "x" }, PROD_ENV, /agentRecordPath/);
  rejects({ ...prodConfig(), crashAt: { point: "x" } }, PROD_ENV, /crashAt/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, fake: {} } }, PROD_ENV, /fake/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, live: true } }, PROD_ENV, /live/);
  rejects(withJira({ relationship: { linkTypeName: "Blocks" } }), PROD_ENV, /relationship/);
  rejects(withJira({ relationship: { ...SYNTHETIC_BLOCKS_RELATIONSHIP, extra: 1 } }), PROD_ENV, /extra/);
  rejects(withJira({ taskIdPattern: "([" }), PROD_ENV, /regular expression/);
  rejects(withJira({ observation: { source: "board" } }), PROD_ENV, /observation/);
  rejects(withJira({ observation: { source: "search", extra: true } }), PROD_ENV, /extra/);
  rejects(withJira({ observation: { source: "search", boardId: 5 } }), PROD_ENV, /observation/);
  rejects(withJira({ mode: "other" }), PROD_ENV, /mode/);
  rejects(withJira({ mode: "classic", site: "" }), PROD_ENV, /site|required/);
  rejects({ ...prodConfig(), agent: { ...prodConfig().agent, kind: "claude" } }, PROD_ENV, /agent\.kind/);
  rejects({ ...prodConfig(), agent: { ...prodConfig().agent, pollMs: -1 } }, PROD_ENV, /pollMs/);
  rejects({ ...prodConfig(), validation: { command: "x", args: "not-an-array" } }, PROD_ENV, /args/);
  rejects({ ...prodConfig(), review: { command: "x", timeoutMs: 0 } }, PROD_ENV, /timeoutMs/);
  rejects({ ...prodConfig(), repository: { identity: "  ", baseRef: "main" } }, PROD_ENV, /identity|required/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, owner: "bad owner!" } }, PROD_ENV, /owner/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, repo: "bad/repo" } }, PROD_ENV, /repo/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, workflowIdentity: "validate.yml" } }, PROD_ENV, /workflow/);
  rejects(null, PROD_ENV, /object/);
  rejects([], PROD_ENV, /object/);
});

test("6b. every optional value is type- and range-checked; nothing bad is silently accepted or surfaces as an internal error", () => {
  const cases = [
    [{ timings: "abc" }, /timings/], [{ timings: { instanceLeaseTtlMs: "x" } }, /instanceLeaseTtlMs/], [{ timings: { instanceLeaseTtlMs: 5 } }, /instanceLeaseTtlMs/],
    [{ timings: { idlePollMs: 0 } }, /idlePollMs/], [{ timings: { unknownTiming: 1 } }, /unknownTiming/], [{ timings: { defaultWaitMs: 1.5 } }, /defaultWaitMs/],
    [{ ownerId: 5 }, /ownerId/], [{ ownerId: "" }, /ownerId/], [{ outboxClaimTtlMs: "x" }, /outboxClaimTtlMs/], [{ heartbeatWorker: "yes" }, /heartbeatWorker/],
    [{ exitOnCompleted: 1 }, /exitOnCompleted/], [{ passEnv: "PATH" }, /passEnv/], [{ passEnv: ["LOOP_JIRA_API_TOKEN"] }, /passEnv/], [{ passEnv: ["bad name"] }, /passEnv/],
  ];
  for (const [patch, pattern] of cases) rejects({ ...prodConfig(), ...patch }, PROD_ENV, pattern);
  for (const [patch, pattern] of [
    [{ timeoutMs: "x" }, /jira\.timeoutMs/], [{ gatewayHost: 5 }, /gatewayHost/], [{ scheme: "ftp" }, /scheme/], [{ site: 5 }, /site/],
    [{ completion: { doneStatusName: "Done", transitionName: "Done", expectedCurrentStatusNames: "x" } }, /expectedCurrentStatusNames/],
    [{ completion: { doneStatusName: "Done", transitionName: "Done", surprise: 1 } }, /surprise/],
  ]) rejects(withJira(patch), PROD_ENV, pattern);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, timeoutMs: "x" } }, PROD_ENV, /github\.timeoutMs/);
  // valid optionals are accepted
  const ok = build({ ...prodConfig(), timings: { instanceLeaseTtlMs: 5000, idlePollMs: 10 }, ownerId: "owner-1", outboxClaimTtlMs: 1000, heartbeatWorker: false, exitOnCompleted: true, passEnv: ["MY_OPTIONAL_VAR"] });
  ok.close();
});

test("6c. plain http is allowed only for a loopback endpoint (credentials never cross a network in cleartext)", () => {
  rejects(withJira({ scheme: "http" }), PROD_ENV, /loopback/);
  rejects(withJira({ scheme: "http", site: "jira.example.com" }), PROD_ENV, /loopback/);
  rejects(withJira({ scheme: "http", site: "127.0.0.1.evil.example.com:80" }), PROD_ENV, /loopback/);
  rejects(withJira({ mode: "scoped", site: undefined, scheme: "http" }), { ...PROD_ENV, LOOP_JIRA_CLOUD_ID: "c-1" }, /loopback/);
  rejects(withJira({ mode: "scoped", site: undefined, scheme: "http", gatewayHost: "api.atlassian.com" }), { ...PROD_ENV, LOOP_JIRA_CLOUD_ID: "c-1" }, /loopback/);
  for (const site of ["127.0.0.1:8080", "localhost:3000", "127.0.0.1"]) build(withJira({ scheme: "http", site })).close();
  build(withJira({ scheme: "https", site: "jira.example.com" })).close();
});

test("6d. startup facts are checked: a missing plan file, local clone or executable fails closed before any state is created", () => {
  const cases = [
    [{ ...prodConfig(), planSource: { file: join(ws.dir, "missing-plan.txt") } }, /planSource\.file/],
    [{ ...prodConfig(), planSource: { file: ws.dir } }, /planSource\.file/],
    [{ ...prodConfig(), git: { repoPath: join(ws.dir, "no-such-clone") } }, /git\.repoPath/],
    [{ ...prodConfig(), agent: { ...prodConfig().agent, command: "definitely-not-installed-agent-xyz" } }, /agent\.command/],
    [{ ...prodConfig(), validation: { command: join(ws.dir, "no-such-validator") } }, /validation\.command/],
    [{ ...prodConfig(), review: { command: "definitely-not-installed-reviewer-xyz" } }, /review\.command/],
  ];
  for (const [config, pattern] of cases) {
    assert.throws(() => buildProductionController(config, PROD_ENV), (error) => error instanceof ProductionProfileError && error.code === "CONFIG_INVALID" && pattern.test(error.message));
    assert.ok(!existsSync(config.workspaceDir), "no state is created");
  }
  assert.ok(executableExists(process.execPath, PROD_ENV));
  assert.ok(executableExists("node", PROD_ENV));
  assert.ok(!executableExists("definitely-not-installed-xyz", PROD_ENV));
});

test("6d-2. an executable must be runnable without a shell: Windows .cmd/.bat shims and non-executable POSIX files are rejected", () => {
  const shim = join(ws.dir, "tool.cmd"); writeFileSync(shim, "@echo off\r\n", "utf8");
  const bat = join(ws.dir, "tool.bat"); writeFileSync(bat, "@echo off\r\n", "utf8");
  const plain = join(ws.dir, "tool-plain"); writeFileSync(plain, "#!/bin/sh\n", { mode: 0o644 });
  if (process.platform === "win32") {
    assert.ok(!executableExists(shim, PROD_ENV) && !executableExists(bat, PROD_ENV), "a .cmd/.bat shim is not accepted");
    assert.ok(!executableExists(plain, PROD_ENV), "an extension-less file is not accepted");
    assert.ok(!executableExists("tool", { ...PROD_ENV, PATH: ws.dir, Path: ws.dir, PATHEXT: ".CMD;.BAT;.EXE" }), "a .cmd found through PATHEXT is not accepted");
    assert.throws(() => buildProductionController({ ...prodConfig(), validation: { command: shim } }, PROD_ENV), (error) => error.code === "CONFIG_INVALID" && /\.cmd\/\.bat/.test(error.message));
  } else {
    assert.ok(!executableExists(plain, PROD_ENV), "a file without the execute bit is not accepted");
    const exe = join(ws.dir, "tool-exec"); writeFileSync(exe, "#!/bin/sh\n", { mode: 0o755 });
    assert.ok(executableExists(exe, PROD_ENV));
    assert.throws(() => buildProductionController({ ...prodConfig(), validation: { command: plain } }, PROD_ENV), (error) => error.code === "CONFIG_INVALID");
  }
  assert.ok(executableExists(process.execPath, PROD_ENV));
});

test("6e. the reviewer must not be the same executable as the implementing agent", () => {
  rejects({ ...prodConfig(), review: { command: process.execPath } }, PROD_ENV, /independent/);
});

test("6e-2. independence is judged on the resolved binary, not the spelling: the same executable by name and by full path is rejected; maxCorrections is bounded; the executor kind is a registry", () => {
  assert.throws(() => buildProductionController({ ...prodConfig(), review: { command: "node" } }, PROD_ENV), (error) => error.code === "CONFIG_INVALID" && /same executable/.test(error.message));
  assert.ok(!existsSync(join(ws.dir, "state")), "no state is created");
  for (const bad of [0, 11, 1.5, "3", -1]) rejects({ ...prodConfig(), github: { ...prodConfig().github, maxCorrections: bad } }, PROD_ENV, /maxCorrections/);
  for (const ok of [1, 3, 10]) build({ ...prodConfig(), workspaceDir: join(ws.dir, `state-mc-${ok}`), github: { ...prodConfig().github, maxCorrections: ok } }).close();
  const built = build({ ...prodConfig(), workspaceDir: join(ws.dir, "state-mc-wired"), github: { ...prodConfig().github, maxCorrections: 2 } });
  try { assert.equal(built.lifecycle.maxCorrections, 2, "the configured bound reaches the lifecycle"); } finally { built.close(); }
  const defaulted = build({ ...prodConfig(), workspaceDir: join(ws.dir, "state-mc-default") });
  try { assert.equal(defaulted.lifecycle.maxCorrections, 3, "the default bound is 3"); } finally { defaulted.close(); }
  rejects({ ...prodConfig(), agent: { ...prodConfig().agent, kind: "someone-else" } }, PROD_ENV, /one of: hermes/);
  rejects({ ...prodConfig(), agent: { kind: "hermes", command: process.execPath } }, PROD_ENV, /agent.board|required/);
});

test("7. Google is not required: no Google key or credential is needed, and a Google option is not accepted", () => {
  const env = { ...PROD_ENV }; for (const name of Object.keys(env)) assert.ok(!/google/i.test(name));
  const built = build(prodConfig(), env); built.close();
  rejects({ ...prodConfig(), google: { documentId: "x" } }, env, /google/);
  const text = readFileSync(new URL("../src/composition/production-profile.js", import.meta.url), "utf8");
  assert.ok(!/process\.env\.GOOGLE|GOOGLE_[A-Z_]+/.test(text), "the production profile reads no Google environment variable");
});

test("8. secrets never appear in errors or validation messages, and child processes get an allowlisted environment", () => {
  const withKey = { ...prodConfig(), apiToken: SECRET };
  assert.throws(() => validateProductionConfig(withKey, PROD_ENV), (error) => /credential/.test(error.message) && !error.message.includes(SECRET));
  const nested = withJira({ password: SECRET });
  assert.throws(() => validateProductionConfig(nested, PROD_ENV), (error) => !error.message.includes(SECRET));
  const nestedTimings = { ...prodConfig(), timings: { accessKey: SECRET } };
  assert.throws(() => validateProductionConfig(nestedTimings, PROD_ENV), (error) => !error.message.includes(SECRET));
  for (const mutate of [(c) => { delete c.agent.board; }, (c) => { c.jira.taskIdPattern = "(["; }, (c) => { c.profile = "x"; }]) {
    const config = clone(prodConfig()); mutate(config);
    assert.throws(() => validateProductionConfig(config, PROD_ENV), (error) => !error.message.includes(SECRET) && !error.message.includes(PROD_ENV.LOOP_JIRA_EMAIL));
  }
  const ambient = {
    PATH: "p", HOME: "h", TEMP: "t", LOOP_JIRA_EMAIL: "e", LOOP_JIRA_API_TOKEN: SECRET, GITHUB_TOKEN: SECRET, MY_PASSWORD: SECRET, OPENAI_API_KEY: SECRET,
    AWS_ACCESS_KEY_ID: SECRET, AWS_SESSION_X: SECRET, DEPLOY_PAT: SECRET, SSH_AUTH_SOCK: SECRET, NPM_CONFIG__AUTH: SECRET, SERVICE_PRIVATE_KEY: SECRET, UNRELATED_CUSTOM_CREDS: SECRET,
  };
  assert.deepEqual(Object.keys(childEnvironment(ambient)).sort(), ["HOME", "PATH", "TEMP"]);
  assert.deepEqual(Object.keys(childEnvironment({ ...ambient, MY_OPTIONAL_VAR: "v" }, ["MY_OPTIONAL_VAR"])).sort(), ["HOME", "MY_OPTIONAL_VAR", "PATH", "TEMP"]);
  const built = build();
  try {
    assert.ok(!JSON.stringify(built.validator.env).includes(SECRET));
    assert.ok(!JSON.stringify(built.reviewer.env).includes(SECRET));
    assert.ok(!JSON.stringify(built.agent.env).includes(SECRET) && !Object.keys(built.agent.env).some((n) => /^LOOP_JIRA_/.test(n)), "the Hermes CLI is started with the allowlisted environment too");
    assert.ok(!Object.keys(built.reviewer.env).some((name) => /^LOOP_JIRA_/.test(name)));
  } finally { built.close(); }
});

test("8b. log scrubbing replaces raw and JSON-escaped secret values, including ones containing quotes and backslashes", () => {
  const tricky = 'tok"en\\with-special-0123456789';
  const env = { LOOP_JIRA_API_TOKEN: tricky, CUSTOM_SESSION_ID: "session-value-123", SSH_AUTH_SOCK: "/tmp/agent.sock-1", PLAIN: "plain-visible-value", SHORT_TOKEN: "abc" };
  const values = secretValues(env);
  assert.ok(values.includes(tricky) && values.includes("session-value-123") && values.includes("/tmp/agent.sock-1"));
  assert.ok(!values.includes("plain-visible-value") && !values.includes("abc"), "non-secret and too-short values are not scrubbed");
  const line = JSON.stringify({ event: "fatal", message: `bad ${tricky} and session-value-123 and plain-visible-value` });
  assert.ok(line.includes(JSON.stringify(tricky).slice(1, -1)), "precondition: the JSON text carries the escaped form");
  const out = scrubText(line, values);
  assert.ok(!out.includes(tricky) && !out.includes(JSON.stringify(tricky).slice(1, -1)) && !out.includes("session-value-123"));
  assert.ok(out.includes("[REDACTED]") && out.includes("plain-visible-value"));
  assert.deepEqual(JSON.parse(out).event, "fatal", "the scrubbed line is still valid JSON");
  // a message that already embeds the value JSON-encoded is encoded a second time by the log line
  const twice = JSON.stringify(JSON.stringify(tricky).slice(1, -1)).slice(1, -1);
  const nestedLine = JSON.stringify({ event: "fatal", message: `got ${JSON.stringify(tricky)}` });
  assert.ok(nestedLine.includes(twice), "precondition: the doubly encoded form is present");
  assert.ok(!scrubText(nestedLine, values).includes(twice) && !scrubText(nestedLine, values).includes("special-0123456789"));
  assert.ok(secretValues({ LOOP_PASSED: "passed-through-value" }, ["LOOP_PASSED"]).includes("passed-through-value"));
});

test("9. the selector builds production only when asked, with no default profile", async () => {
  const built = await buildControllerForProfile(prodConfig(), PROD_ENV);
  try { assert.ok(built.agent instanceof HermesAgentExecutor); } finally { built.close(); }
  for (const profile of [undefined, null, "", "prod", "Production", "SYNTHETIC", "live"]) {
    await assert.rejects(buildControllerForProfile({ ...prodConfig(), profile }, PROD_ENV), (error) => error.code === "CONFIG_INVALID" && /no default profile/.test(error.message));
  }
  await assert.rejects(buildControllerForProfile(undefined, PROD_ENV), (error) => error.code === "CONFIG_INVALID");
});

test("10. there is no implicit fallback from production to synthetic: an invalid production config never builds a synthetic controller", async () => {
  const broken = { ...prodConfig(), agent: undefined };
  await assert.rejects(buildControllerForProfile(broken, PROD_ENV), (error) => error.code === "CONFIG_INVALID" && /agent/.test(error.message));
  // a production config that also carries synthetic fields is rejected outright rather than interpreted as synthetic
  const hybrid = { ...prodConfig(), planFile: ws.planFile };
  await assert.rejects(buildControllerForProfile(hybrid, PROD_ENV), (error) => error.code === "CONFIG_INVALID");
  assert.ok(!existsSync(join(ws.dir, "state", "agent-calls.jsonl")), "no synthetic artifact is produced");
});

test("10b. a store failing after earlier stores were opened closes them (no leaked handles) and leaves no half-built controller", () => {
  const config = prodConfig();
  mkdirSync(join(config.workspaceDir, "controller.sqlite"), { recursive: true }); // makes the THIRD store fail after two were opened
  assert.throws(() => buildProductionController(config, PROD_ENV));
  // an open SQLite handle would keep these files locked (EBUSY/EPERM on Windows); closed handles let them be removed
  rmSync(join(config.workspaceDir, "plans.sqlite"), { force: false });
  rmSync(join(config.workspaceDir, "outbox.sqlite"), { force: false });
});

const writeJson = (name, value) => { const path = join(ws.dir, name); writeFileSync(path, JSON.stringify(value), "utf8"); return path; };

test("11. CLI: production is selected explicitly; bad or missing selection exits 78 without running any cycle or synthetic work", async () => {
  const cases = [
    ["missing profile", { ...prodConfig(), profile: undefined }, PROD_ENV],
    ["unknown profile", { ...prodConfig(), profile: "prod" }, PROD_ENV],
    ["production without credentials", prodConfig(), {}],
    ["production with missing section", { ...prodConfig(), agent: undefined }, PROD_ENV],
    ["production with a bad optional value", { ...prodConfig(), ownerId: 5 }, PROD_ENV],
    ["production with a missing executable", { ...prodConfig(), review: { command: "definitely-not-installed-reviewer-xyz" } }, PROD_ENV],
  ];
  for (const [name, config, env] of cases) {
    const handle = runProcess(writeJson(`${name.replace(/ /g, "-")}.json`, config), { env: { LOOP_JIRA_EMAIL: "", LOOP_JIRA_API_TOKEN: "", ...env } });
    const result = await handle.exited;
    assert.equal(result.code, 78, `${name}: exit code`);
    assert.ok(result.lines.some((l) => l.event === "fatal" && l.code === "CONFIG_INVALID"), `${name}: fatal CONFIG_INVALID logged`);
    assert.ok(!result.lines.some((l) => l.event === "cycle" || l.event === "exit"), `${name}: no cycle ran`);
    assert.ok(!JSON.stringify(result.lines).includes(SECRET) && !result.stderr.includes(SECRET), `${name}: no secret in output`);
  }
  assert.ok(!existsSync(join(ws.dir, "state")), "no state directory was created by any rejected configuration");
});

test("11b. CLI log scrubbing is active: a secret that reaches a log line is redacted (plain and with quotes/backslashes)", async () => {
  for (const token of [SECRET, 'quo"te\\back-slash-secret-0123']) {
    const handle = runProcess(writeJson("leak.json", { ...prodConfig(), profile: `leaky-${token}` }), { env: { ...PROD_ENV, LOOP_JIRA_API_TOKEN: token } });
    const result = await handle.exited;
    assert.equal(result.code, 78);
    const fatal = result.lines.find((l) => l.event === "fatal");
    assert.ok(fatal, "the configuration error was logged");
    assert.ok(/leaky-\[REDACTED\]/.test(fatal.message), `redacted marker present: ${fatal.message}`);
    const raw = JSON.stringify(result.lines);
    const once = JSON.stringify(token).slice(1, -1); const twice = JSON.stringify(once).slice(1, -1);
    assert.ok(!raw.includes(token) && !raw.includes(once) && !raw.includes(twice) && !result.stderr.includes(token));
  }
});

test("12. CLI: a valid production config is built and started from the CLI (real process, local Jira mock, no Hermes needed to start)", async () => {
  await mock.reset();
  const config = prodConfig({ timings: { instanceLeaseTtlMs: 15000, defaultWaitMs: 200, idlePollMs: 300, blockedPollMs: 300 } }, `127.0.0.1:${mock.port}`);
  config.jira.scheme = "http"; config.jira.projectKey = "LOOP";
  const handle = runProcess(writeJson("valid-production.json", config), { env: PROD_ENV });
  try {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !handle.lines.some((l) => l.event === "cycle")) await new Promise((r) => setTimeout(r, 100));
    assert.ok(handle.lines.some((l) => l.event === "cycle" && l.phase === "STARTED"), `controller started: ${JSON.stringify(handle.lines.slice(0, 4))}`);
    assert.ok(!handle.lines.some((l) => l.event === "fatal"), "no fatal error");
    assert.ok(existsSync(join(ws.dir, "state", "controller.sqlite")), "production state lives in the configured workspaceDir");
    assert.ok(!existsSync(join(ws.dir, "state", "agent-calls.jsonl")), "no synthetic agent was used");
    assert.ok(!JSON.stringify(handle.lines).includes(SECRET));
  } finally { handle.child.kill(); await handle.exited; }
});

test("13. the existing synthetic profile still builds through the explicit selector (and still requires an explicit profile)", async () => {
  const synthetic = { profile: "synthetic", workspaceDir: ws.dir, workspaceId: "ws-syn", documentId: "doc-syn", planFile: ws.planFile, jira: { site: "127.0.0.1:1", scheme: "http", projectKey: "LOOP", issueTypeName: "Task" }, repository: { identity: "synthetic/repo", baseRef: "main" } };
  const built = await buildControllerForProfile(synthetic, ENV);
  try { assert.ok(built.agent instanceof SyntheticAgentExecutor); assert.ok(built.controller instanceof LoopController); } finally { built.close(); }
  assert.ok(BIN.endsWith("loop-controller.js"));
});

test("14. production wiring is deterministic: the same config yields the same wiring and a fresh, empty controller state", () => {
  // The controller itself is unchanged by CP-09; its behavioural determinism is proven by the existing loop-controller suites, which run unmodified.
  const a = build(prodConfig()); const b = build({ ...prodConfig(), workspaceDir: join(ws.dir, "state-b") });
  try {
    assert.deepEqual(a.controller.materialization, b.controller.materialization);
    assert.deepEqual(a.controller.completion, b.controller.completion);
    assert.deepEqual(a.controller.relationship, b.controller.relationship);
    assert.equal(a.controller.constructor, b.controller.constructor);
    assert.deepEqual(a.stores.controllerStore.list(), []);
    assert.deepEqual(b.stores.controllerStore.list(), []);
  } finally { a.close(); b.close(); }
});
