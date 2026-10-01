import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Fake GitHub for tests: implements the small slice of the `gh api` REST surface that the REAL GitHubSCMProvider and
 * GitHubCIProvider call (they accept an injected `run`), backed by a REAL local bare git repository and a JSON state file
 * (so separate processes observe the same "GitHub"). The provider code under test is the production code, unchanged.
 * Synthetic evidence only - it is not evidence about the real GitHub API.
 *
 * State file: { nextNumber, prs: [...], ci: { <sha>: { status, conclusion, runId } }, autoCI: { pendingPolls, outcome }, polls: {<sha>: n},
 *               faults: { mergeResponseLostOnce } }
 */
const AUTHOR = ["-c", "user.name=Fake GitHub", "-c", "user.email=noreply@github.invalid"];

function sh(cwd, args) {
  try { return execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch (error) { throw new Error(`git ${args[0]} failed: ${String(error.stderr ?? error.message).trim().slice(0, 200)}`); }
}
const notFound = () => Object.assign(new Error("gh: Not Found (HTTP 404)"), { status: 404 });

export function createFakeGitHub({ barePath, stateFile, owner = "fake-owner", repo = "fake-repo", workflowPath = ".github/workflows/validate.yml", defaultBranch = "main" }) {
  const read = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, "utf8")) : { nextNumber: 1, prs: [], ci: {}, autoCI: null, polls: {}, faults: {} });
  const write = (state) => writeFileSync(stateFile, JSON.stringify(state), "utf8");
  const gitDir = (args) => execFileSync("git", ["--git-dir", barePath, ...args], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  // Loose ref files are read directly (no process spawn); packed/unknown refs fall back to git.
  const branchHead = (name) => {
    try { const sha = readFileSync(join(barePath, "refs", "heads", ...name.split("/")), "utf8").trim(); if (/^[0-9a-f]{40}$/.test(sha)) return sha; } catch { /* fall through */ }
    try { return gitDir(["rev-parse", "--verify", `refs/heads/${name}^{commit}`]); } catch { return null; }
  };
  const repository = `${owner}/${repo}`;

  let flips = 0;
  const flap = () => { flips += 1; return flips % 2 === 0; };
  const prView = (pr, { single }) => {
    const headSha = pr.mergedHeadSha ?? branchHead(pr.head) ?? pr.lastHeadSha;
    const view = {
      number: pr.number, state: pr.state, merged_at: pr.mergedAt ?? null, merge_commit_sha: pr.mergeSha ?? null,
      head: { ref: pr.head, sha: headSha }, base: { ref: pr.base }, user: { login: "loop-bot" },
      mergeable: pr.state === "open" ? Boolean(branchHead(pr.base) && headSha)
        : (read().faults?.flappingMergedMergeable ? flap() : null), // real GitHub reports an unstable value for merged PRs
      updated_at: pr.updatedAt, title: pr.title, body: pr.body, html_url: `https://fake.github.invalid/${repository}/pull/${pr.number}`,
    };
    if (single) view.merged = Boolean(pr.mergedAt); // the list endpoint omits it (as real GitHub does); the single GET includes it
    return view;
  };

  function squashMerge(pr, expectedSha) {
    const tmp = mkdtempSync(join(tmpdir(), "fake-gh-merge-"));
    try {
      sh(tmp, ["clone", "-q", barePath, "work"]);
      const work = join(tmp, "work");
      sh(work, ["checkout", "-q", pr.base]);
      sh(work, [...AUTHOR, "merge", "--squash", `origin/${pr.head}`]);
      sh(work, [...AUTHOR, "commit", "-q", "-m", `${pr.title} (#${pr.number})`]);
      const sha = sh(work, ["rev-parse", "HEAD"]);
      sh(work, ["push", "-q", "origin", `HEAD:refs/heads/${pr.base}`]);
      return sha;
    } finally { rmSync(tmp, { recursive: true, force: true }); }
  }

  function api(path, flags) {
    const [route, query = ""] = path.split("?");
    const params = new URLSearchParams(query);
    const method = (() => { const i = flags.indexOf("-X"); return i >= 0 ? flags[i + 1] : "GET"; })();
    const fields = {};
    for (let i = 0; i < flags.length; i += 1) if (flags[i] === "-F") { const [k, ...rest] = flags[i + 1].split("="); fields[k] = rest.join("="); }
    const state = read();
    const base = `repos/${repository}`;
    if (route === base) return { full_name: repository, default_branch: defaultBranch, private: true, html_url: `https://fake.github.invalid/${repository}` };
    let m;
    if ((m = route.match(new RegExp(`^${base}/branches/(.+)$`)))) {
      const name = decodeURIComponent(m[1]);
      const sha = branchHead(name);
      if (!sha) throw notFound();
      return { name, commit: { sha }, protected: false };
    }
    if (route === `${base}/pulls` && method === "GET") {
      const head = params.get("head")?.split(":")[1] ?? null;
      const wanted = params.get("state") ?? "open";
      return state.prs
        .filter((pr) => (wanted === "all" || pr.state === wanted) && (!head || pr.head === head) && (!params.get("base") || pr.base === params.get("base")))
        .map((pr) => prView(pr, { single: false }));
    }
    if (route === `${base}/pulls` && method === "POST") {
      if (!branchHead(fields.head)) throw Object.assign(new Error("gh: Validation Failed (HTTP 422)"), { status: 422 });
      const pr = { number: state.nextNumber, state: "open", head: fields.head, base: fields.base, title: fields.title, body: fields.body, updatedAt: new Date().toISOString(), lastHeadSha: branchHead(fields.head) };
      state.nextNumber += 1;
      state.prs.push(pr);
      write(state);
      return prView(pr, { single: true });
    }
    if ((m = route.match(new RegExp(`^${base}/pulls/(\\d+)$`)))) {
      const pr = state.prs.find((p) => p.number === Number(m[1]));
      if (!pr) throw notFound();
      return prView(pr, { single: true });
    }
    if ((m = route.match(new RegExp(`^${base}/pulls/(\\d+)/merge$`))) && method === "PUT") {
      const pr = state.prs.find((p) => p.number === Number(m[1]));
      if (!pr) throw notFound();
      const live = branchHead(pr.head);
      if (pr.state !== "open" || live !== fields.sha) throw Object.assign(new Error("gh: Head branch was modified (HTTP 409)"), { status: 409 });
      pr.mergeSha = squashMerge(pr, fields.sha);
      pr.mergedHeadSha = live;
      pr.state = "closed";
      pr.mergedAt = new Date().toISOString();
      pr.updatedAt = pr.mergedAt;
      const lost = state.faults?.mergeResponseLostOnce === true;
      if (lost) state.faults.mergeResponseLostOnce = false;
      write(state);
      if (lost) throw new Error("connection reset while reading the merge response"); // the merge HAPPENED, the response was lost
      return { merged: true, message: "Pull Request successfully merged", sha: pr.mergeSha };
    }
    if (route === `${base}/actions/runs`) {
      const sha = params.get("head_sha");
      let entry = state.ci[sha];
      if (!entry && state.autoCI) {
        state.polls[sha] = (state.polls[sha] ?? 0) + 1;
        entry = state.polls[sha] > state.autoCI.pendingPolls ? { status: "completed", conclusion: state.autoCI.outcome } : { status: "in_progress", conclusion: null };
        write(state);
      }
      if (!entry) return { workflow_runs: [] };
      return { workflow_runs: [{
        id: 900000 + Number.parseInt(sha.slice(0, 6), 16) % 100000, run_attempt: 1, status: entry.status, conclusion: entry.conclusion ?? null, head_sha: sha,
        path: workflowPath, repository: { full_name: repository }, created_at: "2026-10-02T10:00:00Z", updated_at: "2026-10-02T10:05:00Z",
      }] };
    }
    throw new Error(`fake GitHub: unsupported request ${method} ${path}`);
  }

  const run = (args) => {
    if (args[0] !== "api") throw new Error(`fake GitHub: unsupported command ${args[0]}`);
    return JSON.stringify(api(args[1], args.slice(2)));
  };

  return {
    owner, repo, repository, workflowPath, run, barePath, stateFile, branchHead,
    /** Test controls (state is shared through the file, so they work across processes). */
    state: read,
    setCI(sha, entry) { const s = read(); s.ci[sha] = entry; write(s); },
    setAutoCI(autoCI) { const s = read(); s.autoCI = autoCI; s.polls = {}; write(s); },
    setFault(name, value = true) { const s = read(); s.faults = { ...s.faults, [name]: value }; write(s); },
    prs: () => read().prs,
  };
}

/** Creates the bare "remote" and seeds its default branch from an existing local repository's HEAD. */
export function initFakeRemote({ barePath, seedPath, branch = "main" }) {
  execFileSync("git", ["init", "-q", "--bare", barePath], { windowsHide: true });
  sh(seedPath, ["push", "-q", barePath, `HEAD:refs/heads/${branch}`]);
}
