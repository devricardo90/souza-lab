# Hermes agent boundary

The production implementation path is:

`Loop Controller -> ExecutionRunner -> HermesAgentExecutor -> Hermes Kanban coder -> isolated Git worktree`

`ExecutionRunner` owns execution identity, the isolated workspace, branch, and base SHA. The adapter transports the task body through a private mode-0600 `--body-file`, never inline arguments. Execute and resume use distinct deterministic identities: `loop-<executionId>-execute` and `loop-<executionId>-resume`.

Coder instructions require `Loop-Execution-Id` and `Loop-Task-Id` commit trailers. After Hermes reports `done`, `classifyExecution` is authoritative: only `COMMITTED_IMPLEMENTATION_PRESENT` succeeds. Results are read from Git, not Hermes prose. Recovery preserves existing uncommitted work; the adapter never cleans, resets, or overwrites a workspace.
