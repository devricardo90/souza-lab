import test from "node:test";
import assert from "node:assert/strict";
import { MarkdownTaskAdapter, TaskSourceError, parseTasksMarkdown, resolveNextTask } from "../src/adapters/markdown-task-adapter.js";

const ROADMAP = `# Roadmap

- [x] TASK-001 — Bootstrap
  - spec: reviewed
  - depends_on: none
  - acceptance_criteria:
    - AC-01 — Baseline exists

- [ ] TASK-002 — Build core
  - spec: present
  - depends_on: TASK-001
  - acceptance_criteria:
    - AC-01 — Contracts are validated
    - AC-02 — State vocabulary is closed

- [ ] TASK-003 — Use core
  - spec: missing
  - depends_on: TASK-002
  - acceptance_criteria:
    - AC-01 — Next task is selected
`;

test("Markdown adapter parses canonical tasks and resolves the first dependency-ready task", () => {
  const tasks = parseTasksMarkdown(ROADMAP);
  assert.deepEqual(tasks.map(({ id, completed }) => [id, completed]), [
    ["TASK-001", true], ["TASK-002", false], ["TASK-003", false],
  ]);
  assert.equal(tasks[1].specPresent, true);
  assert.equal(tasks[1].specReviewed, false);
  assert.equal(tasks[1].acceptanceCriteria[1].id, "AC-02");
  assert.deepEqual(resolveNextTask(tasks), {
    taskId: "TASK-002",
    reason: "ELIGIBLE_TASK_FOUND",
    skipped: [],
  });
});

test("task selection is deterministic, reports skipped blockers, and recognizes completion", () => {
  const tasks = parseTasksMarkdown(ROADMAP.replace("[x] TASK-001", "[ ] TASK-001"));
  assert.deepEqual(resolveNextTask(tasks), {
    taskId: "TASK-001",
    reason: "ELIGIBLE_TASK_FOUND",
    skipped: [],
  });
  const reordered = parseTasksMarkdown(ROADMAP);
  assert.deepEqual(resolveNextTask([reordered[2], reordered[1], reordered[0]]), {
    taskId: "TASK-002",
    reason: "ELIGIBLE_TASK_FOUND",
    skipped: [{ taskId: "TASK-003", blockers: ["TASK-002"] }],
  });
  const allDone = parseTasksMarkdown(ROADMAP.replaceAll("[ ] TASK-", "[x] TASK-"));
  assert.equal(resolveNextTask(allDone).reason, "ROADMAP_COMPLETE");
});

test("adapter reads only through the supplied reader and parses on each request", () => {
  const calls = [];
  const adapter = new MarkdownTaskAdapter({
    path: "fixture.md",
    readFile(path, encoding) { calls.push([path, encoding]); return ROADMAP; },
  });
  assert.equal(adapter.listTasks().length, 3);
  assert.equal(adapter.resolveNextTask().taskId, "TASK-002");
  assert.deepEqual(calls, [["fixture.md", "utf8"], ["fixture.md", "utf8"]]);
});

test("invalid task rows, missing ACs, duplicate IDs, and malformed fields fail closed", () => {
  assert.throws(() => parseTasksMarkdown("- [ ] TASK-01 no separator\n  - acceptance_criteria:\n    - AC-01 — x"), /malformed task row/);
  assert.throws(() => parseTasksMarkdown("- [ ] TASK-01 — no AC\n"), /no acceptance criteria/);
  assert.throws(() => parseTasksMarkdown(ROADMAP.replace("TASK-003 — Use core", "TASK-001 — Duplicate")), /duplicate task id/);
  assert.throws(() => parseTasksMarkdown(ROADMAP.replace("depends_on: TASK-001", "depends_on: TASK-999")), /missing task TASK-999/);
  assert.throws(() => parseTasksMarkdown(ROADMAP.replace("depends_on: none", "depends_on: TASK-002")), /dependency cycle/);
  assert.throws(() => parseTasksMarkdown(ROADMAP.replace("AC-01 — Next task is selected", "AC1 — Next task is selected")), /malformed acceptance criterion/);
});

test("task-shaped examples inside Markdown code fences cannot become executable tasks", () => {
  const example = `# Task format example

\`\`\`markdown
- [ ] TASK-999 — Example only
  - spec: reviewed
  - depends_on: none
  - acceptance_criteria:
    - AC-01 — This is documentation
\`\`\`
`;
  assert.deepEqual(parseTasksMarkdown(example), []);
  assert.throws(() => parseTasksMarkdown("# Missing close\n\n\`\`\`markdown\n- [ ] TASK-999 — Example"), /unclosed Markdown code fence/);
});

test("commented-out task rows cannot become executable tasks", () => {
  const comment = `# Roadmap

<!--
- [ ] TASK-999 — Disabled work
  - spec: reviewed
  - depends_on: none
  - acceptance_criteria:
    - AC-01 — This is commented out
-->
`;
  assert.deepEqual(parseTasksMarkdown(comment), []);
});
