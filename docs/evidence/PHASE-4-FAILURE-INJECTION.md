# Phase 4 — Failure Injection Evidence

**Accepted Foundation baseline:** `bfc30fd3333ad5ff61366def7d5880ced5faebd9`
**Implementation HEAD audited:** `b2aabe5abe270d931ba9421085e956359595646d`
**Branch:** `main`
**Remote before synchronization:** `origin/main` at the accepted Foundation baseline.
**Environment:** local Node.js and isolated temporary repositories/stores; no production services or credentials.

## Result

All 34 mandatory fault IDs were executed. There were no unexpected outcomes after correction. F03 is an explicitly confirmed limitation, not a passing detection claim: deletion of a valid evidence-log suffix cannot be detected by the local hash chain alone.

| Measure | Result |
|---|---:|
| Fault IDs planned / executed | 34 / 34 |
| Expected outcomes / unexpected outcomes | 34 / 0 |
| Focused Phase 4 and evidence-store tests | 35 passed, 0 failed, 0 skipped |
| Microtest 001 | 9 passed, 0 failed, 0 skipped; all 8 acceptance cases passed |
| Full `npm test` suite | 70 passed, 0 failed, 0 skipped |

## Fault matrix

Allowed/blocked actions describe safe behavior while each injected condition remains. The classification distinguishes expected handling from actual defects.

| ID | Precondition and injected fault | Expected state; allowed / blocked actions | Actual result | Classification |
|---|---|---|---|---|
| F01 | Valid JSONL chain; alter an earlier event payload without rehashing later records. | Integrity error; allow diagnosis, block evidence reads/recovery and DONE. | `listAll` and `getById` reject with `HASH_CHAIN_MISMATCH`. | EXPECTED_REJECTION |
| F02 | Valid E1→E2→E3 chain; present E1→E3→E2. | Integrity error; block recovery from reordered history. | `listAll` and `getById` reject with `INVALID_SEQUENCE`. | EXPECTED_REJECTION |
| F03 | Valid E1–E4 chain; remove E4. | Local store can read valid prefix; cannot prove missing suffix. Do not claim truncation detection. | E1–E3 read successfully. | KNOWN_LIMITATION |
| F04 | Existing event ID; append same ID with different payload. | Reject duplicate; preserve original; block overwrite. | `DUPLICATE_EVENT`; original payload remains. | EXPECTED_REJECTION |
| F05 | Valid log; alter sequence to 1,2,4. | Reject malformed history; block recovery. | `INVALID_SEQUENCE`. | EXPECTED_REJECTION |
| F06 | CI, validation and CLEAN review for HEAD A; candidate advances to B. | `VALIDATING`; allow fresh B validation, block merge/DONE. | A validation is stale; merge forbidden. | EXPECTED_REJECTION |
| F07 | Validation only for A; candidate advances to B. | `VALIDATING`; allow fresh B validation, block use of A proof. | Stale A validation does not satisfy B. | EXPECTED_REJECTION |
| F08 | CI statuses GREEN, SUCCESSFUL, OK, UNKNOWN_CUSTOM_STATE. | `TESTING`; allow diagnosis/retry, block later gates. | Noncanonical values stay in `TESTING`; canonical PASS advances. | EXPECTED_REJECTION |
| F09 | Review verdicts APPROVED, GOOD, LGTM, SUCCESS. | `REVIEWING`; allow canonical review, block merge. | All noncanonical values stay in `REVIEWING`. | EXPECTED_REJECTION |
| F10 | Noncanonical validator outputs. | `VALIDATING`; allow canonical retry, block merge/DONE. | Noncanonical outputs stay in `VALIDATING`. | EXPECTED_REJECTION |
| F11 | CLEAN review timestamp equals merge timestamp. | `INCONSISTENT_STATE`; allow reconciliation, block authorization/DONE. | Equality is rejected as not strictly pre-merge. | EXPECTED_REJECTION |
| F12 | CLEAN review timestamp is later than merge. | `INCONSISTENT_STATE`; block retroactive authorization. | Later review is rejected. | EXPECTED_REJECTION |
| F13 | Candidate author and reviewer are the same identity. | `REVIEWING`; allow independent review, block merge. | Same identity fails the review gate. | EXPECTED_REJECTION |
| F14 | CLEAN review has an unresolved blocking finding. | `REVIEWING`; allow finding resolution, block merge. | Verdict does not suppress finding. | EXPECTED_REJECTION |
| F15 | STATE=HANDOFF=DONE and narrative says complete; facts compute REVIEWING. | `INCONSISTENT_STATE`; allow projection repair, block completion. | Derived truth is REVIEWING; false DONE is flagged. | EXPECTED_REJECTION |
| F16 | STATE=READY_TO_MERGE, HANDOFF=VALIDATING; facts compute REVIEWING. | Report computed REVIEWING/mismatch; block trusting either projection. | `derivedState=REVIEWING`, mismatch true, operational state `INCONSISTENT_STATE`. | EXPECTED_REJECTION |
| F17 | Active TASK-X disappears from task source. | Fail closed; allow source repair, block replacement task in this execution. | `ACTIVE_TASK_MISSING`. | EXPECTED_REJECTION |
| F18 | TASK-A dependency becomes incomplete while TASK-B is active. | `DISCOVER`; allow dependency reconciliation, block TASK-B progression. | Coordinator reports incomplete dependency; not merge-ready. | EXPECTED_REJECTION |
| F19 | Candidate worktree becomes dirty. | `IMPLEMENTING`; allow commit/discard/reconciliation, block merge readiness. | Dirty candidate is not merge-ready or DONE. | EXPECTED_REJECTION |
| F20 | Git provider reports repository unavailable/failure. | `BLOCKED_EXTERNAL`; allow external recovery, block inferred success. | `BLOCKED_EXTERNAL`, no DONE. | EXPECTED_REJECTION |
| F21 | CI provider throws a transient retryable error. | `WAIT_RETRYABLE`; allow retry, block CI PASS assumption. | Retryable wait; no fabricated CI result. | EXPECTED_RETRY |
| F22 | Review provider throws a transient retryable error. | `WAIT_RETRYABLE`; allow retry, block merge. | Retryable wait; valid prior facts retained. | EXPECTED_RETRY |
| F23 | Validation provider throws a transient retryable error. | `WAIT_RETRYABLE`; allow retry, block merge/DONE. | Retryable wait; no fabricated validation. | EXPECTED_RETRY |
| F24 | Merge succeeds at provider; process crashes before evidence append. | Reconstruct from provider facts; resume first unproved requirement; block unsupported DONE. | Restart observes merge, resumes `POST_MERGE_VALIDATION`, and appends recovery evidence. | EXPECTED_RECOVERY |
| F25 | Evidence append succeeds; process crashes before next transition response. | Reuse equivalent durable event; avoid destructive duplicate append. | Restart sets `evidenceReused=true`; one event exists. | EXPECTED_RECOVERY |
| F26 | CLEAN exact-HEAD review exists before merge; process restarts. | `READY_TO_MERGE`; allow merge, block reimplementation/review duplication. | First unproved step is `MERGE`. | EXPECTED_RECOVERY |
| F27 | Merge exists; post-merge validation absent. | `POST_MERGE_VALIDATION`; allow validation, block DONE. | Resumes at `VALIDATE_MERGE`. | EXPECTED_RECOVERY |
| F28 | Post-merge evidence proves DONE; projections still say READY_TO_MERGE. | Compute DONE and regenerate projections; allow next-task selection, block projection authority. | Computed state and returned STATE/HANDOFF projections are DONE. | EXPECTED_RECOVERY |
| F29 | Recover twice with unchanged facts and same event ID. | Preserve state; avoid duplicate evidence. | Same computed state; one event; second run reuses it. | EXPECTED_RECOVERY |
| F30 | Duplicate task/AC IDs, broken/self/cyclic dependencies, unclosed fence, partially commented fields. | Reject task source deterministically; block implicit selection. | Each malformed fixture throws a task-source error. | EXPECTED_REJECTION |
| F31 | Spec digest changes after validation while HEAD is fixed. | `VALIDATING`; allow validation for new spec identity, block old proof. | Old validation is stale for changed spec digest. | EXPECTED_REJECTION |
| F32 | AC description changes with count fixed. | `VALIDATING`; allow new AC-bound validation, block old proof. | AC-set digest mismatch invalidates old validation. | EXPECTED_REJECTION |
| F33 | SCM reports merged candidate inconsistent with Git candidate. | `INCONSISTENT_STATE`; allow reconciliation, block DONE. | Contradictory merge fact returns `INCONSISTENT_STATE`. | EXPECTED_REJECTION |
| F34 | Git provider returns two contradictory candidate revisions. | Fail closed at `TESTING`; allow fact reconciliation, block merge/DONE. | No candidate selected; missing exact-head CI keeps `TESTING`. | EXPECTED_REJECTION |

## Defects and corrections

Failure tests were committed before implementation corrections. The initial failing runs exposed these defects:

| Finding | Violated invariant | Correction | Regression coverage |
|---|---|---|---|
| Same implementation identity could pass as reviewer. | Independent review must differ from known candidate author. | Local Git revision now includes author email; state engine rejects matching or absent reviewer identity for known author. | F13; Microtest and state-engine suites |
| Provider exceptions escaped recovery. | Unknown external facts cannot progress; transient failures remain retryable. | Retryable exceptions map to `WAIT_RETRYABLE`; other provider failures map to `BLOCKED_EXTERNAL`. | F20–F23; recovery suite |
| Reusing a recovery event ID could fail on restart. | Recovery must reuse equivalent durable evidence and reject conflicting reuse. | Added `getById`; recovery compares semantic event contents and reuses equivalent records. | F25, F29; recovery suite |
| Lagging projections obscured provider-computed completion and were not regenerated in recovery output. | Projections are not authorities. | Exposed derived state and mismatch; false DONE/conflicting projections are inconsistent; recovery returns fresh projection values. | F15, F16, F28; Microtest 001 |
| Validation ignored acceptance-criteria identity. | AC set changes invalidate prior validation even if count stays the same. | Added canonical AC-set SHA-256 to Task/ValidationResult and checked pre- and post-merge. | F32; state and microtest suites |
| Partially commented task fields could be ignored after hiding the task row. | Malformed task source fails closed. | Orphan fields outside a task raise `ORPHAN_TASK_FIELD`. | F30; Markdown adapter suite |

Commits:

- `63f2756` — `test: add Phase 4 failure injections`
- `b2aabe5` — `fix: fail closed on Phase 4 injected faults`
- Evidence and phase-marker documentation follow in a separate commit.

## Verification commands and evidence

```text
node --test tests/phase4-failure-injection.test.js tests/jsonl-evidence-store.test.js
node --test tests/microtest-001.test.js
npm test
git diff HEAD --check
```

Observed results: focused tests 35/35; Microtest 001 9/9 (all 8 acceptance cases); full suite 70/70; zero failures, cancellations, skipped or todo tests. `git diff HEAD --check` reported no whitespace errors. Git emitted only environment-level ignore-file permission and LF/CRLF advisory messages.

## Known limitation

The JSONL chain detects altered records, reordering, duplicate IDs and sequence gaps. A valid suffix deletion leaves a valid prefix and is locally undetectable. The smallest future mechanism is a trusted external checkpoint of the latest sequence number and root hash (for example, a separately protected checkpoint file or remote immutable record). No external anchoring was implemented in Phase 4.

## Boundaries and verdict

- No Jira, GitHub Issues, reviewer/model API, Vercel, production database, deployment or production credentials were used. Repository synchronization to its configured remote is the only external write planned after verification.
- RecompraCRM was not modified. Its observed `main` HEAD remains `87d27d1f2f94a4fa64b0b6e789b1d1d99d1dc27a`; its pre-existing untracked `.claude/settings.local.json` was left untouched.
- Foundation history was not rewritten. No Phase 5 work or production-provider integration began.
- **Phase 4 verdict: PASS**, with F03 tail truncation retained as a known limitation.
