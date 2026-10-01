import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FakeNotifier } from "../../src/controller/ports.js";
import { buildSyntheticController } from "../../src/testing/synthetic-profile.js";

/** Shared test harness for the Controller: a real Jira mock process + synthetic providers. Synthetic evidence only. */
const MOCK = fileURLToPath(new URL("./jira-mock-server.js", import.meta.url));
export const BIN = fileURLToPath(new URL("../../bin/loop-controller.js", import.meta.url));
export const ENV = Object.freeze({ LOOP_JIRA_EMAIL: "controller-test@example.invalid", LOOP_JIRA_API_TOKEN: "controller-test-token-0123456789" });
export const DOC = "doc-controller-1";

export async function startMock() {
  const server = spawn(process.execPath, [MOCK], { stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => { server.once("error", reject); server.stdout.once("data", (chunk) => resolve(Number(/PORT=(\d+)/.exec(String(chunk))[1]))); });
  const base = `http://127.0.0.1:${port}`;
  const control = (payload) => fetch(`${base}/__control`, { method: "POST", body: JSON.stringify(payload), headers: { connection: "close" } }).then((r) => r.json());
  const get = (path) => fetch(`${base}${path}`, { headers: { connection: "close" } }).then((r) => r.json());
  return {
    port, control, stop: () => server.kill(),
    reset: () => control({ reset: true, legacySearch: false }),
    log: () => get("/__log"),
    issues: async () => (await get("/rest/api/3/search?maxResults=100")).issues,
    posts: async (pattern) => (await get("/__log")).filter((e) => e.method === "POST" && pattern.test(e.path)).length,
    outage: (status = 503) => control({ override: { pathIncludes: "/rest/api", status, body: {}, times: 100000 } }),
    restore: () => control({ clearOverrides: true }),
  };
}

export const task = (id, title, extra = "", ac = ["works", "is verified"]) =>
  `TASK_ID: ${id}\nTITLE: ${title}\n${extra}AC:\n${ac.map((text, i) => `- AC-00${i + 1}: ${title} ${text}`).join("\n")}\n`;
export const planText = (version, ...blocks) => `Narrative that is not executable.\nLOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: ${version}\n\n${blocks.join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`;
export const TWO_TASKS = (version = 1) => planText(version, task("TASK-001", "First task"), task("TASK-002", "Second task", "DEPENDS_ON: TASK-001\n"));

export function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "controller-ws-"));
  const planFile = join(dir, "plan.txt");
  return {
    dir, planFile,
    setPlan: (text) => writeFileSync(planFile, text, "utf8"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function baseConfig({ ws, port, extra = {} }) {
  return {
    profile: "synthetic", workspaceDir: ws.dir, workspaceId: "ws-test", documentId: DOC, planFile: ws.planFile,
    jira: { site: `127.0.0.1:${port}`, scheme: "http", projectKey: "LOOP", issueTypeName: "Task", timeoutMs: 5000 },
    repository: { identity: "synthetic/repo", baseRef: "main" },
    timings: { instanceLeaseTtlMs: 30000, defaultWaitMs: 200 },
    ...extra,
  };
}

/** A manually advanced clock: every durable timestamp and retry time follows it. */
export function steppingClock(startIso = "2026-10-01T10:00:00.000Z") {
  let now = Date.parse(startIso);
  return { clock: () => new Date(now).toISOString(), advance: (ms) => { now += ms; }, now: () => now };
}

/** In-process Controller over the real stores, real curl transport to the mock, and synthetic lifecycle/agent. */
export function inProcessController({ ws, port, clock, overrides = {}, configExtra = {} }) {
  const config = baseConfig({ ws, port, extra: configExtra });
  const notifier = overrides.notifier ?? new FakeNotifier();
  const built = buildSyntheticController(config, ENV, { clock, notifier, ...overrides });
  const log = [];
  return { ...built, notifier, log, config };
}

/** Runs controller cycles until a stop condition; records every cycle result. */
export async function drive(handle, { until = (r) => r.outcome === "COMPLETED", maxCycles = 120, onCycle = null } = {}) {
  let last = null;
  for (let i = 0; i < maxCycles; i += 1) {
    last = await handle.controller.cycle();
    handle.log.push(last);
    if (onCycle) await onCycle(last, i);
    if (until(last)) return { last, cycles: i + 1 };
  }
  throw new Error(`controller did not reach the stop condition in ${maxCycles} cycles; last=${JSON.stringify(last)}`);
}

export function runProcess(configPath, { env = ENV, extraEnv = {} } = {}) {
  const child = spawn(process.execPath, ["--no-warnings", BIN, "--config", configPath], { env: { ...process.env, ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] });
  const lines = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); try { lines.push(JSON.parse(line)); } catch { lines.push({ raw: line }); } }
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal, lines, stderr })));
  return { child, lines, exited, stderr: () => stderr };
}
