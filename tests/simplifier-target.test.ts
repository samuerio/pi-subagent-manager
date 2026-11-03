import assert from "node:assert/strict";
import { test } from "node:test";
import {
  composeSimplifierTask,
  SIMPLIFIER_FOCUS,
  SIMPLIFIER_TARGETS,
  simplifierSpawnParameters,
  targetRefError,
} from "../src/agents/simplifier/target.ts";

test("the simplifier vocabulary is the reviewer's minus commit and pr", () => {
  assert.deepEqual(SIMPLIFIER_TARGETS, ["working-tree", "branch", "paths"]);
});

test("targetRef grammar is per target kind", () => {
  // working-tree accepts an absolute worktree path (shape check only).
  assert.equal(targetRefError("working-tree", "/tmp/wt"), undefined);
  assert.ok(targetRefError("working-tree", "tmp/wt"));
  // Writing scope: unknown vocabulary is rejected, never defaulted to working-tree.
  assert.ok(targetRefError("pr", "123"));
  assert.ok(targetRefError("commit", "abc1234"));
  assert.ok(targetRefError("working-tree", "main"));
  assert.equal(targetRefError("branch", "main"), undefined);
  assert.ok(targetRefError("branch", "two words"));
  assert.equal(targetRefError("paths", "src/orch,docs/"), undefined);
  assert.ok(targetRefError("paths", "src/orch, docs/"));
});

test("compose renders the TARGET descriptor plus self-sufficiency instructions", () => {
  const workingTree = composeSimplifierTask({ target: "working-tree" });
  assert.match(workingTree, /^TARGET: working-tree\n/);
  assert.match(
    workingTree,
    /Polish the current code changes \(staged, unstaged and untracked files\)\./,
  );
  const worktree = composeSimplifierTask({
    target: "working-tree",
    targetRef: "/tmp/wt",
  });
  assert.match(worktree, /^TARGET: working-tree:\/tmp\/wt\n/);
  assert.match(
    worktree,
    /in the worktree at \/tmp\/wt \(a worktree of the current repository\)\./,
  );
  const branch = composeSimplifierTask({ target: "branch", targetRef: "main" });
  assert.match(branch, /^TARGET: branch:main\n/);
  assert.match(
    branch,
    /Polish the files this branch touched against 'main', in the current checkout\./,
  );
  const paths = composeSimplifierTask({
    target: "paths",
    targetRef: "src/orch",
  });
  assert.match(
    paths,
    /Polish these files or directories as they stand: src\/orch; there is no diff to compare against\./,
  );
  // The self-sufficiency rule rides on every message, whatever the kind.
  for (const message of [workingTree, worktree, branch, paths]) {
    assert.match(message, /resolve the scope from git/);
    assert.match(message, /AGENTS\.md/);
  }
});

test("compose rejects malformed input in the tool's voice", () => {
  assert.throws(
    () => composeSimplifierTask({ target: "pr" }),
    /target must be one of/,
  );
  assert.throws(
    () => composeSimplifierTask({ target: "snap" }),
    /target must be one of/,
  );
  // A valued kind without its ref fails clearly.
  assert.throws(
    () => composeSimplifierTask({ target: "branch" }),
    /targetRef is required for target branch/,
  );
});

test("parameters carry target/targetRef and never task", () => {
  const properties = (simplifierSpawnParameters as any).properties;
  assert.equal("task" in properties, false);
  for (const key of [
    "path",
    "description",
    "wait",
    "timeoutMs",
    "target",
    "targetRef",
  ])
    assert.ok(key in properties, key);
  assert.doesNotMatch(JSON.stringify(properties.target), /commit|pr/);
});

test("the simplifier focus sentences carry scope only, no mechanism", () => {
  for (const key of SIMPLIFIER_TARGETS) {
    const sentence = SIMPLIFIER_FOCUS[key]();
    assert.doesNotMatch(
      sentence,
      /git |rev-parse|merge-base|status --porcelain/,
    );
    assert.doesNotMatch(sentence, /\{[a-z]+\}/);
  }
});
