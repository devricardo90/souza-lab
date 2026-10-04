import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { composeGitHubLifecycle } from "../src/controller/production-composition.js";

/** The production development lifecycle must not be able to reach synthetic success. */
const PRODUCTION_FILES = [
  "../src/controller/production-composition.js", "../src/controller/github-lifecycle.js", "../src/controller/gate-ports.js",
  "../src/controller/execution-runner.js", "../src/controller/runtime-assembly.js", "../src/controller/loop-controller.js",
  "../src/adapters/git-push.js", "../src/adapters/git-workspace.js", "../src/adapters/sqlite-gate-fact-store.js",
  "../src/adapters/sqlite-execution-attempt-store.js", "../src/adapters/workspace-command-validator.js",
  "../src/adapters/github-scm-provider.js", "../src/adapters/github-ci-provider.js", "../src/adapters/local-git-provider.js", "../src/adapters/hermes-agent-executor.js",
];
const code = (file) => readFileSync(new URL(file, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

test("NO SYNTHETIC SUCCESS IN THE PRODUCTION PATH: no production module imports src/testing/ or names a synthetic/fake provider", () => {
  for (const file of PRODUCTION_FILES) {
    const text = code(file);
    const imports = [...text.matchAll(/(?:from|import)\s*\(?\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(imports.every((spec) => !/testing\//.test(spec)), `${file} imports a testing module: ${imports.filter((s) => /testing\//.test(s))}`);
    assert.ok(!/SyntheticLifecycle|SyntheticAgent|SyntheticGitAgent|FakeCIProvider|FakeSCMProvider|FakeReviewProvider|FakeValidationProvider|createFakeGitHub|DeterministicReviewer|DeterministicValidator/.test(text), `${file} references a synthetic or fake provider`);
  }
});

test("the lifecycle never asserts a gate result by itself: PASS/CLEAN facts are only derived from provider or port output", () => {
  const text = code("../src/controller/github-lifecycle.js");
  assert.ok(!/result:\s*"PASS"/.test(text), "no literal PASS result is constructed");
  assert.ok(!/verdict:\s*"CLEAN"/.test(text.replace(/verdict: out\.verdict/g, "")), "no literal CLEAN verdict is constructed");
  assert.ok(/result: passed \? "PASS" : "FAIL"/.test(text), "validation PASS is derived from the validator's own result");
  assert.ok(/verdict: out\.verdict/.test(text), "the review verdict is taken from the reviewer's output");
});

test("composition fails closed without its real ports or GitHub identity", () => {
  const ports = { github: { owner: "o", repo: "r", baseBranch: "main", workflowIdentity: ".github/workflows/validate.yml" }, repoPath: "/x", attemptStore: {}, gateStore: {}, reviewer: {}, validator: {}, agent: {} };
  assert.doesNotThrow(() => composeGitHubLifecycle(ports));
  for (const missing of ["reviewer", "validator", "agent", "gateStore", "attemptStore", "repoPath", "github"]) assert.throws(() => composeGitHubLifecycle({ ...ports, [missing]: null }), TypeError, missing);
  for (const field of ["owner", "repo", "baseBranch", "workflowIdentity"]) assert.throws(() => composeGitHubLifecycle({ ...ports, github: { ...ports.github, [field]: "" } }), TypeError, field);
});
