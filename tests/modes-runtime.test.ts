import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModesController } from "../src/modes/runtime.ts";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { ModesFile } from "../src/modes/schema.ts";
import { editModeUI, removeModeRecord } from "../src/modes/ui.ts";

interface Fixture {
  ctx: ExtensionContext;
  modes: ModesController;
  applied: Array<{ provider: string; modelId: string }>;
  thinking: { current: string };
  setModelOk(ok: boolean): void;
}

function fixture(
  t: { after(fn: () => void): void },
  file: ModesFile | undefined,
  options?: {
    setModelOk?: boolean;
    branch?: unknown[];
    model?: { provider: string; id: string };
    /** Enable ctx.hasUI and capture notifications into the given array. */
    ui?: { notify: Array<{ text: string; kind: string }> };
  },
): Fixture {
  const root = mkdtempSync(join(tmpdir(), "pi-modes-runtime-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir);
  if (file) writeFileSync(join(agentDir, "modes.json"), JSON.stringify(file));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
  });

  const applied: Array<{ provider: string; modelId: string }> = [];
  let modelOk = options?.setModelOk ?? true;
  const thinking = { current: "high" };
  const pi = {
    getThinkingLevel: () => thinking.current,
    setThinkingLevel: (level: string) => {
      thinking.current = level;
    },
    setModel: async (model: { provider: string; id: string }) => {
      if (!modelOk) return false;
      applied.push({ provider: model.provider, modelId: model.id });
      return true;
    },
  } as unknown as ExtensionAPI;

  const ctx = {
    cwd: join(root, "project"),
    hasUI: Boolean(options?.ui),
    ui: options?.ui
      ? {
          notify: (text: string, kind: string) =>
            options!.ui!.notify.push({ text, kind }),
        }
      : undefined,
    model: options?.model ?? { provider: "p", id: "main", reasoning: true },
    modelRegistry: {
      find: (provider: string, modelId: string) =>
        modelId === "ghost" ? undefined : { provider, id: modelId },
    },
    sessionManager: { getBranch: () => options?.branch ?? [] },
  } as unknown as ExtensionContext;

  const modes = new ModesController(pi);
  return {
    ctx,
    modes,
    applied,
    thinking,
    setModelOk: (ok: boolean) => {
      modelOk = ok;
    },
  };
}

const sessionStart = {
  type: "session_start",
  reason: "startup",
} as SessionStartEvent;
const modesFile = (current: string, modes: ModesFile["modes"]): ModesFile => ({
  version: 1,
  currentMode: current,
  modes,
});
const mainModes = modesFile("fast", {
  default: {
    roles: { main: { provider: "p", modelId: "main", thinkingLevel: "high" } },
  },
  fast: {
    roles: { main: { provider: "p", modelId: "main", thinkingLevel: "off" } },
  },
});
const resumedBranch = [
  {
    type: "message",
    message: {
      role: "user",
      content: [{ type: "text", text: "hi" }],
      timestamp: 1,
    },
  },
];

test("applyMode applies the mode's main pin and thinking level", async (t) => {
  const f = fixture(t, mainModes);
  // A fresh session applies the persisted currentMode ("fast") on its own.
  await f.modes.onSessionStart(f.ctx, sessionStart);
  assert.deepEqual(f.applied, [{ provider: "p", modelId: "main" }]);
  assert.equal(f.thinking.current, "off");
  assert.equal(f.modes.currentModeName, "fast");
  await f.modes.applyMode(f.ctx, "default");
  assert.equal(f.thinking.current, "high");
  assert.equal(f.modes.currentModeName, "default");
  // Persisted so a fresh session starts in the selected mode.
  const persisted = JSON.parse(
    readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), "utf8"),
  );
  assert.equal(persisted.currentMode, "default");
});

test("a resumed session infers the mode from the live selection", async (t) => {
  const f = fixture(t, mainModes, { branch: resumedBranch });
  await f.modes.onSessionStart(f.ctx, { ...sessionStart, reason: "resume" });
  assert.equal(f.modes.currentModeName, "default");
  assert.equal(f.modes.lastRealMode, "default");
  assert.deepEqual(f.applied, []);
});

test("an unmatched selection lands in the custom overlay without persisting", async (t) => {
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
    }),
    { branch: resumedBranch, model: { provider: "p", id: "other-model" } },
  );
  await f.modes.onSessionStart(f.ctx, { ...sessionStart, reason: "resume" });
  assert.equal(f.modes.currentModeName, "custom");
  assert.ok(f.modes.customOverlay);
  // The overlay selection is never written back as currentMode.
  const persisted = JSON.parse(
    readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), "utf8"),
  );
  assert.equal(persisted.currentMode, "default");
});

test("a manual model switch moves to the overlay; applyMode's own switch does not", async (t) => {
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
    }),
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  // A selection matching the active mode's main pin is treated as ours, not
  // as a manual switch (the event can arrive after applyMode's await settles).
  await f.modes.onModelSelect(f.ctx, {
    type: "model_select",
    model: { provider: "p", id: "main" } as never,
    previousModel: undefined,
    source: "cycle",
  });
  assert.equal(f.modes.currentModeName, "default");
  // A genuinely different model is a manual switch into the overlay.
  await f.modes.onModelSelect(f.ctx, {
    type: "model_select",
    model: { provider: "p", id: "other" } as never,
    previousModel: undefined,
    source: "cycle",
  });
  assert.equal(f.modes.currentModeName, "custom");
  // applyMode's own setModel re-entrancy must not bounce into the overlay.
  await f.modes.applyMode(f.ctx, "default");
  assert.equal(f.modes.currentModeName, "default");
});

test("an unappliable model falls into the overlay instead of failing the mode", async (t) => {
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
      ghost: {
        roles: {
          main: { provider: "p", modelId: "ghost", thinkingLevel: "high" },
        },
      },
    }),
    { setModelOk: false },
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  await f.modes.applyMode(f.ctx, "ghost");
  assert.equal(f.modes.currentModeName, "custom");
  assert.ok(f.modes.customOverlay);
});

test("a manual thinking-level change lands in the overlay; the pin's own level does not", async (t) => {
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
    }),
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  // The level the mode pins is ours (applyMode set it): ignored.
  await f.modes.onThinkingLevelSelect(f.ctx, { level: "high" });
  assert.equal(f.modes.currentModeName, "default");
  // A genuinely different level is a manual change into the overlay, and the
  // overlay pin carries the fresh level for the next /mode store.
  await f.modes.onThinkingLevelSelect(f.ctx, { level: "low" });
  assert.equal(f.modes.currentModeName, "custom");
  assert.equal(f.modes.customOverlay?.roles?.main?.thinkingLevel, "low");
});

test("persistRuntime without an initialized file reports nothing persisted", async (t) => {
  const f = fixture(t, undefined);
  assert.equal(await f.modes.persistRuntime(f.ctx, true), false);
});

test("the mode color override wins over the thinking-level border", async (t) => {
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        color: "accent",
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
      plain: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
    }),
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  const fgCalls: string[] = [];
  const theme = {
    fg: (token: string, _text: string) => {
      fgCalls.push(token);
      return _text;
    },
    getFgAnsi: (token: string) => token,
    getThinkingBorderColor: () => (text: string) => text,
  } as never;
  f.modes.getModeBorderColor(theme, "default")("x");
  assert.ok(fgCalls.includes("accent"));
  // A mode without an override uses the thinking-level border.
  f.modes.getModeBorderColor(theme, "plain")("y");
  assert.equal(fgCalls.length, 1);
});

test("persistRuntime refuses to rewrite a corrupt modes.json and warns", async (t) => {
  const notices: Array<{ text: string }> = [];
  const f = fixture(t, mainModes, { ui: { notify: notices } as never });
  const corrupt = "{ not valid json";
  writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), corrupt);
  // The corrupt file loads leniently (defaults); switching modes computes a
  // patch, and the persist path refuses to rewrite the file.
  await f.modes.onSessionStart(f.ctx, sessionStart);
  await f.modes.applyMode(f.ctx, "fast");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /not valid JSON/);
  // The user's file is preserved byte for byte.
  assert.equal(
    readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), "utf8"),
    corrupt,
  );
});

test("saving a file with unknown fields warns instead of stripping silently", async (t) => {
  const notices: Array<{ text: string }> = [];
  const f = fixture(t, mainModes, { ui: { notify: notices } as never });
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "modes.json"),
    JSON.stringify({
      version: 1,
      currentMode: "fast",
      comment: "hand-written note",
      modes: {
        fast: {
          roles: {
            main: { provider: "p", modelId: "main", thinkingLevel: "high" },
          },
          tags: ["x"],
        },
      },
    }),
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  await f.modes.applyMode(f.ctx, "default");
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /comment, fast\.tags/);
});

test("a refused deletion warns instead of claiming success", async (t) => {
  const notices: Array<{ text: string; kind: string }> = [];
  let selections: string[] = [];
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
      fast: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "off" },
        },
      },
    }),
    { ui: { notify: notices } as never },
  );
  (f.ctx.ui as unknown as Record<string, unknown>).select = async () => {
    const [first] = selections;
    selections = selections.slice(1);
    return first;
  };
  (f.ctx.ui as unknown as Record<string, unknown>).confirm = async () => true;
  // The file cannot be parsed, so every persist attempt is refused.
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "modes.json"),
    "{ not valid json",
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  selections = ["fast", "Delete mode", undefined as unknown as string];
  await editModeUI(f.modes, f.ctx, "fast");
  // The refusal warning came from persistRuntime...
  assert.ok(notices.some((notice) => /not valid JSON/.test(notice.text)));
  // ...and the "deleted successfully" toast is suppressed.
  assert.ok(!notices.some((notice) => /Deleted mode "/.test(notice.text)));
  assert.ok(
    notices.some((notice) => /in memory only/.test(notice.text)),
    JSON.stringify(notices),
  );
});

test("deleting the persisted current mode repoints it instead of leaving a dangling reference", async (t) => {
  const f = fixture(
    t,
    modesFile("work", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
      work: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "off" },
        },
      },
    }),
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  await removeModeRecord(f.modes, f.ctx, "work");
  const persisted = JSON.parse(
    readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), "utf8"),
  );
  assert.equal(persisted.currentMode, "default");
  assert.ok(persisted.modes.work === undefined);
  // The session lands on the adjacent mode instead of the custom overlay.
  assert.equal(f.modes.currentModeName, "default");
  assert.equal(f.modes.lastRealMode, "default");
  assert.equal(f.modes.customOverlay, null);
});

test("a refused store warns instead of claiming success", async (t) => {
  const notices: Array<{ text: string; kind: string }> = [];
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
    }),
    { ui: { notify: notices } as never },
  );
  writeFileSync(
    join(process.env.PI_CODING_AGENT_DIR!, "modes.json"),
    "{ not valid json",
  );
  await f.modes.onSessionStart(f.ctx, sessionStart);
  // The store computes a patch (new mode) but persistence is refused.
  await f.modes.storeSelectionIntoMode(f.ctx, "work", { roles: {} });
  assert.ok(notices.some((notice) => /not valid JSON/.test(notice.text)));
  // Nothing was written: the corrupt file is untouched.
  assert.equal(
    readFileSync(join(process.env.PI_CODING_AGENT_DIR!, "modes.json"), "utf8"),
    "{ not valid json",
  );
});

test("deleting a session-selected mode falls back to the persisted mode", async (t) => {
  const f = fixture(
    t,
    modesFile("b", {
      b: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
      a: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "low" },
        },
      },
    }),
    { branch: resumedBranch },
  );
  // Inference (exact thinking match) selects "a" while the file's
  // currentMode stays "b".
  f.thinking.current = "low";
  await f.modes.onSessionStart(f.ctx, { ...sessionStart, reason: "resume" });
  assert.equal(f.modes.currentModeName, "a");
  assert.equal(f.modes.data.currentMode, "b");
  await removeModeRecord(f.modes, f.ctx, "a");
  assert.equal(f.modes.currentModeName, "b");
  assert.equal(f.modes.lastRealMode, "b");
});

test("a failed deletion surfaces an error instead of crashing", async (t) => {
  const notices: Array<{ text: string; kind: string }> = [];
  let selections: string[] = [];
  const f = fixture(
    t,
    modesFile("default", {
      default: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "high" },
        },
      },
      work: {
        roles: {
          main: { provider: "p", modelId: "main", thinkingLevel: "off" },
        },
      },
    }),
    {
      ui: {
        notify: notices,
        // typed through the shared fixture option; select/confirm ride on ctx.ui
      } as never,
    },
  );
  (f.ctx.ui as unknown as Record<string, unknown>).select = async (
    _title: string,
    _items: string[],
  ) => {
    const [first] = selections;
    selections = selections.slice(1);
    return first;
  };
  (f.ctx.ui as unknown as Record<string, unknown>).confirm = async () => true;
  await f.modes.onSessionStart(f.ctx, sessionStart);
  // Persistence cannot succeed: the agent directory rejects writes, so the
  // lock file cannot be created and withFileLock throws immediately.
  const agentDir = process.env.PI_CODING_AGENT_DIR!;
  chmodSync(agentDir, 0o500);
  try {
    selections = ["Delete mode", undefined as unknown as string];
    await editModeUI(f.modes, f.ctx, "work");
    const failure = notices.find((notice) =>
      /Could not save modes\.json/.test(notice.text),
    );
    assert.ok(failure, JSON.stringify(notices));
    assert.equal(failure.kind, "error");
    // The mode survives on disk: nothing was persisted.
    const persisted = JSON.parse(
      readFileSync(join(agentDir, "modes.json"), "utf8"),
    );
    assert.ok(persisted.modes.work);
  } finally {
    chmodSync(agentDir, 0o700);
  }
});
