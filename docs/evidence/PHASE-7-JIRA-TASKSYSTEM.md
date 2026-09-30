# Phase 7 — Real Jira TaskSystem Adapter

## Result

**Phase 7 status: BLOCKED on the real-Jira requirement.** `JiraTaskSystemAdapter` and `JiraSyncClient` are implemented behind the existing `TaskSystemAdapter` contract, the canonical status/AC/dependency mapping is proven deterministically, the J01–J20 failure matrix passed, and a real `LoopRuntime` was proven to drive a Jira-sourced task to computed `DONE` with the Jira-dependent task becoming eligible next — all without any change to the State Engine, LoopRuntime, ActionPlanner, GitHub SCM provider, GitHub CI provider, or lease model. **No real Jira site, project, credentials, or connector exists in this environment.** Per the owner directive's own instruction ("If Jira authentication is unavailable: report BLOCKED with exact evidence. Do not replace the required real Jira path with a fake and claim PASS"), the real Jira read path, real Jira write path, and Microtest 004 against a real Jira project were **not executed** and are not claimed.

## Baseline

```text
PHASE7_BASELINE = ac5884df9053ce5749597410b2c43df690bb1335
```

`git rev-parse HEAD` and `git rev-parse origin/main` both returned this value before and after this phase's work; `git status --short` was clean before starting; `git diff HEAD --check` reported nothing. No existing file was modified. All Phase 7 changes are new files.

## Jira access check (evidence for BLOCKED)

Before writing any code, the environment was checked directly:

- No `jira` or `acli` (Atlassian CLI) binary on `PATH`.
- No `JIRA_*` / `ATLASSIAN_*` environment variables.
- No Jira/Atlassian MCP connector available (`ToolSearch` for `jira atlassian` returned only the generic `WebFetch` tool, which explicitly documents that it cannot reach authenticated services like Jira).
- No Jira npm client installed.

No credentials were fabricated, and no request was made to any Jira host.

## Architecture

```text
Jira (blocked in this environment)
  ↓
JiraTaskSystemAdapter (src/adapters/jira-task-adapter.js)     — read path
JiraSyncClient        (src/adapters/jira-sync-client.js)      — write path
  ↓
canonical Task / AcceptanceCriterion / Dependency (src/core/contracts.js, UNCHANGED)
  ↓
existing resolveNextTask resolver (src/adapters/markdown-task-adapter.js, UNCHANGED, reused as-is)
  ↓
existing RecoveryCoordinator / ComputedStateEngine / LoopRuntime / ActionPlanner (UNCHANGED)
  ↓
existing GitHubSCMProvider / GitHubCIProvider (UNCHANGED)
```

No file outside `src/adapters/jira-task-adapter.js`, `src/adapters/jira-sync-client.js`, and their three test files was modified. `git status --short` shows only new, untracked files for the whole phase.

Transport is synchronous `curl` invoked via `execFileSync`, for the same reason the GitHub adapters shell out to `gh` synchronously: `RuntimeObserver.observe()` and `RecoveryCoordinator.recover()` call `taskSystem.listTasks()` without `await`, so the `TaskSystemAdapter` contract is inherently synchronous. An async Jira SDK could not be plugged in without changing that contract, which this phase must not do. Credentials are written to a mode-0600 curl config file (`-K`) and never appear in `argv`, matching why the GitHub adapters never leak a token either — `gh` never receives one as an argument.

## Jira contract mapping

| Canonical field | Jira source | Notes |
|---|---|---|
| `Task.id` | `issue.key` (e.g. `LOOP-1`) | Stable identity. Title/summary is never used for identity or resolution (J14). |
| `Task.title` | `issue.fields.summary` | Display-only. |
| `Task.completed` | `issue.fields.status.name`, via an explicit `statusMapping` config (`{ "To Do": "OPEN", "In Progress": "OPEN", "Done": "DONE" }`) | Any status absent from the mapping fails closed (`JIRA_UNKNOWN_STATUS`, J04). The State Engine only ever sees the boolean `completed`; it does not learn Jira status names. Pre-completion statuses (`To Do`, `In Progress`, ...) all collapse to `completed:false` — eligibility among incomplete tasks is decided entirely by the existing `resolveNextTask` dependency-graph resolver, not by Jira's status vocabulary or backlog rank. |
| `Task.acceptanceCriteria` | Either a configured custom field (`acSource:"field"`) or a strictly named `Acceptance Criteria` section of the plain-text description (`acSource:"description"`, default), containing only `- AC-NNN: description` lines | Malformed lines, duplicate ids, and empty/missing sections all fail closed (J06–J08). No prose is scanned for implied ACs. |
| `Task.dependencies` | `issue.fields.issuelinks` filtered to a configured link type (`dependencyLinkType`, default `Blocks`) and only its inward ("is blocked by") direction | Any other link type/direction (`Relates`, `Duplicate`, epic membership, sprint rank, priority) is ignored, never inferred as a dependency (J09). A dependency pointing at an issue key absent from the fetched set, or a cycle, is rejected before the task set is used (J10/J11), by graph validation independent of (not shared with) the Markdown adapter's own copy. |
| "metadata" (project key, issue URL, raw status) | kept **inside the adapter**, returned by `getIssueMetadata(taskId)` | The frozen canonical `Task` object the State Engine observes carries none of this; `contracts.js`'s `makeTask()` was not touched. This is a deliberate interpretation of the directive's "Task.metadata": Jira bookkeeping needed for idempotent writes (comment markers, issue URLs) lives in the adapter, not in the contract the core consumes, per section 3's non-negotiable rule. |

`Task.specPresent` is set to `true` and `Task.specReviewed` to `true` for every Jira-sourced task: the Jira issue's description/AC content is treated as the specification, so the Markdown-only `SPEC_REQUIRED` phase is bypassed. The independent `SPEC_REVIEW` gate is unchanged and is still satisfied the same way Phase 5/6 satisfy it — an independent CLEAN review of a Git spec revision, supplied by the existing `contextProvider`/`ReviewProvider` seam — because code review has nothing to do with Jira.

Zero caching: `listTasks()` performs a fresh Jira read on every call. This is what makes task-source drift detection (AC edits, dependency edits, status edits) fall out of the **existing, unmodified** `executionFactsFingerprint`/precondition-guard mechanism in `loop-runtime.js` for free — no Jira-specific drift code was needed or written.

## Write path (Jira is not execution truth)

`JiraSyncClient` implements `recordExecutionStarted`, `recordPullRequestReference`, `recordMergeReference` (all via one idempotent `addExecutionComment` primitive keyed by an embedded `<!-- loop-execution:{id}:{kind} -->` marker — a lost response is rediscovered by re-reading comments before ever posting again, J17) and `markTaskComplete`.

**Architecture decision, and why:** `JiraSyncClient` is **not** wired into the `ActionPlanner`'s `COMPLETE` action. In the existing `LoopRuntime`, `COMPLETE` is a terminal marker the runtime flips computed state to `DONE` on without invoking any capability at all (`loop-runtime.js`'s `COMPLETE` branch never calls the executor) — the core has no post-`DONE` side-effect hook today, for GitHub or anything else, and adding one would be a `LoopRuntime` change, which section 3 forbids. Jira completion sync is therefore an **out-of-band** step an orchestration script performs strictly after `runtime.runUntilStop()` (or a cycle loop) observes `outcome === "DONE"`, exactly like an external notification worker would. `markTaskComplete` refuses synchronously, before any network call, unless the caller passes `computedState: "DONE"` — this is a second, defense-in-depth check, not the primary one; the primary guarantee is structural: nothing this client does can reach back into `LoopRuntime`'s computed state. This keeps "Jira sync state" (`JIRA_SYNC_PENDING`/`JIRA_SYNC_COMPLETE`, if tracked) fully outside the State Engine's execution truth, per section 21, with zero core changes.

Every write requires `context.assertLeaseCurrent()` — the same `LocalExecutionLeaseProvider` primitive Phase 6 already proved durable and fencing-safe, reused unchanged. A fenced-out runtime's write attempt throws `STALE_EXECUTION_LEASE` before the transport is ever called (J19); this was proven with the real lease provider, not a mock of it.

## J01–J20 failure matrix

All of the following are **CONTROLLED_FAILURE_INJECTION** against production adapter code through an injected transport function (the same pattern Phase 6 used for the GitHub adapters) — not a claim that a real Jira account's auth or network was disabled. `tests/jira-task-adapter.test.js` (18 tests) and `tests/jira-sync-client.test.js` (4 tests) cover J01–J11, J14, J15, J17–J20, plus J12/J13 as integration tests against the real (unmodified) `RecoveryCoordinator`/`ComputedStateEngine`. `tests/jira-runtime-substitution.test.js` additionally exercises J16 through a real `LoopRuntime.runCycle` loop.

| ID | Expected | Result |
|---|---|---|
| J01 | `BLOCKED_EXTERNAL`, no fabricated tasks | PASS — `JIRA_AUTH_FAILED`, `classification: EXTERNAL_BLOCK` |
| J02 | `WAIT_RETRYABLE` | PASS — `classification: TRANSIENT`, `retryable: true` |
| J03 | fail closed | PASS — `JIRA_INVALID_JSON` |
| J04 | fail closed | PASS — `JIRA_UNKNOWN_STATUS` |
| J05 | reject | PASS — `JIRA_DUPLICATE_ISSUE_KEY` |
| J06 | reject | PASS — `JIRA_AC_MALFORMED` |
| J07 | reject | PASS — `JIRA_AC_DUPLICATE` |
| J08 | reject | PASS — `JIRA_AC_MISSING` |
| J09 | not silently a dependency | PASS — non-configured link type yields zero dependencies |
| J10 | fail closed | PASS — `JIRA_MISSING_DEPENDENCY` |
| J11 | reject task graph | PASS — `JIRA_DEPENDENCY_CYCLE` |
| J12 | fail closed, no silent switch | PASS — real `RecoveryCoordinator.recover({activeTaskId})` throws `ACTIVE_TASK_MISSING` (pre-existing, provider-neutral behavior; proven here through the Jira adapter) |
| J13 | computed state stays authoritative | PASS — Jira `status:"Done"` with no CI/validation/review/merge evidence yields a non-`DONE` computed state and blocker `"task source marks work complete without completion evidence"` (pre-existing, provider-neutral State Engine behavior) |
| J14 | stable identity across title edits | PASS — `Task.id` and `acceptanceCriteriaDigest` unchanged when only `summary` changes |
| J15 | AC digest changes; old validation stale | PASS — AC content edit changes `acceptanceCriteriaDigest` (feeds the existing, unmodified `exactValidation` staleness check) |
| J16 | reconcile; unsafe progression blocked | PASS — a real `runtime.runCycle` loop reaches `READY_TO_MERGE`, a new dependency is added to the active Jira issue mid-flight, and the next cycle's fresh observation leaves the task no longer at `READY_TO_MERGE`; no additional merge call occurs |
| J17 | rediscover, no duplicate write | PASS — a marker already present in Jira comments short-circuits `addExecutionComment` before any POST |
| J18 | Loop remains `DONE`; Jira sync retryable | PASS — `markTaskComplete` refuses synchronously (`JIRA_PREMATURE_COMPLETION`) unless `computedState==="DONE"`; a transport failure on the transition POST is classified `TRANSIENT`/`retryable:true`, and by construction (see architecture decision above) has no path back into `LoopRuntime` state to corrupt |
| J19 | lease prevents unsafe duplication | PASS — real `LocalExecutionLeaseProvider`: the fenced-out runtime's `assertLeaseCurrent()` throws `STALE_EXECUTION_LEASE` before the transport is invoked at all |
| J20 | deterministic canonical resolution | PASS — the adapter's JQL always requests `ORDER BY key ASC`; canonical resolution order does not depend on Jira's live backlog rank |

## Microtest 004 — status: BLOCKED (real), PROVEN (synthetic substitution)

Section 27 of the directive requires real external Jira reachability for a PASS verdict and forbids reporting PASS from mocks only. That real run could not be attempted (no Jira access exists) and is **not claimed**.

What was proven instead, entirely through a real `LoopRuntime` (`runtime.runUntilStop`/`runCycle`, never manually stepped), is the actual Primary Objective of this phase — that the architecture accepts Jira as a drop-in task source:

```text
Jira issue LOOP-1 (fake transport, real adapter code)
  → JiraTaskSystemAdapter.listTasks()
  → canonical Task
  → existing resolveNextTask resolver
  → real LoopRuntime / ComputedStateEngine / ActionPlanner
  → deterministic controlled implementation/CI/validation/review/merge capabilities
     (the same style Microtest 002 uses; this does not touch real GitHub)
  → computed DONE
  → resolveNextTask reports LOOP-2 (which `Blocks`-depends on LOOP-1) eligible
```

`tests/jira-runtime-substitution.test.js`, test "Microtest 004 (synthetic)": PASS. `state.calls` recorded exactly `["implement","tests","validation","review","merge","post-validation"]`; `result.outcome==="DONE"`; `result.nextTaskId==="LOOP-2"`; the fake transport was invoked once per observation (no caching), confirmed by `searchCalls > cycles/2`.

This test does not substitute for Microtest 004; it substitutes for nothing except demonstrating that once real Jira credentials exist, only the transport function passed to `JiraTaskSystemAdapter`/`JiraSyncClient` needs to change — no other file in this repository does.

## Regressions

All pre-existing suites were re-run unmodified and are unaffected (zero existing files were edited):

| Suite | Result |
|---|---|
| `tests/microtest-001.test.js` | 9/9 |
| `tests/phase4-failure-injection.test.js` + `tests/jsonl-evidence-store.test.js` | 35/35 |
| `tests/microtest-002.test.js` (Phase 5 regressions + P6-A lease regressions) | 25/25 |
| `tests/phase6-github-failure-matrix.test.js` (G01–G18) | 16/16 |
| `tests/execution-lease-provider.test.js` | 2/2 |
| New: `tests/jira-task-adapter.test.js` | 18/18 |
| New: `tests/jira-sync-client.test.js` | 4/4 |
| New: `tests/jira-runtime-substitution.test.js` | 2/2 |
| `npm test` (full suite) | 152/152, 0 failed, 0 skipped |

Microtest 003 (real GitHub) was not re-run; nothing in this phase touches the GitHub adapters, LoopRuntime, or lease provider, and Phase 6's independent acceptance audit already verified PR #1/#2 real facts live against GitHub.

## Trust boundaries and known limitations

- **Real Jira reachability is unproven.** Everything above exercises production adapter *logic* against an injected transport, exactly like Phase 6's G01–G18 exercised the GitHub adapters against an injected `run`. No request has ever reached a real Jira host.
- The `curl`-based transport is a design proposal exercised only by its own request/response shape, not by a live server; real-world Jira Cloud response quirks (pagination edge cases, ADF description formatting beyond plain text, custom-field type variance) are not proven against a live API.
- The AC-parsing grammar is deliberately narrow (`- AC-NNN: description`, exact `Acceptance Criteria` heading). A real project's actual Jira conventions may need the `acSource:"field"` path instead, which is implemented but likewise unverified against a live custom field.
- Jira completion sync is intentionally decoupled from `LoopRuntime`'s action vocabulary (see architecture decision above); an orchestration script must call it, which does not exist yet for Jira (Microtest 003's script is GitHub-only and was not extended, since doing so before Jira access exists would itself be unverifiable dead code).
- `validateDependencyGraph` (cycle/missing-dependency detection) is intentionally duplicated in `jira-task-adapter.js` rather than importing the Markdown adapter's private copy, to guarantee zero risk to the Phase 4/6-audited `markdown-task-adapter.js` file. This is a deliberate, documented trade-off of a small amount of duplication for total isolation.

## Souza Lab / Recompra safety

- `git status --short` on Souza Lab: clean except new untracked files for this phase; `git rev-parse HEAD` unchanged at `ac5884df9053ce5749597410b2c43df690bb1335` before and after.
- RecompraCRM: `git rev-parse HEAD` at `C:\Users\ricardodev\Desktop\RecompraCRM` = `87d27d1f2f94a4fa64b0b6e789b1d1d99d1dc27a` (unchanged), `git status --short` clean. **RECOMPRA_MUTATED = NO.** TASK-17 was not resumed; RecompraCRM was not opened for anything beyond this `rev-parse`/`status` check.

## Final verdict

**BLOCKED** on the real-Jira requirement, per the directive's own instruction for this exact situation. The provider-neutral substitution claim (the phase's actual primary objective) is proven synthetically and the deterministic J01–J20 matrix passed; nothing here is reported as PASS for the parts that require live Jira access, because they were not run.
