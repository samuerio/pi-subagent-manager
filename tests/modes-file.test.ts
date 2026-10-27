import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyModesPatch,
  unknownModesFields,
  computeModesPatch,
  ensureDefaultModeEntries,
  loadModesFile,
  parseModesFile,
  projectModesPath,
  resolveModesPathSync,
  saveModesFile,
  withFileLock,
} from "../src/modes/file.ts";
import { cloneModesFile, type ModesFile } from "../src/modes/schema.ts";

const defaults: ModesFile = {
  version: 1,
  currentMode: "default",
  modes: {
    default: {
      roles: { main: { provider: "p", modelId: "m", thinkingLevel: "high" } },
    },
    fast: {
      roles: { main: { provider: "p", modelId: "m", thinkingLevel: "off" } },
    },
  },
};

function tempDir(t: { after(fn: () => void): void }): string {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-file-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test("parse leniently drops malformed pins and keeps valid ones", () => {
  const file = parseModesFile(
    JSON.stringify({
      currentMode: "work",
      modes: {
        work: {
          roles: {
            main: { provider: "p", modelId: "m", thinkingLevel: "high" },
            oracle: { provider: 7 },
          },
          color: "accent",
        },
        broken: "not an object",
      },
    }),
    defaults,
  );
  assert.equal(file.currentMode, "work");
  assert.deepEqual(file.modes.work!.roles, {
    main: { provider: "p", modelId: "m", thinkingLevel: "high" },
  });
  assert.equal(file.modes.work!.color, "accent");
  assert.deepEqual(file.modes.broken, { color: undefined });
});

test("invalid JSON falls back to the defaults snapshot", () => {
  assert.deepEqual(parseModesFile("{oops", defaults), cloneModesFile(defaults));
});

test("missing default modes are reseeded and the overlay never persists", () => {
  const file: ModesFile = { version: 1, currentMode: "custom", modes: {} };
  ensureDefaultModeEntries(file, defaults);
  assert.ok(file.modes.default);
  assert.equal(file.currentMode, "default");
});

test("patch computes only the changed fields", () => {
  const next = cloneModesFile(defaults);
  next.modes.fast!.roles!.main!.thinkingLevel = "low";
  next.modes.default!.roles = {
    ...next.modes.default!.roles,
    oracle: { provider: "p", modelId: "o", thinkingLevel: "off" },
  };
  next.currentMode = "fast";
  const patch = computeModesPatch(defaults, next, true);
  assert.ok(patch);
  assert.equal(patch.currentMode, "fast");
  assert.deepEqual(patch.modes!.fast!.roles!.main, {
    provider: "p",
    modelId: "m",
    thinkingLevel: "low",
  });
  assert.deepEqual(patch.modes!.default!.roles!.oracle, {
    provider: "p",
    modelId: "o",
    thinkingLevel: "off",
  });
  // Roles diff as a whole: the default patch carries roles and nothing else.
  assert.deepEqual(Object.keys(patch.modes!.default!), ["roles"]);
});

test("patch round-trips through apply without aliasing", () => {
  const next = cloneModesFile(defaults);
  next.modes.fast!.roles!.main!.thinkingLevel = "high";
  const patch = computeModesPatch(defaults, next, false)!;
  const target = cloneModesFile(defaults);
  applyModesPatch(target, patch);
  assert.equal(target.modes.fast!.roles!.main!.thinkingLevel, "high");
  // Mutating the applied value must not touch the patch source.
  target.modes.fast!.roles!.main!.thinkingLevel = "off";
  assert.equal(next.modes.fast!.roles!.main!.thinkingLevel, "high");
});

test("a project .pi/modes.json wins over the global path", (t) => {
  const root = tempDir(t);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "modes.json"), "{}");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });
  assert.equal(resolveModesPathSync(cwd), join(agentDir, "modes.json"));
  assert.equal(projectModesPath(cwd), join(cwd, ".pi", "modes.json"));
});

test("save then load round-trips and keeps concurrent patches", async (t) => {
  const root = tempDir(t);
  const filePath = join(root, "modes.json");
  await saveModesFile(filePath, defaults);
  const loaded = await loadModesFile(filePath, defaults);
  assert.equal(loaded.currentMode, "default");
  assert.deepEqual(loaded.modes.default!.roles, defaults.modes.default!.roles);
  assert.deepEqual(loaded.modes.fast!.roles, defaults.modes.fast!.roles);

  // Two writers with different edits merge instead of clobbering.
  const first = cloneModesFile(defaults);
  first.modes.fast!.roles!.main!.thinkingLevel = "low";
  const second = cloneModesFile(defaults);
  second.modes.extra = {
    roles: { main: { provider: "p", modelId: "x", thinkingLevel: "off" } },
  };
  await withFileLock(filePath, async () => {
    const latest = await loadModesFile(filePath, defaults);
    applyModesPatch(latest, computeModesPatch(defaults, first, true)!);
    await saveModesFile(filePath, latest);
  });
  await withFileLock(filePath, async () => {
    const latest = await loadModesFile(filePath, defaults);
    applyModesPatch(latest, computeModesPatch(defaults, second, true)!);
    await saveModesFile(filePath, latest);
  });
  const merged = await loadModesFile(filePath, defaults);
  assert.equal(merged.modes.fast!.roles!.main!.thinkingLevel, "low");
  assert.ok(merged.modes.extra);
  assert.ok(existsSync(filePath));
  // Only a trailing newline separates the last JSON line from EOF.
  assert.ok(readFileSync(filePath, "utf8").endsWith("\n"));
});

test("withFileLock recovers from a malformed lock file instead of throwing", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const filePath = join(root, "modes.json");
  const lockPath = `${filePath}.lock`;
  // Truncated lock: a crash between lock creation and metadata write, or a
  // torn concurrent read. JSON.parse of the raw content throws.
  writeFileSync(lockPath, '{"pid":', "utf8");
  const result = await withFileLock(filePath, async () => "ran");
  assert.equal(result, "ran");
  // The broken lock was replaced by a normal acquire/release cycle.
  assert.ok(!existsSync(lockPath));
});

test("unknownModesFields recurses into roles", () => {
  const parsed = {
    version: 1,
    currentMode: "work",
    comment: "note",
    modes: {
      work: {
        color: "accent",
        roles: {
          main: { provider: "p", modelId: "m", thinkingLevel: "high" },
          reviewer: { provider: "p", modelId: "r", thinkingLevel: "low" },
        },
      },
    },
  };
  assert.deepEqual(unknownModesFields(parsed), [
    "comment",
    "work.roles.reviewer",
  ]);
});
