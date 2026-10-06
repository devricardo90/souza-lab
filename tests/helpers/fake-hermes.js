import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A deterministic stand-in for the `hermes` CLI, injected as HermesAgentExecutor's `run`. It speaks the same `kanban create` / `kanban show`
 * contract the executor uses, is idempotent on --idempotency-key like the real board, and does its "work" with REAL git commits in the
 * workspace it is handed (execute, resume and correction rounds), so the whole production path above it is exercised. Zero model calls.
 *
 * Failure injection (each fires `times` times, then the CLI behaves):
 *   { key: RegExp, when: "before" | "after" }   `show` throws BEFORE the worker did anything / AFTER the worker committed (a lost response)
 */
const AUTHOR = ["-c", "user.name=Hermes Simulator", "-c", "user.email=hermes-sim@example.invalid"];
export const HERMES_SIM_IDENTITY = "hermes-sim@example.invalid";

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

export class FakeHermes {
  constructor({ failures = [], onWork = null } = {}) {
    this.tasks = new Map();
    this.byKey = new Map();
    this.created = [];
    this.deduped = 0;
    this.shows = 0;
    this.bodies = [];
    this.argv = [];
    this.failures = failures.map((f) => ({ times: 1, ...f }));
    this.onWork = onWork;
    this.run = this.run.bind(this);
  }

  async run(args) {
    this.argv.push([...args]);
    const verb = args[args.indexOf("--board") + 2];
    if (verb === "create") return this.create(args);
    if (verb === "show") return this.show(args);
    throw Object.assign(new Error(`FakeHermes: unsupported command ${verb}`), { code: "EFAKE" });
  }

  create(args) {
    const key = argAfter(args, "--idempotency-key");
    if (this.byKey.has(key)) { this.deduped += 1; return { stdout: JSON.stringify({ id: this.byKey.get(key) }) }; }
    const body = readFileSync(argAfter(args, "--body-file"), "utf8");
    const id = `h-${this.tasks.size + 1}`;
    const workspace = argAfter(args, "--workspace").replace(/^dir:/, "");
    this.tasks.set(id, { id, key, title: args[args.indexOf("create") + 1], body, workspace, assignee: argAfter(args, "--assignee"), done: false });
    this.byKey.set(key, id);
    this.created.push({ id, key });
    this.bodies.push(body);
    return { stdout: JSON.stringify({ id }) };
  }

  fail(task, when) {
    const rule = this.failures.find((f) => f.key.test(task.key) && f.when === when && f.times > 0);
    if (!rule) return;
    rule.times -= 1;
    throw Object.assign(new Error("fake hermes: connection lost"), { code: "ECONNRESET" });
  }

  show(args) {
    this.shows += 1;
    const task = this.tasks.get(args[args.indexOf("show") + 1]);
    if (!task) throw Object.assign(new Error("fake hermes: no such task"), { code: "EFAKE" });
    if (!task.done) {
      this.fail(task, "before");
      this.work(task);
      task.done = true;
      this.fail(task, "after");
    }
    return { stdout: JSON.stringify({ status: "done" }) };
  }

  /** The coder: obeys the task body exactly as a well-behaved agent would (trailers, new commit, no history rewrite). */
  work(task) {
    const trailers = /Loop-Execution-Id: (\S+) and Loop-Task-Id: (\S+?)\./.exec(task.body);
    if (!trailers) throw new Error("fake hermes: the task body carries no trailer instruction");
    const [, executionId, loopTaskId] = trailers;
    const correction = /-correct-/.test(task.key);
    const file = join(task.workspace, "impl", `${loopTaskId}.txt`);
    mkdirSync(dirname(file), { recursive: true });
    const existing = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (correction) {
      const ids = [...task.body.matchAll(/^- (F[-A-Z0-9]*): /gm)].map((m) => m[1]);
      writeFileSync(file, `${existing}correction for ${ids.join(", ")}\n`, "utf8");
    } else {
      writeFileSync(file, `${existing}implementation of ${loopTaskId}\n`, "utf8");
    }
    if (this.onWork) this.onWork({ task, correction, workspace: task.workspace });
    git(task.workspace, ["add", "-A"]);
    const message = `${correction ? "fix" : "feat"}(${loopTaskId}): ${correction ? "address review findings" : "implement"}\n\nLoop-Execution-Id: ${executionId}\nLoop-Task-Id: ${loopTaskId}\n`;
    execFileSync("git", [...AUTHOR, "commit", "-q", "-F", "-"], { cwd: task.workspace, input: message, encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  }
}
