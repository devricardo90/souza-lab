import { GitHubSCMProvider, GitHubSCMError } from "../adapters/github-scm-provider.js";
import { GitHubCIProvider, GitHubCIError } from "../adapters/github-ci-provider.js";
import { createTransientAwareGhRunner } from "../adapters/gh-runner.js";
import { GitHubLifecycle } from "./github-lifecycle.js";

/**
 * Production composition of the post-agent development lifecycle. Every fact it can produce comes from a real provider
 * boundary: real local Git, the GitHub SCM and CI providers, durable gate evidence, and the injected reviewer/validator ports.
 * There are NO hardcoded PASS facts here, and this module (and github-lifecycle.js) never import anything from src/testing/:
 * a static test enforces that the production path cannot reach SyntheticLifecycle or any fake.
 *
 * `run` is the providers' own command-runner injection point (default: the real `gh` CLI). Tests pass a fake `gh api` runner;
 * production passes nothing.
 */
export function composeGitHubLifecycle({ github, repoPath, attemptStore, gateStore, reviewer, validator, agent, clock, faultPoints = {}, run = null }) {
  for (const [name, value] of Object.entries({ github, repoPath, attemptStore, gateStore, reviewer, validator, agent })) if (!value) throw new TypeError(`composeGitHubLifecycle requires ${name}`);
  for (const field of ["owner", "repo", "baseBranch", "workflowIdentity"]) if (typeof github[field] !== "string" || github[field] === "") throw new TypeError(`github.${field} is required`);
  const timeoutMs = github.timeoutMs ?? 30000;
  // Production uses the transient-aware gh runner (network blips are retried, not permanent blocks); tests inject a fake runner.
  const scmRun = run ?? createTransientAwareGhRunner({ ErrorClass: GitHubSCMError, codePrefix: "GITHUB" });
  const ciRun = run ?? createTransientAwareGhRunner({ ErrorClass: GitHubCIError, codePrefix: "GITHUB_CI" });
  const scm = new GitHubSCMProvider({ owner: github.owner, repo: github.repo, baseBranch: github.baseBranch, timeoutMs, run: scmRun });
  const ci = new GitHubCIProvider({ owner: github.owner, repo: github.repo, workflowIdentity: github.workflowIdentity, timeoutMs, run: ciRun });
  return new GitHubLifecycle({ scm, ci, attemptStore, gateStore, repoPath, baseBranch: github.baseBranch, reviewer, validator, agent, clock, faultPoints, maxCorrections: github.maxCorrections ?? 3 });
}
