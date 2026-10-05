# Production profile (CP-09)

`node bin/loop-controller.js --config <path>` builds the Controller for the profile named in the config. `profile` is required and has no default: `"synthetic"` (tests and local proofs) or `"production"`. A missing, unknown or invalid profile or configuration exits with code 78 and never falls back to another profile.

## Composition

```text
Jira (JiraSyncClient + durable outbox)
→ LoopController (deterministic, unchanged)
→ HermesAgentExecutor, reached through the crash-safe ExecutionRunner
→ real Git workspaces + GitHub SCM/CI (exact-head, exact-workflow)
→ validation (WorkspaceCommandValidator) and independent review (CommandIndependentReviewer)
→ reconciliation / recovery (durable stores, instance lease)
```

The plan is read from a local file (`planSource.file`). Google Docs is not used and not required.

## Configuration

Every identity is explicit; nothing is defaulted to a project, path or fixture. Unknown keys and credential-looking keys are rejected. Validation runs before any state is created.

```jsonc
{
  "profile": "production",
  "workspaceDir": "<durable state directory>",
  "workspaceId": "<unique per controller workspace>",
  "documentId": "<plan identity>",
  "planSource": { "file": "<path to the plan file>" },
  "jira": {
    "mode": "classic | scoped",
    "site": "<host, classic mode>",
    "projectKey": "<Jira project key>",
    "issueTypeName": "<issue type>",
    "taskIdPattern": "<regex of Loop task ids the write guard may touch>",
    "observation": { "source": "search" },          // or { "source": "board", "boardId": <integer> }
    "relationship": { "linkTypeName": "...", "inwardLabel": "...", "outwardLabel": "...", "dependentEnd": "inward | outward" },
    "completion": { "doneStatusName": "...", "transitionName": "..." }
  },
  "repository": { "identity": "<owner/repo>", "baseRef": "<default branch>" },
  "git": { "repoPath": "<local clone>" },
  "github": { "owner": "...", "repo": "...", "baseBranch": "...", "workflowIdentity": ".github/workflows/<file>" },
  "agent": { "kind": "hermes", "command": "<hermes executable>", "board": "<board>", "coderAssignee": "<assignee>" },
  "validation": { "command": "<executable>", "args": ["..."] },
  "review": { "command": "<executable>", "args": ["..."] }
}
```

## Environment (credentials are never read from the config or argv)

| Variable | Required | Use |
|---|---|---|
| `LOOP_JIRA_EMAIL` | yes | Jira account |
| `LOOP_JIRA_API_TOKEN` | yes | Jira API token |
| `LOOP_JIRA_CLOUD_ID` | scoped mode | Jira cloud id |

`validation.command`, `review.command` and `agent.command` are executed as an argv without a shell, so name a real executable (on Windows, for example, `node` or a full path rather than an `npm.cmd` shim). GitHub access uses the authenticated `gh` CLI of the process owner. Validation and review commands receive an environment with every credential-looking variable and all `LOOP_JIRA_*` variables removed. Log output is scrubbed of the values of credential-looking environment variables.

## Review command contract

`review.command` receives one JSON request on stdin (`kind: "spec" | "implementation"`, the work package, and for implementations `head`, `base`, `workspacePath`, `authorId`, `changedFiles`) and prints one JSON object on stdout: `{ "verdict": "CLEAN" | "FINDINGS", "reviewerId": "...", "findings": [{ "id", "summary" }] }`. A command that cannot run, exits non-zero, times out or prints oversized output is treated as UNAVAILABLE (a wait), never as a verdict; exit 0 with invalid output fails closed. `reviewerId` must differ from the commit author; the state engine and merge gate enforce this.

## Scope and limits

CP-09 proves the composition with deterministic tests. It makes no live Jira, Hermes or GitHub call; the end-to-end live proof is CP-10. `HermesAgentExecutor` has no correction round yet, so review FINDINGS escalate to an owner decision. Wakeup, locking and server-side merge enforcement belong to CP-12 through CP-14.
