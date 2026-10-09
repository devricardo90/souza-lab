/**
 * Generic live-proof fixture preflight. It runs against the CURRENT baseline BEFORE any external side effect (Jira, branch, PR) and proves
 * that the scenario is a valid test: the requested capability does not exist yet, the acceptance criteria are not already satisfied, and
 * the task therefore necessarily requires a non-empty diff. A scenario that fails it is INVALID_FIXTURE_PREVENTED_BEFORE_SIDE_EFFECTS.
 *
 *   scenario = {
 *     id,
 *     expectedNewFiles: ["src/x.js", ...],            the surface a correct implementation must add (used to detect a no-op)
 *     acProbe: { command, args },                     runs in the baseline checkout; exit 0 means "the AC is already satisfied"
 *   }
 */
import { spawnSync } from "node:child_process";

export const FIXTURE_VALID = "FIXTURE_VALID";
export const FIXTURE_INVALID = "INVALID_FIXTURE_PREVENTED_BEFORE_SIDE_EFFECTS";

const git = (cwd, args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });

export function fixturePreflight({ repoDir, scenario, probeTimeoutMs = 30000 }) {
  const checks = [];
  const add = (name, ok, detail = "") => checks.push({ name, ok: Boolean(ok), detail });
  const head = git(repoDir, ["rev-parse", "HEAD"]);
  const baselineSha = head.status === 0 ? head.stdout.trim() : null;
  add("baseline SHA recorded", /^[0-9a-f]{40}$/.test(baselineSha ?? ""), baselineSha ?? "unresolvable");
  const files = Array.isArray(scenario?.expectedNewFiles) ? scenario.expectedNewFiles : [];
  add("expected affected surface is declared", files.length > 0 && files.every((f) => typeof f === "string" && f !== ""), files.join(", "));
  const present = baselineSha ? files.filter((f) => git(repoDir, ["cat-file", "-e", `${baselineSha}:${f}`]).status === 0) : files;
  add("requested capability does not already exist at the baseline", files.length > 0 && present.length === 0, present.length ? `already present: ${present.join(", ")}` : "none of the expected files exist");
  let probeDetail = "no probe declared"; let unsatisfied = false;
  if (scenario?.acProbe?.command) {
    const probe = spawnSync(scenario.acProbe.command, scenario.acProbe.args ?? [], { cwd: repoDir, encoding: "utf8", windowsHide: true, timeout: probeTimeoutMs });
    unsatisfied = probe.error === undefined && probe.status !== 0 && probe.status !== null;
    probeDetail = probe.error ? `probe could not run: ${probe.error.code ?? probe.error.message}` : `probe exit ${probe.status} (0 would mean the acceptance criteria are already satisfied)`;
  }
  add("acceptance criteria are NOT already satisfied at the baseline", unsatisfied, probeDetail);
  add("task necessarily requires a non-empty diff", files.length > 0 && present.length === 0 && unsatisfied, "every expected file is absent and the AC probe fails at the baseline");
  const ok = checks.every((c) => c.ok);
  return { ok, result: ok ? FIXTURE_VALID : FIXTURE_INVALID, scenarioId: scenario?.id ?? null, baselineSha, expectedNewFiles: files, checks };
}
