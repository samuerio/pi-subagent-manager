import type {
  ExtensionAPI,
  ExtensionContext,
  ModelSelectEvent,
  SessionStartEvent,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../types.ts";
import {
  cloneModesFile,
  cloneRoles,
  CUSTOM_MODE_NAME,
  orderedModeNames,
  type ModeRoles,
  type ModeSpec,
  type ModesFile,
  type RolePin,
} from "./schema.ts";
import {
  computeModesPatch,
  readModesSnapshot,
  unknownModesFields,
  applyModesPatch,
  ensureDefaultModeEntries,
  getMtimeMs,
  loadModesFile,
  resolveModesPath,
  saveModesFile,
  withFileLock,
} from "./file.ts";
import { registerModesUi } from "./ui.ts";

/**
 * modes.json state machine ported from the dotfiles prompt-editor, minus the
 * editor takeover: the navigation editor owns the editor slot; this controller
 * only manages modes, exposes border/label hooks and feeds prompt history.
 */

export type SelectionSpec = { roles?: ModeRoles };

export class ModesController {
  data: ModesFile = { version: 1, currentMode: "default", modes: {} };
  /** Effective current mode; can temporarily be the "custom" overlay. */
  currentModeName = "default";
  lastRealMode = "default";
  customOverlay: ModeSpec | null = null;
  /** Set by the host to repaint the editor when the mode label changes. */
  requestRender: () => void = () => {};

  private filePath = "";
  private fileMtimeMs: number | null = null;
  private baseline: ModesFile | null = null;
  private applying = false;
  private lastObservedModel: { provider?: string; modelId?: string } = {};

  constructor(readonly pi: ExtensionAPI) {}

  private notify(
    ctx: ExtensionContext,
    message: string,
    kind: "info" | "warning" | "error" = "info",
  ): void {
    if (ctx.hasUI) ctx.ui.notify(message, kind);
  }

  /**
   * Explicit color override from the JSON, else the thinking-level border.
   * Validate the override eagerly so a bad token cannot crash during render.
   */
  getModeBorderColor(theme: Theme, mode: string): (text: string) => string {
    const spec = this.data.modes[mode];
    if (spec?.color) {
      try {
        const token = spec.color as Parameters<Theme["fg"]>[0];
        theme.getFgAnsi(token);
        return (text: string) => theme.fg(token, text);
      } catch {
        // fall through to thinking-based colors
      }
    }
    try {
      return theme.getThinkingBorderColor(this.pi.getThinkingLevel());
    } catch {
      // Incomplete theme implementations (embedders, custom themes): fall back
      // to an uncolored border instead of crashing every render.
      try {
        return theme.getThinkingBorderColor("off");
      } catch {
        return (text: string) => text;
      }
    }
  }

  async ensureRuntime(ctx: ExtensionContext): Promise<void> {
    const filePath = await resolveModesPath(ctx.cwd);
    const mtimeMs = await getMtimeMs(filePath);
    const filePathChanged = this.filePath !== filePath;
    const fileChanged = filePathChanged || this.fileMtimeMs !== mtimeMs;

    if (fileChanged) {
      this.filePath = filePath;
      this.fileMtimeMs = mtimeMs;
      const defaults = this.createDefaultModes(ctx);
      const loaded = await loadModesFile(filePath, defaults);
      // Normalize/ensure defaults before snapshotting baseline so later
      // persistence only reflects explicit user actions ("store").
      ensureDefaultModeEntries(loaded, defaults);
      this.data = loaded;
      this.baseline = cloneModesFile(this.data);
      // Reset the overlay when switching projects.
      if (filePathChanged && this.currentModeName !== CUSTOM_MODE_NAME) {
        this.currentModeName = this.data.currentMode;
        this.lastRealMode = this.currentModeName;
      }
    }

    if (this.currentModeName !== CUSTOM_MODE_NAME) {
      if (!this.currentModeName || !(this.currentModeName in this.data.modes)) {
        this.currentModeName = this.data.currentMode;
      }
      if (!this.lastRealMode || !(this.lastRealMode in this.data.modes)) {
        this.lastRealMode = this.currentModeName;
      }
    }
  }

  /**
   * Merge and save the in-memory file. Returns false when the on-disk file was
   * left untouched (refusal paths: unreadable or unparsable), so callers can
   * suppress success messages instead of lying to the operator.
   */
  async persistRuntime(
    ctx: ExtensionContext,
    includeCurrentMode = false,
  ): Promise<boolean> {
    if (!this.filePath) return false;
    // Configuration edits normally leave currentMode alone; explicit mode
    // selections include it so fresh sessions start in the last selected mode.
    this.baseline ??= cloneModesFile(this.data);
    const patch = computeModesPatch(
      this.baseline,
      this.data,
      includeCurrentMode,
    );
    if (!patch) return true;
    return withFileLock(this.filePath, async () => {
      // Never rewrite a file we cannot parse: the operator may have hand-edited
      // it; silently replacing it with defaults would destroy their config.
      // Read it raw first and bail out, leaving the file untouched.
      const snapshot = await readModesSnapshot(this.filePath);
      if (snapshot.status === "unreadable") {
        // Present but not ours to read: rewriting it from defaults would
        // destroy configuration we never saw.
        this.notify(
          ctx,
          `modes.json exists but cannot be read (${this.filePath}); refusing to overwrite it. Check the file permissions, then retry.`,
          "warning",
        );
        return false;
      }
      if (snapshot.status === "ok" && snapshot.parsed === null) {
        this.notify(
          ctx,
          `modes.json is not valid JSON; refusing to overwrite ${this.filePath}. Fix or remove the file, then retry.`,
          "warning",
        );
        return false;
      }
      if (snapshot.parsed) {
        const unknown = unknownModesFields(snapshot.parsed);
        if (unknown.length > 0) {
          this.notify(
            ctx,
            `modes.json contains unrecognized field(s): ${unknown.join(", ")}. They are not part of the schema and will be dropped on save.`,
            "warning",
          );
        }
      }
      // Merge our local patch into the latest on disk to avoid clobbering other agents.
      const latest = await loadModesFile(
        this.filePath,
        this.createDefaultModes(ctx),
      );
      applyModesPatch(latest, patch);
      ensureDefaultModeEntries(latest, this.createDefaultModes(ctx));
      await saveModesFile(this.filePath, latest);
      this.data = latest;
      this.baseline = cloneModesFile(latest);
      this.fileMtimeMs = await getMtimeMs(this.filePath);
      return true;
    });
  }

  createDefaultModes(ctx: ExtensionContext): ModesFile {
    const currentModel = ctx.model;
    const currentThinking = this.pi.getThinkingLevel();
    const main: RolePin | undefined =
      currentModel?.provider && currentModel?.id
        ? {
            provider: currentModel.provider,
            modelId: currentModel.id,
            thinkingLevel: currentThinking,
          }
        : undefined;
    return {
      version: 1,
      currentMode: "default",
      modes: {
        default: main ? { roles: { main } } : {},
        fast: main
          ? { roles: { main: { ...main, thinkingLevel: "off" as const } } }
          : {},
      },
    };
  }

  /** The live selection, used for the "custom" overlay and mode stores. */
  getCurrentSelectionSpec(): ModeSpec {
    const provider = this.lastObservedModel.provider;
    const modelId = this.lastObservedModel.modelId;
    const spec: ModeSpec = {};
    if (provider && modelId) {
      spec.roles = {
        main: { provider, modelId, thinkingLevel: this.pi.getThinkingLevel() },
      };
    }
    return spec;
  }

  /**
   * Store a selection into a mode. Returns persistRuntime's outcome: false
   * means the on-disk file was left untouched (refused) and the store only
   * lives in memory.
   */
  async storeSelectionIntoMode(
    ctx: ExtensionContext,
    mode: string,
    selection: ModeSpec,
  ): Promise<boolean> {
    // "custom" is an overlay; it is not persisted.
    if (mode === CUSTOM_MODE_NAME) return false;
    await this.ensureRuntime(ctx);
    const existingTarget = this.data.modes[mode] ?? {};
    const next: ModeSpec = {
      ...existingTarget,
      roles: cloneRoles(existingTarget.roles) ?? {},
    };
    // Only overwrite fields we can observe. Storing an overlay replaces
    // roles.main only, so oracle/subagents pins survive the store.
    if (selection.roles?.main)
      next.roles = { ...next.roles, main: selection.roles.main };
    this.data.modes[mode] = next;
    return this.persistRuntime(ctx);
  }

  async applyMode(ctx: ExtensionContext, mode: string): Promise<void> {
    await this.ensureRuntime(ctx);

    // "custom" is a runtime-only overlay mode.
    if (mode === CUSTOM_MODE_NAME) {
      this.currentModeName = CUSTOM_MODE_NAME;
      this.customOverlay = this.getCurrentSelectionSpec();
      this.requestRender();
      return;
    }

    const spec = this.data.modes[mode];
    if (!spec) {
      this.notify(ctx, `Unknown mode: ${mode}`, "warning");
      return;
    }

    this.currentModeName = mode;
    this.lastRealMode = mode;
    this.customOverlay = null;

    this.applying = true;
    let modelAppliedOk = true;
    try {
      const main = spec.roles?.main;
      if (main) {
        const m = ctx.modelRegistry.find(main.provider, main.modelId);
        if (m) {
          const ok = await this.pi.setModel(m);
          modelAppliedOk = ok;
          if (!ok)
            this.notify(
              ctx,
              `No API key available for ${main.provider}/${main.modelId}`,
              "warning",
            );
        } else {
          modelAppliedOk = false;
          this.notify(
            ctx,
            `Mode "${mode}" references unknown model ${main.provider}/${main.modelId}`,
            "warning",
          );
        }
      }
      // The main pin carries the mode's effort level.
      if (main?.thinkingLevel) this.pi.setThinkingLevel(main.thinkingLevel);
    } finally {
      this.applying = false;
    }

    // An unappliable model (e.g. missing API key) falls into the overlay.
    // Thinking-level clamping is not a failure: it is expected when switching
    // between models with different thinking capabilities.
    if (!modelAppliedOk) {
      this.currentModeName = CUSTOM_MODE_NAME;
      this.customOverlay = this.getCurrentSelectionSpec();
    } else {
      // Persist only real, successfully applied modes so a fresh session
      // starts in the last selected one.
      this.data.currentMode = mode;
      await this.persistRuntime(ctx, true);
    }
    this.requestRender();
  }

  async cycleMode(ctx: ExtensionContext, direction: 1 | -1 = 1): Promise<void> {
    if (!ctx.hasUI) return;
    await this.ensureRuntime(ctx);
    const names = orderedModeNames(this.data.modes);
    if (names.length === 0) return;
    // Cycle relative to the last real mode while in the overlay.
    const baseMode =
      this.currentModeName === CUSTOM_MODE_NAME
        ? this.lastRealMode
        : this.currentModeName;
    const index = Math.max(0, names.indexOf(baseMode));
    const next =
      names[(index + direction + names.length) % names.length] ?? names[0]!;
    await this.applyMode(ctx, next);
  }

  inferModeFromSelection(ctx: ExtensionContext): string | null {
    const provider = ctx.model?.provider;
    const modelId = ctx.model?.id;
    const thinkingLevel = this.pi.getThinkingLevel();
    if (!provider || !modelId) return null;

    // Only persisted/real modes (exclude the overlay "custom").
    const names = orderedModeNames(this.data.modes);
    const supportsThinking = Boolean(ctx.model?.reasoning);

    // Exact match so modes can differ by thinking level.
    if (supportsThinking) {
      for (const name of names) {
        const main = this.data.modes[name]?.roles?.main;
        if (!main) continue;
        if (main.provider !== provider || main.modelId !== modelId) continue;
        if ((main.thinkingLevel ?? undefined) !== thinkingLevel) continue;
        return name;
      }
      return null;
    }

    // Without thinking support the effective level is always "off"; treat
    // thinkingLevel differences as non-distinguishing.
    const candidates: string[] = [];
    for (const name of names) {
      const main = this.data.modes[name]?.roles?.main;
      if (!main) continue;
      if (main.provider !== provider || main.modelId !== modelId) continue;
      candidates.push(name);
    }
    if (candidates.length === 0) return null;
    for (const name of candidates) {
      const main = this.data.modes[name]?.roles?.main;
      if ((main?.thinkingLevel ?? "off") === thinkingLevel) return name;
    }
    for (const name of candidates) {
      if (!this.data.modes[name]?.roles?.main?.thinkingLevel) return name;
    }
    return candidates[0] ?? null;
  }

  /** Port of the prompt-editor session_start handler: load, infer or apply. */
  async onSessionStart(
    ctx: ExtensionContext,
    event: SessionStartEvent,
  ): Promise<void> {
    void event;
    this.lastObservedModel = {
      provider: ctx.model?.provider,
      modelId: ctx.model?.id,
    };
    await this.ensureRuntime(ctx);
    this.customOverlay = null;

    const branch = ctx.sessionManager.getBranch();
    const isFreshSession = branch.every(
      (entry) =>
        entry.type === "model_change" || entry.type === "thinking_level_change",
    );
    if (isFreshSession) {
      // Pi records the default model/thinking level before session_start even
      // for fresh sessions; apply the last mode instead of inferring from those.
      await this.applyMode(ctx, this.data.currentMode);
    } else {
      const inferred = this.inferModeFromSelection(ctx);
      if (inferred) {
        this.currentModeName = inferred;
        this.lastRealMode = inferred;
      } else {
        this.currentModeName = CUSTOM_MODE_NAME;
        this.customOverlay = this.getCurrentSelectionSpec();
      }
    }
    this.requestRender();
  }

  /**
   * Manual thinking-level changes behave like model changes: they leave the
   * mode's pin behind, so the selection lands in the overlay "custom" mode.
   * Without this, a later store/apply would resurrect the stale overlay level.
   */
  async onThinkingLevelSelect(
    ctx: ExtensionContext,
    event: { level: string },
  ): Promise<void> {
    if (this.applying) return;
    const activeMain = this.data.modes[this.currentModeName]?.roles?.main;
    if (
      this.currentModeName !== CUSTOM_MODE_NAME &&
      activeMain &&
      activeMain.thinkingLevel === event.level
    ) {
      return;
    }
    await this.ensureRuntime(ctx);
    if (this.currentModeName !== CUSTOM_MODE_NAME)
      this.lastRealMode = this.currentModeName;
    this.currentModeName = CUSTOM_MODE_NAME;
    this.customOverlay = {
      roles: {
        main: {
          provider: ctx.model?.provider ?? "",
          modelId: ctx.model?.id ?? "",
          thinkingLevel: event.level as ThinkingLevel,
        },
      },
    };
    this.requestRender();
  }

  /** Manual model changes always land in the overlay "custom" mode. */
  async onModelSelect(
    ctx: ExtensionContext,
    event: ModelSelectEvent,
  ): Promise<void> {
    this.lastObservedModel = {
      provider: event.model.provider,
      modelId: event.model.id,
    };
    // Skip mode switching triggered by applyMode() itself.
    if (this.applying) return;
    // Events may also arrive after applyMode's await has settled; treat a
    // selection equal to the active mode's main pin as ours, not as a manual
    // switch into the overlay.
    const activeMain = this.data.modes[this.currentModeName]?.roles?.main;
    if (
      this.currentModeName !== CUSTOM_MODE_NAME &&
      activeMain &&
      activeMain.provider === event.model.provider &&
      activeMain.modelId === event.model.id
    ) {
      return;
    }
    await this.ensureRuntime(ctx);
    if (this.currentModeName !== CUSTOM_MODE_NAME)
      this.lastRealMode = this.currentModeName;
    this.currentModeName = CUSTOM_MODE_NAME;
    this.customOverlay = {
      roles: {
        main: {
          provider: event.model.provider,
          modelId: event.model.id,
          thinkingLevel: this.pi.getThinkingLevel(),
        },
      },
    };
    this.requestRender();
  }

  /** /mode command plus its shortcuts; the dialogs live in ui.ts. */
  registerUi(pi: ExtensionAPI): void {
    registerModesUi(pi, this);
  }
}
