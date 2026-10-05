#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runControllerLoop } from "../src/controller/controller-process.js";
import { buildControllerForProfile } from "../src/controller/profile-selector.js";

/**
 * Standalone Controller process (run under systemd / Docker / any supervisor).
 *   node bin/loop-controller.js --config <path-to-json>
 * argv carries only a config FILE PATH; secrets come from the environment (LOOP_JIRA_EMAIL / LOOP_JIRA_API_TOKEN).
 * SIGTERM / SIGINT: the current cycle finishes, state is already durable, the instance lease is released, exit 0.
 * Exit codes: 0 graceful / completed, 70 internal error, 75 lease lost, 78 configuration error.
 * The profile is chosen EXPLICITLY by config.profile ("synthetic" | "production"). There is no default and no fallback: a missing,
 * unknown or invalid profile/configuration exits 78 and never degrades into synthetic mode (see src/controller/profile-selector.js).
 * "production" is the CP-09 composition (Jira + HermesAgentExecutor + Git/GitHub + command validator/reviewer; no Google required).
 * Logged text is scrubbed of the values of credential-looking environment variables.
 */

function parseArgs(argv) {
  const index = argv.indexOf("--config");
  if (index < 0 || !argv[index + 1]) throw Object.assign(new Error("usage: loop-controller --config <path>"), { code: "CONFIG_INVALID" });
  return argv[index + 1];
}

const SECRET_NAME = /token|secret|password|passwd|api[-_]?key|credential|authorization/i;
const secretValues = () => Object.entries(process.env).filter(([name, value]) => (SECRET_NAME.test(name) || /^LOOP_JIRA_/.test(name)) && typeof value === "string" && value.length >= 6).map(([, value]) => value);
const scrub = (text) => secretValues().reduce((out, value) => out.split(value).join("[REDACTED]"), text);
const log = (entry) => process.stdout.write(`${scrub(JSON.stringify(entry))}\n`);

let exitCode = 0;
try {
  const config = JSON.parse(readFileSync(parseArgs(process.argv.slice(2)), "utf8"));
  const { controller, close } = await buildControllerForProfile(config);
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { log({ event: "signal", signal }); abort.abort(); });
  try {
    const result = await runControllerLoop({
      controller, signal: abort.signal, exitOnCompleted: config.exitOnCompleted === true,
      idlePollMs: config.timings?.idlePollMs ?? 5000, standbyPollMs: config.timings?.standbyPollMs ?? 1000,
      blockedPollMs: config.timings?.blockedPollMs ?? 30000,
      onCycle: (cycle) => log({ event: "cycle", outcome: cycle.outcome ?? cycle.phase, phase: cycle.phase, taskId: cycle.taskId ?? null, code: cycle.code ?? null, detail: cycle.detail ? String(cycle.detail).slice(0, 200) : undefined }),
    });
    log({ event: "exit", ...result });
    if (result.exit === "LEASE_LOST") exitCode = 75;
  } finally { close(); }
} catch (error) {
  log({ event: "fatal", code: error.code ?? "INTERNAL", message: String(error.message).slice(0, 300) });
  exitCode = error.code === "CONFIG_INVALID" ? 78 : 70;
}
process.exit(exitCode);
