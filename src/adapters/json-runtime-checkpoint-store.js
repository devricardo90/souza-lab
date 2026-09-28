import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { makeRuntimeCheckpoint } from "../core/runtime-contracts.js";
import { createHash } from "node:crypto";
import { RuntimeCheckpointStore } from "../core/contracts.js";

export class JsonRuntimeCheckpointStore extends RuntimeCheckpointStore {
  constructor({ path } = {}) {
    super();
    if (typeof path !== "string" || path.trim() === "") throw new TypeError("runtime checkpoint path is required");
    this.path = path;
  }

  read(executionId) {
    const checkpointPath = this.pathFor(executionId);
    if (!existsSync(checkpointPath)) return null;
    const saved = JSON.parse(readFileSync(checkpointPath, "utf8"));
    if (saved.executionId !== executionId) throw new TypeError("runtime checkpoint execution identity mismatch");
    return makeRuntimeCheckpoint(saved);
  }

  write(checkpoint) {
    const value = makeRuntimeCheckpoint(checkpoint);
    const checkpointPath = this.pathFor(value.executionId);
    mkdirSync(dirname(checkpointPath), { recursive: true });
    const temp = `${checkpointPath}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "w" });
    renameSync(temp, checkpointPath);
    return value;
  }

  pathFor(executionId) {
    const slug = createHash("sha256").update(executionId, "utf8").digest("hex").slice(0, 24);
    return `${this.path}.${slug}.json`;
  }
}
