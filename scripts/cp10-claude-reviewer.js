#!/usr/bin/env node
/**
 * CP-10 live-proof independent reviewer: a SEPARATE execution context from the Hermes implementer (Claude Code, headless, no tools).
 * It speaks the CommandIndependentReviewer contract: one JSON review request on stdin, one JSON reviewer output on stdout.
 *
 *   node scripts/cp10-claude-reviewer.js --claude <path to claude.exe> [--policy loop-marker] [--log <jsonl>] [--max-budget-usd 0.5]
 *
 * Findings come from two sources and are recorded with their source:
 *   policy  deterministic repository convention checked from Git (policy "loop-marker": every added or changed non-test .js file must
 *           begin with the exact line `// Loop-Reviewed: <taskId>`). The task text deliberately does not state the convention, so a
 *           first implementation that follows only the task text receives a deterministic, repairable finding.
 *   llm     Claude's own review of the diff against the acceptance criteria (no tools, no file access, diff text only).
 * CLEAN requires both to be clean. If the reviewer cannot run it exits non-zero (the Loop treats that as UNAVAILABLE, never a verdict).
 * Nothing secret is logged: the log holds heads, finding ids/sources, the binary path, duration and cost.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const argv = process.argv.slice(2);
const opt = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const CLAUDE = opt("--claude");
const POLICY = opt("--policy", "none");
const LOG = opt("--log");
const BUDGET = opt("--max-budget-usd", "0.5");
const REVIEWER_ID = "claude-code-reviewer@loop.invalid";
const MAX_DIFF = 60000;

const log = (entry) => { if (LOG) { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`); } };
const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const fail = (message) => { process.stderr.write(`${message}\n`); process.exit(3); };

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  let request;
  try { request = JSON.parse(raw); } catch { fail("review request is not JSON"); }
  // The contract carries id/summary/ownerDecision only; the finding's source (policy | llm) is kept in the evidence log.
  const out = (findings, defaultSource) => {
    const verdict = findings.length === 0 ? "CLEAN" : "FINDINGS";
    process.stdout.write(JSON.stringify({ verdict, reviewerId: REVIEWER_ID, findings: findings.map(({ source, ...rest }) => rest) }));
    log({ kind: request.kind, head: request.head ?? null, verdict, findings: findings.map((f) => ({ id: f.id, source: f.source ?? defaultSource })), reviewerExecutable: CLAUDE });
  };

  if (request.kind === "spec") {
    const criteria = request.workPackage?.acceptanceCriteria ?? [];
    return out(criteria.length > 0 ? [] : [{ id: "F-SPEC-1", summary: "the work package has no acceptance criteria" }], "policy");
  }
  if (!CLAUDE) fail("--claude <path> is required");
  const { workspacePath, base, head, workPackage } = request;
  if (!workspacePath || !/^[0-9a-f]{40}$/.test(base ?? "") || !/^[0-9a-f]{40}$/.test(head ?? "")) fail("implementation request lacks workspacePath/base/head");

  // ---- deterministic policy findings (from Git, bound to the exact head) ----
  const policyFindings = [];
  const changed = git(workspacePath, ["diff", "--name-only", `${base}..${head}`]).split("\n").map((s) => s.trim()).filter(Boolean);
  if (POLICY === "loop-marker") {
    const marker = `// Loop-Reviewed: ${workPackage.taskId}`;
    for (const file of changed.filter((f) => /\.js$/.test(f) && !/(^|\/)(tests?|__tests__)\//.test(f) && !/\.(test|spec)\.js$/.test(f))) {
      let first = "";
      try { first = git(workspacePath, ["show", `${head}:${file}`]).split(/\r?\n/, 1)[0].trim(); } catch { first = ""; }
      if (first !== marker) policyFindings.push({ id: `F-MARKER-${policyFindings.length + 1}`, source: "policy", summary: `Repository convention: every added or changed non-test .js file must begin with the exact first line \`${marker}\`; ${file} does not. Add that line; do not change behaviour.` });
    }
  }

  // ---- independent LLM review of the diff (no tools, diff text only) ----
  let diff = git(workspacePath, ["diff", "--no-color", `${base}..${head}`]);
  if (diff.length > MAX_DIFF) diff = `${diff.slice(0, MAX_DIFF)}\n[diff truncated]`;
  const criteria = (workPackage.acceptanceCriteria ?? []).map((c) => `- ${c.id}: ${c.text}`).join("\n");
  const system = "You are an independent code reviewer in an automated delivery loop. You review ONLY the diff you are given against the acceptance criteria. "
    + "Report only concrete defects that violate an acceptance criterion or are clear correctness bugs, each fixable by the implementer without a product, scope, architecture or security decision. "
    + "Do not report style preferences, missing extras, or repository conventions that are not in the criteria. If you are unsure, do not report it. "
    + 'Answer with ONE JSON object and nothing else: {"findings":[{"id":"F-LLM-1","summary":"...","ownerDecision":false}]}. An empty findings array means the change is acceptable. Set ownerDecision true only if fixing the finding needs a human decision.';
  const prompt = `Task ${workPackage.taskId}: ${workPackage.title}\n\nAcceptance criteria:\n${criteria || "- (none)"}\n\nDiff under review (${base.slice(0, 8)}..${head.slice(0, 8)}):\n${diff}`;
  const started = Date.now();
  const run = spawnSync(CLAUDE, ["-p", "--output-format", "json", "--no-session-persistence", "--tools", "", "--max-budget-usd", BUDGET, "--system-prompt", system], {
    input: prompt, encoding: "utf8", windowsHide: true, timeout: 300000, maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error || run.status !== 0) fail(`reviewer model call failed (exit ${run.status ?? "none"})`);
  let envelope; try { envelope = JSON.parse(run.stdout); } catch { fail("reviewer model output is not JSON"); }
  if (envelope?.is_error === true) fail("reviewer model reported an error");
  const text = String(envelope?.result ?? "");
  const match = /\{[\s\S]*\}/.exec(text);
  let parsed = null; try { parsed = match ? JSON.parse(match[0]) : null; } catch { parsed = null; }
  if (!parsed || !Array.isArray(parsed.findings)) fail("reviewer model answer is not the expected JSON");
  const llmFindings = parsed.findings.slice(0, 3).map((f, i) => ({ id: String(f.id ?? `F-LLM-${i + 1}`), source: "llm", summary: String(f.summary ?? "").slice(0, 600) || "unspecified", ...(f.ownerDecision === true ? { ownerDecision: true } : {}) }));
  log({ kind: "model-call", head, durationMs: Date.now() - started, costUsd: envelope?.total_cost_usd ?? null, reviewerExecutable: CLAUDE });
  out([...policyFindings, ...llmFindings], "llm");
});
