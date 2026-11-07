import assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import {
  AGENT_SPECS,
  getAgentSpec,
  listAgentSpecs,
  spawnToolName,
  toolSurface,
} from "../src/agents/specs.ts";
import { AGENT_SPEC_NAMES, AGENT_ROLES } from "../src/types.ts";
import { agentTools } from "../src/orch/tools.ts";

test("the built-in roster is exactly the six documented agents", () => {
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

test("toolSurface lists the full allowlist, working tools first, and flags read-only specs", () => {
  for (const spec of AGENT_SPECS) {
    const surface = toolSurface(spec);
    const listed = surface.match(/has access to the following tools: ([^.]+)/);
    assert.ok(listed, spec.name);
    // Work tools come first; the agent_* orchestration plumbing follows.
    const workTools = spec.tools.filter((name) => !name.startsWith("agent_"));
    const plumbing = spec.tools.filter((name) => name.startsWith("agent_"));
    assert.deepEqual(listed[1].split(", "), [...workTools, ...plumbing], spec.name);
    const writes = spec.tools.includes("edit") || spec.tools.includes("write");
    assert.equal(
      surface.includes("It is read-only: it does not modify files."),
      !writes,
      spec.name,
    );
  }
});

test("spawn tool descriptions carry the generated tool surface", () => {
  const tools = agentTools(() => ({}) as any, "/root");
  for (const spec of AGENT_SPECS) {
    const tool = tools.find((entry) => entry.name === spawnToolName(spec.name));
    assert.ok(tool, spec.name);
    assert.ok(tool.description.includes(toolSurface(spec)), spec.name);
  }
});

test("no agent delegates; every agent reports progress and pauses", () => {
  const spawnVerbs = AGENT_SPECS.map((spec) => spawnToolName(spec.name));
  for (const spec of AGENT_SPECS) {
    const spawns = spawnVerbs.filter((verb) => spec.tools.includes(verb));
    assert.deepEqual(spawns, [], spec.name);
    // Progress reporting is available to every agent; nothing can spawn a descendant.
    for (const tool of ["agent_update", "agent_pause"])
      assert.ok(spec.tools.includes(tool), spec.name);
    for (const control of [
      "agent_wait",
      "agent_steer",
      "agent_status",
      "agent_output",
      "agent_stop",
    ])
      assert.equal(spec.tools.includes(control), false, `${spec.name}: ${control}`);
  }
});

test("no agent carries a model; routing is a role name", () => {
  for (const spec of AGENT_SPECS) {
    for (const field of [
      "model",
      "models",
      "thinkingLevel",
      "modelSuggestions",
    ]) {
      assert.equal(Object.hasOwn(spec, field), false, `${spec.name}: ${field}`);
    }
  }
  const roles = new Set(AGENT_SPECS.map((spec) => spec.role));
  assert.deepEqual([...roles].sort(), ["oracle", "subagents"]);
  assert.equal(getAgentSpec("oracle").role, "oracle");
});

test("only the librarian and the worker ship agent-specific skills", () => {
  const withSkills = AGENT_SPECS.filter((spec) => spec.skills.length > 0);
  assert.deepEqual(withSkills.map((spec) => spec.name), ["task", "librarian"]);
  assert.deepEqual(
    getAgentSpec("task").skills.map((dir) => path.basename(dir)),
    ["playwright-cli"],
  );
  assert.match(getAgentSpec("librarian").skills[0]!, /skills\/librarian$/);
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
    if (tool.name === "reviewer_spawn" || tool.name === "simplifier_spawn")
      assert.deepEqual(Object.keys(properties).sort(), [
        "description",
        "path",
        "target",
        "targetRef",
        "timeoutMs",
        "wait",
      ]);
    else
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
