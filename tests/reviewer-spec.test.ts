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
  assert.ok(
    AGENT_COLORS.includes(reviewer.color as (typeof AGENT_COLORS)[number]),
  );
  assert.match(reviewer.icon ?? "", /^\p{Co}$/u);
});

test("the reviewer may read and report but never write or delegate", () => {
  for (const tool of [
    "read",
    "bash",
    "grep",
    "find",
    "ls",
    "agent_update",
    "agent_pause",
  ])
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
    assert.equal(
      reviewer.tools.includes(spawnToolName(spec.name)),
      false,
      spec.name,
    );
  // The roster is flat: no built-in agent delegates, so only /root orchestrates.
  assert.equal(getAgentSpec("task").tools.includes("finder_spawn"), false);
  assert.equal(getAgentSpec("task").tools.includes("reviewer_spawn"), false);
  assert.ok(spawnTools.some((tool) => tool.name === "reviewer_spawn"));
});

test("reviewer_spawn swaps task for typed target params", () => {
  const tool = spawnTools.find(
    (candidate) => candidate.name === "reviewer_spawn",
  );
  assert.ok(tool);
  const properties = (tool.parameters as any).properties;
  assert.deepEqual(Object.keys(properties).sort(), [
    "description",
    "path",
    "target",
    "targetRef",
    "timeoutMs",
    "wait",
  ]);
  // Not name-branched in tools.ts: the seam lives on the spec.
  assert.ok(reviewer.parameters);
  assert.ok(reviewer.composeTask);
  assert.equal("task" in properties, false);
  for (const target of ["working-tree", "branch", "commit", "paths"])
    assert.match(JSON.stringify(properties.target), new RegExp(target));
  assert.match(tool.description, /target: working-tree/);
  assert.match(tool.description, /targetRef: abc1234/);
  // The old prose channel is gone: no extra-instructions invitation either.
  assert.doesNotMatch(
    tool.description,
    /Lines after the descriptor|extra instructions/,
  );
  assert.doesNotMatch(tool.description, /not supported|refuse|use \/review/i);
  // The rubric belongs to the child prompt only; per-turn tool descriptions stay small.
  assert.doesNotMatch(tool.description, /Review Guidelines/);
  // 2100 leaves room for the generated tool-surface line.
  assert.ok(tool.description.length < 2100, String(tool.description.length));
});

test("the reviewer prompt drops the unreachable descriptor-repair branch", () => {
  const prompt = reviewer.systemPrompt;
  assert.match(prompt, /first line is always a `TARGET:`/);
  assert.doesNotMatch(prompt, /extra instructions from the caller/);
  assert.doesNotMatch(prompt, /descriptor is missing or unreadable/);
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
    "git rev-parse --abbrev-ref",
    "git merge-base HEAD",
    "git show --stat",
  ])
    assert.ok(prompt.includes(command), command);
  // Two-dot diffing against a base branch silently includes commits the base added.
  assert.match(prompt, /never use `git diff <base>`/);
  // The four-step merge-base recipe replaced the fallback chain.
  assert.match(prompt, /agent_pause` and ask for the correct base/);
  assert.match(prompt, /agent_pause` and ask for the correct base/);
  // The fallback runs against a possibly-stale local base; disclosed, not hidden.
  assert.match(
    prompt,
    /can be stale; if it has no upstream and may be stale, say so in the report/,
  );
  // pr is not a kind any more, and the old fallback/origin chain is gone.
  assert.doesNotMatch(prompt, /gh pr diff/);
  assert.doesNotMatch(prompt, /merge-base --all/);
  assert.doesNotMatch(prompt, /origin\/<base>/);
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
