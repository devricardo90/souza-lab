# CP-08 Jira live proof: status

**CP08_LIVE_STATUS = ALL_LIVE_STAGES_PASSED** (run `CP08MUS8I9PM`, project LOOP only; executed against the code at reviewed commit `95ff0d1`)
**CP08_STATUS = READY_FOR_RE_REVIEW** (independent review returned CHANGES_REQUIRED; the fixes are listed under "Review fixes" and were verified OFFLINE only; not merged; CP-09 not started)

Every fact below was observed in the output of `scripts/cp08-live-jira.js`. Only part of it was ALSO persisted at the time, in the
append-only ledger `docs/evidence/CP-08-JIRA-LEDGER.json` and the discovery config `docs/evidence/cp08-jira-live-config.json`.
See "Evidence provenance" for exactly which claim is backed by which committed artifact. Google remains
`BLOCKED_PENDING_GOOGLE_CREDENTIALS` and is out of scope here.
Scoped transport: `api.atlassian.com/ex/jira/{cloudId}`; credentials come from the environment and are never printed or stored.

## Live stages (run CP08MUS8I9PM)

| Stage | Endpoint(s) | HTTP | Result | Jira object |
| --- | --- | --- | --- | --- |
| auth | `GET /rest/api/3/myself` | 200 | PASS (`accountType: atlassian`, `active: true`) | none |
| discover | `GET agile/board/199`, `issue/createmeta/LOOP/issuetypes[/10230]`, `issueLinkType`, `agile board/199/sprint` | 200 | PASS | none |
| create | `POST issue` | 201 | PASS after the observation fix below | LOOP-1 (Tarefa) |
| ADF roundtrip | `GET issue/LOOP-1` | 200 | PASS: marker, metadata and AC-001/AC-002 decode; reconcile NOOP / STATE_MATCH | LOOP-1 |
| create idempotency | board + `GET issue/LOOP-1` | 200 | PASS: fresh outbox -> CONFIRMED, 0 writes; no second issue | none |
| comment idempotency | `POST issue/LOOP-1/comment` | 201 | PASS: 1 write, repeats 0 writes, exactly 1 marked comment | comment 13193 on LOOP-1 |
| dependency | `POST issue` (LOOP-2), `POST issueLink`, then corrective `DELETE issueLink/10244` and `POST issueLink` | 201 / 204 / 201 | PASS after the direction correction below; both tasks NOOP / STATE_MATCH | LOOP-2; link 10245 |
| sprint | `POST agile/sprint/137/issue` (one per issue) | 204 | PASS: final membership exactly `[LOOP-1, LOOP-2]`; repeat 0 writes | sprint 137 "CP08 Test" |
| transition discovery | `GET issue/LOOP-1/transitions` | 200 | PASS: `A fazer`(11, new), `Fazendo`(21, indeterminate), `Feito`(31, done); exactly one done transition | none |
| status transition | `POST issue/LOOP-1/transitions` | 204 | PASS: `A fazer` -> `Feito` (done); repeat (same and fresh outbox) 0 writes | LOOP-1 |

No Jira issue was deleted at any point: neither the script nor `JiraSyncClient` contains an issue-delete call (the only DELETE is
`issueLink/{id}`), and the ledger records `issuesDeleted: 0` for the link repair. That board 199 held exactly LOOP-1 and LOOP-2
from this run was read from console output and is not in the ledger.

## Defects found by the live proof and corrected

1. **Board observation returned a stringified description.** `GET agile/board/{id}/issue` serves `description` as a rendered
   string, not ADF, so acceptance criteria could not be decoded and a correct LOOP-1 reconciled to `REMOTE_INVALID`
   (create returned CONFLICT; the issue itself was correct). Fix: the board endpoint now only enumerates candidate keys
   (foreign-project keys are dropped and never fetched); reconciliation uses `GET /rest/api/3/issue/{key}`. A canonical
   response for a different key fails closed. `REMOTE_INVALID` detection and the write guard are unchanged.
   Tests: `tests/jira-board-canonical.test.js`.
2. **The dependency direction hypothesis was disproven.** The first Blocks link was written with `dependentEnd: "inward"`
   (POST `inwardIssue`=LOOP-2, `outwardIssue`=LOOP-1). Live raw issuelinks showed LOOP-2 `outwardIssue: LOOP-1` and
   LOOP-1 `inwardIssue: LOOP-2`, i.e. the reverse of "LOOP-2 depends on LOOP-1"; reconciliation reported DEPENDENCY_DRIFT on
   both tasks. Live behaviour is the source of truth: Jira keys the OTHER issue on an entry by that issue's own POST end.
   Corrected mapping: the dependent is the POSTed `outwardIssue` (`dependentEnd: "outward"`), the blocker the POSTed
   `inwardIssue`, and the blocker is read on the dependent under the opposite end's key. Updated: `src/reconcile/jira-relationship.js`
   (`blockerOf`, `SYNTHETIC_BLOCKS_RELATIONSHIP`), the Jira mock's link rendering, the live config, and
   `tests/jira-relationship.test.js` (three regression tests built from the raw live shapes).

## Corrective link repair (ledger entries, run CP08MUS8I9PM)

| Ledger op | Observed |
| --- | --- |
| `dependency` (CONFLICT, 0 noops) | original reversed link created by the dependency stage |
| `reversed-link-observed` | link 10244: LOOP-2 `outwardIssue` LOOP-1 / LOOP-1 `inwardIssue` LOOP-2; direction hypothesis disproven |
| `reversed-link-removed` | `DELETE issueLink/10244` -> 204; link gone from both issues; issues deleted: 0 |
| `correct-link-verified` | `POST issueLink` (inward=LOOP-1, outward=LOOP-2) -> 201; link 10245 |
| `dependency` (RESUMED_EXISTING, 2 noops, 0 conflicts) | both tasks STATE_MATCH |

Raw live issuelinks after the repair:

- LOOP-1: `[{ type: Blocks, outwardIssue: LOOP-2 }]`: **LOOP-1 blocks LOOP-2**
- LOOP-2: `[{ type: Blocks, inwardIssue: LOOP-1 }]`: **LOOP-2 is blocked by LOOP-1**

Only the one wrong link between LOOP-1 and LOOP-2 was removed, through the guarded `removeIssueLink` (project LOOP, Loop
ownership of both ends, exact link id/type/counterpart verified before the DELETE; tests in `tests/jira-remove-link.test.js`).

## Token scope notes (observed)

With the reloaded token: `myself`, `issue` create/read, `issueLink` create/delete, comments, transitions, `issueLinkType`,
createmeta, agile board/sprint reads and `POST agile sprint/{id}/issue` all succeeded. Search endpoints
(`GET search`, `search/jql`, `POST search/jql`) were 401 with the earlier token and were not retried; CP-08 uses the
explicit `board` observation source with per-issue canonical reads instead.

## Review fixes (commit after `95ff0d1`; verified OFFLINE with synthetic stubs, NOT re-run against live Jira)

The independent review (CHANGES_REQUIRED) found, and this commit fixes:

1. **Duplicate create under board/index lag (blocking).** Board observation is index-backed and may lag a write. During the
   live run an `UNCERTAIN_WRITE` retry-wait was observed (console only, see provenance); in that situation a retry that
   reconciled only through a lagging board could have created a second issue. Fix: `observeBoard` still enumerates candidates
   from the board but now also reads, canonically (`GET issue/{key}`, not index-backed), (a) every explicitly `include`d key
   (the executor includes the key `createIssue` returned) and (b) the "frontier": the keys following the highest known project
   key, until Jira answers 404 (this covers a lost create response, where no key is known). A frontier longer than 25 fails
   closed. Project restriction, ownership markers, fail-closed behaviour and `UNCERTAIN_WRITE` recovery are unchanged.
   Regression tests (`tests/jira-board-canonical.test.js`, "LAG ..." and "frontier ..."): board lag with the response
   received, with the response lost and early retries, with a lost outbox, an unbounded frontier, a foreign project under lag;
   each proves exactly one `POST issue`. These tests fail against the pre-fix source (checked by stashing `src/`).
2. **`removeIssueLink` was usable as a generic delete (blocking).** It now REQUIRES a configured `writeGuard` and, before the
   DELETE, re-reads BOTH issues canonically and requires: project LOOP, Loop ownership of both ends by this run's task-id
   pattern, the exact link id on both issues, the relationship's link type (name, and id when configured), and the expected
   blocker/dependent pair and direction (the dependent's entry names the blocker via `blockerOf`; the blocker's entry names
   the dependent under the dependent's end). It then verifies the link is gone from both issues. Signature changed to
   `{ linkId, blockerKey, dependentKey, relationship }`, describing the link as it exists (a reversed link is removed by
   passing the reversed pair). `tests/jira-remove-link.test.js` has a negative test for every guard, each asserting zero writes.
3. **Malformed board responses (finding 3).** A board entry without a string key now throws `INVALID_RESPONSE` instead of being
   dropped, and a page with neither a numeric `total` nor a boolean `isLast` throws instead of ending the scan after one page.
   Foreign-project keys are still dropped by design (never fetched). Tests in `tests/jira-board-canonical.test.js`.
4. **Evidence consistency (finding 4).** This file now separates ledger/config-backed facts from console-only observations
   (next section) and no longer states console-only figures as if they were recorded. No ledger event was added or edited.

The live `repair-link` stage that actually ran used the earlier `removeIssueLink` signature (`issueKey/otherKey/typeName`); the
script was updated to the new signature but that stage was not re-run, so the strengthened guard has offline evidence only.

## Evidence provenance

| Claim | Backed by |
| --- | --- |
| auth `GET myself` 200 (both runs) | ledger `auth` entries |
| first run: `POST issue` rejected 401, no Jira object created | ledger (`CP08MUS5UCQI` create entry; its remark "also for an invalid body" is the author's annotation made then) |
| discovery: project, board 199, issue types, link types, `Blocks` mapping, sprint 137 (`future`, board 199), completion transition id 31 `A fazer` -> `Feito`, status ids | `cp08-jira-live-config.json` |
| LOOP-1 created, first reconcile CONFLICT, later NOOP | ledger `create` entries (CONFLICT, then RESUMED_EXISTING / NOOP) |
| exactly one marked comment (id 13193), no second issue | ledger `idempotency` entry |
| reversed link 10244 observed with raw shapes, removed from both issues, 0 issues deleted | ledger `reversed-link-observed`, `reversed-link-removed` |
| correct link: raw issuelinks of both issues, both directions true | ledger `correct-link-verified` |
| both tasks NOOP, 0 conflicts after repair | ledger second `dependency` entry |
| sprint 137 membership exactly `[LOOP-1, LOOP-2]` | ledger `sprint` entry (`exact: true`) |
| LOOP-1 `A fazer` -> `Feito`, outcome CONFIRMED | ledger `transition` entry |
| HTTP codes of individual POSTs (201/204), the new link id 10245, per-request write counts | console only |
| the `UNCERTAIN_WRITE` retry-waits on issue creation and sprint assignment, each resolving to one write | console only |
| "repeat = 0 writes" for fresh-outbox create, comment, sprint and transition repeats | console only (the offline tests assert the same property, which is different evidence) |
| same-outbox repeat of the first create reporting `NOT_OWNER` | console only (consistent with the ledger's terminal CONFLICT for that attempt) |
| the transition list (ids 11, 21, 31) and "exactly one done transition" | console only; the script aborts unless exactly one done transition exists, and only the chosen one is in the config |
| search endpoints 401 with the earlier token (the reason for board observation) | console only; also stated in the config's `observationReason`, which is therefore an author's note, not a recorded response |

These console-only observations were not separately recorded in the ledger when they happened. They are NOT back-filled here:
no ledger entry has been added for them, and a reader should treat them as the author's reported observations.

## Known limits

- Board observation is index-backed and may lag writes. Since the review fix, lag cannot hide a just-created or recently-created
  owned issue from reconciliation (canonical `include` + frontier reads), but the frontier read assumes consecutive project
  keys: a gap (an issue deleted or moved away) ends the probe early, and more than 25 unindexed issues fails closed. Issues that
  the board's own filter excludes remain invisible to enumeration.
- Reconciliation with main (after PR #1): production search mode of `JiraSyncClient` now uses `GET search/jql` with `nextPageToken`/`isLast` pagination, matching `JiraTaskSystemAdapter`. This was verified OFFLINE only (mock server and stubs); the live CP-08 run used board observation and never exercised search mode, so search/jql is not live-proven by this evidence. The ledger is unchanged.
- Same-outbox repeat of the first create reports `NOT_OWNER` because that outbox row is the terminal CONFLICT from the
  pre-fix attempt; the fresh-outbox repeat (the stronger lost-outbox case) reports CONFIRMED with 0 writes (both console-only observations, see provenance).

## Local verification

At reviewed commit `95ff0d1`: 501 tests, 501 pass, 0 fail (`node --test`; independently reproduced by the reviewer serially).

After the review fixes (this commit), run serially with `node --test --test-concurrency=1`:

- 516 tests, 516 pass, 0 fail, 0 cancelled, 0 skipped (501 baseline + 15 new regression tests). An earlier serial run of the same
  tree had one failure in `tests/runtime-guard-blocked-retry-audit.test.js` (a wall-clock lease expiry: that test took 71 minutes
  because the machine stalled; the file is not part of this change). That file passes alone (4/4) and the whole suite passed on the rerun.
- `git diff --check`: exit 0 (only LF/CRLF working-copy warnings).
- Secret scan (128 tracked and untracked files, working tree): no `ATATT` token, no Basic credential, no personal email, no
  UUID or cloud id outside tests; the only hits are this document's own description of the scan and the synthetic `ghp_abcd...`
  redaction fixture in `tests/gh-runner.test.js` (committed in a0da5ae, not a credential). The run state directory used by the
  live stages was not available for this scan.
