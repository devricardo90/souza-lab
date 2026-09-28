import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GENERATED_MARKER = "DO NOT EDIT — GENERATED FROM COMPUTED EXECUTION STATE";

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function render(name, data) {
  return `# ${name}\n\n${GENERATED_MARKER}\n\n<!-- loop-generated-sha256:${digest(data)} -->\n\n- State: ${data.state}\n- Task: ${data.taskId ?? "none"}\n- Candidate: ${data.candidateHead ?? "none"}\n- Execution: ${data.executionId}\n`;
}

function parse(path, executionId) {
  if (!existsSync(path)) return { projection: null, drift: true };
  const content = readFileSync(path, "utf8");
  const match = content.match(/<!-- loop-generated-sha256:([0-9a-f]{64}) -->/);
  const state = content.match(/^- State: ([A-Z_]+)$/m)?.[1] ?? null;
  const taskId = content.match(/^- Task: (.+)$/m)?.[1] ?? null;
  const candidateHead = content.match(/^- Candidate: (.+)$/m)?.[1] ?? null;
  const storedExecutionId = content.match(/^- Execution: (.+)$/m)?.[1] ?? null;
  if (!match || !state || !storedExecutionId) return { projection: { state: "INVALID" }, drift: true };
  const data = { state, taskId: taskId === "none" ? null : taskId, candidateHead: candidateHead === "none" ? null : candidateHead, executionId: storedExecutionId };
  return {
    projection: { state, taskId: data.taskId, candidateHead: data.candidateHead },
    drift: content !== render(path.endsWith("STATE.md") ? "STATE" : "HANDOFF", data)
      || storedExecutionId !== executionId
      || match[1] !== digest(data),
  };
}

export class MarkdownProjectionStore {
  constructor({ directory } = {}) {
    if (typeof directory !== "string" || directory.trim() === "") throw new TypeError("projection directory is required");
    this.directory = directory;
  }

  read(executionId) {
    const state = parse(join(this.directory, "STATE.md"), executionId);
    const handoff = parse(join(this.directory, "HANDOFF.md"), executionId);
    return Object.freeze({ stateProjection: state.projection, handoffProjection: handoff.projection, drift: state.drift || handoff.drift });
  }

  write({ executionId, computed }) {
    mkdirSync(this.directory, { recursive: true });
    const data = {
      state: computed.derivedState ?? computed.state,
      taskId: computed.taskId,
      candidateHead: computed.candidateHead,
      executionId,
    };
    writeFileSync(join(this.directory, "STATE.md"), render("STATE", data), "utf8");
    writeFileSync(join(this.directory, "HANDOFF.md"), render("HANDOFF", data), "utf8");
    return Object.freeze({ digest: digest(data), files: Object.freeze(["STATE.md", "HANDOFF.md"]) });
  }
}
