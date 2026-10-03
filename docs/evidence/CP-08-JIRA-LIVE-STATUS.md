# CP-08 Jira live proof: status

**CP08_LIVE_STATUS = ALL_LIVE_STAGES_PASSED** (run `CP08MUS8I9PM`, project LOOP only)
**REVIEW_STATUS = READY_FOR_INDEPENDENT_REVIEW** (not merged; CP-09 not started)

Every fact below is taken from observed output of `scripts/cp08-live-jira.js` and the append-only ledger
`docs/evidence/CP-08-JIRA-LEDGER.json`. Google remains `BLOCKED_PENDING_GOOGLE_CREDENTIALS` and is out of scope here.
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

No Jira issue was deleted at any point. Board 199 holds exactly LOOP-1 and LOOP-2 from this run.

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

## Known limits

- Board observation is index-backed and may lag writes. Sprint assignment and issue creation each hit one
  `UNCERTAIN_WRITE` retry-wait that resolved to CONFIRMED with exactly one write.
- Production search mode still uses the deprecated `GET /rest/api/3/search`; moving it to `search/jql` is outside CP-08.
- Same-outbox repeat of the first create reports `NOT_OWNER` because that outbox row is the terminal CONFLICT from the
  pre-fix attempt; the fresh-outbox repeat (the stronger lost-outbox case) reports CONFIRMED with 0 writes.

## Local verification

Run after the final relationship and observation fixes (no source change afterwards):

- `npm test`: 501 tests, 501 pass, 0 fail, 0 skipped.
- `git diff --check`: exit 0 (only CRLF line-ending warnings).
- Secret scan (128 tracked and untracked files plus the run state directory): no occurrence of the Jira token, email or
  cloud id values, no Basic credential, no `ATATT` token; the only pattern hit is the synthetic `ghp_abcd...` redaction
  fixture in `tests/gh-runner.test.js` (committed in a0da5ae, not a credential).
