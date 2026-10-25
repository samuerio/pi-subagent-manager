import assert from "node:assert/strict";
import { test } from "node:test";
import { modelIdentity } from "../src/prefs/models.ts";
import { resolveRoleRouting } from "../src/orch/routing.ts";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("modelIdentity joins provider and model id", () => {
  assert.equal(modelIdentity({ provider: "p", id: "model/with/slashes" }), "p/model/with/slashes");
});

function modesFixture(t: { after(fn: () => void): void }, modes: unknown) {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(cwd);
  writeFileSync(join(agentDir, "modes.json"), JSON.stringify(modes));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  return { agentDir, cwd };
}

const modes = {
  version: 1,
  currentMode: "default",
  modes: {
    default: {
      roles: {
        main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        oracle: { provider: "p", modelId: "advisor", thinkingLevel: "high" },
        subagents: { provider: "p", modelId: "worker", thinkingLevel: "medium" },
      },
    },
  },
};

test("each role resolves to its own pin", (t) => {
  const { cwd } = modesFixture(t, modes);
  assert.deepEqual(resolveRoleRouting(cwd, "oracle"), {
    model: "p/advisor",
    thinking: "high",
  });
  assert.deepEqual(resolveRoleRouting(cwd, "subagents"), {
    model: "p/worker",
    thinking: "medium",
  });
});

test("a project .pi/modes.json overrides the global file", (t) => {
  const { cwd } = modesFixture(t, modes);
  mkdirSync(join(cwd, ".pi"));
  const project = structuredClone(modes);
  project.modes.default.roles.subagents.modelId = "project-worker";
  writeFileSync(join(cwd, ".pi", "modes.json"), JSON.stringify(project));
  assert.equal(resolveRoleRouting(cwd, "subagents").model, "p/project-worker");
  assert.equal(resolveRoleRouting(cwd, "oracle").model, "p/advisor");
});

test("a missing file, mode, role or field is a hard error naming the problem", (t) => {
  const { cwd } = modesFixture(t, modes);
  assert.equal(resolveRoleRouting(cwd, "oracle").model, "p/advisor");
  const missingMode = { ...modes, currentMode: "nope" };
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), JSON.stringify(missingMode));
  assert.throws(() => resolveRoleRouting(cwd, "oracle"), /modes\["nope"\] is missing/);

  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), JSON.stringify(modes));
  const noRole = structuredClone(modes);
  delete (noRole.modes.default.roles as Record<string, unknown>).oracle;
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), JSON.stringify(noRole));
  assert.throws(() => resolveRoleRouting(cwd, "oracle"), /roles\.oracle is required/);

  const noThinking = structuredClone(modes);
  delete (noThinking.modes.default.roles.oracle as Record<string, unknown>).thinkingLevel;
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), JSON.stringify(noThinking));
  assert.throws(() => resolveRoleRouting(cwd, "oracle"), /roles\.oracle\.thinkingLevel/);
});

test("an unreadable modes.json reports the path", (t) => {
  const { cwd } = modesFixture(t, modes);
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), "{not json");
  assert.throws(() => resolveRoleRouting(cwd, "subagents"), /failed to read\/parse .*modes\.json/);
});
