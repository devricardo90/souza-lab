# Phase 5 — Execution Runtime Evidence

## Verdict and baseline

- Phase baseline: `1c28ae08f7f2ed178330237a2d6dcf76ea1e3e52` (accepted Phase 4).
- Phase result: **PASS** for the local deterministic runtime foundation and required synthetic tests.
- Remote synchronization and the final commit SHA are recorded in the execution report after commit/push.
- No real Jira, GitHub task/PR writes, model/reviewer API, Vercel, production credentials, deployment, or RecompraCRM code was used.

## Runtime architecture

The runtime composes existing authorities and does not implement state-machine rules:

```text
task/Git/SCM/CI/review/validation providers
  → RuntimeObserver
  → RecoveryCoordinator and ComputedStateEngine
  → ActionPlanner
  → CapabilityExecutor
  → EvidenceStore and checkpoint providers
  → next observation and computed state
```

`Observation`, `ExecutionSnapshot`, `PlannedAction`, `ActionResult`, `RuntimeCheckpoint`, `RuntimeCycle`, `ExecutionOutcome`, and `WakeupRequest` are validated structures in `src/core/runtime-contracts.js`. `src/core/loop-runtime.js` performs a bounded `runCycle()` and `runUntilStop({ maxCycles })`. A cycle performs at most one capability action. It records structured planned/result/cycle events and checkpoint references.

The closed action vocabulary is:

```text
NO_OP LOAD_TASK PREPARE_SPEC REQUEST_SPEC_REVIEW PREPARE_IMPLEMENTATION
RUN_TESTS RUN_VALIDATION REQUEST_REVIEW PREPARE_MERGE
RUN_POST_MERGE_VALIDATION WRITE_PROJECTIONS WAIT ESCALATE_OWNER
ESCALATE_EXTERNAL COMPLETE
```

The planner maps the computed state to one of those actions. Before execution the runtime observes providers again and compares computed state, candidate HEAD, and a stable fingerprint of authoritative facts with the action preconditions. Stale actions are blocked. Malformed reconciliation status/results are blocked rather than treated as `NOT_STARTED` or success.

## Idempotency, checkpoints, retries, and wakeups

- Action identity includes repository, execution, task, action type, stable input fingerprint, and attempt. Cycle identity is recorded but excluded from the stable action fingerprint so a restart can reuse a planned action.
- Before re-execution, the runtime calls the executor’s reconciliation boundary. Completed provider facts are reconciled; contradictory successful evidence with unchanged provider facts blocks instead of repeating the action. Merge recovery was exercised before and after provider success.
- `JsonRuntimeCheckpointStore` writes atomic, execution-scoped checkpoint records. The checkpoint stores state/fact fingerprints, revision, action, cycle, task, and evidence sequence as recovery pointers. Recovery recomputes operational state from authorities. Task identity hints are checked against current task-system ordering; an incomplete task that is not selected cannot be activated from checkpoint data. A completed active task may be reconciled to `DONE` so the next task can be selected.
- `RuntimeRetryPolicy` classifies transient, permanent, owner-required, external-block, and invariant errors. Transient retries use bounded exponential delay, attempt count, failure summary, and a `WakeupRequest`; runtime waits until `earliestRetryAt`. Permanent and exhausted failures do not become `DONE`.
- Both asynchronous capability execution and reconciliation have deadlines. Timeout yields a transient retryable result, and the executor receives an `AbortSignal` and stable idempotency key.
- The `WakeupProvider` contract is present; tests use an in-memory fake. A durable scheduler adapter is not included.

## Evidence checkpoint and projections

`EvidenceCheckpointProvider` anchors `(sequence, rootHash, timestamp)` outside the append-only JSONL history. The local deterministic provider validates checkpoint schema/checksum and detects a missing suffix, altered history, rollback, or same-sequence conflict. The runtime fails closed on truncated or mismatched history. This detects suffix deletion only relative to a previously trusted checkpoint. An actor able to modify both the event log and trusted checkpoint can rewrite both; the local implementation is not a separately administered trust boundary.

`MarkdownProjectionStore` generates `STATE.md` and `HANDOFF.md` from computed state with a generated marker and digest. Changed, malformed, or stale projections are reported as drift and regenerated. Neither projection is an authority.

## Microtest 002 — Runtime Lifecycle

`tests/microtest-002.test.js` runs the actual runtime with synthetic task, Git, SCM, CI, review, and validation facts. It autonomously executes:

```text
TASK-001 → spec → spec review → implementation → CI → validation
→ independent review → merge → post-merge validation → DONE → TASK-002 selected
```

It does not manually set computed states. Fake capabilities mutate synthetic provider facts; the next cycle observes those facts and computes the next state. The Microtest 002 file has 19 passing tests; with the 3 runtime-contract tests, the focused command reports 22 passing tests.

## Runtime crash matrix

| ID | Injected interruption | Verified recovery |
|---|---|---|
| R01 | After planning, before execution | Restart reuses the stable action identity; no duplicate plan/action. |
| R02 | During execution, before durable result | Provider facts are re-observed before retry; changed facts advance recovery without another execution. |
| R03 | After provider success, before result evidence | Restart observes the provider change and does not repeat the successful action. |
| R04 | After result evidence, before checkpoint | Evidence remains durable and recovery advances without repeating work. |
| R05 | After checkpoint, before next observation | Restart recomputes from provider/evidence facts without repeating work. |
| R06 | Immediately before merge execution | Merge is attempted only after a fresh exact-head gate check. |
| R07 | Immediately after merge provider success | Merge is not repeated; state resumes at post-merge validation. |
| R08 | After final validation provider success, before durable result/projection | Restart derives completion from facts, repairs projections, and reaches `DONE`. |

## P5 test matrix

| ID | Evidence / test | Result |
|---|---|---|
| P5-01 | Microtest 002 autonomous lifecycle | PASS |
| P5-02 | One capability action per cycle | PASS |
| P5-03 | Deterministic state-driven planner | PASS |
| P5-04 | Stale HEAD action rejected | PASS |
| P5-05 | Stale spec/AC fingerprint action rejected | PASS |
| P5-06 | Stable action IDs, duplicate capability calls, evidence success without provider advancement, and malformed reconcile response | PASS |
| P5-07 | R03 provider success before evidence | PASS |
| P5-08 | R04 evidence before checkpoint | PASS |
| P5-09 | R05 checkpoint recovery | PASS |
| P5-10 | Transient retry delay/attempt accounting and execution/reconciliation timeout | PASS |
| P5-11 | Permanent external failure blocks | PASS |
| P5-12 | Owner-required failure yields owner block | PASS |
| P5-13 | R06/R07 merge action is not duplicated | PASS |
| P5-14 | R07 resumes post-merge validation | PASS |
| P5-15 | Generated projection writing and regeneration | PASS |
| P5-16 | Manual projection tampering detected | PASS |
| P5-17 | Trusted checkpoint detects valid evidence suffix deletion | PASS |
| P5-18 | Corrupted evidence/runtime checkpoint rejected | PASS |
| P5-19 | Stale checkpoint state/task hint cannot override recomputed task-system truth | PASS |
| P5-20 | `DONE` selects the dependency-ready next task | PASS |

## Defects found and corrections

1. An unknown executor reconciliation status could previously fall through to execution; a `COMPLETED` result also needed action identity and success validation. Runtime now fails closed. Regression tests prove neither malformed response can trigger capability execution.
2. Asynchronous reconciliation lacked a deadline even though execution was bounded. Both operations now have deadlines and transient timeout classification. A never-resolving reconcile provider is tested and cannot invoke the capability.
3. A checkpoint task ID could override task-system order. A regression reproduced selection of `TASK-002` while `TASK-001` remained eligible. Recovery now treats checkpoint task ID as a hint: it may resume the currently selected task or finish that task after the task source marks it complete; it cannot skip ahead. The checkpoint’s stored state remains non-authoritative.

Each correction remains covered by permanent tests. The independent acceptance audit found three additional runtime defects and added permanent regressions:

4. Two concurrent `runCycle()` calls for the same execution could both reconcile `NOT_STARTED` and issue duplicate merges. Calls are now serialized by execution ID inside one `LoopRuntime` instance; an overlapping-cycle regression asserts one merge call.
5. Idempotency keys included the attempt number, so retrying the same logical operation changed its provider key. Keys now bind repository, execution, task, action type, and input fingerprint, while remaining stable across attempts. A regression checks retries reuse the key.
6. A crash after a retry result was appended but before the checkpoint write lost the retry deadline. Retry schedule metadata is now part of the hash-chained `ACTION_RESULT` event and recovered before another action; a restart regression proves the provider is not called early.
7. Restart after a permanent failure or exhausted transient retry budget could execute the same logical operation again. Runtime now restores terminal retry classifications from durable action-result evidence and blocks further execution. Regressions prove restart does not repeat permanent or exhausted actions.

The late-capability regression uses a controlled deferred operation rather than a wall-clock race. It proves the same executor reports/reconciles an in-flight action instead of issuing a second call. The serialization guarantee is process-local to a single runtime instance; no cross-process execution lease is implemented.

## Performance investigation

The slow work is concentrated in Git-backed temporary-repository tests, which launch several Git child processes per fixture. Microtest 001 ranged from 27 to 104 seconds across this audit's runs (its slowest subtest reached 39 seconds in one run); the final full suite took 27 seconds. Phase 4 tests took 0.5–2.2 seconds. Runtime capability execution and reconciliation have bounded deadlines, and local Git subprocesses and fixture Git helpers use a 15-second timeout. The earlier ~11-minute result was not reproduced as a single hang; the wide timing spread indicates variable Windows/Git fixture performance, not a fixed runtime. No command exceeded the bounded test/process controls.

## Verification results

All commands were run sequentially after the final runtime corrections:

| Command | Tests | Passed | Failed | Skipped | Result |
|---|---:|---:|---:|---:|---|
| `node --test tests/microtest-002.test.js tests/runtime-contracts.test.js` | 26 | 26 | 0 | 0 | PASS, 9 seconds |
| `node --test tests/phase4-failure-injection.test.js tests/jsonl-evidence-store.test.js` | 35 | 35 | 0 | 0 | PASS |
| `node --test tests/microtest-001.test.js` | 9 (8 acceptance subtests) | 9 | 0 | 0 | PASS, 27 seconds |
| `node --test tests/microtest-002.test.js` | 23 | 23 | 0 | 0 | PASS, 11 seconds |
| `npm test` | 96 | 96 | 0 | 0 | PASS, 27 seconds |

The standalone Microtest 002 run before the deterministic test adjustment initially exposed a timing-sensitive test (21 passed, 1 failed), not a production failure: its fixed 300 ms delay could complete while the Windows runner was delayed. It was replaced with a manually released pending operation and zero-delay retry policy. The test harness then captured two real restart defects (permanent failure and retry exhaustion caused another provider call); both were corrected and are included in all final runs above. No mandatory test was skipped.

## Known limitations

- All execution capabilities and external facts in Microtest 002 are deterministic fakes. No real code-writing agent, review provider, CI service, SCM merge, or scheduler is connected.
- Safe retry of a real side effect depends on a production executor honoring idempotency keys and accurately reconciling provider facts. The fake executor is process-local; no multi-process lease/lock is implemented.
- A timeout aborts via `AbortSignal` and stops the runtime from waiting, but JavaScript cannot forcibly terminate an arbitrary adapter promise. A real adapter that ignores cancellation must still provide durable idempotency and reconciliation; otherwise its timed-out operation could complete later. Current tests demonstrate the fake executor's pending-operation reconciliation, not arbitrary third-party adapter cancellation.
- The local evidence anchor protects against accidental/partial history loss only when its storage remains trusted independently from the JSONL log. It does not defend against coordinated rewriting of both.
- Runtime checkpoint JSON is schema-validated, but the checkpoint itself is a recovery hint rather than an authenticated truth source. Provider facts, task-system ordering, and evidence are recomputed.
- Runtime authority-provider contracts are currently synchronous. Local Git calls are bounded; asynchronous capability execute/reconcile calls are bounded. A future asynchronous task/CI/SCM adapter needs its own deadlines and cancellation behavior.
- A real durable wakeup backend and platform-specific projection placement remain future adapters.

Phase 5 requires no production/provider credentials and was verified with local files and fake providers only. RecompraCRM remained read-only.
