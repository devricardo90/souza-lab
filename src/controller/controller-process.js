/**
 * Process loop for a single persistent Controller (systemd / Docker / any supervisor).
 * All waiting is a deterministic timer or an abort signal: no polling LLM, no model call, ever.
 *
 *   start -> acquire the instance lease (standby if another instance owns the workspace)
 *         -> recover -> run cycles -> wait efficiently -> SIGTERM => finish the current cycle, persist, release, exit
 *
 * Waiting renews the instance lease in chunks so a long wait never lets the lease expire.
 */

const defaultSleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(() => { signal?.removeEventListener?.("abort", onAbort); resolve(); }, Math.max(0, ms));
  const onAbort = () => { clearTimeout(timer); resolve(); };
  signal?.addEventListener?.("abort", onAbort, { once: true });
});

export async function runControllerLoop({
  controller, signal = null, sleep = defaultSleep, exitOnCompleted = false,
  standbyPollMs = 1000, idlePollMs = 5000, blockedPollMs = 30000, minWaitMs = 50, onCycle = () => {}, maxCycles = Infinity,
} = {}) {
  let cycles = 0;
  let exit = "SIGNALED";
  const leaseChunkMs = Math.max(100, Math.floor(controller.instanceLeaseTtlMs / 3));
  const waitUntil = async (targetMs) => {
    while (!signal?.aborted) {
      const remaining = targetMs - Date.now();
      if (remaining <= 0) return;
      await sleep(Math.min(remaining, leaseChunkMs), signal);
      if (!signal?.aborted && targetMs - Date.now() > 0) await controller.renewLease();
    }
  };
  try {
    while (!signal?.aborted && cycles < maxCycles) {
      if (!controller.lease) {
        const started = await controller.start();
        if (!started.owner) { await sleep(standbyPollMs, signal); continue; } // standby: another instance owns the workspace
        onCycle({ phase: "STARTED", report: started.report });
      }
      const result = await controller.cycle();
      cycles += 1;
      onCycle(result);
      if (result.code === "CONTROLLER_LEASE_LOST") { exit = "LEASE_LOST"; break; }
      if (result.outcome === "COMPLETED" && exitOnCompleted) { exit = "COMPLETED"; break; }
      if (result.outcome === "CONTINUE") { await sleep(0, signal); continue; }
      const base = ["COMPLETED", "IDLE"].includes(result.outcome) ? idlePollMs
        : ["BLOCK_GLOBAL", "BLOCK_TASK", "OWNER_DECISION_REQUIRED"].includes(result.outcome) ? blockedPollMs : idlePollMs;
      const target = result.nextWakeAt ? Date.parse(result.nextWakeAt) : Date.now() + base;
      await waitUntil(Math.max(Date.now() + minWaitMs, target));
    }
    if (cycles >= maxCycles) exit = "MAX_CYCLES";
  } finally {
    await controller.stop(); // persist-before-exit: the instance lease is released; stores are durable on every commit
  }
  return Object.freeze({ exit, cycles });
}
