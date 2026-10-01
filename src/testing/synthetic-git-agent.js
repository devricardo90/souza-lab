import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentExecutor } from "../controller/ports.js";
import { EXECUTION_TRAILERS, git } from "../adapters/git-workspace.js";

/**
 * Synthetic implementation agent that works in a REAL Git workspace. Deterministic, ZERO model calls. A recoverable
 * executor: execute() does the work; resume() continues uncommitted work it finds, preserving it byte for byte.
 * Test-only crash points (killed abruptly, once per point) let child-process tests die at precise moments:
 *   before_write | after_write (files changed, nothing committed) | after_commit (committed, result not returned)
 */
const AUTHOR = ["-c", "user.name=Synthetic Agent", "-c", "user.email=synthetic-agent@example.invalid"];

export class SyntheticGitAgent extends AgentExecutor {
  constructor({ recordPath = null, crashAt = null, crashMarkerDir = null } = {}) {
    super();
    this.recordPath = recordPath;
    this.crashAt = crashAt;
    this.crashMarkerDir = crashMarkerDir;
    this.calls = [];
    this.modelCalls = 0;
  }

  record(entry) {
    this.calls.push(entry);
    if (this.recordPath) { mkdirSync(dirname(this.recordPath), { recursive: true }); appendFileSync(this.recordPath, `${JSON.stringify(entry)}\n`); }
  }

  crashpoint(name) {
    if (this.crashAt !== name || !this.crashMarkerDir) return;
    const marker = join(this.crashMarkerDir, `agent-crashed-${name}`);
    if (existsSync(marker)) return; // only the first invocation dies
    writeFileSync(marker, "crashed");
    process.kill(process.pid, "SIGKILL");
  }

  commit(workspace, workPackage, message) {
    git(workspace.path, ["add", "-A"]);
    const body = `${message}\n\n${EXECUTION_TRAILERS.execution}: ${workPackage.executionId}\n${EXECUTION_TRAILERS.task}: ${workPackage.taskId}\n`;
    git(workspace.path, [...AUTHOR, "commit", "-q", "-F", "-"], { input: body });
    return {
      head: git(workspace.path, ["rev-parse", "HEAD"]).trim(), base: workspace.baseSha, branch: workspace.branch,
      authorId: "synthetic-agent@example.invalid", changedFiles: [`impl/${workPackage.taskId}.txt`],
    };
  }

  async execute(workPackage, { workspace }) {
    this.record({ mode: "execute", taskId: workPackage.taskId, title: workPackage.title, planVersion: workPackage.planBinding.planVersion, seen: Object.keys(workPackage).sort() });
    this.crashpoint("before_write");
    const file = join(workspace.path, "impl", `${workPackage.taskId}.txt`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `implementation of ${workPackage.taskId}: ${workPackage.title}\n${workPackage.acceptanceCriteria.map((ac) => `${ac.id}: ${ac.text}`).join("\n")}\n`, "utf8");
    this.crashpoint("after_write");
    const result = this.commit(workspace, workPackage, `feat(${workPackage.taskId}): ${workPackage.title}`);
    this.crashpoint("after_commit");
    return result;
  }

  /** Correction round: addresses review findings with a NEW commit on the same branch (history is never rewritten). */
  async correct(workPackage, { workspace, findings, round, facts }) {
    this.record({ mode: "correct", taskId: workPackage.taskId, round, findings: (findings ?? []).map((f) => f.id), resumed: facts !== null });
    const file = join(workspace.path, "impl", `${workPackage.taskId}.txt`);
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${existing}correction round ${round + 1}: ${(findings ?? []).map((f) => f.id).join(", ") || "none"} addressed\n`, "utf8");
    this.crashpoint("after_correct_write");
    return this.commit(workspace, workPackage, `fix(${workPackage.taskId}): address review findings (round ${round + 1})`);
  }

  async resume(workPackage, { workspace, facts }) {
    const file = join(workspace.path, "impl", `${workPackage.taskId}.txt`);
    const preserved = existsSync(file) ? readFileSync(file, "utf8") : null;
    this.record({ mode: "resume", taskId: workPackage.taskId, preservedBytes: preserved === null ? 0 : Buffer.byteLength(preserved), uncommitted: [...(facts?.trackedChanges ?? []), ...(facts?.untracked ?? [])] });
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${preserved ?? ""}resumed and completed by the recoverable executor\n`, "utf8"); // appends: earlier work is kept
    return this.commit(workspace, workPackage, `feat(${workPackage.taskId}): ${workPackage.title} (resumed)`);
  }
}
