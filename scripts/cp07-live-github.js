import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { baseConfig, planText, startMock, task, workspace } from "../tests/helpers/controller-harness.js";
import { buildSyntheticController } from "../src/testing/synthetic-profile.js";
import { WorkspaceCommandValidator } from "../src/adapters/workspace-command-validator.js";
import { createTransientAwareGhRunner } from "../src/adapters/gh-runner.js";
import { GitHubSCMProvider, GitHubSCMError } from "../src/adapters/github-scm-provider.js";
import { GitHubCIProvider, GitHubCIError } from "../src/adapters/github-ci-provider.js";
import { RuntimeObserver } from "../src/core/runtime-observer.js";
import { executionFactsFingerprint } from "../src/core/runtime-contracts.js";

/**
 * CP-07 CONTROLLED LIVE PROOF. One real lifecycle through the full Controller composition against the EXISTING Phase 6
 * sandbox only (private repo devricardo90/souza-loop-sandbox), using the existing `gh` login (no new credentials):
 *   real local git worktree -> real push -> real GitHub PR -> real GitHub Actions CI (exact SHA) -> real command validation ->
 *   deterministic offline reviewer (the real independent-review provider does not exist yet) -> real GitHub merge (expected SHA) ->
 *   read-back -> post-merge validation on the real merge commit -> LOCAL_DONE -> Jira completion via the outbox (local Jira MOCK)
 * Google is a fake file source; the agent is the synthetic zero-model executor. souza-lab main is never used or modified.
 *
 *   node scripts/cp07-live-github.js          (requires `gh auth status` to be logged in; takes several minutes)
 */
const OWNER = process.env.LOOP_GITHUB_OWNER ?? "devricardo90";
const REPO = process.env.LOOP_GITHUB_REPO ?? "souza-loop-sandbox";
const WORKFLOW = ".github/workflows/validate.yml";
const TASK_ID = process.env.LOOP_LIVE_TASK_ID ?? `TASK-${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(2, 14)}`;
const ghRead = (args) => { for (let i = 1; ; i += 1) { try { return execFileSync("gh", args, { encoding: "utf8", windowsHide: true, timeout: 90000 }); } catch (error) { if (i >= 3) throw error; } } };
const log = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`);

async function main() {
  if (`${OWNER}/${REPO}`.toLowerCase() !== "devricardo90/souza-loop-sandbox") throw new Error("refusing to run against anything but the existing Phase 6 sandbox");
  const scratch = mkdtempSync(join(tmpdir(), "cp07-live-"));
  const clonePath = join(scratch, "sandbox");
  execFileSync("gh", ["repo", "clone", `${OWNER}/${REPO}`, clonePath], { stdio: "ignore", windowsHide: true, timeout: 120000 });
  execFileSync("git", ["config", "user.name", "Loop CP07 Live Proof"], { cwd: clonePath });
  execFileSync("git", ["config", "user.email", "loop-cp07-live@users.noreply.github.com"], { cwd: clonePath });

  const mock = await startMock();
  await mock.reset();
  const ws = workspace();
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  ws.setPlan(planText(1, task(TASK_ID, `CP-07 live lifecycle ${stamp}`)));
  const env = { LOOP_JIRA_EMAIL: "cp07-live@example.invalid", LOOP_JIRA_API_TOKEN: "cp07-live-mock-token-0123456789" };
  const config = baseConfig({ ws, port: mock.port, extra: {
    timings: { instanceLeaseTtlMs: 60000, defaultWaitMs: 3000 },
    git: { repoPath: clonePath },
    github: { owner: OWNER, repo: REPO, baseBranch: "main", workflowIdentity: WORKFLOW, timeoutMs: 90000 },
  } });
  const built = buildSyntheticController(config, env, { validator: new WorkspaceCommandValidator({ command: "node", args: ["--test"], timeoutMs: 180000 }) });
  const { controller, close } = built;
  // Diagnostics only: record every fact the lifecycle reads, so a runtime precondition-guard abort can be traced to the exact flapping fact.
  const recorded = [];
  const originalScope = built.lifecycle.scope.bind(built.lifecycle);
  built.lifecycle.scope = (wp) => {
    const scope = originalScope(wp);
    const wrap = (object, key, name) => { const fn = object[key].bind(object); object[key] = (...args) => { const value = fn(...args); recorded.push({ name, json: JSON.stringify(value) }); return value; }; };
    wrap(scope.gitProvider, "getRevision", "revision"); wrap(scope.ciProvider, "getCIResult", "ci");
    wrap(scope.scmProvider, "getPullRequestFact", "pullRequest"); wrap(scope.scmProvider, "getMergeFact", "merge");
    wrap(scope.reviewProvider, "getReviewResult", "review"); wrap(scope.validationProvider, "getValidationResult", "validation");
    return scope;
  };
  // Diagnostics only: keep the ordered observation facts so a precondition-guard abort shows exactly which field changed.
  const observations = [];
  const realObserve = RuntimeObserver.prototype.observe;
  RuntimeObserver.prototype.observe = function patched(args) {
    const out = realObserve.call(this, args);
    observations.push({ at: new Date().toISOString(), cycleId: args.cycleId, state: out.computed?.state, candidateHead: out.computed?.candidateHead ?? null, fp: executionFactsFingerprint(out.recovery?.facts ?? {}).slice(0, 12), facts: JSON.parse(JSON.stringify(out.recovery?.facts ?? {})) });
    return out;
  };
  const diffFacts = () => {
    const diffs = [];
    for (let i = 1; i < observations.length; i += 1) {
      const a = observations[i - 1].facts; const b = observations[i].facts;
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) diffs.push({ idx: i, at: observations[i].at, cycleId: observations[i].cycleId, state: observations[i].state, key, before: JSON.stringify(a[key])?.slice(0, 600), after: JSON.stringify(b[key])?.slice(0, 600) });
      }
    }
    return diffs.slice(-14);
  };
  const started = Date.now();
  let last = null;
  try {
    await controller.start();
    for (let i = 0; i < 400; i += 1) {
      last = await controller.cycle();
      log({ t: Math.round((Date.now() - started) / 1000), outcome: last.outcome, phase: last.phase, taskId: last.taskId, code: last.code });
      if (last.outcome === "COMPLETED") break;
      if (["BLOCK_GLOBAL", "BLOCK_TASK", "OWNER_DECISION_REQUIRED"].includes(last.outcome)) throw new Error(`controller stopped: ${JSON.stringify(last)}`);
      if (last.nextWakeAt) await new Promise((r) => setTimeout(r, Math.max(0, Math.min(10000, Date.parse(last.nextWakeAt) - Date.now()))));
    }
    if (last?.outcome !== "COMPLETED") throw new Error("did not complete within the cycle bound");

    const attempt = built.stores.attemptStore.db.prepare("SELECT execution_id FROM execution_attempts").all().map((r) => built.stores.attemptStore.get(r.execution_id))[0];
    const scm = new GitHubSCMProvider({ owner: OWNER, repo: REPO, baseBranch: "main", timeoutMs: 90000, run: createTransientAwareGhRunner({ ErrorClass: GitHubSCMError, codePrefix: "GITHUB" }) });
    const ci = new GitHubCIProvider({ owner: OWNER, repo: REPO, workflowIdentity: WORKFLOW, timeoutMs: 90000, run: createTransientAwareGhRunner({ ErrorClass: GitHubCIError, codePrefix: "GITHUB_CI" }) });
    const head = attempt.agentResult.head;
    const pr = scm.findPullRequest({ branch: attempt.branch, baseBranch: "main", candidateSha: head });
    const merge = scm.getMergeFact(TASK_ID, head);
    const ciResult = ci.getCIResult(head);
    const main_ = scm.getBranchFacts("main");
    const evidence = {
      result: "PASS", repository: `${OWNER}/${REPO}`, executionId: attempt.executionId, branch: attempt.branch,
      candidateSha: head, baseSha: attempt.baseSha, pullRequest: pr?.number ?? null, pullRequestUrl: pr?.url ?? null,
      ciRunId: ciResult.runId, ciStatus: ciResult.status, ciConclusion: ciResult.conclusion, ciHeadSha: ciResult.head,
      mergeStatus: merge.status, mergeSha: merge.mergeCommit, mergedAt: merge.mergedAt, sandboxMainHead: main_.headSha,
      mainEqualsMerge: main_.headSha === merge.mergeCommit, remoteBranchHead: scm.getBranchFacts(attempt.branch).headSha,
      controllerRows: built.stores.controllerStore.list().map((r) => [r.taskId, r.status]),
      jiraIssuesDone: (await mock.issues()).every((i) => i.fields.status.name === "Done"),
      agentCalls: built.agent.calls, modelCalls: built.agent.modelCalls, durationSeconds: Math.round((Date.now() - started) / 1000), scratch,
    };
    const prsForBranch = JSON.parse(ghRead(["pr", "list", "--repo", `${OWNER}/${REPO}`, "--head", attempt.branch, "--state", "all", "--json", "number,state"]));
    const openLoopPrs = JSON.parse(ghRead(["pr", "list", "--repo", `${OWNER}/${REPO}`, "--state", "open", "--json", "number,headRefName"])).filter((p) => p.headRefName.startsWith("loop/"));
    evidence.taskId = TASK_ID; evidence.prsForBranch = prsForBranch; evidence.openLoopPrs = openLoopPrs;
    const variants = new Map();
    for (const { name, json } of recorded) { if (!variants.has(name)) variants.set(name, new Map()); variants.get(name).set(json, (variants.get(name).get(json) ?? 0) + 1); }
    evidence.factVariants = [...variants].filter(([, v]) => v.size > 1).map(([name, v]) => ({ name, distinct: [...v].map(([json, count]) => ({ count, json: json.slice(0, 500) })) }));
    if (prsForBranch.length !== 1 || openLoopPrs.length !== 0) throw new Error(`live proof residue check failed: ${JSON.stringify({ prsForBranch, openLoopPrs })}`);
    if (!(evidence.ciStatus === "PASS"&& evidence.ciHeadSha === head && evidence.mergeStatus === "MERGED" && evidence.mainEqualsMerge && evidence.jiraIssuesDone)) {
      throw new Error(`live proof assertions failed: ${JSON.stringify(evidence)}`);
    }
    writeFileSync(join(scratch, "evidence.json"), JSON.stringify(evidence, null, 2));
    log(evidence);
  } catch (error) {
    // surface the runtime's own explanation before the workspace is cleaned up
    try {
      const root = join(ws.dir, "executions");
      for (const dir of existsSync(root) ? readdirSync(root) : []) {
        const events = readFileSync(join(root, dir, "evidence.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).event).filter((e) => e.eventType === "ACTION_RESULT");
        const byName = new Map();
        for (const { name, json } of recorded) { if (!byName.has(name)) byName.set(name, new Map()); byName.get(name).set(json, (byName.get(name).get(json) ?? 0) + 1); }
        log({ factVariants: [...byName].filter(([, variants]) => variants.size > 1).map(([name, variants]) => ({ name, distinct: [...variants].map(([json, count]) => ({ count, json: json.slice(0, 400) })) })) });
        log({ tailObservations: observations.slice(-8).map((o) => ({ at: o.at, cycleId: o.cycleId.split(":").slice(1).join(":"), state: o.state, candidateHead: o.candidateHead?.slice(0, 8) ?? null, fp: o.fp, keys: Object.fromEntries(["revision", "ci", "validation", "review", "pullRequest", "merge", "specReview"].map((k) => [k, JSON.stringify(o.facts[k] ?? null).slice(0, 90)])) })) });
        log({ observationCount: observations.length, lastFactDiffs: diffFacts() });
        log({ failureEvidence: events.slice(-4).map((e) => ({ action: e.payload.actionType, result: e.payload.result, errorClass: e.payload.errorClass, retry: e.payload.retry?.outcome ?? null })) });
      }
    } catch { /* best effort */ }
    throw error;
  } finally {
    await controller.stop().catch(() => {});
    close();
    mock.stop();
    ws.cleanup();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => { process.stderr.write(`${error.name}: ${error.message}\n`); process.exitCode = 1; });
}
