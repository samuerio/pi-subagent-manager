import assert from "node:assert/strict";
import { test } from "node:test";
import {
  AGENT_SPECS,
  getAgentSpec,
  listAgentSpecs,
  spawnToolName,
  spawnToolNames,
} from "../src/agents/specs.ts";
import { AGENT_COLORS } from "../src/prefs/colors.ts";
import { AGENT_SPEC_NAMES } from "../src/types.ts";
import { agentTools } from "../src/orch/tools.ts";

const reviewer = getAgentSpec("reviewer");
const spawnTools = agentTools(() => ({}) as any, "/root");

test("the reviewer sits last in the shipped roster", () => {
  assert.deepEqual(
    AGENT_SPECS.map((spec) => spec.name),
    [...AGENT_SPEC_NAMES],
  );
  assert.equal(AGENT_SPECS.at(-1)?.name, "reviewer");
  assert.deepEqual(
    spawnToolNames(),
    listAgentSpecs().map((spec) => spawnToolName(spec.name)),
  );
});

test("the reviewer reuses the worker role and display tokens", () => {
  assert.equal(reviewer.role, "subagents");
  assert.deepEqual(reviewer.skills, []);
  assert.ok(AGENT_COLORS.includes(reviewer.color as (typeof AGENT_COLORS)[number]));
  assert.match(reviewer.icon ?? "", /^\p{Co}$/u);
});

test("the reviewer may read and report but never write or delegate", () => {
  for (const tool of ["read", "bash", "grep", "find", "ls", "agent_update", "agent_pause"])
    assert.ok(reviewer.tools.includes(tool), tool);
  for (const tool of [
    "write",
    "edit",
    "agent_wait",
    "agent_steer",
    "agent_status",
    "agent_output",
    "agent_stop",
  ])
    assert.equal(reviewer.tools.includes(tool), false, tool);
  for (const spec of AGENT_SPECS)
    assert.equal(reviewer.tools.includes(spawnToolName(spec.name)), false, spec.name);
  // Only the worker keeps the delegation surface.
  assert.ok(getAgentSpec("task").tools.includes("reviewer_spawn"));
  assert.ok(spawnTools.some((tool) => tool.name === "reviewer_spawn"));
});

test("reviewer_spawn keeps the shared spawn parameter set", () => {
  const tool = spawnTools.find((candidate) => candidate.name === "reviewer_spawn");
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool.parameters as any).properties).sort(), [
    "path",
    "task",
    "timeoutMs",
    "wait",
  ]);
  assert.match(tool.description, /TARGET: working-tree/);
  assert.match(tool.description, /TARGET: pr:123/);
  assert.doesNotMatch(tool.description, /not supported|refuse|use \/review/i);
  // The rubric belongs to the child prompt only; per-turn tool descriptions stay small.
  assert.doesNotMatch(tool.description, /Review Guidelines/);
  assert.ok(tool.description.length < 1800, String(tool.description.length));
});

test("the reviewer prompt carries the rubric plus the procedure", () => {
  const prompt = reviewer.systemPrompt;
  assert.match(prompt, /^# Review Guidelines\n/);
  for (const heading of [
    "## Determining what to flag",
    "## Untrusted User Input",
    "## Comment guidelines",
    "## Review priorities",
    "## Fail-fast error handling (strict)",
    "## Priority levels",
    "## Output format",
    "# Review Procedure",
    "## 1. Parse the target",
    "## 2. Resolve the diff yourself",
    "## 3. Read project instructions",
    "## 4. Review",
    "## 5. Reply contract",
    "## When the target stays ambiguous",
  ])
    assert.ok(prompt.includes(heading), heading);
  assert.match(prompt, /Verdict: correct/);
  assert.match(prompt, /Verdict: needs attention/);
  assert.match(prompt, /first line/);
  assert.ok(prompt.length < 12000, String(prompt.length));
});

test("the procedure resolves diffs without inventing them", () => {
  const prompt = reviewer.systemPrompt;
  for (const command of [
    "git diff HEAD",
    "git ls-files --others --exclude-standard",
    "git status --porcelain",
    "git rev-parse --verify",
    "git merge-base --all",
    "git show --stat",
    "gh pr diff",
  ])
    assert.ok(prompt.includes(command), command);
  // Two-dot diffing against a base branch silently includes commits the base added.
  assert.match(prompt, /Never use `git diff <base>`/);
  assert.match(prompt, /no merge base/);
  // Listing untracked paths is not reviewing them.
  assert.match(prompt, /git diff --no-index \/dev\/null/);
  assert.match(prompt, /Do not run `git add -N`/);
  assert.match(prompt, /REVIEW_GUIDELINES\.md/);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /agent_pause/);
});

test("the reply contract matches how the manager hands results back", () => {
  const prompt = reviewer.systemPrompt;
  assert.match(prompt, /Only your last message is handed back/);
  assert.match(prompt, /call no tools at all, `agent_update` included/);
  assert.match(prompt, /Never modify the working tree/);
  // Language is the caller's, not the package author's.
  assert.doesNotMatch(prompt, /in chinese/i);
  assert.match(prompt, /Answer in the language of the task text/);
});
