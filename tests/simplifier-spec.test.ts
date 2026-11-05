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
import { agentTools } from "../src/orch/tools.ts";

const simplifier = getAgentSpec("simplifier");
const spawnTools = agentTools(() => ({}) as any, "/root");

test("the simplifier sits second to last, before the reviewer", () => {
  assert.equal(AGENT_SPECS.at(-2)?.name, "simplifier");
  assert.equal(AGENT_SPECS.at(-1)?.name, "reviewer");
  assert.equal(listAgentSpecs().at(-1)!.name, "reviewer");
  assert.deepEqual(
    spawnToolNames(),
    listAgentSpecs().map((spec) => spawnToolName(spec.name)),
  );
});

test("the simplifier reuses the worker role and its own display tokens", () => {
  assert.equal(simplifier.role, "subagents");
  assert.deepEqual(simplifier.skills, []);
  assert.ok(
    AGENT_COLORS.includes(simplifier.color as (typeof AGENT_COLORS)[number]),
  );
  assert.match(simplifier.icon ?? "", /^\p{Co}$/u);
  for (const spec of AGENT_SPECS) {
    if (spec.name === "simplifier") continue;
    assert.notEqual(spec.icon, simplifier.icon, spec.name);
    assert.notEqual(spec.color, simplifier.color, spec.name);
  }
});

test("the simplifier may edit but never delegates", () => {
  for (const tool of [
    "read",
    "write",
    "edit",
    "bash",
    "grep",
    "find",
    "ls",
    "agent_update",
    "agent_pause",
  ])
    assert.ok(simplifier.tools.includes(tool), tool);
  for (const tool of [
    "agent_wait",
    "agent_steer",
    "agent_status",
    "agent_output",
    "agent_stop",
  ])
    assert.equal(simplifier.tools.includes(tool), false, tool);
  for (const spec of AGENT_SPECS)
    assert.equal(
      simplifier.tools.includes(spawnToolName(spec.name)),
      false,
      spec.name,
    );
});

test("simplifier_spawn swaps task for typed target params", () => {
  const tool = spawnTools.find(
    (candidate) => candidate.name === "simplifier_spawn",
  );
  assert.ok(tool);
  assert.deepEqual(Object.keys((tool.parameters as any).properties).sort(), [
    "description",
    "path",
    "target",
    "targetRef",
    "timeoutMs",
    "wait",
  ]);
  // Not name-branched in tools.ts: the seam lives on the spec.
  assert.ok(simplifier.parameters);
  assert.ok(simplifier.composeTask);
  assert.equal("task" in (tool.parameters as any).properties, false);
  assert.match(tool.description, /Simplifies and refines code/);
  assert.match(tool.description, /target: working-tree/);
  assert.match(tool.description, /targetRef: main/);
  assert.match(tool.description, /targetRef: src\/orch/);
  // The old prose channel is gone: no extra-instructions invitation either.
  assert.doesNotMatch(tool.description, /Extra lines after the descriptor/);
  assert.doesNotMatch(tool.description, /pr:/i);
  assert.doesNotMatch(tool.description, /Simplifier Procedure/);
  // 2100 leaves room for the generated tool-surface line.
  assert.ok(tool.description.length < 2100, String(tool.description.length));
});

test("the simplifier prompt drops the unreachable descriptor-repair branch", () => {
  const prompt = simplifier.systemPrompt;
  assert.match(prompt, /first line is always a `TARGET:`/);
  assert.doesNotMatch(prompt, /extra instructions from the caller/);
  assert.doesNotMatch(prompt, /when the descriptor is missing/);
});

test("the simplifier prompt carries the procedure before the rubric", () => {
  const prompt = simplifier.systemPrompt;
  assert.match(prompt, /^# Simplifier Procedure\n/);
  for (const heading of [
    "## 1. Parse the target",
    "## 2. Resolve the scope yourself",
    "## 3. Guardrails",
    "## 4. Reply contract",
    "## When the target stays ambiguous",
    "# Simplification Guidelines",
    "## 1. Preserve Functionality",
    "## 2. Apply Project Standards",
    "## 3. Enhance Clarity",
    "## 4. Maintain Balance",
    "## 5. Focus Scope",
  ])
    assert.ok(prompt.includes(heading), heading);
  assert.ok(prompt.length < 12000, String(prompt.length));
});

test("guardrails and reply contract match how the manager runs a child", () => {
  const prompt = simplifier.systemPrompt;
  for (const fragment of [
    "git status --porcelain",
    "git diff HEAD",
    "git rev-parse --verify",
    "git merge-base --all",
    "AGENTS.md",
    "agent_pause",
    "Behavior stays exact",
    "Never mutate git state",
    "New files only as move-extraction",
    "Tests are not the object",
    "One pass",
    "Only your last message is handed back",
    "`agent_update` included",
    "zero edits is a valid outcome",
  ])
    assert.ok(prompt.includes(fragment), fragment);
  // The write targets are pull-request shaped or session shaped; neither exists here.
  assert.doesNotMatch(prompt, /current session/);
  assert.doesNotMatch(prompt, /pr:</);
  // Language is the caller's, not the package author's.
  assert.doesNotMatch(prompt, /in chinese/i);
});

test("the rubric keeps the authored taste sections near-verbatim", () => {
  const prompt = simplifier.systemPrompt;
  for (const fragment of [
    "Never change what the code does - only how it does it",
    "Avoid nested ternary operators",
    "Choose clarity over brevity",
    "Maintain Balance",
    'Prioritize "fewer lines" over readability',
  ])
    assert.ok(prompt.includes(fragment), fragment);
});
