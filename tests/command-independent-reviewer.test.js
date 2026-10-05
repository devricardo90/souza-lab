import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandIndependentReviewer } from "../src/adapters/command-independent-reviewer.js";

/** Real child processes via node -e: deterministic, no model, no network. */
const reviewer = (script, options = {}) => new CommandIndependentReviewer({ command: process.execPath, args: ["-e", script], env: {}, timeoutMs: 5000, ...options });
const echoVerdict = (output) => `process.stdin.resume();process.stdin.on("data",()=>{});process.stdin.on("end",()=>{process.stdout.write(${JSON.stringify(JSON.stringify(output))});});`;
const REQUEST = { workPackage: { taskId: "TASK-1", executionId: "e1", title: "t", acceptanceCriteria: [] }, head: "a".repeat(40), base: "b".repeat(40), workspacePath: "/w", authorId: "author@example.invalid", changedFiles: ["x"] };

test("a CLEAN verdict from the command is returned through the existing reviewer contract", async () => {
  const out = await reviewer(echoVerdict({ verdict: "CLEAN", reviewerId: "rev@example.invalid", findings: [] })).reviewImplementation(REQUEST);
  assert.equal(out.verdict, "CLEAN"); assert.equal(out.reviewerId, "rev@example.invalid");
});

test("FINDINGS carry their findings; the spec review uses the same boundary", async () => {
  const findings = [{ id: "F1", summary: "bug" }];
  const out = await reviewer(echoVerdict({ verdict: "FINDINGS", reviewerId: "rev@example.invalid", findings })).reviewSpec(REQUEST.workPackage);
  assert.equal(out.verdict, "FINDINGS"); assert.equal(out.findings[0].id, "F1");
});

test("the request is delivered as JSON on stdin (kind, head, author) and never through argv", async () => {
  const script = `let b="";process.stdin.on("data",d=>b+=d);process.stdin.on("end",()=>{const r=JSON.parse(b);process.stdout.write(JSON.stringify({verdict:"CLEAN",reviewerId:r.kind+":"+r.authorId+":"+r.head.slice(0,4),findings:[]}))})`;
  const r = reviewer(script);
  const request = { ...REQUEST, authorId: "unique-author-7788" };
  assert.equal((await r.reviewImplementation(request)).reviewerId, "implementation:unique-author-7788:aaaa");
  assert.ok(!r.args.join(" ").includes("unique-author-7788") && !r.args.join(" ").includes(request.head));
});

test("failure to produce an answer is UNAVAILABLE (a wait), never a verdict: missing command, non-zero exit, timeout, oversized output", async () => {
  const cases = [
    new CommandIndependentReviewer({ command: "definitely-not-a-real-command-xyz", env: {}, timeoutMs: 5000 }),
    reviewer("process.exit(3)"),
    reviewer("setTimeout(()=>{},60000)", { timeoutMs: 300 }),
    reviewer(`process.stdout.write("x".repeat(2*1024*1024))`),
  ];
  for (const r of cases) assert.equal((await r.reviewImplementation(REQUEST)).verdict, "UNAVAILABLE");
});

test("on timeout the command is actually terminated, not just abandoned", async () => {
  const pidFile = join(tmpdir(), `reviewer-pid-${process.pid}-${Date.now()}`);
  const script = `require("fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(()=>{}, 1000);`;
  try {
    const out = await reviewer(script, { timeoutMs: 1500 }).reviewImplementation(REQUEST);
    assert.equal(out.verdict, "UNAVAILABLE");
    const pid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(Number.isInteger(pid) && pid > 0);
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    const deadline = Date.now() + 5000;
    while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!alive(), "the timed-out reviewer process was killed");
  } finally { rmSync(pidFile, { force: true }); }
});

test("only a still-running command is killed: an already-exited one is never signalled (its pid may belong to someone else)", async () => {
  const killed = [];
  const spy = (child) => { killed.push(child.pid); };
  assert.equal((await reviewer("process.exit(3)", { kill: spy }).reviewImplementation(REQUEST)).verdict, "UNAVAILABLE");
  assert.equal((await reviewer(echoVerdict({ verdict: "CLEAN", reviewerId: "r", findings: [] }), { kill: spy }).reviewImplementation(REQUEST)).verdict, "CLEAN");
  assert.deepEqual(killed, [], "exited children are not killed");
  assert.equal((await reviewer("setInterval(()=>{},1000)", { kill: (child) => { spy(child); child.kill(); }, timeoutMs: 300 }).reviewImplementation(REQUEST)).verdict, "UNAVAILABLE");
  assert.equal(killed.length, 1, "a child still running at the timeout is killed exactly once");
});

test("a successful exit with invalid reviewer output fails closed instead of being treated as a verdict", async () => {
  for (const script of [`process.stdout.write("not json")`, echoVerdict({ verdict: "MAYBE", reviewerId: "r", findings: [] }), echoVerdict({ verdict: "CLEAN", findings: [] }),
    echoVerdict({ verdict: "FINDINGS", reviewerId: "r", findings: [] }), echoVerdict({ verdict: "CLEAN", reviewerId: "r", findings: [{ id: "a", summary: "b" }] })]) {
    await assert.rejects(reviewer(script).reviewImplementation(REQUEST), (error) => error.code === "REVIEWER_OUTPUT_INVALID");
  }
});

test("the reviewer command receives only the environment it is given and its stderr is never surfaced", async () => {
  const secret = "stderr-secret-0123456789";
  const r = reviewer(`console.error("${secret}");process.stdout.write(JSON.stringify({verdict:"CLEAN",reviewerId:process.env.SECRET_SEEN?"leaked":"clean-env",findings:[]}))`, { env: {} });
  const out = await r.reviewImplementation(REQUEST);
  assert.equal(out.reviewerId, "clean-env");
  assert.ok(!JSON.stringify(out).includes(secret));
});

test("constructor fails closed on missing command or invalid options", () => {
  assert.throws(() => new CommandIndependentReviewer({}), TypeError);
  assert.throws(() => new CommandIndependentReviewer({ command: "" }), TypeError);
  assert.throws(() => new CommandIndependentReviewer({ command: "x", args: "a" }), TypeError);
  assert.throws(() => new CommandIndependentReviewer({ command: "x", timeoutMs: 0 }), TypeError);
});
