import assert from "node:assert/strict";
import { test } from "node:test";
import { AGENT_SPECS, getAgentSpec, listAgentSpecs, spawnToolName } from "../src/agents/specs.ts";
import { AGENT_SPEC_NAMES, AGENT_ROLES } from "../src/types.ts";
import { agentTools } from "../src/orch/tools.ts";

test("the built-in roster is exactly the five documented agents", () => {
  assert.deepEqual(
    AGENT_SPECS.map((spec) => spec.name),
    [...AGENT_SPEC_NAMES],
  );
  for (const spec of AGENT_SPECS) {
    assert.ok(AGENT_ROLES.includes(spec.role), spec.name);
    assert.ok(spec.description.length > 40, spec.name);
    assert.ok(spec.systemPrompt.length > 100, spec.name);
    assert.equal(new Set(spec.tools).size, spec.tools.length, spec.name);
    for (const tool of spec.tools) {
      // Names are exact allowlist entries, so a stray pattern would silently allow nothing.
      assert.match(tool, /^[a-z0-9_]+$/, `${spec.name}: ${tool}`);
    }
  }
});

test("only the worker may delegate", () => {
  const spawnVerbs = AGENT_SPECS.map((spec) => spawnToolName(spec.name));
  for (const spec of AGENT_SPECS) {
    const spawns = spawnVerbs.filter((verb) => spec.tools.includes(verb));
    if (spec.name === "task") assert.deepEqual(spawns, spawnVerbs);
    else assert.deepEqual(spawns, [], spec.name);
    // Progress reporting is available to every agent, delegation controls only to the worker.
    for (const tool of ["agent_update", "agent_pause"])
      assert.ok(spec.tools.includes(tool), spec.name);
    for (const control of [
      "agent_wait",
      "agent_steer",
      "agent_status",
      "agent_output",
      "agent_stop",
    ]) {
      assert.equal(spec.tools.includes(control), spec.name === "task", `${spec.name}: ${control}`);
    }
  }
});

test("no agent carries a model; routing is a role name", () => {
  for (const spec of AGENT_SPECS) {
    for (const field of ["model", "models", "thinkingLevel", "modelSuggestions"]) {
      assert.equal(Object.hasOwn(spec, field), false, `${spec.name}: ${field}`);
    }
  }
  const roles = new Set(AGENT_SPECS.map((spec) => spec.role));
  assert.deepEqual([...roles].sort(), ["oracle", "subagents"]);
  assert.equal(getAgentSpec("oracle").role, "oracle");
});

test("the librarian ships its own skill and no other agent has skills", () => {
  const withSkills = AGENT_SPECS.filter((spec) => spec.skills.length > 0);
  assert.deepEqual(
    withSkills.map((spec) => spec.name),
    ["librarian"],
  );
  assert.match(withSkills[0]!.skills[0]!, /skills\/librarian$/);
});

test("each agent registers one spawn tool with no type parameter", () => {
  const tools = agentTools(() => ({}) as any, "/root");
  const spawnTools = tools.filter((tool) => tool.name.endsWith("_spawn"));
  assert.deepEqual(
    spawnTools.map((tool) => tool.name),
    listAgentSpecs().map((spec) => spawnToolName(spec.name)),
  );
  for (const tool of spawnTools) {
    const properties = (tool.parameters as any).properties;
    assert.deepEqual(Object.keys(properties).sort(), [
      "description",
      "path",
      "task",
      "timeoutMs",
      "wait",
    ]);
    assert.equal("type" in properties, false, tool.name);
    assert.ok(tool.description.length > 100, tool.name);
    assert.equal(tool.name.startsWith("agent_"), false);
  }
  // Agent discovery is gone: the roster is baked into the tool descriptions and prompt guidance.
  assert.equal(
    tools.some((tool) => tool.name === "agent_types"),
    false,
  );
});

test("unknown agents cannot be resolved", () => {
  assert.throws(() => getAgentSpec("coder"), /Unknown agent: coder/);
  assert.throws(() => getAgentSpec("architect"), /Unknown agent/);
});
