# Owner Decision — Jira Deterministic Control Plane

**Date recorded:** 2026-09-30
**Recorded at commit context:** HEAD `fca64a33a3079f87c63ccbaf6a78077e4a7ae9e4` (Phase 7 synthetic work)
**Type:** Owner decision, not a phase evidence record. This document persists a decision; it does not claim any implementation or test result.

## Decision

The Owner has decided that the independent Souza Lab Loop must support **Jira** as a persistent, deterministic operational task system. This is an explicit, forward-looking scope decision. It is not being revisited by future audits of *whether* Jira should exist — only *how* and *when* it is safely built is open for further work.

## Historical clarification (does not rewrite prior history)

- The original B0–B7 objective was: preserve proven RecompraCRM Loop behavior, remove Recompra-specific coupling, create provider-neutral contracts, and prove independent operation. That objective did **not** originally require Jira, and no prior evidence record is being reinterpreted to claim otherwise.
- `CORE_PORTABILITY_BASELINE` = already proven independently. B0–B7 (`docs/roadmap/SOUZA-LAB-LOOP-SOURCE-OF-TRUTH.md`), Phase 4 (`docs/evidence/PHASE-4-FAILURE-INJECTION.md`), Phase 5 (`docs/evidence/PHASE-5-EXECUTION-RUNTIME.md`), and Phase 6 (`docs/evidence/PHASE-6-GITHUB-RUNTIME.md`) stand as PASS on their own terms, using the Markdown task adapter and real GitHub SCM/CI providers. Nothing about accepting Jira as a future integration changes any of those results.
- `PHASE_7_JIRA` = an approved **operational extension** of the already-portable Loop, not a requirement that was ever necessary for B0–B7 to pass, and not retroactively claimed as such.

## Scope of the Jira integration

Jira is intended to become the Loop's persistent operational task-system integration for:

- Epics
- Stories / Tasks
- Sprint association
- Lifecycle status
- Dependencies
- Operational comments
- Execution evidence references

## Authority split (refines Source-of-truth rule 1)

`docs/roadmap/SOUZA-LAB-LOOP-SOURCE-OF-TRUTH.md` rule 1 currently reads: "The roadmap or task-system adapter owns intended work and acceptance criteria." This decision refines, and does not contradict, that rule:

- **Repository documents** (this decisions folder, `docs/roadmap/`, `docs/evidence/`) remain authoritative for: architecture, policies, protocol invariants, Owner decisions, and acceptance gates.
- **Jira** owns operational work state: which issues exist, their current status, sprint/epic association, dependency links, and the operational comment/evidence trail attached to each issue.
- These two sources must not compete. A Jira status is a fact the Loop's `JiraTaskSystemAdapter` reads and normalizes into the canonical `Task` contract; it never becomes execution truth by itself (the State Engine's `INCONSISTENT_STATE` behavior when Jira claims "Done" without completion evidence, already proven in Phase 7 under J13, is the existing enforcement of this boundary and needed no change to remain correct here).

## Required architecture direction (recorded, not yet implemented)

```text
AGENT (Claude, Codex, Hermes, or any other agent)
  ↓
LOOP CONTROLLER
  ↓
TaskSystemAdapter (existing, unchanged contract)
  ↓
JIRA GATEWAY / TRANSPORT  ← not yet built as a shared, agent-agnostic boundary
  ↓
JIRA
```

No agent should depend on an ad-hoc Jira MCP appearing in its current session, manually pasted credentials, direct agent-to-Jira access, or vendor-specific logic inside the Loop core. Any conforming agent must be able to reach Jira through the same deterministic interface. This is a target for future work; the accompanying architecture-gap audit (delivered alongside this decision) records that this shared, agent-agnostic gateway boundary does not exist yet — today, using the Jira adapter means importing the Node module directly and supplying credentials in-process, which does not yet meet this bar.

## Non-secret record

This document contains no secrets, tokens, site identifiers, or credential material, and none should ever be added to it or to any file under `docs/`. Secret handling is addressed separately as a credential-architecture recommendation, deferred until the Owner chooses to supply real access.

## Status

This decision is recorded. It authorizes continued Jira-related design and implementation work under Phase 7's existing BLOCKED status (real Jira access still does not exist in this environment). It does not itself change Phase 7's verdict, and it does not authorize skipping the real Jira read/write proof or Microtest 004 required for Phase 7 to reach PASS.
