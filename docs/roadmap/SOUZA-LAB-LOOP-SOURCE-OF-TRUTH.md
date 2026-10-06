# Souza Lab Loop — Source of Truth

**Baseline date:** 2026-09-27
**Last reconciled:** 2026-10-06 (documentation-only reconciliation; see "Project identity and lineage")
**Source-of-truth status:** RECONCILED
**Status:** CP-08 (live Jira integration) is DONE and merged at `e94ac52c0464437428d097db7caa8df7c63d54bd`. The Hermes agent executor bridge is merged (PR #3). CP-09 (production composition) is DONE and merged at `4059e62876759430a8abe36e75cf4a226b0ff519` (PR #5; post-merge full serial suite 565/565): the CLI selects an explicit `synthetic` or `production` profile (`docs/production-profile.md`). The production path has been proven by deterministic tests only; no live Hermes run exists yet.
**Active checkpoint:** CP-10 — Live Hermes End-to-End + Autonomous Correction Proof (Owner-authorized 2026-10-06).

This document is the canonical roadmap and governance record for building a reusable development Loop in Souza Lab. It records the phase order, current evidence, decisions, and boundaries. The owner accepted baseline commit `e20e9f327f6b67bf62ca05b53c4185013f910b0b` and authorized implementation through B7; no additional planning gate is required between stages.

## Project identity and lineage

Owner decision, recorded 2026-10-05. This section resolves any ambiguity about which repository and which roadmap are active. These statements are Owner directives given in session; they are not derivable from repository history, which does not otherwise mention `rick-loop` or AXYVERO. The same applies to the CP-09..CP-15 roadmap below.

| Name | Role |
|---|---|
| RecompraCRM | Historical origin: the environment where the autonomous Loop was first developed and proven. Read-only evidence. |
| `rick-loop` | Historical precursor and abandoned extraction attempt. Preserved read-only. **Not part of the active roadmap**: its Foundation plan, milestones (M0–M9) and sprint labels (F0–F7) do not control `souza-lab` and must not be used to plan or judge it. |
| `souza-lab` | The **official repository** of the reusable autonomous Loop. The only active repository for its development. |
| Souza Loop | The runtime/engine implemented in `souza-lab`. |
| Jira | Operational control plane and task system. It owns operational work state; it is **not** the canonical architecture authority (see [Owner decision](../decisions/OWNER-DECISION-JIRA-CONTROL-PLANE.md)). |
| Hermes | The production agent execution layer, reached through `HermesAgentExecutor` (see [Hermes agent boundary](../hermes-agent-executor.md)). |
| Google Docs | Optional and deferred integration. **Not required for Loop readiness** and not a blocker; no acceptance criterion in this repository requires it. |
| AXYVERO and future projects | Consumers of Souza Loop. |

Status decisions recorded with this reconciliation:

- **CP-08 is DONE.** This is the Owner's final status for the checkpoint (the CP-08 evidence files use their own status tokens, not this wording). Evidence: `docs/evidence/CP-08-JIRA-LIVE-STATUS.md`, `docs/evidence/CP-08-JIRA-LEDGER.json`, and the merge of PR #2 at `e94ac52c0464437428d097db7caa8df7c63d54bd`. The CP-08 evidence files are unchanged by this reconciliation; where they still carry pre-merge wording (for example "READY_FOR_RE_REVIEW"), that wording is historical and this document governs. The Owner records the post-merge validation of CP-08 closure as 534/534 passing; the latest test count committed in repository evidence is 516 (recorded before PR #1 and PR #3 were reconciled into the CP-08 branch), and no code has changed since closure.
- **Phase 7's earlier BLOCKED state is superseded** by the CP-08 live Jira evidence. The Phase 7 evidence file remains an accurate record of the state at that time.
- **CP-01 through CP-07 are historical implementation checkpoints with evidence limitations.** Several have code and tests but no standalone evidence document (for example, CP-07's live-proof script is committed without a committed result record). Those limitations are recorded, not repaired by fabrication, and **do not by themselves authorize reopening or reimplementing those checkpoints**.
- The Phase 7 Microtest 004 wording and "Do not begin Phase 8" in Change control are historical; forward work is governed by the checkpoint roadmap below.

## Active checkpoint roadmap

Owner-approved forward checkpoints. Only the active checkpoint may be implemented, and only after Owner authorization.

| Checkpoint | Name | Status |
|---|---|---|
| CP-09 | Production Composition | DONE — merged `4059e62876759430a8abe36e75cf4a226b0ff519` (PR #5), post-merge 565/565; limitations below |
| CP-10 | Live Hermes End-to-End + Autonomous Correction Proof | ACTIVE — scope recorded below |
| CP-11 | Agent-Agnostic Jira Gateway / Write Authority | NOT_STARTED |
| CP-12 | Durable Wakeup and Real Restart Recovery | NOT_STARTED |
| CP-13 | Multi-Process Locking / Concurrency Safety | NOT_STARTED |
| CP-14 | Server-Side Merge Enforcement and Hardening | NOT_STARTED |
| CP-15 | Release Candidate / Final Souza Loop Audit | NOT_STARTED |

### CP-09 scope (DONE)

**Goal:** replace the synthetic-only runtime composition with a production composition reachable from the CLI. Today `bin/loop-controller.js` supports only the `synthetic` profile.

Required production composition:

```text
Jira task/control plane
→ Souza Loop deterministic controller
→ HermesAgentExecutor
→ Git/GitHub
→ CI/validation/review lifecycle
→ reconciliation/recovery
```

Google Docs must **not** be required by CP-09.

Open decisions that remain listed in "Loop Base v0 design boundary" (durable wakeup service, multi-process locking, server-side merge enforcement) are assigned to CP-12, CP-13 and CP-14 respectively, and the agent-agnostic Jira gateway to CP-11.

### CP-09 recorded limitations

CP-09 is a composition checkpoint proven with deterministic tests (no live Jira, Hermes or GitHub call). Limitations carried forward honestly:

- `HermesAgentExecutor` has no correction round: review FINDINGS currently escalate to an owner decision. This is the first gap CP-10 closes.
- No real model-backed reviewer exists. The production reviewer is `CommandIndependentReviewer`, a generic command boundary whose independence rests on the declared `reviewerId` differing from the commit author; the profile only rejects an identical executable. Choosing a genuinely independent reviewer is the Owner's responsibility.
- The production path has not been exercised against live Jira, Hermes and GitHub together (CP-10).
- Durable wakeup, multi-process locking and server-side merge enforcement remain CP-12, CP-13 and CP-14.

### CP-10 scope

**Goal:** prove the real production path with live evidence: Jira → deterministic controller → `HermesAgentExecutor` → Git workspace → GitHub PR → validation → independent review → correction when required → revalidation → independent re-review → merge → reconciliation/recovery → task closure. It must use the CP-09 production composition and no second synthetic composition.

Required work: a minimal generic, bounded correction contract (findings go back to the implementation agent on the same task/worktree/branch; a new HEAD makes prior validation and review evidence stale; validation and review rerun on the new exact HEAD; the loop ends at CLEAN or a genuine stop condition and never loops without bound); a genuinely separate reviewer execution context with recorded identities; live proof A (clean path) and live proof B (finding → correction → CLEAN) on controlled test Jira data only. The owner is interrupted only for scope ambiguity, architecture, security, material cost, contradictory requirements, credential/access needs, non-deterministic external blockers, or repair failure beyond the configured safe limit. Google Docs is not required. Out of scope: CP-11 to CP-15.

## Mission and evidence boundary

RecompraCRM is the historical reference implementation. Its repository is read-only evidence and must remain untouched. Souza Lab is the target repository. Discovery examined RecompraCRM at `87d27d1f2f94a4fa64b0b6e789b1d1d99d1dc27a` on `main` and Souza Lab before this baseline, when it had no commits.

The source review found a working Loop with a `/loop` skill, Node controller and supervisor, roadmap resolver, fail-closed preflight, independent validation and review paths, GitHub Actions, and operational state/evidence records. It also found documented failures and unimplemented gaps. Those findings are evidence for design; they do not make RecompraCRM's project-specific code or configuration suitable for copying.

The detailed discovery report is the evidence record for Phase 1. Facts from repository evidence must remain distinguishable from proposals and unresolved questions. No statement in this document is evidence that a proposed capability has been implemented or tested in Souza Lab.

## Source-of-truth rules

1. The roadmap or task-system adapter owns **intended work** and acceptance criteria.
2. Git and the hosting provider own **operational facts**, including branch, commit, pull request, and merge state.
3. Tests and CI own **validation evidence**, bound to the revision they actually checked.
4. The independent reviewer owns the **review verdict**, bound to the exact reviewed commit.
5. The controller computes **execution state** from those sources. An agent's narrative cannot declare work done.
6. STATE and HANDOFF are computed views of reality, not competing authorities. Their pointers must agree with computed state, not merely with each other.
7. Completion requires all applicable acceptance criteria and gates, exact-revision evidence, and post-merge validation. A partial delivery or an unverified claim remains incomplete.
8. Unknown or stale evidence fails closed. Retryable waits remain resumable and are not treated as completion.
9. RecompraCRM remains read-only. No source files, history, branches, or worktree state may be changed while using it as evidence.

## Phase sequence

The owner gate for implementation was passed after the accepted baseline commit. B0–B7 proceed in order without per-stage owner approval. A phase is complete only when its implementation exists and its required tests pass.

| Phase | Name | Status | Exit condition |
|---|---|---|---|
| 0 | Canonical baseline | Accepted at `e20e9f3` | Baseline document committed and pushed. |
| 1 | Recompra Loop Discovery | Complete | Discovery evidence delivered; Recompra remains read-only. |
| — | Owner gate | Passed | Owner accepted the baseline and explicitly authorized implementation through B7. |
| B0 | Contracts | PASS | Provider-neutral interfaces, canonical structures, closed states, and contract tests pass. |
| B1 | Markdown Task Adapter | PASS | Parse tasks, acceptance criteria, and dependencies into canonical structures; prove deterministic resolution. |
| B2 | Local Git Adapter | PASS | Read local revision and working-tree facts through `GitProvider`. |
| B3 | Computed State Engine | PASS | Derive state from authoritative facts; projections and narrative cannot override it. |
| B4 | Evidence Store | PASS | Append and read validated evidence events without update/delete operations. |
| B5 | Fake Providers | PASS | Exercise all provider boundaries with deterministic fixtures and no external services. |
| B6 | Recovery | PASS | Reconstruct the first unproved step from task/Git/CI/validation/review/merge facts. |
| B7 | Synthetic Microtest 001 | PASS | `node --test tests/microtest-001.test.js`; all eight acceptance cases passed, including exact-head staleness, recovery, fail-closed evidence, review ordering, and successful completion/next-task selection. |
| 4 | Failure injection, correction and retest | PASS | All 34 fault IDs executed; corrections are regression-tested; Microtest 001 and full suite pass. F03 confirms that local suffix truncation needs a trusted external checkpoint to detect. Evidence: `docs/evidence/PHASE-4-FAILURE-INJECTION.md`. |
| 5 | Execution runtime | PASS | Deterministic runtime, action planning, checkpoints, retries/wakeup contract, evidence anchoring, projections, Microtest 002, R01–R08, and P5-01–P5-20 passed. Phase 4 regressions, Microtest 001, and the 92-test full suite pass. Evidence: `docs/evidence/PHASE-5-EXECUTION-RUNTIME.md`. |
| 6 | Durable execution safety and real GitHub SCM/CI | PASS | Local durable leases/fencing, real GitHub SCM and exact-workflow CI adapters, two-runtime race, two real sandbox PR/CI/merge lifecycles, G01–G18 injections, Microtest 001, Phase 4, Microtest 002, and the 128-test full suite passed. GitHub server-side manual-bypass enforcement is not proven. Evidence: `docs/evidence/PHASE-6-GITHUB-RUNTIME.md`. |
| 7 | Real Jira TaskSystem adapter | SUPERSEDED by CP-08 (was BLOCKED on real Jira access at the time of the evidence below) | `JiraTaskSystemAdapter`/`JiraSyncClient` implemented behind the unchanged `TaskSystemAdapter` contract; canonical status/AC/dependency mapping, J01–J20, and a real-`LoopRuntime` synthetic substitution proof (Jira task → DONE → next Jira-dependent task eligible) all pass; the 152-test full suite passes with zero existing files modified. No Jira site/credentials/connector exist in this environment, so the real Jira read/write path and Microtest 004 against a live project were not executed and PASS is not claimed for them. Evidence: `docs/evidence/PHASE-7-JIRA-TASKSYSTEM.md`. |

## Phase 1 evidence snapshot

### Environment at discovery

- RecompraCRM: `main`, HEAD `87d27d1f2f94a4fa64b0b6e789b1d1d99d1dc27a`; one pre-existing untracked `.claude/settings.local.json` was observed and left untouched.
- Souza Lab: `main`, no prior commit, and no source files before the Phase 0 baseline.
- No repository scripts, tests, builds, dependency installation, or mutations were performed during discovery.

### Reusable evidence

- Exact-head independent review and a deterministic merge predicate refused merges when required review, CI, or complete finding evidence was missing.
- Fail-closed preflight caught real pointer drift and blocked review dispatch on red CI.
- The resolver selected roadmap work by dependencies; architecture work absent from the roadmap was invisible to it.
- Controller-owned review dispatch reduced cancelled model reviews in the documented before/after period and used the default branch's trusted workflow definition.
- TASK-15 demonstrated a real HTTP path through customer, product, sales, stock, forecast, dashboard, and history, with an isolated database schema and post-merge CI evidence.

### Gaps and failures that constrain Phase 2

- The audit records 17 cases of pointer, status, or explanatory prose drifting; current checks do not cover all prose or compare every pointer to computed truth.
- STATE, HANDOFF, roadmap, and event records duplicate some facts. The register accepts records without enforced severity, and JSON validity alone does not prove record completeness.
- The audit records merges before required independent review and task closure before post-merge validation. Later gates address these defects, but the historical events remain failures.
- Review-workflow self-review produced green checks without verdicts. The later solution used staged bootstrap and trusted default-branch dispatch.
- Early wait/recovery paths could stop without re-entry; later supervisor/watcher changes improved retry behavior. A local watcher cannot run while its host is shut down.
- The final audit says exact-head authoritative validation was exercised once across the experiment; that path is less proven than code review.
- Concurrent task execution, deployment, and complete server-side enforcement against manual merge were not demonstrated by the discovery evidence.

## Loop Base v0 design boundary

The evidence-backed conceptual lifecycle is:

```text
TASK
→ RESOLVE CONTEXT
→ PLAN
→ EXECUTE
→ TEST
→ VALIDATE
→ INDEPENDENT REVIEW
→ EVIDENCE
→ STATE TRANSITION
→ HANDOFF / NEXT TASK
```

Loop Base v0 preserves the proven properties—dependency-based task resolution, exact-revision validation and review, fail-closed gates, append-only evidence, post-merge validation, and resumable waits—while changing project-specific Markdown/GitHub assumptions into replaceable adapters. Computed state must be checked against persisted projections. Implementation follows the approved B0–B7 sequence.

Production task-system/SCM/CI/review/validation adapters, real capability providers, durable wakeup service, multi-process execution locking, and server-side merge enforcement remain open decisions. They must not be silently settled by this synthetic implementation.

## Microtest boundary

Microtest 001 ran against a temporary local Git repository and Markdown roadmap, using the real local Git/task/evidence/state/recovery components and deterministic fake SCM/CI/review/validation providers. `node --test tests/microtest-001.test.js` passed all eight required cases. It used no RecompraCRM files, credentials, GitHub writes, model calls, deployment, or external services. The full `npm test` suite is the final B0–B7 verification gate.

## Change control

Update this document when the owner changes phase order, accepts a gate, resolves an open decision, or corrects a factual claim. Record evidence for completed phase gates. Do not mark a phase complete based only on an agent's summary. The owner gate for B0–B7 is passed. Phases 4, 5, and 6 are complete. Phase 7 was BLOCKED on real Jira access when its evidence was recorded; that state is superseded by the CP-08 live Jira evidence (see "Project identity and lineage"), and the Phase 7 evidence file is not rewritten. Forward work after CP-08 is governed by the "Active checkpoint roadmap" above (CP-09 onward), which supersedes the earlier Phase 7 and Phase 8 wording; each checkpoint still requires its own Owner authorization before implementation.

Owner decisions are recorded under `docs/decisions/`. See [`docs/decisions/OWNER-DECISION-JIRA-CONTROL-PLANE.md`](../decisions/OWNER-DECISION-JIRA-CONTROL-PLANE.md) for the Owner's decision approving Jira as a persistent operational task-system integration; that decision did not itself change Phase 7's status at the time it was recorded; the later CP-08 live evidence did.
