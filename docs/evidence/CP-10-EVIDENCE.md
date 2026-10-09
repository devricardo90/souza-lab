# CP-10 Live Evidence Index

Raw per-run JSON files in this directory are immutable evidence. This index only classifies them. Nothing was deleted or rewritten.
Sandbox repository: `devricardo90/souza-loop-sandbox`. Jira project: `LOOP`.

## 1. PROOF_A (clean path) — PASS

- File: `CP-10-LIVE-CP10A-261007171704.json`; task LOOP-5 (see file), PR #15 MERGED, merge commit `a1539ead108a39d39eb749c6f8ae35dd38f3a163`.
- Independent review CLEAN on `1e02a720` (spec) and on final head `6452aef4`; merge, post-merge validation and Jira completion per file.
- Earlier failed Proof A attempts kept as history: `…154658.json` (LOOP-3, no reviewer reached) and `…170632.json` (LOOP-4, `OWNER_DECISION_REQUIRED`). Both are failed pre-fix artifacts, not passes.

## 2. PROOF_B_INVALID_FIXTURE — historical, classified INVALID_FIXTURE

- Files: `CP-10-LIVE-CP10B-261007172658.json`, `…-resume1-sleep-interrupted.json`, `CP-10-PROOF-B-RECOVERY.json`.
- Task LOOP-6, PR #16 (left OPEN, unmerged). Sandbox `main` already contained `src/greet.js` after Proof A, so the acceptance criteria were already satisfied; every implementation commit (`50653cb`, `8f02874`, `f547433`) was empty relative to base. The scenario could not converge by design. Status: `STOPPED_INVALID_FIXTURE` — not a pass, not a reviewer false-CLEAN.
- Defects it exposed (fixed afterwards): reviewer request omitted the diff; no fixture preflight; no empty-diff guard.
- Environmental interruptions (kept, they are recovery evidence):
  1. `SYSTEM_LOW_MEMORY` — controller process lost.
  2. `SYSTEM_SLEEP` — Kernel-Power standby; controller lease expired; exit 75 `CONTROLLER_LEASE_LOST`.
- Zero-duplicate recovery after restart: duplicate Jira writes 0, duplicate PRs 0, duplicate implementation dispatches 0; the same Hermes correction task (same idempotency key) was re-attached; LOOP-6 `JIRA_CREATE` outbox CONFIRMED once; PR #16 kept the same branch.

## 3. PROOF_B_VALID_RUN — PASS

- File: `CP-10-LIVE-CP10B-261008183201.json`; task `CP10B-261008183201` = Jira LOOP-7; PR #17 MERGED.
- Fixture preflight `FIXTURE_VALID`; baseline SHA `a1539ead108a39d39eb749c6f8ae35dd38f3a163` (probe exit 1 at baseline, target files absent).
- Initial implementation HEAD `32fe9b6dd6cf4429181af76f514911aa810085f7` → validation PASS → independent review **FINDINGS** (`F-MARKER-1`, repo convention marker missing).
- Automatic correction through the generic correction path (1 round, second Hermes task `t_a72ece50`, no Owner involvement) → corrected HEAD `e569f584c3ce6314bec98a0c59d5f8ddcaa26d2c`.
- Stale-evidence invalidation: `correction.firstHeadStaleForFinalHead = true`; evidence for `32fe9b6d` was not reused for `e569f584`.
- Revalidation on `e569f584` PASS → independent re-review **CLEAN** → merge commit `973deb2a512f788266a2fa67a65a705b948a0cbf` → post-merge validation PASS → Jira LOOP-7 DONE (`REMOTE_DONE_CONFIRMED`).

## 4. Measured reviewer cost (Claude Code headless, USD, cap 5 per run)

| Run | Model calls | USD |
|---|---|---|
| Proof A (…171704) | 1 | 0.2667 |
| Proof B invalid (…172658) + resume | 2 + 1 | 0.0613 + 0.0213 |
| Proof B valid (…183201) | 2 | 0.2946 |
| Total across recorded runs | 6 | 0.6439 |

## 5. Hermes / Copilot cost limitation

Hermes ran on the GitHub Copilot provider (`gpt-4.1`, profile `coder`). Copilot does not report per-call cost to Hermes, so implementer/corrector cost is **not measured**. Only reviewer cost is.

## 6. Duplicate side-effect counts

| Run | Jira create | Jira transition | PRs | Impl. dispatch |
|---|---|---|---|---|
| Valid Proof B (LOOP-7) | 1 (attempt_count 1) | 1 (attempt_count 1) | 1 (#17) | 1 (+1 intended correction task) |
| Invalid Proof B after 2 interruptions (LOOP-6) | 1 | 0 | 1 (#16) | 1; correction task re-attached, not re-created |
| Duplicates, all runs | 0 | 0 | 0 | 0 |

## 7. Identities

- Implementer: `loop-cp10-hermes@users.noreply.github.com`, `hermes.exe`, copilot/gpt-4.1.
- Reviewer: `claude-code-reviewer@loop.invalid`, Claude Code headless (default model). Reviewer identity differs from implementer identity (independence enforced).

## 8. Known limitations

- Hermes/Copilot cost unmeasured (section 5).
- Only one executor (Hermes) was proven live; Claude-direct and Codex-direct executors were not run live.
- Only one finding class (convention marker) was exercised live for autonomous correction; one correction round.
- Live proofs depend on an external sandbox repo, Jira site, Hermes and Claude CLIs; they are not reproducible in CI. Deterministic tests cover the logic.
- The empty-diff guard and fixture preflight were added **after** the invalid-fixture run; the valid run used the preflight, and the guard is proven by deterministic tests (`tests/execution-runner.test.js`, `tests/live-proof-fixtures.test.js`), not by a live empty-commit event.
- A non-empty but irrelevant diff is left to validation/review by design.
