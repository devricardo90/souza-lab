# Souza Lab — Souza Loop

`souza-lab` is the **official repository** of the reusable autonomous development Loop. **Souza Loop** is the runtime/engine implemented here.

## Start here

- **Canonical source of truth (roadmap, status, active checkpoint):** [`docs/roadmap/SOUZA-LAB-LOOP-SOURCE-OF-TRUTH.md`](docs/roadmap/SOUZA-LAB-LOOP-SOURCE-OF-TRUTH.md). It is the only source of truth; do not create another.
- Owner decisions: [`docs/decisions/`](docs/decisions/)
- Evidence records: [`docs/evidence/`](docs/evidence/)
- Hermes execution boundary: [`docs/hermes-agent-executor.md`](docs/hermes-agent-executor.md)

## Which repository is which

| Name | Role |
|---|---|
| RecompraCRM | Historical origin of the Loop. Read-only evidence. |
| `rick-loop` | Historical precursor, preserved read-only. **Not active.** Its M0–M9 / F0–F7 plan does not govern this repository. |
| `souza-lab` | Official Loop repository (this one). |
| Jira | Operational control plane and task system; not the architecture authority. |
| Hermes | Production agent execution layer. |
| Google Docs | Optional, deferred; not required for Loop readiness. |

## Current state

See the "Active checkpoint roadmap" in the Source of Truth for the authoritative status. At the time of writing, CP-08 is DONE and the active checkpoint is CP-09 — Production Composition. Implementation of a checkpoint requires Owner authorization.

## Tests

```text
npm test
```
