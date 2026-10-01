#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runControllerLoop } from "../src/controller/controller-process.js";

/**
 * Standalone Controller process (run under systemd / Docker / any supervisor).
 *   node bin/loop-controller.js --config <path-to-json>
 * argv carries only a config FILE PATH; secrets come from the environment (LOOP_JIRA_EMAIL / LOOP_JIRA_API_TOKEN).
 * SIGTERM / SIGINT: the current cycle finishes, state is already durable, the instance lease is released, exit 0.
 * Exit codes: 0 graceful / completed, 70 internal error, 75 lease lost, 78 configuration error.
 * Only the "synthetic" profile exists in CP-05; real Google/Jira/GitHub/agent composition is deliberately not wired.
 */

function parseArgs(argv) {
  const index = argv.indexOf("--config");
  if (index < 0 || !argv[index + 1]) throw Object.assign(new Error("usage: loop-controller --config <path>"), { code: "CONFIG_INVALID" });
  return argv[index + 1];
}

const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

let exitCode = 0;
try {
  const config = JSON.parse(readFileSync(parseArgs(process.argv.slice(2)), "utf8"));
  if (config.profile !== "synthetic") throw Object.assign(new Error(`unsupported profile "${config.profile}" (only "synthetic" exists in CP-05)`), { code: "CONFIG_INVALID" });
  const { buildSyntheticController } = await import("../src/testing/synthetic-profile.js");
  const { controller, close } = buildSyntheticController(config);
  const abort = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { log({ event: "signal", signal }); abort.abort(); });
  try {
    const result = await runControllerLoop({
      controller, signal: abort.signal, exitOnCompleted: config.exitOnCompleted === true,
      idlePollMs: config.timings?.idlePollMs ?? 5000, standbyPollMs: config.timings?.standbyPollMs ?? 1000,
      blockedPollMs: config.timings?.blockedPollMs ?? 30000,
      onCycle: (cycle) => log({ event: "cycle", outcome: cycle.outcome ?? cycle.phase, phase: cycle.phase, taskId: cycle.taskId ?? null, code: cycle.code ?? null }),
    });
    log({ event: "exit", ...result });
    if (result.exit === "LEASE_LOST") exitCode = 75;
  } finally { close(); }
} catch (error) {
  log({ event: "fatal", code: error.code ?? "INTERNAL", message: String(error.message).slice(0, 300) });
  exitCode = error.code === "CONFIG_INVALID" ? 78 : 70;
}
process.exit(exitCode);
