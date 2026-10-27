import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import piSubagent from "../src/index.ts";

/**
 * A held, live lock must not take the session down: session_start warns and
 * attachSession still runs (manager, widget, tools initialized).
 */
test("session_start survives a failing modes file and still attaches the session", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-modes-guard-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  // A valid file so ensureRuntime is happy; the failure comes from the write.
  writeFileSync(
    join(agentDir, "modes.json"),
    JSON.stringify({
      version: 1,
      currentMode: "default",
      modes: {
        default: {
          roles: {
            main: { provider: "p", modelId: "main", thinkingLevel: "high" },
          },
        },
      },
    }),
  );
  const sessionManager = SessionManager.inMemory(cwd);
  const hooks = new Map<string, Function>();
  const notifications: string[] = [];
  const warnings: string[] = [];
  const widgets: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (message: string) => warnings.push(message);
  try {
    const pi = {
      getCommands: () => [],
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
      on: (event: string, handler: Function) => hooks.set(event, handler),
      registerTool() {},
      registerCommand() {},
      registerShortcut() {},
      getThinkingLevel: () => "high",
      setThinkingLevel() {},
      setModel: async () => true,
      appendEntry: (type: string, data: unknown) =>
        sessionManager.appendCustomEntry(type, data),
      sendMessage() {},
    } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      sessionManager,
      hasUI: true,
      mode: "tui",
      isProjectTrusted: () => false,
      ui: {
        theme: { fg: (_t: string, s: string) => s, style: (s: string) => s },
        setStatus() {},
        setWidget(_key: string, widget: unknown) {
          widgets.push(widget);
        },
        setEditorComponent() {},
        getEditorComponent: () => undefined,
        getEditorText: () => "",
        notify: (text: string, kind: string) =>
          notifications.push(`${kind}: ${text}`),
      },
    } as unknown as ExtensionContext;

    piSubagent(pi);
    // The agent directory rejects writes: the lock file cannot be created and
    // withFileLock throws before the 5s timeout.
    chmodSync(agentDir, 0o500);
    try {
      await hooks.get("session_start")!({ reason: "startup" }, ctx);
    } finally {
      chmodSync(agentDir, 0o700);
    }
    // The failure was reported, not swallowed.
    assert.ok(
      notifications.some((text) => /Mode initialization failed/.test(text)),
      JSON.stringify(notifications),
    );
    assert.ok(warnings.some((text) => /Mode initialization failed/.test(text)));
    // The session attached anyway: the widget is registered.
    assert.ok(widgets.length > 0);
    // The user's modes.json is untouched.
    assert.ok(existsSync(join(agentDir, "modes.json")));
    assert.match(
      readFileSync(join(agentDir, "modes.json"), "utf8"),
      /"currentMode":"default"/,
    );
  } finally {
    console.warn = originalWarn;
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    chmodSync(agentDir, 0o700);
    rmSync(cwd, { recursive: true, force: true });
  }
});
