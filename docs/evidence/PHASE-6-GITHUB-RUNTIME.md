# Phase 6 — Durable Execution Safety and Real GitHub Lifecycle

## Result

**Phase 6 status: PASS** for the approved scope: durable local execution leases, GitHub SCM/Actions adapters, the controlled sandbox runtime lifecycle, injected provider failures, and all local regressions passed. GitHub server-side protection against a manual bypass was unavailable on the account tier and is not claimed.

## Baseline and final source revision

- Phase 6 baseline: `5a41e3ed31955c630a9a53f4285acb111d31b8aa` (`main`, clean; equal to `origin/main` at phase start).
- Final source revision before this evidence commit: `fa5b4957a4495639e39db3b3a1c07e8e08c0b67c`.
- Thirteen implementation/test commits were made on top of the accepted Phase 5 baseline. Foundation, Phase 4, and Phase 5 history was not rewritten.
- The source repository was synchronized after this artifact and canonical phase-status update were committed.

## P6-A — Durable execution lease

`LocalExecutionLeaseProvider` stores an execution lease outside the runtime object. Acquisition is serialized with an atomic filesystem link; state is durably replaced; fencing tokens increase after lease expiry. Runtime calls renew/inspect authority and passes a lease assertion into capabilities. GitHub mutations assert the current lease immediately before mutation. Independent runtime instances and independent child processes were tested against one execution; only one could hold authority. An expired lease was reacquired with a higher token, and the stale token was rejected before merge.

Trust boundary: this provider serializes processes sharing its local filesystem storage. It is not a distributed lock across machines without shared storage semantics and external fencing enforcement.

## P6-B/C — GitHub adapters

- `GitHubSCMProvider` normalizes repository, branch, PR, and merge facts. All `gh` commands and REST paths remain inside the adapter. PR discovery uses both task and execution markers. PR creation rediscovers by execution branch and exact candidate before attempting creation.
- Merge authorization requires runtime state `READY_TO_MERGE`, exact candidate SHA, the configured repository and workflow identity, canonical CI `PASS`, complete exact-spec/AC validation, independent CLEAN review with no unresolved finding, review strictly before the merge attempt, a current lease, an open/mergeable PR, the configured base branch, and a second PR/branch HEAD read immediately before the merge request. The merge API request includes the expected SHA.
- `GitHubCIProvider` accepts only the configured workflow path, repository, exact SHA, completed status, successful conclusion, and a valid completion timestamp. Other/missing states remain pending, failed, or unknown.
- Provider subprocess requests have adapter-level timeouts and terminate the spawned command on timeout. The runtime's async timeout cannot interrupt a synchronous `execFileSync` while Node is blocked; the adapter/process timeout is the active bound for those calls.

## P6-D/E — Private sandbox and Microtest 003

Sandbox: `devricardo90/souza-loop-sandbox` (private). It contains only a small Markdown task source, one task specification, a Node test workflow, and the synthetic integer-addition candidate. The sandbox does not contain Loop implementation code.

The actual `LoopRuntime` selected and executed actions, used the real GitHub SCM and GitHub Actions providers, re-observed facts between actions, used deterministic controlled validation/review capabilities, merged through the SCM adapter, validated the merge, reached computed `DONE`, and resolved `TASK-002` next. The lifecycle was run twice successfully on distinct execution branches. Each candidate includes an execution marker so repeated runs still produce a new Git revision after prior code has merged.

Successful repeatable lifecycle:

| Fact | Value |
|---|---|
| Repository | `devricardo90/souza-loop-sandbox` |
| Execution | `p6-20260929191354848-37df0dc8` |
| Branch | `loop/TASK-001/p6-20260929191354848-37df0dc8` |
| PR | [#2](https://github.com/devricardo90/souza-loop-sandbox/pull/2) |
| Candidate SHA | `90ff6be9a4f9de66f1f1b9804d82da5aa5ae1c7c` |
| CI identity | `.github/workflows/validate.yml` |
| CI run | `36617991869`, `pull_request` event, exact candidate, `PASS` / `success` |
| Merge SHA | `9352a4aebd87125ef325274d13979fd230678551` |
| Merge time | `2026-09-29T19:18:38Z` |
| Runtime result | `DONE`; next task `TASK-002`; 16 cycles |

An earlier successful lifecycle was PR #1, candidate `9401df394b5bbb67b0196175a31fb9eb3c5c7dde`, CI run `36604857479`, merge `b95875f10a8d9aa7ee6c2451102d561236932e52`. Both PRs were created and merged by the runtime against unique execution branches. Their branches and PR records are retained for audit.

## P6-F — Failure and recovery matrix

`tests/phase6-github-failure-matrix.test.js` injects G01–G18 through production provider code and the real local lease provider. All 16 named test cases passed and collectively cover all 18 IDs. Authentication failure, network timeout, missing branch, malformed schema, pending/failed/wrong-identity CI, stale candidate/review, PR mutation after planning, competing runtimes, lease expiry/fencing, ambiguous merge timeout, merge recovery, and duplicate PR prevention fail closed or reconcile as specified. These controlled faults do not claim that account authentication or network outages were actually induced against GitHub.

### Defects discovered and corrections

1. The planner only created a PR in `TESTING`. Push-triggered CI could finish before the next observation, moving computed state to validation while no PR existed. A live run reached `READY_TO_MERGE` and was blocked because no current PR was identified. Regression `ace740a` fails on `VALIDATING` without a PR; correction `a45b2b4` prioritizes PR creation for every post-candidate state when the current execution has no PR. The next live run created the PR before merge progression.
2. GitHub's PR-list REST response omitted the `merged` boolean (`null`), even for an open PR, while supplying state and `merged_at`. The original normalizer rejected the valid response and recovery blocked after PR creation. Regression `c1fe804` captures this response; `16030cd` derives merge state only from the open/closed state and `merged_at`, and rejects contradictions.
3. Merge authorization did not verify that the PR still targeted the configured base. Regression `0da593f` failed for a PR retargeted to `release`; correction `e93ef46` blocks merges unless the configured base matches.
4. A second sandbox run found that reapplying identical task output after the first merge made the implementation commit a no-op. `fa5b495` adds an execution-specific source marker and a regression; the subsequent fresh-branch lifecycle passed.

## Test results

After all corrections:

- `node --test tests/microtest-001.test.js`: 9 passed, 0 failed, 0 skipped.
- `node --test tests/phase4-failure-injection.test.js`: 27 passed, 0 failed, 0 skipped (the phase's 34 named injections are grouped in this test file).
- `node --test tests/microtest-002.test.js`: 25 passed, 0 failed, 0 skipped.
- `node scripts/microtest-003-github.js`: two successful real sandbox executions; the last execution is recorded above.
- `npm test`: 128 passed, 0 failed, 0 skipped; duration reported by Node was approximately 88 seconds.
- `git diff HEAD --check`: clean before evidence changes; repeated after final evidence commit.

The external GitHub lifecycle took several minutes due to synchronous Git/`gh` process startup and remote round trips. Calls are bounded by command-level timeouts. The local deterministic test suite remains under 90 seconds in the final run. Windows denied CIM process enumeration, so ownership of any unrelated system processes could not be established; the runtime command sessions completed and no spawned test session remained active when they returned.

## Server-side enforcement and trust boundaries

- GitHub rejected branch-protection and repository-ruleset inspection with HTTP 403, stating that the private-repository feature requires a higher account tier or a public repository. No server-side required-check or review rules are asserted.
- The proven claim is that the Loop adapter refuses unsafe merges. The sandbox repository owner can still manually bypass those adapter checks; GitHub-side prevention is not proven.
- Review and validation are deterministic controlled providers, not model review or external validation services.
- The local lease protects runtimes sharing the lease filesystem. The evidence checkpoint protects against event-log suffix loss only while its trusted checkpoint file remains independently preserved. No distributed trust anchor was added.
- Authentication loss and provider/network faults in G01–G18 were injected through adapters; they were not induced by changing credentials or disabling the user's network.

## Safety and final verdict

- Souza Lab remained the implementation source repository; the isolated private GitHub repository was the runtime target.
- RecompraCRM was not used or modified. Final observed HEAD remained `87d27d1f2f94a4fa64b0b6e789b1d1d99d1dc27a`; its pre-existing `.claude/settings.local.json` remained present.
- No Jira, GitHub Issues, real model reviewer, Vercel, production credentials, production repository, or deployment was used.
- **Final verdict: PASS** for Phase 6's approved scope, with server-side manual-bypass enforcement explicitly outside the proven boundary.
