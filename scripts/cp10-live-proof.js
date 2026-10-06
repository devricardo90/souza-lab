#!/usr/bin/env node
/**
 * CP-10 LIVE PROOF (A = clean path, B = finding -> autonomous correction -> CLEAN) through the REAL production stack:
 *   Jira (controlled LOOP test project) -> bin/loop-controller.js --config (profile "production") -> HermesAgentExecutor
 *   -> Hermes kanban (real `hermes` dispatcher, `coder` profile) -> real git worktree -> real GitHub PR + Actions CI
 *   (private sandbox repo only) -> command validator (`node --test`) -> independent Claude Code review (separate process/context)
 *   -> correction when required -> merge -> post-merge validation -> Jira completion.
 *
 *   node scripts/cp10-live-proof.js <A|B> --env-file <path to KEY=VALUE file with LOOP_JIRA_*> [--preflight] [--timeout-min 50]
 *
 * Credentials come only from the env file (outside the repo) into the child environment; they are never printed or written.
 * The evidence file is scrubbed of every secret value before it is written. No Jira issue is deleted; no other repository is touched.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROOF = (process.argv[2] ?? "").toUpperCase();
const argv = process.argv.slice(3);
const opt = (name, fallback = null) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const flag = (name) => argv.includes(name);
if (!["A", "B"].includes(PROOF)) { console.error("usage: node scripts/cp10-live-proof.js <A|B> --env-file <path> [--preflight]"); process.exit(2); }

const OWNER = "devricardo90"; const REPO = "souza-loop-sandbox";
const BOARD = "loop-cp10"; const ASSIGNEE = "coder";
const WORKFLOW = ".github/workflows/validate.yml";
const LOCAL = process.env.LOCALAPPDATA ?? "";
const HERMES = process.env.CP10_HERMES_EXE ?? join(LOCAL, "hermes", "bin", "hermes.exe");
const CLAUDE = process.env.CP10_CLAUDE_EXE ?? join(process.env.APPDATA ?? "", "..", "..", "..", "..", "nvm4w", "nodejs", "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
const STAMP = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(2, 14);
const TASK_ID = `CP10${PROOF}-${STAMP}`;
const IMPLEMENTER_EMAIL = "loop-cp10-hermes@users.noreply.github.com";
const COST_CAP_USD = 5;

const say = (event, detail = {}) => process.stdout.write(`${JSON.stringify({ event, at: new Date().toISOString(), ...detail })}\n`);
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
const tryRun = (cmd, args, options = {}) => { try { return run(cmd, args, options); } catch { return null; } };

// ---------------- env file (outside the repo); values stay in this object and the child environment ----------------
function loadEnvFile(path) {
  if (!path || !existsSync(path)) return null;
  const env = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !m[1].startsWith("#")) env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return env;
}
const jiraEnv = loadEnvFile(opt("--env-file"));
const NEEDED = ["LOOP_JIRA_EMAIL", "LOOP_JIRA_API_TOKEN", "LOOP_JIRA_CLOUD_ID"];
const secretValues = () => Object.values(jiraEnv ?? {}).filter((v) => typeof v === "string" && v.length >= 6);
const scrub = (text) => secretValues().reduce((out, v) => out.split(v).join("[REDACTED]").split(JSON.stringify(v).slice(1, -1)).join("[REDACTED]"), String(text));

// ---------------- preflight ----------------
function preflight() {
  const checks = [];
  const add = (name, ok, detail = "") => { checks.push({ name, ok: Boolean(ok), detail }); };
  add("env file", jiraEnv !== null, jiraEnv === null ? "pass --env-file <path> (file outside the repo)" : "loaded");
  for (const n of NEEDED) add(`env ${n}`, Boolean(jiraEnv?.[n]), jiraEnv?.[n] ? "set" : "missing");
  add("gh authenticated", tryRun("gh", ["auth", "status"]) !== null);
  add("sandbox repo reachable (private)", tryRun("gh", ["api", `repos/${OWNER}/${REPO}`, "--jq", ".private"]) === "true", `${OWNER}/${REPO}`);
  add("hermes.exe", existsSync(HERMES), HERMES);
  add("hermes board", (tryRun(HERMES, ["kanban", "boards", "list"]) ?? "").includes(BOARD), BOARD);
  add("hermes coder model", /gpt-4\.1/.test(tryRun(HERMES, ["-p", ASSIGNEE, "config", "get", "model"]) ?? ""), "profile coder -> copilot/gpt-4.1");
  add("claude.exe", existsSync(CLAUDE), CLAUDE);
  add("git", tryRun("git", ["--version"]) !== null);
  return checks;
}
const checks = preflight();
say("preflight", { proof: PROOF, taskId: TASK_ID, checks });
if (flag("--preflight")) process.exit(checks.every((c) => c.ok) ? 0 : 1);
if (!checks.every((c) => c.ok)) { say("abort", { reason: "preflight failed" }); process.exit(1); }

// ---------------- run directory, sandbox clone, plan, config ----------------
const RUN = mkdtempSync(join(tmpdir(), `cp10-live-${PROOF}-`));
const CLONE = join(RUN, "sandbox");
run("gh", ["repo", "clone", `${OWNER}/${REPO}`, CLONE], { timeout: 180000 });
run("git", ["config", "user.name", "Loop CP10 Hermes Implementer"], { cwd: CLONE });
run("git", ["config", "user.email", IMPLEMENTER_EMAIL], { cwd: CLONE });
run("git", ["config", "core.autocrlf", "false"], { cwd: CLONE });

const criteria = PROOF === "A"
  ? [`AC-001: src/greet.js exports a function greet(name) that returns the string "Hello, " followed by name and "!".`,
     "AC-002: test/greet.test.js tests greet using node:test and node:assert.",
     `AC-003: the first line of src/greet.js is exactly: // Loop-Reviewed: ${TASK_ID}`]
  : [`AC-001: src/greet.js exports a function greet(name) that returns the string "Hello, " followed by name and "!".`,
     "AC-002: test/greet.test.js tests greet using node:test and node:assert."];
const TITLE = PROOF === "A" ? "Add greet function (clean path)" : "Add greet function (finding and correction path)";
const planFile = join(RUN, "plan.txt");
writeFileSync(planFile, `Narrative that is not executable.\nLOOP_EXECUTION_PLAN: 1\nPLAN_VERSION: 1\n\nTASK_ID: ${TASK_ID}\nTITLE: ${TITLE}\nAC:\n${criteria.map((c) => `- ${c}`).join("\n")}\nEND_LOOP_EXECUTION_PLAN\n`, "utf8");

const cp08 = JSON.parse(readFileSync(join(ROOT, "docs", "evidence", "cp08-jira-live-config.json"), "utf8"));
const STATE = join(RUN, "state"); mkdirSync(STATE, { recursive: true });
const REVIEWER_LOG = join(RUN, "reviewer-log.jsonl");
const config = {
  profile: "production", workspaceDir: STATE, workspaceId: `cp10-${PROOF.toLowerCase()}-${STAMP}`, documentId: `cp10-${PROOF.toLowerCase()}-${STAMP}`,
  planSource: { file: planFile },
  jira: {
    mode: "scoped", projectKey: cp08.project.key, issueTypeName: cp08.taskIssueType.name, taskIdPattern: `^CP10${PROOF}-\\d+$`,
    observation: { source: "board", boardId: cp08.board.id }, relationship: cp08.relationship,
    completion: { doneStatusName: cp08.completion.doneStatusName, transitionName: cp08.completion.transitionName }, timeoutMs: 30000,
  },
  repository: { identity: `${OWNER}/${REPO}`, baseRef: "main" }, git: { repoPath: CLONE },
  github: { owner: OWNER, repo: REPO, baseBranch: "main", workflowIdentity: WORKFLOW, maxCorrections: 3, timeoutMs: 90000 },
  agent: { kind: "hermes", command: HERMES, board: BOARD, coderAssignee: ASSIGNEE, pollMs: 5000, maxPolls: 720 },
  validation: { command: process.execPath, args: ["--test"], timeoutMs: 300000 },
  review: { command: process.execPath, args: [join(ROOT, "scripts", "cp10-claude-reviewer.js"), "--claude", CLAUDE, "--policy", "loop-marker", "--log", REVIEWER_LOG, "--max-budget-usd", "0.5"], timeoutMs: 420000 },
  passEnv: [], exitOnCompleted: true,
  timings: { instanceLeaseTtlMs: 120000, defaultWaitMs: 5000, idlePollMs: 5000, blockedPollMs: 15000, standbyPollMs: 2000 },
};
const configPath = join(RUN, "config.json");
writeFileSync(configPath, JSON.stringify(config, null, 2), "utf8");
say("prepared", { runDir: RUN, taskId: TASK_ID, project: cp08.project.key, repo: `${OWNER}/${REPO}`, board: BOARD, implementerExecutable: HERMES, reviewerExecutable: CLAUDE });

// ---------------- Hermes dispatcher (separate process; stopped at the end) ----------------
const daemon = spawn(HERMES, ["kanban", "--board", BOARD, "daemon", "--interval", "5", "--pidfile", join(RUN, "hermes-daemon.pid")], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
const daemonLog = []; daemon.stdout.on("data", (c) => daemonLog.push(String(c))); daemon.stderr.on("data", (c) => daemonLog.push(String(c)));
const stopDaemon = () => { try { if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(daemon.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else daemon.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", stopDaemon);

// ---------------- the production CLI, as its own process ----------------
const timeoutMin = Number(opt("--timeout-min", "50"));
const lines = [];
const startedAt = Date.now();
const child = spawn(process.execPath, ["--no-warnings", join(ROOT, "bin", "loop-controller.js"), "--config", configPath], { env: { ...process.env, ...jiraEnv }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
let buffer = ""; let stderr = "";
child.stdout.on("data", (chunk) => { buffer += chunk; let i; while ((i = buffer.indexOf("\n")) >= 0) { const l = buffer.slice(0, i); buffer = buffer.slice(i + 1); try { const o = JSON.parse(l); lines.push(o); if (o.event === "cycle") say("cycle", { phase: o.phase, outcome: o.outcome, code: o.code, detail: o.detail }); } catch { lines.push({ raw: scrub(l) }); } } });
child.stderr.on("data", (chunk) => { stderr += chunk; });
const killer = setTimeout(() => { say("timeout", { minutes: timeoutMin }); try { child.kill(); } catch { /* gone */ } }, timeoutMin * 60000);
const exit = await new Promise((resolveExit) => child.on("close", (code, signal) => resolveExit({ code, signal })));
clearTimeout(killer); stopDaemon();
say("controller-exit", { code: exit.code, signal: exit.signal, seconds: Math.round((Date.now() - startedAt) / 1000) });

// ---------------- evidence ----------------
const { SqliteExecutionAttemptStore } = await import(pathToFileURL(join(ROOT, "src/adapters/sqlite-execution-attempt-store.js")).href);
const { SqliteGateFactStore } = await import(pathToFileURL(join(ROOT, "src/adapters/sqlite-gate-fact-store.js")).href);
const { SqliteControllerStore } = await import(pathToFileURL(join(ROOT, "src/adapters/sqlite-controller-store.js")).href);
const { SqliteOutboxStore } = await import(pathToFileURL(join(ROOT, "src/adapters/sqlite-outbox-store.js")).href);
const attemptStore = new SqliteExecutionAttemptStore({ path: join(STATE, "execution-attempts.sqlite") });
const gateStore = new SqliteGateFactStore({ path: join(STATE, "gate-facts.sqlite") });
const controllerStore = new SqliteControllerStore({ path: join(STATE, "controller.sqlite") });
const outboxStore = new SqliteOutboxStore({ path: join(STATE, "outbox.sqlite") });
const attemptRow = attemptStore.db.prepare("SELECT execution_id FROM execution_attempts").get();
const attempt = attemptRow ? attemptStore.get(attemptRow.execution_id) : null;
const rows = (store, sql, ...p) => store.db.prepare(sql).all(...p);
const reviews = attempt ? rows(gateStore, "SELECT head, verdict, payload, created_at FROM gate_reviews WHERE execution_id = ? ORDER BY rowid", attempt.executionId).map((r) => ({ head: r.head, verdict: r.verdict, reviewerId: JSON.parse(r.payload).reviewerId, at: r.created_at })) : [];
const findings = attempt ? rows(gateStore, "SELECT head, payload FROM gate_findings WHERE execution_id = ? ORDER BY rowid", attempt.executionId).map((r) => ({ head: r.head, findings: JSON.parse(r.payload) })) : [];
const validations = attempt ? rows(gateStore, "SELECT head, post_merge, payload FROM gate_validations WHERE execution_id = ? ORDER BY rowid", attempt.executionId).map((r) => ({ head: r.head, postMerge: r.post_merge === 1, result: JSON.parse(r.payload).result })) : [];
const outbox = rows(outboxStore, "SELECT operation_id, action, task_id, target_object, status, attempt_count FROM outbox_operations ORDER BY rowid");
const controllerRows = controllerStore.list().map((r) => ({ taskId: r.taskId, status: r.status }));
const branchCommits = attempt && attempt.branch ? (tryRun("git", ["log", "--format=%H|%ae|%s", `${attempt.baseSha}..${attempt.branch}`], { cwd: CLONE }) ?? "").split("\n").filter(Boolean).map((l) => { const [sha, email, subject] = l.split("|"); return { sha, authorEmail: email, subject }; }) : [];
const prs = attempt ? JSON.parse(tryRun("gh", ["pr", "list", "-R", `${OWNER}/${REPO}`, "--head", attempt.branch, "--state", "all", "--json", "number,state,mergedAt,mergeCommit,title,url,headRefOid"]) ?? "[]") : [];
const openLoopPrs = JSON.parse(tryRun("gh", ["pr", "list", "-R", `${OWNER}/${REPO}`, "--state", "open", "--json", "number,headRefName"]) ?? "[]").filter((p) => /^loop\//.test(p.headRefName));
const hermesTasks = (() => { try { const j = JSON.parse(run(HERMES, ["kanban", "--board", BOARD, "list", "--json"])); return (Array.isArray(j) ? j : j.tasks ?? []).filter((t) => attempt && String(t.title ?? "").length >= 0).map((t) => ({ id: t.id, title: t.title, status: t.status, assignee: t.assignee, started_at: t.started_at, completed_at: t.completed_at })); } catch { return []; } })();
const reviewerLog = existsSync(REVIEWER_LOG) ? readFileSync(REVIEWER_LOG, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const modelCalls = reviewerLog.filter((e) => e.kind === "model-call");
const reviewerCostUsd = modelCalls.reduce((sum, e) => sum + (Number(e.costUsd) || 0), 0);
const jiraKey = outbox.find((o) => o.action === "JIRA_CREATE")?.target_object ?? null;

const h1 = attempt?.agentResult?.head ?? null;
const mergedHead = prs[0]?.headRefOid ?? null;
const evidence = {
  proof: PROOF, taskId: TASK_ID, generatedAt: new Date().toISOString(), controllerExit: exit,
  identities: {
    IMPLEMENTER_IDENTITY: attempt?.agentResult?.authorId ?? null, REVIEWER_IDENTITY: [...new Set(reviews.map((r) => r.reviewerId))],
    IMPLEMENTER_EXECUTABLE: HERMES, REVIEWER_EXECUTABLE: CLAUDE, implementerModel: "copilot/gpt-4.1 (hermes profile coder)", reviewerModel: "claude code headless (default model)",
  },
  jira: { project: cp08.project.key, issueKey: jiraKey, outbox, controllerRows },
  github: { repo: `${OWNER}/${REPO}`, branch: attempt?.branch ?? null, pullRequests: prs, openLoopPullRequestsAfter: openLoopPrs },
  git: { executionId: attempt?.executionId ?? null, baseSha: attempt?.baseSha ?? null, firstHead: h1, finalHead: mergedHead, branchCommits },
  gate: { reviews, findings, validations },
  hermes: { board: BOARD, assignee: ASSIGNEE, tasks: hermesTasks },
  correction: { rounds: findings.length, headsReviewed: reviews.map((r) => r.head), firstHeadStaleForFinalHead: h1 !== null && mergedHead !== null && h1 !== mergedHead },
  cost: { reviewerModelCalls: modelCalls.length, reviewerMeasuredUsd: Number(reviewerCostUsd.toFixed(4)), hermesNote: "Hermes ran on the GitHub Copilot provider (gpt-4.1); Copilot does not report per-call cost to Hermes, so it is not measured here", capUsd: COST_CAP_USD },
  reviewerLog,
  controllerLog: lines.filter((l) => l.event === "cycle" || l.event === "exit" || l.event === "fatal").map((l) => ({ event: l.event, phase: l.phase, outcome: l.outcome, code: l.code, detail: l.detail, exit: l.exit })),
  stderrTail: scrub(stderr).slice(-400),
};
const evidenceText = scrub(JSON.stringify(evidence, null, 2));
const out = join(ROOT, "docs", "evidence", `CP-10-LIVE-PROOF-${PROOF}.json`);
writeFileSync(out, `${evidenceText}\n`, "utf8");
for (const store of [attemptStore, gateStore, controllerStore, outboxStore]) { try { store.close(); } catch { /* closed */ } }
const completed = controllerRows.some((r) => r.status === "REMOTE_DONE_CONFIRMED") && exit.code === 0;
say("result", { proof: PROOF, completed, evidenceFile: out, jiraKey, reviews: reviews.map((r) => `${r.head.slice(0, 8)}:${r.verdict}`), corrections: findings.length, reviewerCostUsd: evidence.cost.reviewerMeasuredUsd });
process.exit(completed ? 0 : 1);
