import { parentPort, workerData } from "node:worker_threads";
import { LocalExecutionLeaseProvider } from "../adapters/local-execution-lease-provider.js";

/**
 * Instance-lease heartbeat on its OWN thread. The Controller's providers (git, gh, curl) are synchronous and can block the
 * main thread for many seconds; a timer on the main thread cannot fire during that time, so a long blocking stretch would let
 * the lease expire under a live, working Controller. This thread keeps renewing the same lease (same id, owner and fencing
 * token) independently. If a renewal fails (lease fenced out or expired) it reports it and stops; the main thread then ends
 * its authority at its next step. No model, no I/O other than the lease file.
 */
const { directory, ttlMs, intervalMs } = workerData;
const provider = new LocalExecutionLeaseProvider({ directory, defaultTtlMs: Math.max(100, ttlMs) });
let lease = workerData.lease;
const timer = setInterval(() => {
  try { lease = provider.renew(lease, { ttlMs }); }
  catch (error) { clearInterval(timer); parentPort.postMessage({ ok: false, code: error.code ?? "RENEW_FAILED", message: String(error.message) }); }
}, intervalMs);
parentPort.on("message", (message) => {
  if (message?.type === "stop") { clearInterval(timer); process.exit(0); }
  if (message?.type === "lease") lease = message.lease;
});
