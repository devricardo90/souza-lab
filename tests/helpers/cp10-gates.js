// Deterministic gate scripts run as REAL child processes by the production profile (review.command / validation.command).
//   node cp10-gates.js review <stateDir> <mode>     JSON review request on stdin -> JSON reviewer output on stdout
//   node cp10-gates.js validate <stateDir>          exit 0; records the exact HEAD it validated
// Every call is appended to <stateDir>/<kind>.jsonl so tests can assert order, heads and what the child process could see.
// Modes: clean | findings-then-clean | always-findings | owner-decision | same-as-author | unavailable
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [kind, stateDir, mode = "clean"] = process.argv.slice(2);
mkdirSync(stateDir, { recursive: true });
const log = (name, entry) => appendFileSync(join(stateDir, `${name}.jsonl`), `${JSON.stringify(entry)}\n`);
const read = (name) => (existsSync(join(stateDir, `${name}.jsonl`)) ? readFileSync(join(stateDir, `${name}.jsonl`), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const REVIEWER_ID = "cp10-reviewer@example.invalid";

if (kind === "validate") {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
  log("validations", { head, envNames: Object.keys(process.env) });
  process.exit(0);
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  const request = JSON.parse(raw);
  const previousImplementationReviews = read("reviews").filter((r) => r.kind === "implementation").length;
  log("reviews", { kind: request.kind, head: request.head ?? null, authorId: request.authorId ?? null, raw, envNames: Object.keys(process.env) });
  let out = { verdict: "CLEAN", reviewerId: REVIEWER_ID, findings: [] };
  if (request.kind === "implementation") {
    if (mode === "unavailable") process.exit(3);
    if (mode === "findings-then-clean" && previousImplementationReviews === 0) out = { verdict: "FINDINGS", reviewerId: REVIEWER_ID, findings: [{ id: "F-1", summary: "no test covers the new behaviour" }] };
    if (mode === "always-findings") out = { verdict: "FINDINGS", reviewerId: REVIEWER_ID, findings: [{ id: `F-${previousImplementationReviews + 1}`, summary: "still not good enough" }] };
    if (mode === "owner-decision") out = { verdict: "FINDINGS", reviewerId: REVIEWER_ID, findings: [{ id: "F-OWNER", summary: "the change needs an architecture decision", ownerDecision: true }] };
    if (mode === "same-as-author") out = { verdict: "CLEAN", reviewerId: request.authorId, findings: [] };
  }
  process.stdout.write(JSON.stringify(out));
});
