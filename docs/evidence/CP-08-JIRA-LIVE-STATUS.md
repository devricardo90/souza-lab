# CP-08 Jira live proof: status and token scope reconciliation

**CP08_STATUS = PARTIAL_BLOCKED_EXTERNAL**
**BLOCKER = JIRA_SCOPED_TOKEN_WRITE_ACCESS**

CP-08 is not complete and must not be merged or closed. Google remains `BLOCKED_PENDING_GOOGLE_CREDENTIALS`.

## Observed facts (live, project LOOP only)

| Proof | Result |
| --- | --- |
| Scoped transport (`api.atlassian.com/ex/jira/{cloudId}`), production client | implemented; offline-tested |
| `GET /rest/api/3/myself` through the production client | **HTTP 200** |
| Metadata discovery (board 199, issue types, createmeta fields, link types, sprint) | **PASS** |
| Task issue type | "Tarefa", id 10230 (instance is localized; "Task" does not exist) |
| Sprint "CP08 Test" | id 137, state `future`, exactly one match on board 199 |
| `POST /issue` (outbox JIRA_CREATE, run CP08MUS5UCQI) | **HTTP 401** -> `AUTH_INVALID` -> `FAILED_PERMANENT` after 1 attempt |
| `POST /issue` with an intentionally invalid body | **HTTP 401** (scope check precedes validation) |
| Jira objects created | **none** (board 199: 0 issues; sprint 137: 0 members) |

Also 401 with this token: `GET search`, `GET search/jql`, `POST search/jql`, `project/{key}`, `project/search`,
`project/{key}/statuses`, `field`, `issuetype`, `status`, `board/{id}/configuration`.
Working with this token: `myself`, `issueLinkType`, `issue/createmeta/...`, agile `board/199`, `board/199/issue`,
`board/199/sprint`, `sprint/137`, `sprint/137/issue`.

## Not proven (BLOCKED, not passed)

ADF round-trip, create, create idempotency, comment idempotency, dependency semantics and direction (the configured
`dependentEnd: "inward"` is an **unproven hypothesis**), exact sprint membership, transition discovery, status
transition. Nothing in this repository's unit tests substitutes for these.

## Scope reconciliation

Source: Atlassian's published OpenAPI specs (`dac-static.atlassian.com/cloud/jira/platform/swagger-v3.v3.json` and
`.../software/swagger.v3.json`), `security` / `x-atlassian-oauth2-scopes` per operation, read on 2026-10-03.
Each operation accepts EITHER the classic scope OR the granular set marked Beta; the granular set must be complete
for that operation.

| Endpoint used by CP-08 | Classic scope | Granular scopes |
| --- | --- | --- |
| GET myself | read:jira-user | read:application-role:jira, read:group:jira, read:user:jira, read:avatar:jira |
| POST issue (create) | write:jira-work | write:issue:jira, write:comment:jira, write:comment.property:jira, write:attachment:jira, read:issue:jira |
| GET issue/{key} | read:jira-work | read:issue-meta:jira, read:issue-security-level:jira, read:issue.vote:jira, read:issue.changelog:jira, read:avatar:jira, read:issue:jira, read:status:jira, read:user:jira, read:field-configuration:jira |
| PUT issue/{key} (update; reserved, not used yet) | write:jira-work | write:issue:jira |
| GET createmeta/{project}/issuetypes[/{id}] | read:jira-work | read:issue-meta:jira, read:avatar:jira, read:field-configuration:jira |
| GET issue/{key}/comment | read:jira-work | read:comment:jira, read:comment.property:jira, read:group:jira, read:project:jira, read:project-role:jira, read:user:jira, read:avatar:jira |
| POST issue/{key}/comment | write:jira-work | write:comment:jira + the read set above |
| POST issueLink | write:jira-work | write:comment:jira, write:issue:jira, write:issue-link:jira |
| GET issueLinkType | read:jira-work | read:issue-link-type:jira |
| GET search (DEPRECATED, being removed) | read:jira-work | read:issue-details:jira, read:audit-log:jira, read:avatar:jira, read:field-configuration:jira, read:issue-meta:jira |
| GET search/jql | read:jira-work | read:issue-details:jira, read:audit-log:jira, read:avatar:jira, read:field-configuration:jira, read:issue-meta:jira |
| POST search/jql | read:jira-work | read:issue-details:jira, read:field.default-value:jira, read:field.option:jira, read:field:jira, read:group:jira |
| GET project/{key}, project/search | read:jira-work | read:issue-type:jira, read:project:jira, read:project.property:jira, read:user:jira, read:application-role:jira, read:avatar:jira, read:group:jira, read:issue-type-hierarchy:jira, read:project-category:jira, read:project-version:jira, read:project.component:jira |
| GET project/{key}/statuses | read:jira-work | read:issue-status:jira, read:issue-type:jira, read:status:jira |
| GET issuetype | read:jira-work | read:issue-type:jira, read:avatar:jira, read:project-category:jira, read:project:jira |
| GET field | read:jira-work | read:field:jira, read:avatar:jira, read:project-category:jira, read:project:jira, read:field-configuration:jira |
| GET status | read:jira-work | read:status:jira |
| GET issue/{key}/transitions | read:jira-work | read:issue.transition:jira, read:status:jira, read:field-configuration:jira |
| **POST issue/{key}/transitions** | write:jira-work | **write:issue:jira, write:issue.property:jira** |
| GET agile board/{id}, board/{id}/issue | read:board-scope:jira-software + read:issue-details:jira | (same; no Beta variant listed) |
| GET agile board/{id}/sprint, sprint/{id} | read:sprint:jira-software | |
| GET agile sprint/{id}/issue | read:sprint:jira-software + read:issue-details:jira + read:jql:jira | |
| **POST agile sprint/{id}/issue** (assignment) | **write:sprint:jira-software** | |

Corrections to the earlier proposed list:

- **`write:issue.transition:jira` does not exist and is not required.** Executing a transition needs
  `write:issue:jira` + `write:issue.property:jira` (or classic `write:jira-work`). Discovering transitions needs
  `read:issue.transition:jira` (+ `read:status:jira`, `read:field-configuration:jira`).
- `read:issue:jira-software` was not required by any endpoint CP-08 uses. Agile board issue reads need
  `read:board-scope:jira-software` + `read:issue-details:jira`.
- `write:issue-link:jira` alone is not enough for `POST issueLink`; the spec also lists `write:issue:jira` and `write:comment:jira`.

Simplest sufficient classic set: `read:jira-work`, `write:jira-work`, `read:jira-user`, plus
`read:board-scope:jira-software`, `read:sprint:jira-software`, `write:sprint:jira-software`,
`read:issue-details:jira`, `read:jql:jira`. If granular scopes are chosen instead, every scope in the rows above must be present.

Observed 401s are consistent with missing scopes (e.g. `search/jql` needs `read:audit-log:jira` and `POST issue` needs
`write:issue:jira`), but the token's actual scope list is not introspectable, so this is not proven which exact scope is absent.

## Known gaps to address before the live stages

- `JiraSyncClient.observeProject` (search mode) and `JiraTaskSystemAdapter.search` call the deprecated
  `GET /rest/api/3/search`, which Atlassian is removing. Production search mode should move to `GET search/jql`
  (token pagination, no `total`; results may lag writes). CP-08 uses the explicit `board` observation source instead.
- Board observation is an index-backed read and may lag writes; read-after-write over it is unproven live.

## Re-run procedure after the Owner replaces the token

Use a fresh state dir; the previous outbox row for run CP08MUS5UCQI is terminal `FAILED_PERMANENT`.

```
node scripts/cp08-live-jira.js auth        --state <fresh-dir>
node scripts/cp08-live-jira.js discover    --state <fresh-dir>
node scripts/cp08-live-jira.js create      --state <fresh-dir>
node scripts/cp08-live-jira.js idempotency --state <fresh-dir>
node scripts/cp08-live-jira.js dependency  --state <fresh-dir>
node scripts/cp08-live-jira.js sprint      --state <fresh-dir>
node scripts/cp08-live-jira.js transition  --state <fresh-dir>
```

Stop at the first failing stage. Evidence must be updated from observed output only.
