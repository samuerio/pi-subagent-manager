import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { clampThinkingLevel } from "@earendil-works/pi-ai/compat";
import { existsSync } from "node:fs";
import { mkdir, readFile, realpath } from "node:fs/promises";
import {
  createAgentSession,
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  createSyntheticSourceInfo,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  BOOTSTRAP_MESSAGE,
  buildBootstrapMessage,
  buildQueuedUserMessage,
  buildUpdateDetails,
  DurableMailbox,
} from "./mailbox.ts";
import { TranscriptChannel } from "./transcript.ts";
import { discoverSubagentExtensions, selectSubagentExtensions } from "./extensions.ts";
import type { InheritedToolSource } from "./inherited-tools.ts";
import type { SubagentExtensionSelection } from "../prefs/settings.ts";
import { modelIdentity } from "../prefs/models.ts";
import {
  type AgentSpec,
  type DriverFactory,
  type DriverOptions,
} from "../types.ts";
import { resolveRoleRouting } from "./routing.ts";
import { spawnToolNames } from "../agents/specs.ts";

import {
  DIAGNOSTIC_CHANNEL,
  DIAGNOSTIC_PROBE_CHANNEL,
  respondDiagnosticCapability,
  diagnosticSink,
  diagnosticText,
} from "./diagnostics.ts";

const BUILTINS = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];
/** Persisted before transcript messages so older-leaf restores still carry ownership. */
const THREAD_OWNERSHIP_TYPE = "pi-subagent:thread:v1";
const SESSION_FILE_ERROR =
  "Subagent sessionFile must be a JSONL file inside this root's session directory";
type ScopedModel = ExtensionContext["scopedModels"][number];
interface ThreadOwnership {
  rootId: string;
  threadPath: string;
}

function parseModelIdentity(identity: string): { provider: string; id: string } {
  const slash = identity.indexOf("/");
  return { provider: identity.slice(0, slash), id: identity.slice(slash + 1) };
}

function scopedModelsKey(scopedModels: readonly ScopedModel[]): string {
  return scopedModels
    .map(({ model, thinkingLevel }) => `${modelIdentity(model)}\0${thinkingLevel ?? ""}`)
    .join("\n");
}

function isJsonlWithin(directory: string, file: string): boolean {
  const relative = path.relative(directory, file);
  return (
    !!relative &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative) &&
    file.endsWith(".jsonl")
  );
}

async function tryRealpath(target: string): Promise<string | undefined> {
  try {
    return await realpath(target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function ownershipFromTranscript(content: string): ThreadOwnership | undefined {
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object") continue;
    const entry = parsed as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom" || entry.customType !== THREAD_OWNERSHIP_TYPE) continue;
    const data = entry.data;
    if (!data || typeof data !== "object") return undefined;
    const { rootId, threadPath } = data as { rootId?: unknown; threadPath?: unknown };
    if (typeof rootId !== "string" || typeof threadPath !== "string") return undefined;
    return { rootId, threadPath };
  }
  return undefined;
}

/** Orchestrator file for /root and independent roots; nested parents supply their own file. */
function resolveParentSession(
  options: DriverOptions,
  rootSessionFile: string | undefined,
): string | undefined {
  if (options.parentSessionFile) return options.parentSessionFile;
  if (!options.parentPath || options.parentPath === "/root") return rootSessionFile;
  return undefined;
}

async function assertAcceptedSessionFile(
  sessionFile: string,
  sessionDir: string,
  legacyDir: string,
  rootId: string,
  threadPath: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const sharedDir = await realpath(sessionDir);
  signal.throwIfAborted();
  const file = await tryRealpath(sessionFile);
  signal.throwIfAborted();
  const legacyDirReal = await tryRealpath(legacyDir);
  signal.throwIfAborted();
  // Legacy root-scoped transcripts stay valid, including files nested under that directory.
  if (file && legacyDirReal && isJsonlWithin(legacyDirReal, file)) return;
  if (!file || path.dirname(file) !== sharedDir || !file.endsWith(".jsonl")) {
    throw new Error(SESSION_FILE_ERROR);
  }
  const ownership = ownershipFromTranscript(await readFile(file, { encoding: "utf8", signal }));
  signal.throwIfAborted();
  if (!ownership || ownership.rootId !== rootId || ownership.threadPath !== threadPath) {
    throw new Error(
      "Subagent sessionFile ownership metadata does not match this rootId and thread path",
    );
  }
}

const SNIPPET_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "description"];
/** Short single-line argument hint for housekeeping summaries; never shown verbatim as status. */
export function toolArgumentSnippet(args: unknown): string | undefined {
  if (args === null || args === undefined) return undefined;
  let text: string | undefined;
  if (typeof args === "string") text = args;
  else if (typeof args === "object") {
    const record = args as Record<string, unknown>;
    const key = SNIPPET_KEYS.find((name) => typeof record[name] === "string");
    if (key) text = String(record[key]);
    else {
      try {
        text = JSON.stringify(args);
      } catch {
        return undefined;
      }
    }
  }
  const clean = text?.replace(/[\x00-\x1f\x7f-\x9f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, 160) : undefined;
}

/** Isolated SDK sessions; configured extension reload is experimental and opt-in. */
export function createDriverFactory(
  getRootContext: () => ExtensionContext,
  getInheritedTools: () => InheritedToolSource = () => ({ tools: [], activeNames: [] }),
  getSubagentExtensions: () => SubagentExtensionSelection = () => false,
): DriverFactory {
  const normalizeScopedModels = (
    scopedModels: ExtensionContext["scopedModels"] | null | undefined,
  ): readonly ScopedModel[] => scopedModels ?? [];
  /**
   * Routing comes only from the modes.json role pin (fail fast). A spec never
   * carries a model and a restored session never overrides the pin, so the same
   * agent always runs on the model the active mode assigns to its role.
   */
  const resolveInitialSettings = (spec: AgentSpec) => {
    const routing = resolveRoleRouting(getRootContext().cwd, spec.role);
    const { provider, id } = parseModelIdentity(routing.model);
    return { provider, id, thinkingLevel: routing.thinking };
  };
  const createDriver: DriverFactory = async (options) => {
    options.signal.throwIfAborted();
    const ctx = getRootContext();
    // Tool policy is a startup snapshot; retained live sessions keep their selected set.
    const extensionSelection = getSubagentExtensions();
    const rootId = ctx.sessionManager.getSessionId();
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(rootId))
      throw new Error("Unsafe root session id for subagent storage");
    const agentDir = getAgentDir();
    const sessionDir = ctx.sessionManager.getSessionDir();
    const legacyDir = path.join(agentDir, "subagents", rootId);
    options.signal.throwIfAborted();
    await mkdir(sessionDir, { recursive: true });
    options.signal.throwIfAborted();
    let sessionManager: SessionManager;
    if (options.sessionFile) {
      await assertAcceptedSessionFile(
        options.sessionFile,
        sessionDir,
        legacyDir,
        rootId,
        options.path,
        options.signal,
      );
      // Open the caller path, not its realpath, so retained sessionFile identity is stable.
      sessionManager = SessionManager.open(path.resolve(options.sessionFile), sessionDir, ctx.cwd);
      if (options.sessionLeafId !== undefined) {
        if (options.sessionLeafId === null) sessionManager.resetLeaf();
        else sessionManager.branch(options.sessionLeafId);
      }
    } else {
      const parentSession = resolveParentSession(options, ctx.sessionManager.getSessionFile());
      sessionManager = SessionManager.create(
        ctx.cwd,
        sessionDir,
        parentSession ? { parentSession } : undefined,
      );
      // Before transcript messages so an older restored leaf still has name and ownership as ancestors.
      sessionManager.appendSessionInfo(`${options.type.name} ${options.path}`);
      sessionManager.appendCustomEntry(THREAD_OWNERSHIP_TYPE, {
        rootId,
        threadPath: options.path,
        inheritedCount: options.inherited.length,
      });
      for (const message of options.inherited) {
        // Summary messages are projections, not appendable SDK session entries.
        if (message.role === "compactionSummary" || message.role === "branchSummary") {
          sessionManager.appendMessage({
            role: "user",
            content: message.summary,
            timestamp: message.timestamp,
          });
        } else if (message.role === "custom") {
          sessionManager.appendCustomMessageEntry(
            message.customType,
            message.content,
            message.display,
            message.details,
          );
        } else if (
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult" ||
          message.role === "bashExecution"
        ) {
          sessionManager.appendMessage(message);
        }
      }
    }
    const initialScopedModels = normalizeScopedModels(ctx.scopedModels);
    const { provider, id, thinkingLevel } = resolveInitialSettings(options.type);
    options.signal.throwIfAborted();
    const runtime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      modelsStorePath: path.join(agentDir, "models-store.json"),
      allowModelNetwork: false,
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    for (const providerId of ctx.modelRegistry.getRegisteredProviderIds()) {
      const native = ctx.modelRegistry.getRegisteredNativeProvider(providerId);
      const config = ctx.modelRegistry.getRegisteredProviderConfig(providerId);
      if (native) runtime.registerNativeProvider(native);
      if (config) runtime.registerProvider(providerId, config);
    }
    const mirrorRuntimeAuth = async (providerId: string) => {
      options.signal.throwIfAborted();
      if (ctx.modelRegistry.getProviderAuthStatus(providerId).source !== "runtime") return;
      const apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
      options.signal.throwIfAborted();
      if (apiKey !== undefined)
        await runtime.setRuntimeApiKey(providerId, apiKey, { signal: options.signal });
      options.signal.throwIfAborted();
    };
    const resolveRuntimeModel = async (
      providerId: string | undefined,
      modelId: string | undefined,
      scopedModels: readonly ScopedModel[],
    ) => {
      if (!providerId || !modelId)
        throw new Error(
          `Subagent model ${providerId ?? "(unset)"}/${modelId ?? "(unset)"} is unavailable; check modes.json roles.oracle/roles.subagents and provider credentials`,
        );
      await mirrorRuntimeAuth(providerId);
      const sourceModel =
        scopedModels.find(({ model }) => model.provider === providerId && model.id === modelId)
          ?.model ?? ctx.modelRegistry.find(providerId, modelId);
      if (sourceModel?.api === "pi-virtual") {
        throw new Error(
          `Virtual model ${providerId}/${modelId} cannot be reproduced through the public registry API. Pin a physical provider/model-id in modes.json.`,
        );
      }
      const runtimeModel = runtime.getModel(providerId, modelId);
      if (!runtimeModel)
        throw new Error(
          `Subagent model ${providerId}/${modelId} is unavailable; check modes.json roles.oracle/roles.subagents and provider credentials`,
        );
      return runtimeModel;
    };
    const model = await resolveRuntimeModel(provider, id, initialScopedModels);
    const inherited = getInheritedTools();
    const localNames = new Set([...BUILTINS, ...options.tools.map((tool) => tool.name)]);
    const externalTools = inherited.tools.filter((tool) => !localNames.has(tool.name));
    // A spec's tool list is a complete allowlist: a name outside it is blocked,
    // and a listed-but-unavailable name is simply absent. Unknown names are not
    // an error so a spec can list a builtin the running Pi build does not expose.
    const available = [...localNames, ...externalTools.map((tool) => tool.name)];
    const specTools = options.type.tools ?? [];
    const toolNames = specTools.filter((name) => available.includes(name));
    const allowed = new Set(toolNames);
    const specToolNames = new Set(specTools);
    const rootActive = new Set(inherited.activeNames);
    // Preserve deferred/codemode exposure rather than flooding model declarations with MCP tools.
    const activeToolNames = toolNames.filter(
      (name) => localNames.has(name) || rootActive.has(name) || specToolNames.has(name),
    );
    const projectTrusted = ctx.isProjectTrusted?.() ?? false;
    const extensionPaths = extensionSelection === false || (Array.isArray(extensionSelection) && !extensionSelection.length)
      ? []
      : selectSubagentExtensions(
          await discoverSubagentExtensions({ cwd: ctx.cwd, agentDir, projectTrusted }),
          extensionSelection,
        );
    const subagentExtensions = extensionPaths.length > 0;
    // Keep discovery settings OUT of this loader: reload() resolves packages with
    // auto-install enabled. An empty in-memory package/resource list ensures it
    // only loads the already-resolved files and cannot install missing packages.
    const settingsManager = SettingsManager.inMemory({ cacheWarming: "off" }, { projectTrusted });
    let parkQueue = () => {};
    const pauseBoundary = () => {
      if (!options.shouldPause()) return undefined;
      parkQueue();
      return { continue: false };
    };
    // A separate bus per driver: never share parent/other-child extension events.
    const childEvents = createEventBus();
    let diagnosticsClosed = false;
    let diagnosticsInitialized = false;
    // The startup signal belongs to one run; a stopped driver may be reused.
    const diagnosticsUnavailable = () =>
      diagnosticsClosed || (!diagnosticsInitialized && options.signal.aborted);
    if (subagentExtensions)
      childEvents.on(DIAGNOSTIC_PROBE_CHANNEL, (payload) => {
        try {
          if (
            diagnosticsUnavailable() ||
            !payload ||
            typeof payload !== "object"
          )
            return;
          respondDiagnosticCapability(payload);
        } catch {
          /* Untrusted callbacks cannot escape into EventBus's stderr handler. */
        }
      });
    if (subagentExtensions)
      childEvents.on(
        DIAGNOSTIC_CHANNEL,
        diagnosticSink((diagnostic) => {
          if (diagnosticsUnavailable()) return;
          options.onEvent({ kind: "diagnostic", diagnostic });
          try {
            getRootContext().ui.notify(diagnosticText(options.path, diagnostic), diagnostic.level);
          } catch {
            // Agent-facing delivery remains available if the UI is absent/unavailable.
          }
        }),
      );
    const loader = new DefaultResourceLoader({
      eventBus: childEvents,
      cwd: ctx.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: extensionPaths,
      // Put bridges AFTER file extensions in the runner registry. First registration
      // wins there, including tools registered by file extensions on session_start
      // or later. SDK customTools would always override those child-local tools.
      extensionsOverride: subagentExtensions
        ? (base) => {
            const sourceInfo = createSyntheticSourceInfo("<subagent-inherited-tools>", {
              source: "sdk",
            });
            base.extensions.push({
              path: "<subagent-inherited-tools>",
              resolvedPath: "<subagent-inherited-tools>",
              sourceInfo,
              handlers: new Map(),
              tools: new Map(
                externalTools
                  .filter(
                    (tool) =>
                      allowed.has(tool.name) &&
                      tool.name !== "codemode" &&
                      tool.name !== "tool_search",
                  )
                  .map((definition) => [definition.name, { definition, sourceInfo }]),
              ),
              messageRenderers: new Map(),
              commands: new Map(),
              flags: new Map(),
              shortcuts: new Map(),
            });
            return base;
          }
        : undefined,
      // Discovery off; `additionalSkillPaths` still applies, so the two compose
      // into an exact per-spec skill allowlist.
      noSkills: true,
      additionalSkillPaths: [...(options.type.skills ?? [])],
      noPromptTemplates: true,
      noContextFiles: true,
      noThemes: true,
      systemPrompt: [
        options.type.systemPrompt,
        `Your thread path is ${options.path}.`,
        options.parentPath
          ? `Your lexical parent is ${options.parentPath}; inherited conversation comes only from that parent.`
          : "You are an independent root thread with no inherited history.",
        "When finished, give your final answer normally so it can be handed back. To retain unfinished work without a final answer, call agent_pause (if available), then stop; resume only when instructed.",
        ...(spawnToolNames().some((name) => allowed.has(name)) && allowed.has("agent_wait")
          ? [
              "Name child paths with concise task-based kebab-case slugs (e.g. /root/controller-security-research), independent of type.",
              "For independent parallel work, launch all siblings with a spawn tool and wait:false before calling agent_wait. Children share the main conversation's depth and concurrency limits; waiting parents count as active. Do not delegate work beyond your assigned scope.",
            ]
          : []),
      ].join("\n\n"),
      appendSystemPromptOverride: () => [],
      extensionFactories: [
        // These orchestrators must see the CHILD loadout. Forwarding root codemode would
        // let scripts discover/call tools outside the child's allow/block policy.
        ...(allowed.has("codemode")
          ? [
              subagentExtensions
                ? { name: "child-codemode", factory: createCodemodeExtension(), replaceable: true }
                : createCodemodeExtension(),
            ]
          : []),
        ...(allowed.has("tool_search")
          ? [
              subagentExtensions
                ? {
                    name: "child-tool-search",
                    factory: createToolSearchExtension(),
                    replaceable: true,
                  }
                : createToolSearchExtension(),
            ]
          : []),
        (pi) => {
          pi.on("turn_end", pauseBoundary);
          pi.on("agent_before_settle", pauseBoundary);
          pi.on("tool_call", (event) =>
            allowed.has(event.toolName)
              ? undefined
              : { block: true, reason: "Tool is not in this agent's allowlist" },
          );
        },
      ],
    });
    options.signal.throwIfAborted();
    try {
      await loader.reload();
    } catch (error) {
      diagnosticsClosed = true;
      childEvents.clear();
      throw error;
    }
    const loadedExtensions = loader.getExtensions();
    // Manager controls remain SDK custom tools so loaded extensions cannot replace
    // them. With reload disabled, preserve the existing SDK bridge behavior exactly.
    const customTools = [...options.tools, ...(subagentExtensions ? [] : externalTools)].filter(
      (tool) => allowed.has(tool.name) && tool.name !== "codemode" && tool.name !== "tool_search",
    );
    let session: Awaited<ReturnType<typeof createAgentSession>>["session"];
    try {
      ({ session } = await createAgentSession({
        cwd: ctx.cwd,
        agentDir,
        modelRuntime: runtime,
        model,
        thinkingLevel,
        scopedModels: [...initialScopedModels],
        settingsManager,
        resourceLoader: loader,
        sessionManager,
        // SDK `tools` is both a registry allowlist and an initial active list.
        // Register every permitted deferred tool, then narrow declarations after bind.
        tools: toolNames,
        customTools,
      }));
    } catch (error) {
      if (subagentExtensions) {
        // No session was returned, so normal disposal is unavailable. Give loaded
        // factories a shutdown-only runner with child-local metadata/persistence;
        // unavailable session actions remain throwing stubs, not root bridges.
        await (async () => {
          const runner = new ExtensionRunner(
            loadedExtensions.extensions,
            loadedExtensions.runtime,
            ctx.cwd,
            sessionManager,
            new ModelRegistry(runtime),
          );
          try {
            runner.bindCore(
              {
                ...createExtensionRuntime(),
                appendEntry: (customType, data) =>
                  sessionManager.appendCustomEntry(customType, data),
                getSessionName: () => sessionManager.getSessionName(),
                getSettings: () => settingsManager.getSettings(),
                getThinkingLevel: () => clampThinkingLevel(model, thinkingLevel),
              },
              {
                getModel: () => model,
                getScopedModels: () => initialScopedModels,
                isIdle: () => true,
                isProjectTrusted: () => projectTrusted,
                getSignal: () => undefined,
                abort: () => {},
                hasPendingMessages: () => false,
                shutdown: () => {},
                getContextUsage: () => undefined,
                compact: () => {},
                getSystemPrompt: () => loader.getSystemPrompt() ?? "",
              },
            );
            await runner.emit({ type: "session_shutdown", reason: "quit" });
          } finally {
            runner.invalidate();
          }
        })().catch(() => {
          // Best-effort cleanup must not hide the SDK's original startup failure.
        });
      }
      diagnosticsClosed = true;
      childEvents.clear();
      throw error;
    }
    const unsubscribeExtensionErrors = subagentExtensions
      ? session.extensionRunner.onError((error) =>
          options.onEvent({
            kind: "error",
            text: `Extension ${error.extensionPath} (${error.event}): ${error.error}`.slice(
              0,
              1000,
            ),
          }),
        )
      : () => {};
    let shutdownPromise: Promise<void> | undefined;
    const disposeSession = () => {
      if (!subagentExtensions) {
        diagnosticsClosed = true;
        childEvents.clear();
        session.dispose();
        return;
      }
      // SDK dispose invalidates contexts but does not emit session_shutdown. Await
      // handlers before invalidation so session-scoped resources can be released.
      return (shutdownPromise ??= (async () => {
        try {
          await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
        } finally {
          unsubscribeExtensionErrors();
          diagnosticsClosed = true;
          childEvents.clear();
          session.dispose();
        }
      })());
    };
    let lastScopedModelsKey = "";
    /**
     * Report the model the child actually runs on. The pin decides the model, so
     * a child never silently drifts to another provider; only /scoped-models is
     * mirrored live so the child's own model cycling matches the root session.
     */
    const updateResolved = () => {
      const currentModel = session.model;
      if (!currentModel) throw new Error(`Subagent ${options.path} has no selected model`);
      options.onEvent({
        kind: "settings",
        model: modelIdentity(currentModel),
        thinkingLevel: session.thinkingLevel,
      });
    };
    /** One identity for the whole driver: the modes.json pin, never the parent or a restored session. */
    const pinnedIdentity = `${provider}/${id}`;
    const assertPinnedModel = (identity: string) => {
      if (identity === pinnedIdentity) return;
      throw new Error(
        `Agent ${JSON.stringify(options.path)} runs on ${identity} but modes.json pins ${JSON.stringify(options.type.role)} to ${pinnedIdentity}; resume the agent after changing the mode`,
      );
    };
    const enforceModelPin = async () => {
      const liveScopedModels = normalizeScopedModels(getRootContext().scopedModels);
      const key = scopedModelsKey(liveScopedModels);
      if (key !== lastScopedModelsKey) {
        session.setScopedModels([...liveScopedModels]);
        lastScopedModelsKey = key;
      }
      const currentModel = session.model;
      if (!currentModel || modelIdentity(currentModel) !== pinnedIdentity)
        await session.setModel(await resolveRuntimeModel(provider, id, liveScopedModels));
      updateResolved();
    };
    try {
      // Factories have already run: abort/load failures must use the same awaited
      // shutdown lifecycle as failures during extension binding, without emitting
      // session_start or starting a model turn.
      options.signal.throwIfAborted();
      if (subagentExtensions && loadedExtensions.errors.length) {
        throw new Error(
          `Subagent extension loading failed: ${loadedExtensions.errors
            .map(({ path, error }) => `${path}: ${error}`)
            .join("; ")}`,
        );
      }
      await enforceModelPin();
      options.signal.throwIfAborted();
      await session.bindExtensions({ mode: "print" });
      session.setActiveToolsByName(activeToolNames);
      options.signal.throwIfAborted();
    } catch (error) {
      await disposeSession();
      throw error;
    }
    diagnosticsInitialized = true;
    const streamFunction = session.agent.streamFunction;
    // A model switch the SDK performs internally must not silently escape the pin.
    session.agent.streamFunction = async (requestModel, context, streamOptions) => {
      assertPinnedModel(modelIdentity(requestModel));
      return streamFunction(requestModel, context, streamOptions);
    };
    const mailbox = new DurableMailbox(sessionManager);
    const emitCheckpoint = () =>
      options.onEvent({
        kind: "checkpoint",
        text: "",
        sessionFile: session.sessionFile,
        sessionLeafId: sessionManager.getLeafId(),
      });
    const restoreAppends = mailbox.wrapAppends(emitCheckpoint);
    const ensurePersistedSession = () => {
      if (session.sessionFile && existsSync(session.sessionFile)) return;
      sessionManager.appendMessage(buildBootstrapMessage());
      emit("activity", BOOTSTRAP_MESSAGE);
    };
    const queueAccepted = async (kind: "steer" | "followUp", content: string) => {
      const currentModel = session.model;
      if (!currentModel) throw new Error(`Subagent ${options.path} has no selected model`);
      assertPinnedModel(modelIdentity(currentModel));
      ensurePersistedSession();
      const accepted = mailbox.accept(kind, content);
      emitCheckpoint();
      if (kind === "followUp") session.agent.followUp(buildQueuedUserMessage(accepted));
      else session.agent.steer(buildQueuedUserMessage(accepted));
      mailbox.markEnqueued(accepted.id);
    };
    const resumePending = async () => {
      for (const accepted of mailbox.replayablePending()) {
        if (accepted.kind === "update") {
          await session.sendCustomMessage(
            {
              customType: "subagent-update",
              content: accepted.content,
              display: true,
              details: buildUpdateDetails(accepted),
            },
            { triggerTurn: false },
          );
          mailbox.markEnqueued(accepted.id);
          continue;
        }
        if (accepted.kind === "followUp") session.agent.followUp(buildQueuedUserMessage(accepted));
        else session.agent.steer(buildQueuedUserMessage(accepted));
        mailbox.markEnqueued(accepted.id);
      }
    };
    const clearPromptQueues = () => {
      session.clearQueue();
      mailbox.clearQueuedInputs();
    };
    // In 0.99.2 a boundary's continue:false only declines EXTRA continuation;
    // the public core hook is needed to stop automatic tool/steering continuation.
    parkQueue = clearPromptQueues;
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => {
      const decision = await finishTurn?.(turn, signal);
      if (options.shouldPause()) {
        clearPromptQueues();
        return { action: "end" };
      }
      return decision || undefined;
    };
    updateResolved();
    let disposed = false;
    let running = false;
    let aborted = false;
    let baseline = session.messages.length;
    // Subscribe after inherited/restored history is loaded; only new assistant events are counted.
    let settledInput = 0;
    let settledOutput = 0;
    let settledCost: number | undefined;
    const countedUsage = new WeakSet<object>();
    let finalOutput = "";
    let abortPromise: Promise<void> | undefined;
    const emit = (kind: "activity" | "error", text: string, detail?: string) =>
      options.onEvent({ kind, text: text.slice(0, 1000), ...(detail ? { detail } : {}) });
    const assistantUsage = (message: AssistantMessage) => {
      const usage = message.usage;
      const input = usage.input + usage.cacheRead + usage.cacheWrite;
      const output = usage.output;
      if (!Number.isFinite(input) || !Number.isFinite(output)) return;
      const total = usage.cost?.total;
      const costUsd = Number.isFinite(total) && total >= 0 ? total : undefined;
      return {
        input,
        output,
        costUsd,
        reported: input + output + usage.totalTokens > 0 || (costUsd ?? 0) > 0,
      };
    };

    const ownership = sessionManager
      .getBranch()
      .find((entry) => entry.type === "custom" && entry.customType === THREAD_OWNERSHIP_TYPE);
    const inheritedMetadata =
      ownership?.type === "custom"
        ? (ownership.data as { inheritedCount?: unknown })?.inheritedCount
        : undefined;
    const inheritedCount =
      typeof inheritedMetadata === "number" &&
      Number.isInteger(inheritedMetadata) &&
      inheritedMetadata >= 0
        ? inheritedMetadata
        : options.inherited.length;
    const transcript = new TranscriptChannel(
      () => session.messages,
      // A restored compaction has replaced the original inherited prefix.
      session.messages.some((message) => message.role === "compactionSummary") ? 0 : inheritedCount,
    );
    const unsubscribe = session.subscribe((event) => {
      transcript.accept(event);
      if (event.type === "tool_execution_start")
        emit("activity", `Tool: ${event.toolName}`, toolArgumentSnippet(event.args));
      if (event.type === "tool_execution_end")
        emit(
          event.isError ? "error" : "activity",
          `Tool ${event.toolName}: ${event.isError ? "failed" : "finished"}`,
        );
      if (
        (event.type === "message_update" || event.type === "message_end") &&
        event.message.role === "assistant" &&
        !countedUsage.has(event.message)
      ) {
        const usage = assistantUsage(event.message);
        if (event.type === "message_update") {
          if (usage?.reported)
            options.onEvent({
              kind: "usage",
              inputTokens: settledInput + usage.input,
              outputTokens: settledOutput + usage.output,
              costUsd:
                usage.costUsd === undefined ? settledCost : (settledCost ?? 0) + usage.costUsd,
              partial: true,
            });
        } else {
          countedUsage.add(event.message);
          if (usage) {
            settledInput += usage.input;
            settledOutput += usage.output;
            if (usage.costUsd !== undefined) settledCost = (settledCost ?? 0) + usage.costUsd;
          }
          options.onEvent({
            kind: "usage",
            inputTokens: settledInput,
            outputTokens: settledOutput,
            costUsd: settledCost,
          });
          const text = event.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("");
          if (text) emit("activity", text);
        }
      }
    });
    const assertOpen = () => {
      if (disposed) throw new Error("Subagent driver is disposed");
    };
    return {
      get sessionFile() {
        const file = session.sessionFile;
        return file && existsSync(file) ? file : undefined;
      },
      get sessionLeafId() {
        return sessionManager.getLeafId();
      },
      async prompt(message) {
        assertOpen();
        if (running) throw new Error("Subagent is already running; use steer instead");
        running = true;
        aborted = false;
        baseline = session.messages.length;
        finalOutput = "";
        try {
          await enforceModelPin();
          await resumePending();
          await session.prompt(message, { expandPromptTemplates: false });
          await session.waitForIdle();
          const last = session.messages
            .slice(baseline)
            .filter((msg) => msg.role === "assistant")
            .at(-1);
          if (aborted || last?.stopReason === "aborted") throw new Error("Subagent run aborted");
          if (last?.stopReason === "error")
            throw new Error(last.errorMessage || "Subagent model failed");
          if (last && !options.shouldPause())
            finalOutput = last.content
              .filter((block) => block.type === "text")
              .map((block) => block.text)
              .join("");
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        } finally {
          updateResolved();
          running = false;
        }
      },
      async steer(message) {
        assertOpen();
        await queueAccepted("steer", message);
      },
      snapshot() {
        return structuredClone(session.messages);
      },
      observeTranscript(listener) {
        assertOpen();
        return transcript.observe(listener);
      },
      output() {
        return finalOutput;
      },
      async abort() {
        if (disposed) return;
        if (running) aborted = true;
        clearPromptQueues();
        if (!abortPromise)
          abortPromise = session.abort().finally(() => {
            abortPromise = undefined;
          });
        await abortPromise;
      },
      dispose() {
        if (disposed) return shutdownPromise;
        disposed = true;
        aborted = true;
        restoreAppends();
        transcript.dispose();
        unsubscribe();
        return disposeSession();
      },
      async sendUpdate(content) {
        assertOpen();
        try {
          ensurePersistedSession();
          const accepted = mailbox.accept("update", content);
          emitCheckpoint();
          // SDK session method is sendCustomMessage (ExtensionAPI calls it sendMessage).
          await session.sendCustomMessage(
            {
              customType: "subagent-update",
              content,
              display: true,
              details: buildUpdateDetails(accepted),
            },
            { triggerTurn: false },
          );
          mailbox.markEnqueued(accepted.id);
          transcript.reconcile();
        } catch (error) {
          emit("error", error instanceof Error ? error.message : String(error));
          throw error;
        }
      },
    };
  };
  return createDriver;
}
