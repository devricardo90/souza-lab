# Souza Lab Loop — Source of Truth

**Baseline date:** 2026-09-27
**Status:** Documentation baseline accepted; B0 contracts PASS; B1 Markdown adapter PASS; B2 Local Git adapter PASS; B3 Computed State Engine in progress.
**Current phase:** Phase 2 — Loop Base v0 implementation (B0–B7).

This document is the canonical roadmap and governance record for building a reusable development Loop in Souza Lab. It records the phase order, current evidence, decisions, and boundaries. The owner accepted baseline commit `e20e9f327f6b67bf62ca05b53c4185013f910b0b` and authorized implementation through B7; no additional planning gate is required between stages.

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
| B3 | Computed State Engine | In progress | Derive state from authoritative facts; projections and narrative cannot override it. |
| B4 | Evidence Store | Not started | Append and read validated evidence events without update/delete operations. |
| B5 | Fake Providers | Not started | Exercise all provider boundaries with deterministic fixtures and no external services. |
| B6 | Recovery | Not started | Reconstruct the first unproved step from task/Git/CI/validation/review/merge facts. |
| B7 | Synthetic Microtest 001 | Not started | Execute the full architecture and pass all eight required test cases. |

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

The exact task-system adapter, execution runtime, reviewer/validator providers, durable wakeup mechanism, and server-side merge enforcement remain open decisions. They must not be silently settled by implementation.

## Microtest boundary

Microtest 001 is **not started** and is authorized as B7. It will use isolated synthetic facts and deterministic fake providers, with no RecompraCRM files, credentials, GitHub writes, model calls, or deployment. It must execute all eight cases from the owner directive, including the valid path and rejection/recovery cases. Its executable results, not this description, determine PASS.

## Change control

Update this document when the owner changes phase order, accepts a gate, resolves an open decision, or corrects a factual claim. Record evidence for completed phase gates. Do not mark a phase complete based only on an agent's summary. The owner gate is passed; continue through B7 unless a genuine hard blocker occurs.
