import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  Type,
  createAssistantMessageEventStream,
  getCurrentTools,
  type AssistantMessage,
  type Model,
} from "@earendil-works/pi-ai";
import {
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { DurableMailbox, LEGACY_QUEUE_TYPE } from "../src/orch/mailbox.ts";
import { createDriverFactory } from "../src/orch/runtime.ts";
import { testSpec } from "./helpers/spec.ts";
import type {
  AgentDriver,
  AgentSpec,
  DriverEvent,
  DriverOptions,
  TranscriptSnapshot,
} from "../src/types.ts";
import type { SubagentExtensionSelection } from "../src/prefs/settings.ts";
import type { InheritedToolSource } from "../src/orch/inherited-tools.ts";
import { fileURLToPath } from "node:url";

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "runtime-test",
  model: "model/with/slashes",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});

const messageText = (message: unknown): string => {
  if (!message || typeof message !== "object" || !("content" in message)) return "";
  const { content } = message as { content: unknown };
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block): block is { type: string; text?: string } => !!block && typeof block === "object",
    )
    .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
    .join("");
};

const countMessages = (messages: unknown[], role: string, text: string): number =>
  messages.filter(
    (message) =>
      !!message &&
      typeof message === "object" &&
      (message as { role?: string }).role === role &&
      messageText(message) === text,
  ).length;

const countTextMessages = (messages: unknown[], text: string): number =>
  messages.filter((message) => messageText(message) === text).length;

test("isolated real SDK driver without credentials", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-subagent-runtime-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  const drivers: AgentDriver[] = [];
  try {
    const cwd = path.join(directory, "workspace");
    await mkdir(path.join(cwd, ".pi", "extensions"), { recursive: true });
    await writeFile(
      path.join(cwd, ".pi", "extensions", "bad.ts"),
      'throw new Error("External extension loaded")',
    );
    // Model routing comes only from modes.json role pins.
    const writeModes = async (role: "oracle" | "subagents", identity: string, thinking: string) => {
      const file = path.join(directory, "modes.json");
      let modes: any = {
        version: 1,
        currentMode: "default",
        modes: {
          default: {
            roles: {
              main: { provider: "runtime-test", modelId: "model/with/slashes", thinkingLevel: "off" },
              oracle: { provider: "runtime-test", modelId: "model/with/slashes", thinkingLevel: "low" },
              subagents: { provider: "runtime-test", modelId: "model/with/slashes", thinkingLevel: "low" },
            },
          },
        },
      };
      try {
        modes = JSON.parse(await readFile(file, "utf8"));
      } catch {
        /* first write */
      }
      const slash = identity.indexOf("/");
      modes.modes.default.roles[role] = {
        provider: identity.slice(0, slash),
        modelId: identity.slice(slash + 1),
        thinkingLevel: thinking,
      };
      await writeFile(file, JSON.stringify(modes));
    };
    await writeModes("subagents", "runtime-test/model/with/slashes", "low");
    await writeModes("oracle", "runtime-test/model/with/slashes", "low");
    await writeFile(path.join(cwd, "AGENTS.md"), "PARENT CONTEXT MUST NOT LOAD");
    await writeFile(path.join(directory, "APPEND_SYSTEM.md"), "PARENT APPEND MUST NOT LOAD");
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const registry = new ModelRegistry(runtime);
    let calls = 0;
    let next = answer("child answer");
    let beforeDone: Promise<void> | undefined;
    let scripted:
      ((stream: ReturnType<typeof createAssistantMessageEventStream>) => void) | undefined;
    const requests: {
      system: string;
      model: Model<any>;
      messages: unknown[];
      toolNames: string[];
      apiKey?: string;
    }[] = [];
    const registerProvider = (provider: string, ids: string[], reasoning = true) =>
      registry.registerProvider(provider, {
        api: "openai-completions",
        baseUrl: "http://invalid.local",
        models: ids.map((id) => ({
          id,
          name: `${provider}/${id}`,
          reasoning,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 100000,
          maxTokens: 1000,
        })),
        streamSimple(model, context, streamOptions) {
          calls++;
          requests.push({
            system: JSON.stringify(context.messages.filter((msg) => msg.role === "system")),
            model,
            messages: context.messages,
            toolNames: getCurrentTools(context.messages).map((tool) => tool.name),
            apiKey: streamOptions?.apiKey,
          });
          const stream = createAssistantMessageEventStream();
          if (scripted) {
            const run = scripted;
            scripted = undefined;
            run(stream);
            return stream;
          }
          const reply = {
            ...structuredClone(next),
            provider: model.provider,
            model: model.id,
          };
          void (async () => {
            await Promise.resolve();
            stream.push({ type: "start", partial: reply });
            if (beforeDone) await beforeDone;
            if (reply.stopReason === "error" || reply.stopReason === "aborted")
              stream.push({ type: "error", reason: reply.stopReason, error: reply });
            else
              stream.push({
                type: "done",
                reason: reply.stopReason as "stop" | "length" | "toolUse",
                message: reply,
              });
            stream.end(reply);
          })();
          return stream;
        },
      });
    registerProvider("runtime-test", ["model/with/slashes", "fallback"]);
    registerProvider("runtime-other", ["backup"]);
    await runtime.setRuntimeApiKey("runtime-test", "fake-runtime-only-key");
    await runtime.setRuntimeApiKey("runtime-other", "other-runtime-only-key");
    await registry.refresh({ allowNetwork: false });
    assert.equal(registry.getProviderAuthStatus("runtime-test").source, "runtime");
    assert.equal(registry.getProviderAuthStatus("runtime-other").source, "runtime");
    const root = SessionManager.create(cwd, path.join(directory, "root"));
    let scopedModels = [
      { model: registry.find("runtime-test", "model/with/slashes")! },
      { model: registry.find("runtime-other", "backup")! },
    ];
    const notifications: { message: string; level: string }[] = [];
    const ctx = {
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
      cwd,
      sessionManager: root,
      modelRegistry: registry,
      model: registry.find("runtime-test", "model/with/slashes"),
      get scopedModels() {
        return scopedModels;
      },
      thinkingLevel: "low",
      isProjectTrusted: () => false,
    } as unknown as ExtensionContext;
    const apiKeys: Record<string, string> = {
      "runtime-test": "fake-runtime-only-key",
      "runtime-other": "other-runtime-only-key",
      "runtime-plain": "runtime-test-key",
    };
    const assertModel = (identity: string) => {
      const request = requests.at(-1)!;
      assert.equal(`${request.model.provider}/${request.model.id}`, identity);
      assert.equal(request.apiKey, apiKeys[request.model.provider]);
    };
    const toolCall = (id: string, name: string): AssistantMessage => ({
      ...answer(""),
      content: [{ type: "toolCall", id, name, arguments: {} }],
      stopReason: "toolUse",
    });
    // A tool that blocks until released, so tests can act while a tool call is in flight.
    const gatedTool = (name: string, onRelease?: () => void) => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const gate = new Promise<void>((resolve) => (release = resolve));
      const tool: ToolDefinition = {
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        async execute() {
          entered();
          await gate;
          onRelease?.();
          return { content: [{ type: "text", text: "done" }], details: undefined };
        },
      };
      return { tool, started, release };
    };
    let subagentExtensions: SubagentExtensionSelection = false;
    let inheritedTools: InheritedToolSource = { tools: [], activeNames: [] };
    const factory = createDriverFactory(
      () => ctx,
      () => inheritedTools,
      () => subagentExtensions,
    );
    const events: DriverEvent[] = [];
    let pause = false;
    const options = (overrides: Partial<DriverOptions> = {}): DriverOptions => ({
      path: "/root/child",
      parentPath: "/root",
      type: testSpec("worker", { systemPrompt: "ONLY CHILD PROMPT", tools: [] }),
      inherited: [answer("inherited answer")],
      tools: [],
      onEvent: (event) => events.push(event),
      shouldPause: () => pause,
      signal: new AbortController().signal,
      ...overrides,
    });
    const toolOptions = (path: string, tool: ToolDefinition) =>
      options({ path, tools: [tool], type: { ...options().type, tools: [tool.name] } });
    const create = async (opts: DriverOptions) => {
      const driver = await factory(opts);
      drivers.push(driver);
      return driver;
    };

    await t.test(
      "configured hooks are opt-in, child-local, filtered and cleaned up on resume",
      async () => {
        const extensionDir = path.join(directory, "extensions");
        await mkdir(extensionDir);
        const extensionFile = path.join(extensionDir, "hooks.ts");
        const shutdownLog = path.join(directory, "extension-shutdown.log");
        await writeFile(shutdownLog, "");
        const shutdownCount = async () =>
          (await readFile(shutdownLog, "utf8")).trim().split("\n").filter(Boolean).length;
        await writeFile(
          extensionFile,
          `
        import { Type } from "@earendil-works/pi-ai";
        import { appendFile } from "node:fs/promises";
        export default function(pi) {
          let factoryHosted = false;
          pi.events.emit("pi-subagent-manager:diagnostic:probe", { respond: () => { factoryHosted = true; } });
          let count = 0;
          const record = (event, data = {}) => pi.appendEntry("extension-test", { event, ...data });
          pi.on("session_start", (_event, ctx) => {
            count = ctx.sessionManager.getBranch().filter(e => e.type === "custom" && e.customType === "extension-test" && e.data.event === "execute").length;
            let hostAvailable = false;
            pi.events.emit("pi-subagent-manager:diagnostic:probe", { respond: (capability) => { hostAvailable = capability?.protocol === 1 && typeof capability.version === "string"; } });
            if (!hostAvailable) throw new Error("Missing diagnostic host");
            pi.events.emit("pi-subagent-manager:diagnostic", { level: "error", source: "test-extension", message: "Classifier\\n\\u001b[31m unavailable" });
            pi.events.emit("pi-subagent-manager:diagnostic", { level: "error", source: "test-extension", message: "Classifier\\n\\u001b[31m unavailable" });
            record("start", { sessionId: ctx.sessionManager.getSessionId(), trusted: ctx.isProjectTrusted(), factoryHosted });
          });
          pi.on("input", (event) => {
            record("input");
            return { action: "transform", text: "INPUT TRANSFORM: " + event.text };
          });
          pi.on("before_agent_start", (event) => {
            record("before");
            event.systemPromptOptions.appendSystemPrompt += "\\nEXTENSION BEFORE START";
          });
          pi.on("context", (event) => ({ messages: [...event.messages, { role: "user", content: "EXTENSION CONTEXT", timestamp: Date.now() }] }));
          pi.on("tool_call", (event) => {
            if (event.toolName !== "extension_echo") return;
            record("call");
            event.input.value = (event.input.value ?? 0) + 1;
          });
          pi.on("tool_result", (event) => {
            if (event.toolName !== "extension_echo") return;
            record("result");
            return { content: [...event.content, { type: "text", text: "EXTENSION RESULT" }] };
          });
          const echo = {
            name: "extension_echo", label: "Echo", description: "Echo child session state",
            parameters: Type.Object({ value: Type.Optional(Type.Number()) }),
            execute: async (_id, args, _signal, _update, ctx) => {
              record("execute", { count: ++count, value: args.value, sessionId: ctx.sessionManager.getSessionId() });
              return { content: [{ type: "text", text: "EXTENSION EXECUTION" }], details: { count } };
            },
          };
          pi.registerTool(echo);
          pi.on("session_start", () => pi.registerTool({ ...echo, name: "extension_delayed" }));
          pi.on("session_shutdown", async (_event, ctx) => {
            await Promise.resolve();
            record("shutdown");
            await appendFile(${JSON.stringify(shutdownLog)}, ctx.sessionManager.getSessionId() + "\\n");
          });
        }
      `,
        );
        await symlink(
          fileURLToPath(new URL("../src/index.ts", import.meta.url)),
          path.join(extensionDir, "manager.ts"),
        );
        // Also exercise the SDK loader after discovery with a missing configured package.
        // A fake local npm executable records any attempt to install (never uses network).
        const installMarker = path.join(directory, "install-attempted");
        const fakeNpm = path.join(directory, "fake-npm.cjs");
        await writeFile(
          fakeNpm,
          `
        const fs = require("node:fs");
        if (process.argv.includes("install")) {
          fs.writeFileSync(${JSON.stringify(installMarker)}, "installation attempted");
          process.exit(1);
        }
        console.log(${JSON.stringify(path.join(directory, "empty-global-root"))});
      `,
        );
        await writeFile(
          path.join(directory, "settings.json"),
          JSON.stringify({
            packages: ["npm:pi-subagent-missing-package-fixture@0.0.0"],
            npmCommand: [process.execPath, fakeNpm],
          }),
        );
        let bridgeCalls = 0;
        inheritedTools = {
          activeNames: ["extension_echo", "extension_delayed"],
          tools: ["extension_echo", "extension_delayed"].map((name) => ({
            name,
            label: "Echo",
            description: "Root bridge",
            parameters: Type.Object({}),
            async execute() {
              bridgeCalls++;
              return { content: [{ type: "text", text: "ROOT BRIDGE" }], details: undefined };
            },
          })),
        };
        const extensionOptions = (threadPath: string, overrides: Partial<DriverOptions> = {}) =>
          options({
            path: threadPath,
            type: { ...options().type, tools: ["extension_echo", "extension_delayed"] },
            ...overrides,
          });
        const entries = (file: string) =>
          SessionManager.open(file)
            .getBranch()
            .filter((entry) => entry.type === "custom" && entry.customType === "extension-test")
            .map(
              (entry) =>
                (
                  entry as {
                    data: {
                      event: string;
                      count?: number;
                      value?: number;
                      sessionId?: string;
                      trusted?: boolean;
                      factoryHosted?: boolean;
                    };
                  }
                ).data,
            );
        const issueToolCall = (name = "extension_echo") => {
          const reply = toolCall(`echo-${calls}`, name);
          next = answer("extension answer");
          scripted = (stream) => {
            stream.push({ type: "done", reason: "toolUse", message: reply });
            stream.end(reply);
          };
        };
        try {
          const off = await create(extensionOptions("/root/extensions-off"));
          issueToolCall();
          await off.prompt("default off");
          assert.equal(bridgeCalls, 1);
          assert.deepEqual(entries(off.sessionFile!), []);
          assert.doesNotMatch(requests.at(-1)!.system, /EXTENSION BEFORE START/);
          assert.doesNotMatch(JSON.stringify(requests.at(-1)!.messages), /EXTENSION CONTEXT/);

          subagentExtensions = [];
          const none = await create(extensionOptions("/root/extensions-empty"));
          await none.prompt("no selected hooks");
          assert.deepEqual(entries(none.sessionFile!), []);
          await none.dispose();
          // An unselected configured factory must never execute, even at load time.
          const unselected = path.join(extensionDir, "unselected.ts");
          await writeFile(
            unselected,
            'export default function() { throw new Error("UNSELECTED FACTORY RAN"); }',
          );
          subagentExtensions = [extensionFile];
          assert.equal(notifications.length, 0, "extensions off cannot report");
          const diagnosticStart = events.length;
          const savedError = console.error;
          const stderr: unknown[][] = [];
          console.error = (...args) => {
            stderr.push(args);
          };
          let child: AgentDriver;
          try {
            child = await create(extensionOptions("/root/extensions-on"));
          } finally {
            console.error = savedError;
          }
          assert.deepEqual(stderr, [], "channel never writes to stderr");
          const reports = events.slice(diagnosticStart).filter((e) => e.kind === "diagnostic");
          assert.equal(reports.length, 1, "duplicate reports are suppressed");
          assert.deepEqual(notifications, [
            {
              message:
                "Diagnostic from /root/extensions-on [error; test-extension]: Classifier unavailable",
              level: "error",
            },
          ]);
          issueToolCall();
          await child.prompt("run child hooks");
          assert.equal(bridgeCalls, 1, "reloaded tool replaces bridge rather than executing twice");
          const records = entries(child.sessionFile!);
          assert.deepEqual(
            records.map(({ event }) => event),
            ["start", "input", "before", "call", "execute", "result"],
          );
          assert.equal(records[0]!.trusted, false);
          assert.equal(records[0]!.factoryHosted, true, "channel available during factory loading");
          assert.notEqual(records[0]!.sessionId, root.getSessionId());
          const executed = records.find(({ event }) => event === "execute")!;
          assert.equal(executed.sessionId, records[0]!.sessionId);
          assert.equal(executed.count, 1);
          assert.equal(executed.value, 1, "tool hook transforms arguments once");
          assert.match(requests.at(-1)!.system, /EXTENSION BEFORE START/);
          assert.match(JSON.stringify(requests.at(-1)!.messages), /EXTENSION CONTEXT/);
          assert.match(JSON.stringify(requests.at(-1)!.messages), /EXTENSION RESULT/);
          assert.deepEqual(requests.at(-1)!.toolNames, ["extension_echo", "extension_delayed"]);
          assert.equal(
            events.some(
              (event) => event.kind === "error" && /conflict|agent_spawn/i.test(event.text),
            ),
            false,
          );

          const other = await create(extensionOptions("/root/extensions-other"));
          assert.equal(notifications.length, 2, "dedupe state is child-local");
          assert.match(notifications[1]!.message, /Diagnostic from \/root\/extensions-other/);
          issueToolCall();
          await other.prompt("separate extension state");
          assert.equal(
            entries(other.sessionFile!).find(({ event }) => event === "execute")!.count,
            1,
          );
          issueToolCall("extension_delayed");
          await other.prompt("session_start tool also replaces bridge");
          assert.equal(bridgeCalls, 1);
          assert.equal(
            entries(other.sessionFile!)
              .filter(({ event }) => event === "execute")
              .at(-1)!.count,
            2,
          );
          const otherFile = other.sessionFile!;
          const previousInputs = entries(otherFile).filter(({ event }) => event === "input").length;
          await other.steer("DURABLE STEERING STAYS RAW");
          assert.equal(
            entries(otherFile).filter(({ event }) => event === "input").length,
            previousInputs,
          );
          await other.dispose();
          const replayed = await create(
            extensionOptions("/root/extensions-other", { sessionFile: otherFile, inherited: [] }),
          );
          await replayed.prompt("replay pending steering");
          const replayMessages = JSON.stringify(requests.at(-1)!.messages);
          assert.match(replayMessages, /INPUT TRANSFORM: replay pending steering/);
          assert.match(replayMessages, /DURABLE STEERING STAYS RAW/);
          assert.doesNotMatch(replayMessages, /INPUT TRANSFORM: DURABLE STEERING STAYS RAW/);
          assert.equal(
            entries(otherFile).filter(({ event }) => event === "input").length,
            previousInputs + 1,
          );
          await replayed.dispose();
          const file = child.sessionFile!;
          await child.dispose();
          await child.dispose();
          assert.equal(entries(file).filter(({ event }) => event === "shutdown").length, 1);
          const reopened = await create(
            extensionOptions("/root/extensions-on", { sessionFile: file, inherited: [] }),
          );
          issueToolCall();
          await reopened.prompt("restore extension branch state");
          assert.equal(entries(file).filter(({ event }) => event === "start").length, 2);
          assert.equal(
            entries(file)
              .filter(({ event }) => event === "execute")
              .at(-1)!.count,
            2,
          );

          // The startup snapshot is retained until a session is actually reopened.
          subagentExtensions = false;
          await reopened.prompt("keep live hooks");
          assert.match(requests.at(-1)!.system, /EXTENSION BEFORE START/);
          await reopened.dispose();
          const disabledResume = await create(
            extensionOptions("/root/extensions-on", { sessionFile: file, inherited: [] }),
          );
          const previousStarts = entries(file).filter(({ event }) => event === "start").length;
          issueToolCall();
          await disabledResume.prompt("resume with extensions disabled");
          assert.equal(
            entries(file).filter(({ event }) => event === "start").length,
            previousStarts,
          );
          assert.equal(bridgeCalls, 2);

          await rm(unselected);
          subagentExtensions = true;
          const filtered = await create(options({ path: "/root/extensions-filtered" }));
          await filtered.prompt("hooks must not add unauthorized tools");
          assert.deepEqual(requests.at(-1)!.toolNames, []);
          assert.match(requests.at(-1)!.system, /EXTENSION BEFORE START/);
          assert.deepEqual(
            root
              .getBranch()
              .filter((entry) => entry.type === "custom" && entry.customType === "extension-test"),
            [],
            "main session untouched",
          );
          await other.dispose();
          await filtered.dispose();

          const shutdownsBeforeError = await shutdownCount();
          ctx.isProjectTrusted = () => true;
          await assert.rejects(
            create(options({ path: "/root/extensions-project-error" })),
            /Subagent extension loading failed:.*External extension loaded/,
          );
          assert.equal(
            await shutdownCount(),
            shutdownsBeforeError + 1,
            "successful factories shut down when another extension fails to load",
          );
          await writeFile(
            path.join(cwd, ".pi", "settings.json"),
            JSON.stringify({ extensions: ["-extensions/bad.ts"] }),
          );
          const trusted = await create(options({ path: "/root/extensions-trusted" }));
          await trusted.prompt("disabled project extension must stay disabled");
          assert.equal(entries(trusted.sessionFile!)[0]!.trusted, true);
          await trusted.dispose();
          ctx.isProjectTrusted = () => false;
          const cancelKey = "pi-subagent-runtime-abort-during-extension-load";
          const globals = globalThis as Record<string, unknown>;
          const duringLoad = new AbortController();
          globals[cancelKey] = duringLoad;
          const cancellationFile = path.join(extensionDir, "cancel.ts");
          await writeFile(
            cancellationFile,
            `export default function() { globalThis[${JSON.stringify(cancelKey)}]?.abort(new Error("extension startup cancelled")); }`,
          );
          const shutdownsBeforeCancel = await shutdownCount();
          try {
            await assert.rejects(
              create(
                options({ path: "/root/extensions-load-cancelled", signal: duringLoad.signal }),
              ),
              /extension startup cancelled/,
            );
            assert.equal(
              await shutdownCount(),
              shutdownsBeforeCancel + 1,
              "loaded factories shut down after startup cancellation",
            );
          } finally {
            delete globals[cancelKey];
            await rm(cancellationFile, { force: true });
          }

          const appendModelChange = SessionManager.prototype.appendModelChange;
          const shutdownsBeforeSdkFailure = await shutdownCount();
          SessionManager.prototype.appendModelChange = () => {
            throw new Error("SDK session creation failed");
          };
          try {
            await assert.rejects(
              create(options({ path: "/root/extensions-sdk-failed", inherited: [] })),
              /SDK session creation failed/,
            );
            assert.equal(
              await shutdownCount(),
              shutdownsBeforeSdkFailure + 1,
              "best-effort shutdown also runs when SDK construction fails",
            );
          } finally {
            SessionManager.prototype.appendModelChange = appendModelChange;
          }
          const { access } = await import("node:fs/promises");
          await assert.rejects(access(installMarker), { code: "ENOENT" });
        } finally {
          ctx.isProjectTrusted = () => false;
          await rm(path.join(cwd, ".pi", "settings.json"), { force: true });
          await rm(path.join(directory, "settings.json"), { force: true });
          inheritedTools = { tools: [], activeNames: [] };
          subagentExtensions = false;
          await rm(extensionDir, { recursive: true, force: true });
        }
      },
    );

    await t.test(
      "auto-discovered standalone and directory extensions load only when selected/trusted",
      async () => {
        // The enclosing test sets PI_CODING_AGENT_DIR=directory, exercising runtime
        // getAgentDir() resolution rather than assuming the default home directory.
        const extensionDir = path.join(directory, "extensions");
        const projectFile = path.join(cwd, ".pi", "extensions", "standalone.ts");
        const files = ["standalone.ts", "standalone.js", "ts-dir/index.ts", "js-dir/index.js"];
        const hook = (marker: string) => `export default function(pi) {
        pi.on("before_agent_start", (event) => {
          event.systemPromptOptions.appendSystemPrompt += "\\n" + ${JSON.stringify(marker)};
        });
      }`;
        try {
          for (const [index, file] of files.entries()) {
            const target = path.join(extensionDir, file);
            await mkdir(path.dirname(target), { recursive: true });
            await writeFile(target, hook(`AUTO EXTENSION ${index}`));
          }
          await writeFile(
            path.join(extensionDir, "unselected.ts"),
            'throw new Error("UNSELECTED AUTO FILE LOADED")',
          );
          await symlink(
            fileURLToPath(new URL("../src/index.ts", import.meta.url)),
            path.join(extensionDir, "manager.ts"),
          );
          await writeFile(projectFile, hook("AUTO PROJECT EXTENSION"));
          // Select every supported entry-point form, without an extensions setting.
          subagentExtensions = [...files.map((file) => path.join(extensionDir, file)), projectFile];
          const untrusted = await create(options({ path: "/root/auto-untrusted" }));
          await untrusted.prompt("load auto-discovered selections");
          for (const index of files.keys())
            assert.match(requests.at(-1)!.system, new RegExp(`AUTO EXTENSION ${index}`));
          assert.doesNotMatch(requests.at(-1)!.system, /AUTO PROJECT EXTENSION/);
          await untrusted.dispose();
          ctx.isProjectTrusted = () => true;
          subagentExtensions = [projectFile];
          const trusted = await create(options({ path: "/root/auto-trusted" }));
          await trusted.prompt("load only the selected project file");
          assert.match(requests.at(-1)!.system, /AUTO PROJECT EXTENSION/);
          assert.doesNotMatch(requests.at(-1)!.system, /AUTO EXTENSION/);
          await trusted.dispose();
        } finally {
          ctx.isProjectTrusted = () => false;
          subagentExtensions = false;
          await rm(extensionDir, { recursive: true, force: true });
          await rm(projectFile, { force: true });
        }
      },
    );

    await t.test("modes.json pins the model and thinking of every role", async () => {
      const assertPinned = async (role: AgentSpec["role"], expected: string, thinking: string) => {
        const driver = await create(
          options({ path: `/root/pin-${role}-${drivers.length}`, type: testSpec(role, { role }) }),
        );
        await driver.prompt("Verify pinned routing");
        assertModel(expected);
        assert.equal(
          SessionManager.open(driver.sessionFile!).buildSessionContext().thinkingLevel,
          thinking,
        );
        await driver.dispose();
      };
      try {
        await assertPinned("subagents", "runtime-test/model/with/slashes", "low");
        await writeModes("subagents", "runtime-other/backup", "high");
        await assertPinned("subagents", "runtime-other/backup", "high");
        await writeModes("oracle", "runtime-test/fallback", "high");
        await assertPinned("oracle", "runtime-test/fallback", "high");
        // The pin wins over a restored session model and over the parent's model.
        next = answer("restored");
        const first = await create(options({ path: "/root/pin-restored" }));
        await first.prompt("save pin");
        const sessionFile = first.sessionFile!;
        await first.dispose();
        await writeModes("subagents", "runtime-other/backup", "low");
        const reopened = await create(
          options({ path: "/root/pin-restored", sessionFile, inherited: [] }),
        );
        await reopened.prompt("pin overrides restored");
        assertModel("runtime-other/backup");
        // Non-reasoning models clamp the pinned thinking level.
        registerProvider("runtime-plain", ["non-reasoning"], false);
        await runtime.setRuntimeApiKey("runtime-plain", "runtime-test-key");
        await writeModes("subagents", "runtime-plain/non-reasoning", "high");
        await assertPinned("subagents", "runtime-plain/non-reasoning", "off");
      } finally {
        await writeModes("subagents", "runtime-test/model/with/slashes", "low");
        next = answer("child answer");
      }
    });

    await t.test(
      "read-only observation attaches mid-assistant stream and retains inherited metadata",
      async () => {
        const driver = await create(options({ path: "/root/watch-assistant" }));
        const partial = { ...answer("live partial"), stopReason: "pending" as const };
        const final = answer("live final");
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let sawPartial!: () => void;
        const streamed = new Promise<void>((resolve) => (sawPartial = resolve));
        const updates: TranscriptSnapshot[] = [];
        const initial = driver.observeTranscript!((snapshot) => {
          updates.push(snapshot);
          if (messageText(snapshot.assistant) === "live partial") sawPartial();
        });
        assert.equal(initial.snapshot.inheritedCount, 1);
        assert.equal(initial.snapshot.assistant, null);
        scripted = (stream) => {
          void (async () => {
            stream.push({ type: "start", partial });
            stream.push({ type: "text_delta", contentIndex: 0, delta: "live partial", partial });
            await gate;
            stream.push({ type: "done", reason: "stop", message: final });
            stream.end(final);
          })();
        };
        const turn = driver.prompt("watch me");
        try {
          await streamed;
          const attached = driver.observeTranscript!(() => {});
          assert.equal(messageText(attached.snapshot.assistant), "live partial");
          assert.equal(countTextMessages([...attached.snapshot.messages], "live partial"), 0);
          assert.throws(() => (attached.snapshot.messages as unknown[]).push("bad"));
          attached.unsubscribe();
        } finally {
          release();
        }
        await turn;
        assert.equal(updates.at(-1)?.assistant, null);
        assert.equal(countTextMessages([...updates.at(-1)!.messages], "live final"), 1);
        assert.equal(countTextMessages(driver.snapshot(), "bad"), 0);
        initial.unsubscribe();
        const file = driver.sessionFile!;
        driver.dispose();
        const restored = await create(
          options({ path: "/root/watch-assistant", sessionFile: file, inherited: [] }),
        );
        const history = restored.observeTranscript!(() => {});
        assert.equal(
          history.snapshot.inheritedCount,
          1,
          "persisted ownership retains inherited prefix count",
        );
        assert.equal(countTextMessages([...history.snapshot.messages], "live final"), 1);
        history.unsubscribe();
      },
    );

    await t.test(
      "read-only observation captures a running tool and its partial/error result",
      async () => {
        let release!: () => void;
        let entered!: () => void;
        const started = new Promise<void>((resolve) => (entered = resolve));
        const gate = new Promise<void>((resolve) => (release = resolve));
        const tool: ToolDefinition = {
          name: "watch_tool",
          label: "watch_tool",
          description: "watch_tool",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, onUpdate) {
            onUpdate?.({ content: [{ type: "text", text: "partial output" }], details: undefined });
            entered();
            await gate;
            next = answer("after failed tool");
            throw new Error("expected tool failure");
          },
        };
        const driver = await create(toolOptions("/root/watch-tool", tool));
        next = toolCall("watch-call", tool.name);
        const turn = driver.prompt("watch tool");
        await started;
        // onUpdate's SDK event dispatch is asynchronous; tool entry alone is not its completion.
        await new Promise<void>((resolve) => setImmediate(resolve));
        const updates: TranscriptSnapshot[] = [];
        const observation = driver.observeTranscript!((snapshot) => updates.push(snapshot));
        try {
          assert.equal(observation.snapshot.tools[0]?.toolCallId, "watch-call");
          assert.equal(observation.snapshot.tools[0]?.state, "running");
          assert.match(JSON.stringify(observation.snapshot.tools[0]?.result), /partial output/);
        } finally {
          release();
        }
        await turn;
        assert.ok(updates.some((snapshot) => snapshot.tools.some((item) => item.isError)));
        const latest = updates.at(-1)!;
        assert.equal(
          latest.tools.length,
          0,
          "finalized results are rendered from history, not duplicated as active tools",
        );
        assert.equal(
          latest.messages.filter(
            (message) => message.role === "toolResult" && message.toolCallId === "watch-call",
          ).length,
          1,
        );
        observation.unsubscribe();
      },
    );

    await t.test(
      "the spec allowlist is exact: unlisted tools are never declared or callable",
      async () => {
        let executions = 0;
        const probe: ToolDefinition = {
          name: "probe",
          label: "Probe",
          description: "Probe",
          parameters: Type.Object({}),
          async execute() {
            executions++;
            return { content: [{ type: "text", text: "done" }], details: undefined };
          },
        };
        try {
          // `missing` is not available in this build; it is ignored rather than failing the spawn.
          next = answer("declarations");
          const driver = await create(
            options({
              path: "/root/allowlist",
              tools: [probe],
              type: { ...options().type, tools: ["read", "missing"] },
            }),
          );
          await driver.prompt("Inspect selected tools");
          assert.deepEqual(requests.at(-1)!.toolNames, ["read"]);

          // A tool that exists locally but is absent from the allowlist must not be declared.
          const strict = await create(
            options({ path: "/root/allowlist-strict", tools: [probe], type: { ...options().type, tools: [] } }),
          );
          await strict.prompt("No tools");
          assert.deepEqual(requests.at(-1)!.toolNames, []);
          const reply = toolCall("blocked-probe", "probe");
          scripted = (stream) => {
            stream.push({ type: "start", partial: reply });
            stream.push({ type: "done", reason: "toolUse", message: reply });
            stream.end(reply);
          };
          next = answer("after rejected call");
          await strict.prompt("Try a blocked tool");
          assert.ok(
            strict
              .snapshot()
              .some(
                (msg) =>
                  msg.role === "toolResult" &&
                  msg.toolCallId === "blocked-probe" &&
                  msg.isError,
              ),
          );
          assert.equal(executions, 0);
        } finally {
          scripted = undefined;
          next = answer("child answer");
        }
      },
    );

    await t.test("pause settles after tools, then dispose/reopen same JSONL resumes", async () => {
      pause = false;
      const { tool, started, release } = gatedTool("agent_pause", () => {
        pause = true;
      });
      next = toolCall("pause-1", "agent_pause");
      const pauseOptions = toolOptions("/root/pause", tool);
      const driver = await create(pauseOptions);
      await driver.sendUpdate("queued mailbox");
      const count = calls;
      const run = driver.prompt("pause task");
      await started;
      await driver.steer("queued refinement");
      release();
      await run;
      assert.equal(calls, count + 1);
      assert.equal(driver.output(), "");
      assert.ok(
        driver.snapshot().some((msg) => msg.role === "toolResult" && msg.toolCallId === "pause-1"),
      );
      await driver.sendUpdate("paused mailbox");
      assert.equal(calls, count + 1);
      assert.equal(countMessages(driver.snapshot(), "custom", "paused mailbox"), 1);
      const file = driver.sessionFile!;
      driver.dispose();
      const reopened = await create({ ...pauseOptions, sessionFile: file });
      assert.equal(reopened.sessionFile, file);
      assert.equal(countMessages(reopened.snapshot(), "custom", "paused mailbox"), 1);
      const resumeRequests = requests.length;
      pause = false;
      next = answer("resumed");
      await reopened.prompt("resume");
      assert.equal(reopened.output(), "resumed");
      assert.ok(
        requests
          .slice(resumeRequests)
          .some((request) => JSON.stringify(request.messages).includes("queued refinement")),
      );
    });


    await t.test("steering a live child keeps its pinned model", async () => {
      let releaseDone!: () => void;
      beforeDone = new Promise<void>((resolve) => {
        releaseDone = resolve;
      });
      next = answer("first explicit turn");
      const driver = await create(options({ path: "/root/queued-steer" }));
      const beforeCalls = calls;
      const run = driver.prompt("start explicit run");
      await new Promise((resolve) => setImmediate(resolve));
      await driver.steer("queued after acceptance");
      // Changing the pin does not re-route a live child; only a resume does.
      await writeModes("subagents", "runtime-other/backup", "low");
      releaseDone();
      await run;
      beforeDone = undefined;
      assert.equal(calls, beforeCalls + 2);
      assertModel("runtime-test/model/with/slashes");
      assert.equal(countMessages(driver.snapshot(), "user", "queued after acceptance"), 1);
      await writeModes("subagents", "runtime-test/model/with/slashes", "low");
      next = answer("child answer");
    });

    await t.test("missing pins and virtual models fail closed", async () => {
      // A role without a pin must abort the spawn instead of silently inheriting a model.
      const file = path.join(directory, "modes.json");
      const original = JSON.parse(await readFile(file, "utf8"));
      try {
        delete original.modes.default.roles.oracle;
        await writeFile(file, JSON.stringify(original));
        await assert.rejects(
          factory(options({ type: testSpec("oracle", { role: "oracle" }) })),
          /roles\.oracle is required/,
        );
      } finally {
        await writeFile(file, JSON.stringify(original));
      }
      ctx.model = { ...ctx.model!, api: "pi-virtual", id: "virtual" };
      const find = registry.find.bind(registry);
      registry.find = (provider, id) => (id === "virtual" ? ctx.model : find(provider, id));
      await writeModes("subagents", "runtime-test/virtual", "low");
      await assert.rejects(factory(options()), /Virtual model.*physical/);
      registry.find = find;
      await writeModes("subagents", "runtime-test/model/with/slashes", "low");
    });

    await t.test("partial legacy queue migration preserves each occurrence across reopen", () => {
      const legacy = SessionManager.create(cwd, path.join(directory, "legacy"));
      legacy.appendMessage(answer("legacy history"));
      legacy.appendCustomEntry(LEGACY_QUEUE_TYPE, {
        steering: ["same", "same"],
        followUp: ["later"],
      });
      const first = new DurableMailbox(legacy).pending();
      const interrupted = legacy
        .getBranch()
        .find(
          (entry) =>
            entry.type === "custom" &&
            (entry.data as { id?: string } | undefined)?.id === first[0].id,
        );
      assert.ok(interrupted);
      const reopened = SessionManager.open(legacy.getSessionFile()!);
      reopened.branch(interrupted.id); // Simulate exit after only the first acceptance persisted.
      const recovered = new DurableMailbox(reopened).pending();
      assert.deepEqual(
        recovered.map((entry) => entry.content),
        ["same", "same", "later"],
      );
      assert.equal(new Set(recovered.map((entry) => entry.id)).size, 3);
      assert.deepEqual(
        recovered.map((entry) => entry.id),
        first.map((entry) => entry.id),
      );
      assert.deepEqual(new DurableMailbox(reopened).pending(), recovered);
    });


    await t.test("assistant errors and cancellation reject, cleanup is idempotent", async () => {
      next = { ...answer(""), stopReason: "error", errorMessage: "terminal fake failure" };
      const driver = await create(options({ path: "/root/error" }));
      await assert.rejects(driver.prompt("fail"), /terminal fake failure/);
      assert.equal(driver.output(), "");
      next = { ...answer(""), stopReason: "aborted" };
      await assert.rejects(driver.prompt("cancel"), /aborted/);
      await Promise.all([driver.abort(), driver.abort()]);
      driver.dispose();
      driver.dispose();
      await driver.abort();
      await assert.rejects(driver.prompt("closed"), /disposed/);
      assert.ok(events.some((event) => event.kind === "error"));
      assert.ok(
        events.every(
          (event) =>
            event.kind === "settings" ||
            event.kind === "usage" ||
            event.kind === "checkpoint" ||
            event.kind === "diagnostic" ||
            event.text.length <= 1000,
        ),
      );
    });

    await t.test("abort interrupts an active tool without blocking cleanup", async () => {
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const tool: ToolDefinition = {
        name: "wait_signal",
        label: "Wait",
        description: "Wait",
        parameters: Type.Object({}),
        async execute(_id, _args, signal) {
          entered();
          await new Promise<void>((_resolve, reject) => {
            if (signal?.aborted) reject(new Error("cancelled"));
            else
              signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
                once: true,
              });
          });
          return { content: [], details: undefined };
        },
      };
      next = toolCall("wait-1", "wait_signal");
      const driver = await create(toolOptions("/root/abort", tool));
      const run = driver.prompt("wait");
      const rejected = assert.rejects(run, /aborted/);
      await started;
      await Promise.all([driver.abort(), driver.abort()]);
      await rejected;
      driver.dispose();
    });

    await t.test("startup cancellation rejects before allocation and during setup", async () => {
      const controller = new AbortController();
      controller.abort(new Error("startup cancelled"));
      const count = calls;
      await assert.rejects(factory(options({ signal: controller.signal })), /startup cancelled/);
      const duringSetup = new AbortController();
      const registeredIds = registry.getRegisteredProviderIds.bind(registry);
      registry.getRegisteredProviderIds = () => {
        duringSetup.abort(new Error("setup cancelled"));
        return registeredIds();
      };
      try {
        await assert.rejects(factory(options({ signal: duringSetup.signal })), /setup cancelled/);
      } finally {
        registry.getRegisteredProviderIds = registeredIds;
      }
      assert.equal(calls, count);
    });

    await t.test("shared session directory enforces root and thread ownership", async () => {
      next = answer("owned answer");
      const driver = await create(options({ path: "/root/owned" }));
      await driver.prompt("owned task");
      const file = driver.sessionFile!;
      await assert.rejects(
        factory(options({ path: "/root/wrong-thread", sessionFile: file })),
        /inside this root|ownership|thread/i,
      );
      const otherRoot = SessionManager.create(cwd, root.getSessionDir());
      const otherFactory = createDriverFactory(() => ({ ...ctx, sessionManager: otherRoot }));
      await assert.rejects(
        otherFactory(options({ path: "/root/owned", sessionFile: file })),
        /inside this root|ownership|thread/i,
      );
      root.appendMessage(answer("root transcript"));
      await assert.rejects(
        factory(options({ sessionFile: root.getSessionFile()! })),
        /inside this root|ownership|thread/i,
      );
      const foreign = SessionManager.create(cwd, path.join(directory, "foreign"));
      foreign.appendMessage(answer("foreign transcript"));
      const linked = path.join(root.getSessionDir(), "foreign-link.jsonl");
      await symlink(foreign.getSessionFile()!, linked);
      await assert.rejects(factory(options({ sessionFile: linked })), /inside this root/i);
    });

    await t.test("usage counts only this agent's assistant messages", async () => {
      const usage = (input: number, output: number, cacheRead = 0, cacheWrite = 0) => ({
        input,
        output,
        cacheRead,
        cacheWrite,
        totalTokens: input + output + cacheRead + cacheWrite,
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: (input + output + cacheRead + cacheWrite) / 1000,
        },
      });
      const assistant = (
        tokens: AssistantMessage["usage"],
        stopReason: AssistantMessage["stopReason"] = "stop",
      ): AssistantMessage => ({
        ...answer("metrics"),
        stopReason,
        usage: tokens,
        errorMessage: stopReason === "error" ? "model failed" : undefined,
      });
      type StreamEvent = Parameters<
        ReturnType<typeof createAssistantMessageEventStream>["push"]
      >[0];
      const script = (final: AssistantMessage, ...events: StreamEvent[]) => {
        scripted = (stream) => {
          void Promise.resolve().then(() => {
            for (const event of events) stream.push(event);
            stream.end(final);
          });
        };
      };
      let rows: [number, number, boolean][] = [];
      let costs: number[] = [];
      const metricsOptions = (overrides: Partial<DriverOptions>) =>
        options({
          path: "/root/metrics",
          onEvent: (event) => {
            if (event.kind === "usage") {
              rows.push([event.inputTokens, event.outputTokens, event.partial ?? false]);
              costs.push(Number(event.costUsd?.toFixed(3)));
            }
          },
          ...overrides,
        });
      // Inherited assistant usage must never be billed to the child.
      const driver = await create(
        metricsOptions({ inherited: [assistant(usage(500, 500, 20, 20))] }),
      );
      const partial = assistant(usage(4, 1, 1, 0), "pending");
      const grown = assistant(usage(4, 2, 1, 2), "pending");
      const finalMessage = assistant(usage(6, 4, 2, 3));
      script(
        finalMessage,
        { type: "start", partial },
        { type: "text_delta", contentIndex: 0, delta: "x", partial },
        { type: "text_delta", contentIndex: 0, delta: "y", partial: grown },
        { type: "done", reason: "stop", message: finalMessage },
      );
      await driver.prompt("count me");
      assert.deepEqual(rows, [
        [5, 1, true],
        [7, 2, true],
        [11, 4, false],
      ]);
      assert.deepEqual(costs, [0.006, 0.009, 0.015]);

      rows = [];
      costs = [];
      const failed = assistant(usage(2, 1, 1, 0), "error");
      script(failed, { type: "error", reason: "error", error: failed });
      await assert.rejects(driver.prompt("fail"), /model failed/);
      assert.deepEqual(rows, [[14, 5, false]]);
      assert.deepEqual(costs, [0.019]);

      // A reopened driver reports only usage produced after reopening.
      const file = driver.sessionFile!;
      driver.dispose();
      rows = [];
      costs = [];
      const reopened = await create(metricsOptions({ sessionFile: file, inherited: [] }));
      const resumed = assistant(usage(3, 2));
      script(resumed, { type: "done", reason: "stop", message: resumed });
      await reopened.prompt("resume");
      assert.deepEqual(rows, [[3, 2, false]]);
      assert.deepEqual(costs, [0.005]);
    });


  } finally {
    for (const driver of drivers) driver.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
