import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BIN, ENV, TWO_TASKS, startMock, workspace } from "./helpers/controller-harness.js";
import { runProcess } from "./helpers/controller-harness.js";
import { buildProductionController, sanitizedEnv, validateProductionConfig, ProductionProfileError } from "../src/composition/production-profile.js";
import { buildControllerForProfile } from "../src/controller/profile-selector.js";
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
const PROD_ENV = Object.freeze({ LOOP_JIRA_EMAIL: "prod-test@example.invalid", LOOP_JIRA_API_TOKEN: SECRET });
let ws; let mock;
before(async () => { mock = await startMock(); });
after(() => { mock.stop(); });
beforeEach(() => { if (ws) ws.cleanup(); ws = workspace(); ws.setPlan(TWO_TASKS()); });
after(() => { if (ws) ws.cleanup(); });

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
  agent: { kind: "hermes", command: "hermes", board: "board-x", coderAssignee: "coder-x" },
  validation: { command: process.execPath, args: ["-e", "process.exit(0)"] },
  review: { command: process.execPath, args: ["-e", "process.exit(0)"] },
  ...extra,
});
const clone = (value) => JSON.parse(JSON.stringify(value));
const build = (config = prodConfig(), env = PROD_ENV, overrides = {}) => buildProductionController(config, env, overrides);
const rejects = (config, env = PROD_ENV, pattern = null) => {
  assert.throws(() => validateProductionConfig(config, env), (error) => error instanceof ProductionProfileError && error.code === "CONFIG_INVALID" && (pattern === null || pattern.test(error.message)));
  const before = existsSync(config?.workspaceDir ?? "") ? readdirSync(config.workspaceDir).length : 0;
  assert.throws(() => buildProductionController(config, env), (error) => error.code === "CONFIG_INVALID");
  const after = existsSync(config?.workspaceDir ?? "") ? readdirSync(config.workspaceDir).length : 0;
  assert.equal(after, before, "a rejected configuration must not create any state");
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
    assert.equal(built.agent.command, "hermes");
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
  for (const file of ["../src/composition/production-profile.js", "../src/adapters/command-independent-reviewer.js"]) {
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
    "jira.completion.doneStatusName", "jira.completion.transitionName", "repository.identity", "repository.baseRef", "git.repoPath",
    "github.owner", "github.repo", "github.baseBranch", "github.workflowIdentity", "agent.kind", "agent.command", "agent.board", "agent.coderAssignee", "validation.command", "review.command",
  ];
  for (const path of required) {
    const config = prodConfig(); const parts = path.split("."); let node = config;
    for (const part of parts.slice(0, -1)) node = node[part];
    delete node[parts.at(-1)];
    rejects(config, PROD_ENV, null);
  }
  for (const name of ["LOOP_JIRA_EMAIL", "LOOP_JIRA_API_TOKEN"]) {
    const env = { ...PROD_ENV }; delete env[name];
    rejects(prodConfig(), env, new RegExp(name));
  }
  rejects(prodConfig({ jira: { ...prodConfig().jira, mode: "scoped", site: undefined } }), PROD_ENV, /LOOP_JIRA_CLOUD_ID/);
});

test("6. invalid configuration fails closed: profile, unknown or synthetic-only keys, relationship, pattern, observation, agent kind, commands", () => {
  rejects({ ...prodConfig(), profile: "synthetic" }, PROD_ENV, /profile/);
  rejects({ ...prodConfig(), profile: undefined }, PROD_ENV, /profile/);
  rejects({ ...prodConfig(), planFile: "x" }, PROD_ENV, /planFile/);
  rejects({ ...prodConfig(), agentRecordPath: "x" }, PROD_ENV, /agentRecordPath/);
  rejects({ ...prodConfig(), crashAt: { point: "x" } }, PROD_ENV, /crashAt/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, fake: {} } }, PROD_ENV, /fake/);
  rejects({ ...prodConfig(), github: { ...prodConfig().github, live: true } }, PROD_ENV, /live/);
  rejects({ ...prodConfig(), jira: { ...prodConfig().jira, relationship: { linkTypeName: "Blocks" } } }, PROD_ENV, /relationship/);
  rejects({ ...prodConfig(), jira: { ...prodConfig().jira, taskIdPattern: "([" } }, PROD_ENV, /regular expression/);
  rejects({ ...prodConfig(), jira: { ...prodConfig().jira, observation: { source: "board" } } }, PROD_ENV, /observation/);
  rejects({ ...prodConfig(), jira: { ...prodConfig().jira, mode: "other" } }, PROD_ENV, /mode/);
  rejects({ ...prodConfig(), jira: { ...prodConfig().jira, mode: "classic", site: "" } }, PROD_ENV, /site|required/);
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

test("7. Google is not required: no Google key or credential is needed, and a Google option is not accepted", () => {
  const env = { ...PROD_ENV }; for (const name of Object.keys(env)) assert.ok(!/google/i.test(name));
  const built = build(prodConfig(), env); built.close();
  rejects({ ...prodConfig(), google: { documentId: "x" } }, env, /google/);
  const text = readFileSync(new URL("../src/composition/production-profile.js", import.meta.url), "utf8");
  assert.ok(!/process\.env\.GOOGLE|GOOGLE_[A-Z_]+/.test(text), "the production profile reads no Google environment variable");
});

test("8. secrets never appear in errors, validation messages or the child environment", () => {
  const withKey = { ...prodConfig(), apiToken: SECRET };
  assert.throws(() => validateProductionConfig(withKey, PROD_ENV), (error) => /credential/.test(error.message) && !error.message.includes(SECRET));
  const nested = { ...prodConfig(), jira: { ...prodConfig().jira, password: SECRET } };
  assert.throws(() => validateProductionConfig(nested, PROD_ENV), (error) => !error.message.includes(SECRET));
  for (const mutate of [(c) => { delete c.agent.board; }, (c) => { c.jira.taskIdPattern = "(["; }, (c) => { c.profile = "x"; }]) {
    const config = clone(prodConfig()); mutate(config);
    assert.throws(() => validateProductionConfig(config, PROD_ENV), (error) => !error.message.includes(SECRET) && !error.message.includes(PROD_ENV.LOOP_JIRA_EMAIL));
  }
  const env = sanitizedEnv({ PATH: "p", HOME: "h", LOOP_JIRA_EMAIL: "e", LOOP_JIRA_API_TOKEN: SECRET, GITHUB_TOKEN: SECRET, MY_PASSWORD: SECRET, OPENAI_API_KEY: SECRET });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "PATH"]);
  const built = build();
  try {
    assert.ok(!JSON.stringify(Object.entries(built.validator.env)).includes(SECRET));
    assert.ok(!JSON.stringify(Object.entries(built.reviewer.env)).includes(SECRET));
  } finally { built.close(); }
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
  const hybrid = { ...prodConfig(), planFile: ws.planFile, jira: { ...prodConfig().jira, projectKey: "PRJ" } };
  await assert.rejects(buildControllerForProfile(hybrid, PROD_ENV), (error) => error.code === "CONFIG_INVALID");
  assert.ok(!existsSync(join(ws.dir, "state", "agent-calls.jsonl")), "no synthetic artifact is produced");
});

const writeJson = (name, value) => { const path = join(ws.dir, name); writeFileSync(path, JSON.stringify(value), "utf8"); return path; };

test("11. CLI: production is selected explicitly; bad or missing selection exits 78 without running any cycle or synthetic work", async () => {
  const cases = [
    ["missing profile", { ...prodConfig(), profile: undefined }, PROD_ENV],
    ["unknown profile", { ...prodConfig(), profile: "prod" }, PROD_ENV],
    ["production without credentials", prodConfig(), {}],
    ["production with missing section", { ...prodConfig(), agent: undefined }, PROD_ENV],
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

test("12. CLI: a valid production config is built and started from the CLI (real process, local Jira mock, no Hermes needed to start)", async () => {
  await mock.reset();
  const config = prodConfig({ timings: { instanceLeaseTtlMs: 15000, defaultWaitMs: 200, idlePollMs: 300, blockedPollMs: 300 } }, `127.0.0.1:${mock.port}`);
  config.jira.scheme = "http"; config.jira.projectKey = "LOOP"; config.jira.taskIdPattern = "^TASK-\\d+$";
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

test("14. controller behaviour stays deterministic: two production builds from the same config have identical wiring and read-only state", () => {
  const dirA = prodConfig(); const dirB = { ...prodConfig(), workspaceDir: join(ws.dir, "state-b") };
  const a = build(dirA); const b = build(dirB);
  try {
    assert.deepEqual(a.controller.materialization, b.controller.materialization);
    assert.deepEqual(a.controller.completion, b.controller.completion);
    assert.deepEqual(a.controller.relationship, b.controller.relationship);
    assert.equal(a.controller.constructor, b.controller.constructor);
    assert.deepEqual(a.stores.controllerStore.list(), []);
    assert.deepEqual(b.stores.controllerStore.list(), []);
  } finally { a.close(); b.close(); }
  mkdirSync(join(ws.dir, "unused"), { recursive: true });
});
