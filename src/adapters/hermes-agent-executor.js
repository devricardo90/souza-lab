import { execFile } from "node:child_process";
import { open, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { promisify } from "node:util";
import { AgentExecutor, validateAgentResult } from "../controller/ports.js";
import { classifyExecution, inspectWorkspace, resultFromGit } from "./git-workspace.js";

const execFileAsync = promisify(execFile);
const NON_TERMINAL = new Set(["triage", "todo", "scheduled", "ready", "running", "review"]);

export class HermesExecutorError extends Error {
  constructor(message, { code = "HERMES_ERROR", classification = "EXTERNAL_BLOCK", retryable = false } = {}) {
    super(message); this.name = "HermesExecutorError"; Object.assign(this, { code, classification, retryable });
  }
}
const parseJson = (output, label) => { try { return JSON.parse(output); } catch { throw new HermesExecutorError(`Hermes ${label} returned malformed JSON`, { code: "HERMES_MALFORMED_OUTPUT", classification: "TASK_FAILURE" }); } };
const statusOf = (task) => { const value = task?.status ?? task?.task?.status; return typeof value === "string" ? value.toLowerCase() : null; };

/** Production AgentExecutor boundary. The command is injectable for deterministic tests. */
export class HermesAgentExecutor extends AgentExecutor {
  constructor({ command = "hermes", board = "workflow-prod", coderAssignee = "coder", pollMs = 1000, maxPolls = 3600, run = null } = {}) {
    super(); this.command = command; this.board = board; this.coderAssignee = coderAssignee; this.pollMs = pollMs; this.maxPolls = maxPolls;
    this.run = run ?? ((args, options) => execFileAsync(this.command, args, { ...options, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }));
  }
  idempotencyKey(workPackage, resume) { return `loop-${workPackage.executionId}-${resume ? "resume" : "execute"}`; }
  body(workPackage, context, resume) {
    const criteria = (workPackage.acceptanceCriteria ?? []).map(({ id, text }) => `- ${id}: ${text}`).join("\n");
    return [`Loop task id: ${workPackage.taskId}`, `Execution id: ${workPackage.executionId}`, `Work package: ${workPackage.workPackageId}`, `Title: ${workPackage.title}`, "", "Acceptance Criteria:", criteria || "- (none)", "", `Repository: ${workPackage.repository.identity}`, `Base: ${context.workspace.baseSha}`, `Branch: ${context.workspace.branch}`, `Workspace: ${context.workspace.path}`, "", "Explicit scope: implement only this frozen WorkPackage in the supplied workspace. Do not modify other tasks, merge, push, or report success without a real Git commit.", `The implementation commit MUST contain these exact trailers: Loop-Execution-Id: ${workPackage.executionId} and Loop-Task-Id: ${workPackage.taskId}.`, resume ? "Recovery scope: preserve and build on all existing uncommitted work; never reset, clean, checkout over, or discard it." : ""].filter(Boolean).join("\n");
  }
  async invoke(args, options = {}, label = "command") {
    try { return await this.run(args, options); } catch (cause) { throw new HermesExecutorError(`Hermes ${label} failed`, { code: cause?.code === "ENOENT" ? "HERMES_UNAVAILABLE" : "HERMES_COMMAND_FAILED", classification: "EXTERNAL_BLOCK", retryable: true }); }
  }
  async create(workPackage, context, resume) {
    const args = ["kanban", "--board", this.board, "create", workPackage.title, "--assignee", this.coderAssignee, "--workspace", `dir:${context.workspace.path}`, "--idempotency-key", this.idempotencyKey(workPackage, resume), "--json"];
    const path = join(tmpdir(), `hermes-body-${process.pid}-${randomBytes(16).toString("hex")}`);
    const handle = await open(path, "wx", 0o600);
    try { await handle.writeFile(this.body(workPackage, context, resume), "utf8"); const result = await this.invoke([...args, "--body-file", path], {}, "create"); const parsed = parseJson(result.stdout ?? result, "create"); const task = parsed.task ?? parsed;
      if (!task?.id || typeof task.id !== "string") throw new HermesExecutorError("Hermes create response has no task id", { code: "HERMES_INVALID_CREATE", classification: "TASK_FAILURE" }); return task.id;
    } finally { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); }
  }
  async poll(taskId) {
    for (let attempt = 0; attempt < this.maxPolls; attempt += 1) {
      const result = await this.invoke(["kanban", "--board", this.board, "show", taskId, "--json"], {}, "status"); const task = parseJson(result.stdout ?? result, "status"); const status = statusOf(task);
      if (status === "done") return task;
      if (status === "blocked") throw new HermesExecutorError("Hermes task is blocked", { code: "HERMES_BLOCKED", classification: "TASK_FAILURE" });
      if (!NON_TERMINAL.has(status)) throw new HermesExecutorError("Hermes task has unknown status", { code: "HERMES_UNKNOWN_STATUS", classification: "TASK_FAILURE" });
      if (attempt + 1 < this.maxPolls && this.pollMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
    throw new HermesExecutorError(`Hermes task ${taskId} did not reach a terminal state`, { code: "HERMES_POLL_TIMEOUT", retryable: true });
  }
  async execute(workPackage, context) { return this.runTask(workPackage, context, false); }
  async resume(workPackage, context) { return this.runTask(workPackage, context, true); }
  async runTask(workPackage, context, resume) {
    if (!workPackage?.executionId || !context?.workspace?.path) throw new TypeError("HermesAgentExecutor requires a WorkPackage and workspace context");
    const taskId = await this.create(workPackage, context, resume); await this.poll(taskId);
    const facts = inspectWorkspace({ workspacePath: context.workspace.path, baseSha: context.workspace.baseSha, branch: context.workspace.branch, executionId: workPackage.executionId, taskId: workPackage.taskId });
    const { classification } = classifyExecution(facts, { executionId: workPackage.executionId, taskId: workPackage.taskId });
    if (classification !== "COMMITTED_IMPLEMENTATION_PRESENT") throw new HermesExecutorError("Hermes completed without an owned clean implementation", { code: "HERMES_GIT_INCOMPLETE", classification: "TASK_FAILURE" });
    return validateAgentResult(resultFromGit(facts));
  }
}
export default HermesAgentExecutor;
