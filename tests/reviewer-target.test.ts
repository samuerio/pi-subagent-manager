import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentPrompt } from "../src/orch/prompt.ts";
import {
  composeReviewerTask,
  REVIEWER_FOCUS,
  REVIEWER_TARGETS,
  reviewerSpawnParameters,
  targetRefError,
} from "../src/agents/reviewer/target.ts";

test("targetRef grammar is per target kind", () => {
  // working-tree: no ref means the current checkout's working tree.
  assert.equal(targetRefError("working-tree", undefined), undefined);
  // With a ref it is an absolute worktree path; shape check only, compose
  // stays pure and a wrong path surfaces as the child's own bash failure.
  assert.equal(targetRefError("working-tree", "/path/to/wt"), undefined);
  assert.equal(targetRefError("working-tree", "/a dir/path"), undefined);
  assert.ok(targetRefError("working-tree", "path/to/wt"));
  assert.ok(targetRefError("working-tree", "/a\nb"));
  // Every valued target demands a ref.
  for (const target of REVIEWER_TARGETS) {
    if (target !== "working-tree") assert.ok(targetRefError(target, undefined));
  }
  assert.equal(targetRefError("branch", "origin/main"), undefined);
  assert.ok(targetRefError("branch", "two words"));
  assert.equal(targetRefError("commit", "abc1234"), undefined);
  assert.ok(targetRefError("commit", "abc"));
  assert.ok(targetRefError("commit", "not-a-sha"));
  assert.equal(targetRefError("paths", "src/orch,docs/"), undefined);
  assert.ok(targetRefError("paths", "src/orch, docs/"));
});

test("compose renders TARGET, the per-kind focus sentence, and self-sufficiency", () => {
  const message = composeReviewerTask({ target: "working-tree" });
  assert.match(message, /^TARGET: working-tree\n/);
  assert.match(
    message,
    /Review the current code changes \(staged, unstaged, and untracked files\)\./,
  );
  const paths = composeReviewerTask({
    target: "paths",
    targetRef: "src/orch,docs/",
  });
  assert.match(paths, /^TARGET: paths:src\/orch,docs\/\n/);
  assert.match(
    paths,
    /This is a snapshot review \(not a diff\)\. Read the files directly in these paths\./,
  );
  assert.match(
    composeReviewerTask({ target: "commit", targetRef: "abc1234" }),
    /Review the code changes introduced by commit abc1234\./,
  );
  // No caller prose exists to lean on, so the reminder names the repo papers.
  assert.match(message, /REVIEW_GUIDELINES\.md/);
  assert.match(message, /resolve the change from git/);
});

test("the branch focus sentence carries the four-step merge-base algorithm", () => {
  const sentence = REVIEWER_FOCUS.branch("main");
  assert.match(
    sentence,
    /Review the code changes against the base branch 'main'\./,
  );
  assert.match(sentence, /@{upstream}/);
  assert.match(sentence, /git merge-base HEAD/);
  assert.match(sentence, /git diff <mergeBase>/);
  assert.match(sentence, /agent_pause/);
  for (const banned of [
    "merge-base --all",
    "origin/<base>",
    "assembly of the diff",
  ])
    assert.ok(!sentence.includes(banned), banned);
});

test("a worktree ref re-aims the working-tree focus sentence at that worktree", () => {
  const message = composeReviewerTask({
    target: "working-tree",
    targetRef: "/path/to/wt",
  });
  assert.match(message, /^TARGET: working-tree:\/path\/to\/wt\n/);
  assert.match(
    message,
    /Review the current code changes \(staged, unstaged, and untracked files\) in the worktree at \/path\/to\/wt \(a worktree of the current repository\)\./,
  );
});

test("compose rejects malformed input in the tool's voice", () => {
  assert.throws(
    () => composeReviewerTask({ target: "snapshot" }),
    /target must be one of/,
  );
  // pr is no longer a kind, so its ref fails the vocabulary check, and every
  // rejection names the correct spelling to re-issue.
  assert.ok(targetRefError("pr", "123"));
  assert.throws(
    () => composeReviewerTask({ target: "branch" }),
    /targetRef is required for target branch/,
  );
  assert.throws(
    () =>
      composeReviewerTask({ target: "working-tree", targetRef: "src/orch" }),
    /working-tree targetRef must be an absolute worktree path/,
  );
});

test("parameters carry target/targetRef and never task", () => {
  const properties = (reviewerSpawnParameters as any).properties;
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
  assert.deepEqual(REVIEWER_TARGETS, [
    "working-tree",
    "branch",
    "commit",
    "paths",
  ]);
  assert.doesNotMatch(JSON.stringify(properties.target), /pr/);
});

test("the manager prompt recommends fresh roots for the target-resolvers", () => {
  const prompt = subagentPrompt({ subagentMode: "on" } as never, false)!;
  assert.match(
    prompt,
    /Spawn reviewer_spawn and simplifier_spawn as fresh roots \(absolute single-segment path/,
  );
});
