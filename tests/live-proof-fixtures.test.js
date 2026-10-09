import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixturePreflight, FIXTURE_INVALID, FIXTURE_VALID } from "../scripts/lib/fixture-preflight.js";
import { buildReviewPrompt, emptyDiffFinding, isEmptyDiff } from "../scripts/lib/cp10-review-material.js";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const AUTHOR = ["-c", "user.name=T", "-c", "user.email=t@example.invalid"];
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "fixture-"));
  git(dir, ["init", "-q", "-b", "main"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  git(dir, ["add", "-A"]); git(dir, [...AUTHOR, "commit", "-q", "-m", "baseline"]);
  return dir;
}
const probeSource = "const m = await import('./src/farewell.js'); process.exit(typeof m.farewell === 'function' && m.farewell('X') === 'Goodbye, X!' ? 0 : 1)";
const probe = { command: process.execPath, args: ["--input-type=module", "-e", probeSource] };
const scenario = { id: "farewell", expectedNewFiles: ["src/farewell.js", "test/farewell.test.js"], acProbe: probe };

test("fixture preflight: a baseline that lacks the capability is a VALID fixture and records the baseline SHA", () => {
  const dir = repo({});
  const out = fixturePreflight({ repoDir: dir, scenario });
  assert.equal(out.result, FIXTURE_VALID); assert.equal(out.ok, true);
  assert.equal(out.baselineSha, git(dir, ["rev-parse", "HEAD"]));
  assert.ok(out.checks.every((c) => c.ok));
});

test("fixture preflight: a baseline that already satisfies the AC is INVALID_FIXTURE_PREVENTED_BEFORE_SIDE_EFFECTS", () => {
  const dir = repo({ "src/farewell.js": "export const farewell = (n) => `Goodbye, ${n}!`;\n", "package.json": '{"type":"module"}\n' });
  const out = fixturePreflight({ repoDir: dir, scenario });
  assert.equal(out.result, FIXTURE_INVALID); assert.equal(out.ok, false);
  assert.equal(out.checks.find((c) => c.name.startsWith("requested capability")).ok, false);
  assert.equal(out.checks.find((c) => c.name.startsWith("acceptance criteria")).ok, false);
  assert.equal(out.checks.find((c) => c.name.startsWith("task necessarily")).ok, false);
});

test("fixture preflight: no declared surface, an unrunnable probe or no probe never counts as valid", () => {
  const dir = repo({});
  assert.equal(fixturePreflight({ repoDir: dir, scenario: { id: "x", expectedNewFiles: [], acProbe: probe } }).ok, false);
  assert.equal(fixturePreflight({ repoDir: dir, scenario: { ...scenario, acProbe: { command: "definitely-not-a-command-xyz", args: [] } } }).ok, false);
  assert.equal(fixturePreflight({ repoDir: dir, scenario: { ...scenario, acProbe: undefined } }).ok, false);
});

const wp = { taskId: "T-1", title: "Add farewell", acceptanceCriteria: [{ id: "AC-001", text: "farewell(name) returns Goodbye" }] };
const BASE = "a".repeat(40); const HEAD = "b".repeat(40);

test("reviewer request: a non-empty candidate diff is contained verbatim in the model prompt", () => {
  const diff = "diff --git a/src/farewell.js b/src/farewell.js\n+export const farewell = (n) => `Goodbye, ${n}!`;\n";
  assert.equal(isEmptyDiff(diff), false);
  const prompt = buildReviewPrompt({ workPackage: wp, base: BASE, head: HEAD, diff });
  assert.ok(prompt.includes(diff));
  assert.ok(prompt.includes("AC-001: farewell(name) returns Goodbye"));
  assert.ok(prompt.includes(`Diff under review (${BASE.slice(0, 8)}..${HEAD.slice(0, 8)}):\n${diff}`));
});

test("reviewer request: an empty candidate diff is explicitly empty and is a deterministic finding, not a model call", () => {
  for (const empty of ["", "   \n", null, undefined]) assert.equal(isEmptyDiff(empty), true);
  const finding = emptyDiffFinding(BASE, HEAD);
  assert.equal(finding.id, "F-EMPTY-DIFF"); assert.equal(finding.source, "policy"); assert.match(finding.summary, /empty diff/);
});

const wrapper = fileURLToPath(new URL("../scripts/cp10-claude-reviewer.js", import.meta.url));
const review = (dir, base, head, extra = []) => spawnSync(process.execPath, [wrapper, "--claude", "definitely-not-claude", ...extra], {
  input: JSON.stringify({ kind: "implementation", workPackage: wp, head, base, workspacePath: dir, authorId: "impl@example.invalid", changedFiles: [] }), encoding: "utf8", windowsHide: true,
});

test("reviewer wrapper end to end: an empty-diff candidate returns FINDINGS without invoking any model", () => {
  const dir = repo({});
  const base = git(dir, ["rev-parse", "HEAD"]);
  git(dir, [...AUTHOR, "commit", "-q", "--allow-empty", "-m", "empty candidate"]);
  const run = review(dir, base, git(dir, ["rev-parse", "HEAD"]));
  assert.equal(run.status, 0, run.stderr);
  const out = JSON.parse(run.stdout);
  assert.equal(out.verdict, "FINDINGS");
  assert.deepEqual(out.findings.map((f) => f.id), ["F-EMPTY-DIFF"]);
});

test("live-proof orchestrator: an INVALID fixture aborts before any controller spawn, Jira/branch/PR or Hermes side effect", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(fileURLToPath(new URL("../scripts/cp10-live-proof.js", import.meta.url)), "utf8");
  const abort = src.indexOf("if (!fixture.ok) { say(\"abort\"");
  assert.ok(abort > 0, "the preflight abort exists");
  for (const sideEffect of ["const child = spawn(", "\"pr\", \"list\""]) {
    assert.ok(src.indexOf(sideEffect) > abort, `${sideEffect} must come after the fixture-preflight abort`);
  }
  assert.match(src.slice(abort - 400, abort), /fixturePreflight\(\{ repoDir: CLONE, scenario: SCENARIO \}\)/);
});
