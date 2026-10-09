# Agent executor contract (CP-10)

Owner architecture decision (2026-10-06, an Owner directive given in session): **Souza Loop owns the deterministic protocol; the agent that edits files is replaceable.** Hermes is the executor proven in CP-10, not a permanent dependency.

```text
Jira → Souza Loop Controller → AgentExecutor → Git/GitHub → validation → independent review → correction/retry/recovery → merge/reconciliation
```

## What Souza Loop owns (never delegated to an agent)

Task selection, dependency resolution, execution state, branch/worktree identity, exact-HEAD tracking, retry and correction policy (bounded), stale-evidence invalidation, validation gates, independent-review gates, merge eligibility, crash/restart recovery, owner-escalation rules and durable state. A model need not produce identical tokens across runs; the protocol around it is deterministic and is re-derived from durable sources (Jira, Git, GitHub, the state and evidence stores, the task/spec data and recorded findings), never from an agent session's memory.

## The generic capability contract

Defined in `src/controller/ports.js` (`AgentExecutor`, `agentCapabilities`). Names follow the existing architecture; the Owner's `implement / correct / resume / cancel / getResult` map as follows.

| Owner capability | Contract today | Notes |
|---|---|---|
| implement(task, context) | `execute(workPackage, { workspace, facts: null })` | required |
| resume(task, recoveryContext) | `resume(workPackage, { workspace, facts })` | optional; continues uncommitted work, never discards it |
| correct(task, findings, context) | `correct(workPackage, { workspace, findings, round, facts })` | optional; added in CP-10 |
| getResult(run) | the return value: an `AgentResult` (`head`, `base`, `branch`, `authorId`, `changedFiles`) | the Loop re-reads HEAD, trailers and cleanliness from Git and never trusts the claim |
| cancel(run) | **not defined yet** | needed for concurrent execution and hard timeouts; belongs with CP-13 |

An executor only changes files in the workspace it is handed. A correction must be a **new commit that fast-forwards the reviewed head** and carries the execution's `Loop-Execution-Id` / `Loop-Task-Id` trailers; anything else (no commit, amended history, foreign commit, uncommitted leftovers) is rejected from Git facts.

## What CP-10 added around the contract (executor-neutral)

- `HermesAgentExecutor.correct` is the first implementation; the lifecycle and controller call only the generic capability.
- Review findings may declare `ownerDecision: true`; such a finding stops the loop with `OWNER_DECISION_REQUIRED` and is never sent back to the implementer. Absent means repairable.
- The correction loop is bounded by `github.maxCorrections` (1–10, default 3). Exhaustion stops with `OWNER_DECISION_REQUIRED`.
- Reviewer independence is enforced before anything is recorded: a review whose `reviewerId` equals the implementation author is rejected. The production profile also refuses a reviewer that resolves to the same real executable as the implementer.
- The production profile selects the executor through a small registry (`AGENT_EXECUTORS` in `src/composition/production-profile.js`).

## Remaining Hermes-specific coupling (technical debt)

- `src/adapters/hermes-agent-executor.js`: the whole adapter (Hermes kanban CLI, task body, polling, status vocabulary).
- `src/composition/production-profile.js`: the `hermes` registry entry, the config keys `agent.board` and `agent.coderAssignee`, and the `hermesRun` test override.
- Idempotency and re-attachment after a restart rely on Hermes' `--idempotency-key`. The runner's Git-first recovery (adopt committed work, resume uncommitted work, re-run when nothing exists) is executor-neutral; what another executor must supply itself is protection against two live runs of one execution.
- Trailers are enforced by instructing the agent in its task text; an executor that cannot follow that instruction must add the trailers itself after the agent finishes.
- `docs/hermes-agent-executor.md` documents the Hermes boundary only.
- Nothing in `src/controller/*` names an agent: a static guard (the control-plane token-budget test) forbids model and agent names there.

## ClaudeAgentExecutor and CodexAgentExecutor: feasibility and what is required

Both are **feasible without Hermes in the middle**. Each is one adapter plus a shared conformance suite:

1. Run the CLI headless in the workspace (`claude -p` / `codex exec`) with the work package, or the work package plus findings, as the prompt; no shell, argv only, body/prompt via stdin or a private file.
2. Instruct commit trailers and no history rewrite; after the process exits, derive the `AgentResult` from Git exactly as `HermesAgentExecutor` does (the Git-fact helpers are already executor-neutral).
3. Implement `resume` (preserve uncommitted work) and `correct` with the same acceptance rules.
4. Timeouts and process-tree termination (the reviewer adapter already has this pattern), and a per-execution guard against concurrent runs.
5. A conformance test suite that runs the same scenarios (execute, resume, correct, crash/restart, hostile text, rewritten history) against any executor with a scripted CLI; the CP-10 `fake-hermes` helper is the template.
6. Platform notes: on Windows the Claude CLI is an npm shim (`claude.cmd`), so the adapter must run its `cli.js` through `node` (shell-less spawn requires a real binary).

Independent review stays a separate role and a separate execution context (for example Hermes or Claude as implementer with Codex as reviewer); Souza Loop enforces the protocol identically whichever executors are chosen.

## Recommended future checkpoint

A dedicated executor-pluggability checkpoint, placed after CP-11 and before CP-15 without renumbering the roadmap (for example "CP-11B"): `ClaudeAgentExecutor` (direct), the conformance suite, `cancel`/`getResult` semantics, and registry-driven configuration. `CodexAgentExecutor` follows the same pattern and can reuse the suite.
