import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "../types.ts";
import { ModesController } from "./runtime.ts";
import {
  CUSTOM_MODE_NAME,
  describeRoles,
  isDefaultModeName,
  orderedModeNames,
  THINKING_LEVELS_ALL,
  type ModeRoles,
  type ModeSpec,
} from "./schema.ts";

/** Mode selection and configuration dialogs, ported from the dotfiles editor. */

const MODE_UI_CONFIGURE = "Configure modes…";
const MODE_UI_ADD = "Add mode…";
const MODE_UI_BACK = "Back";
const THINKING_UNSET_LABEL = "(don't change)";

function normalizeModeNameInput(name: string | undefined): string {
  return (name ?? "").trim();
}

function isReservedModeName(name: string): boolean {
  return (
    name === CUSTOM_MODE_NAME ||
    // /mode store [name] is the store subcommand; a mode named "store" could
    // never be applied by name.
    name === "store" ||
    name === MODE_UI_CONFIGURE ||
    name === MODE_UI_ADD ||
    name === MODE_UI_BACK
  );
}

function validateModeNameOrError(
  name: string,
  existing: Record<string, ModeSpec>,
  opts?: { allowExisting?: boolean },
): string | null {
  if (!name) return "Mode name cannot be empty";
  if (/\s/.test(name)) return "Mode name cannot contain whitespace";
  if (isReservedModeName(name)) return `Mode name "${name}" is reserved`;
  if (!opts?.allowExisting && existing[name])
    return `Mode "${name}" already exists`;
  return null;
}

function roleFromAction(action: string): keyof ModeRoles {
  return action === "Change main"
    ? "main"
    : action === "Change oracle"
      ? "oracle"
      : "subagents";
}

// ModelSelectorComponent expects ModelRuntime but ctx exposes ModelRegistry.
// This adapter bridges the two so we don't need internal runtime access.
function createModelRuntimeFromRegistry(
  registry: ExtensionContext["modelRegistry"],
): {
  getAvailableSnapshot(): readonly any[];
  getModel(provider: string, modelId: string): any | undefined;
  refresh(options?: {
    signal?: AbortSignal;
  }): Promise<{ aborted: boolean; errors: Map<string, string> }>;
  getError(): string | undefined;
} {
  return {
    getAvailableSnapshot: () => registry.getAvailable(),
    getModel: (provider, modelId) => registry.find(provider, modelId),
    refresh: async (options) => {
      const result = await registry.refresh(options as any);
      if (result && typeof (result as any).errors !== "undefined")
        return result as any;
      return { aborted: false, errors: new Map() };
    },
    getError: () => registry.getError(),
  };
}

async function pickModelForModeUI(
  ctx: ExtensionContext,
  spec: ModeSpec,
): Promise<{ provider: string; modelId: string } | undefined> {
  if (!ctx.hasUI) return undefined;
  const main = spec.roles?.main;
  const currentModel = main
    ? ctx.modelRegistry.find(main.provider, main.modelId)
    : ctx.model;
  const scopedModels: Array<{ model: any; thinkingLevel: string }> = [];
  return ctx.ui.custom<{ provider: string; modelId: string } | undefined>(
    (tui, _theme, _keybindings, done) => {
      const selector = new ModelSelectorComponent(
        tui,
        currentModel,
        createModelRuntimeFromRegistry(ctx.modelRegistry) as any,
        scopedModels as any,
        (model: any) => done({ provider: model.provider, modelId: model.id }),
        () => done(undefined),
      );
      return selector;
    },
  );
}

async function pickThinkingLevelForModeUI(
  ctx: ExtensionContext,
  current: ThinkingLevel | undefined,
): Promise<ThinkingLevel | null | undefined> {
  if (!ctx.hasUI) return undefined;
  const defaultValue = current ?? "off";
  const options = [
    ...THINKING_LEVELS_ALL,
    THINKING_UNSET_LABEL as ThinkingLevel,
  ];
  // Prefer the current selection by ordering it first.
  const ordered = [
    defaultValue,
    ...options.filter((option) => option !== defaultValue),
  ];
  const choice = await ctx.ui.select("Thinking level", ordered);
  if (!choice) return undefined;
  if (choice === THINKING_UNSET_LABEL) return null;
  if (THINKING_LEVELS_ALL.includes(choice as ThinkingLevel))
    return choice as ThinkingLevel;
  return undefined;
}

async function handleModeChoiceUI(
  modes: ModesController,
  ctx: ExtensionContext,
  choice: string,
): Promise<void> {
  // In the "custom" overlay, selecting another mode offers use vs store.
  if (
    modes.currentModeName === CUSTOM_MODE_NAME &&
    choice !== CUSTOM_MODE_NAME
  ) {
    if (!ctx.hasUI) return;
    const action = await ctx.ui.select(`Mode "${choice}"`, ["use", "store"]);
    if (!action) return;
    if (action === "use") {
      await modes.applyMode(ctx, choice);
      return;
    }
    // Overwrite the target with the overlay selection (keep target color if set).
    await modes.ensureRuntime(ctx);
    const overlay = modes.customOverlay ?? modes.getCurrentSelectionSpec();
    const persisted = await modes.storeSelectionIntoMode(ctx, choice, overlay);
    if (!persisted)
      ctx.ui.notify(
        `Stored into "${choice}" in memory only; modes.json was not saved.`,
        "warning",
      );
    await modes.applyMode(ctx, choice);
    if (persisted)
      ctx.ui.notify(`Stored ${CUSTOM_MODE_NAME} into "${choice}"`, "info");
    return;
  }
  await modes.applyMode(ctx, choice);
}

async function selectModeUI(
  modes: ModesController,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;
  while (true) {
    await modes.ensureRuntime(ctx);
    const names = orderedModeNames(modes.data.modes);
    const choice = await ctx.ui.select(
      `Mode (current: ${modes.currentModeName})`,
      [...names, MODE_UI_CONFIGURE],
    );
    if (!choice) return;
    if (choice === MODE_UI_CONFIGURE) {
      await configureModesUI(modes, ctx);
      continue;
    }
    await handleModeChoiceUI(modes, ctx, choice);
    return;
  }
}

async function configureModesUI(
  modes: ModesController,
  ctx: ExtensionContext,
): Promise<void> {
  if (!ctx.hasUI) return;
  while (true) {
    await modes.ensureRuntime(ctx);
    const names = orderedModeNames(modes.data.modes);
    const choice = await ctx.ui.select("Configure modes", [
      ...names,
      MODE_UI_ADD,
      MODE_UI_BACK,
    ]);
    if (!choice || choice === MODE_UI_BACK) return;
    if (choice === MODE_UI_ADD) {
      const created = await addModeUI(modes, ctx);
      if (created) await editModeUI(modes, ctx, created);
      continue;
    }
    await editModeUI(modes, ctx, choice);
  }
}

async function addModeUI(
  modes: ModesController,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  await modes.ensureRuntime(ctx);
  while (true) {
    const raw = await ctx.ui.input(
      "New mode name",
      "e.g. docs, review, planning",
    );
    if (raw === undefined) return undefined;
    const name = normalizeModeNameInput(raw);
    const error = validateModeNameOrError(name, modes.data.modes);
    if (error) {
      ctx.ui.notify(error, "warning");
      continue;
    }
    // Default new modes to the current selection so they behave as expected
    // immediately. Inherit the current mode's full roles (oracle/subagents
    // pins) so a fresh mode does not break subagent dispatch (fail fast).
    const selection = modes.customOverlay ?? modes.getCurrentSelectionSpec();
    const baseModeName =
      modes.currentModeName === CUSTOM_MODE_NAME
        ? modes.lastRealMode
        : modes.currentModeName;
    const inheritedRoles = JSON.parse(
      JSON.stringify(modes.data.modes[baseModeName]?.roles ?? {}),
    ) as ModeRoles;
    modes.data.modes[name] = {
      roles: {
        ...inheritedRoles,
        main: selection.roles?.main ?? inheritedRoles.main,
      },
    };
    const persisted = await modes.persistRuntime(ctx);
    ctx.ui.notify(
      persisted
        ? `Added mode "${name}"`
        : `Added "${name}" in memory only; modes.json was not saved.`,
      persisted ? "info" : "warning",
    );
    return name;
  }
}

async function editRoleUI(
  modes: ModesController,
  ctx: ExtensionContext,
  modeName: string,
  role: keyof ModeRoles,
): Promise<void> {
  if (!ctx.hasUI) return;
  await modes.ensureRuntime(ctx);
  // Seed the picker from the role's current pin; fall back to the live
  // selection so a fresh role starts from something sensible.
  const seed =
    modes.data.modes[modeName]?.roles?.[role] ??
    modes.data.modes[modeName]?.roles?.main;
  // pickModelForModeUI reads roles.main; the role pin must ride in as main
  // or the picker opens on the session model instead of the role's pin.
  const selected = await pickModelForModeUI(ctx, {
    roles: { main: seed },
  });
  if (!selected) return;
  const level = await pickThinkingLevelForModeUI(ctx, seed?.thinkingLevel);
  // Re-read after the dialogs: a concurrent persist may have replaced the
  // data object; writing back a captured spec would resurrect stale state.
  const spec = modes.data.modes[modeName];
  if (!spec) return;
  // Esc / "(don't change)" cancel only the level step: the model the user
  // just picked is kept with the role's existing level; only an explicit
  // level (including "off") overwrites it.
  const currentLevel = spec.roles?.[role]?.thinkingLevel ?? seed?.thinkingLevel;
  spec.roles = {
    ...spec.roles,
    [role]: {
      provider: selected.provider,
      modelId: selected.modelId,
      // RolePin.thinkingLevel is required; fall back to the current level.
      thinkingLevel: level ?? currentLevel ?? "off",
    },
  };
  const persisted = await modes.persistRuntime(ctx);
  ctx.ui.notify(
    persisted
      ? `Updated ${role} for "${modeName}"`
      : `Updated ${role} for "${modeName}" in memory only; modes.json was not saved.`,
    persisted ? "info" : "warning",
  );
  // Only main affects the running session immediately; oracle/subagents pins
  // are read fresh from modes.json on each subagent dispatch.
  if (role === "main" && modes.currentModeName === modeName)
    await modes.applyMode(ctx, modeName);
}

function renameModesRecord(
  modes: Record<string, ModeSpec>,
  oldName: string,
  newName: string,
): Record<string, ModeSpec> {
  const out: Record<string, ModeSpec> = {};
  for (const [key, value] of Object.entries(modes)) {
    if (key === oldName) out[newName] = value;
    else out[key] = value;
  }
  return out;
}

async function renameModeUI(
  modes: ModesController,
  ctx: ExtensionContext,
  oldName: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) return undefined;
  if (isDefaultModeName(oldName)) {
    ctx.ui.notify(`Cannot rename default mode "${oldName}"`, "warning");
    return oldName;
  }
  await modes.ensureRuntime(ctx);
  while (true) {
    const raw = await ctx.ui.input(`Rename mode "${oldName}"`, oldName);
    if (raw === undefined) return undefined;
    const newName = normalizeModeNameInput(raw);
    if (!newName || newName === oldName) return oldName;
    const error = validateModeNameOrError(newName, modes.data.modes);
    if (error) {
      ctx.ui.notify(error, "warning");
      continue;
    }
    modes.data.modes = renameModesRecord(modes.data.modes, oldName, newName);
    const renamedPersistedMode = modes.data.currentMode === oldName;
    if (renamedPersistedMode) modes.data.currentMode = newName;
    const persisted = await modes.persistRuntime(ctx, renamedPersistedMode);
    if (modes.currentModeName === oldName) modes.currentModeName = newName;
    if (modes.lastRealMode === oldName) modes.lastRealMode = newName;
    modes.requestRender();
    ctx.ui.notify(
      persisted
        ? `Renamed "${oldName}" → "${newName}"`
        : `Renamed in memory only; modes.json was not saved.`,
      persisted ? "info" : "warning",
    );
    return newName;
  }
}

export async function editModeUI(
  modes: ModesController,
  ctx: ExtensionContext,
  mode: string,
): Promise<void> {
  if (!ctx.hasUI) return;
  let modeName = mode;
  while (true) {
    await modes.ensureRuntime(ctx);
    const spec = modes.data.modes[modeName];
    if (!spec) return;
    const main = spec.roles?.main;
    const modelLabel = main ? `${main.provider}/${main.modelId}` : "(no model)";
    const thinkingLabel = main?.thinkingLevel ?? THINKING_UNSET_LABEL;
    const rolesSummary = describeRoles(spec.roles);
    const actions = [
      "Change name",
      "Change main",
      "Change oracle",
      "Change subagents",
    ];
    if (!isDefaultModeName(modeName)) actions.push("Delete mode");
    actions.push(MODE_UI_BACK);
    const action = await ctx.ui.select(
      `Edit mode "${modeName}"  model: ${modelLabel}  thinking: ${thinkingLabel}` +
        (rolesSummary ? `  |  ${rolesSummary}` : ""),
      actions,
    );
    if (!action || action === MODE_UI_BACK) return;
    if (action === "Change name") {
      const renamed = await renameModeUI(modes, ctx, modeName);
      if (renamed) modeName = renamed;
      continue;
    }
    if (
      action === "Change main" ||
      action === "Change oracle" ||
      action === "Change subagents"
    ) {
      await editRoleUI(modes, ctx, modeName, roleFromAction(action));
      continue;
    }
    if (action === "Delete mode") {
      const ok = await ctx.ui.confirm(
        "Delete mode",
        `Delete mode "${modeName}"?`,
      );
      if (!ok) continue;
      let persisted: boolean;
      try {
        persisted = await removeModeRecord(modes, ctx, modeName);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Could not save modes.json: ${message}`, "error");
        continue;
      }
      if (persisted) ctx.ui.notify(`Deleted mode "${modeName}"`, "info");
      else
        ctx.ui.notify(
          `Deleted "${modeName}" in memory only; modes.json was not saved.`,
          "warning",
        );
      return;
    }
  }
}

/**
 * Remove a mode from the in-memory file and persist. When the deleted mode is
 * the persisted currentMode, repoint it first: a dangling reference would make
 * the next subagent dispatch fail fast with `modes["<deleted>"] is missing`.
 */
export async function removeModeRecord(
  modes: ModesController,
  ctx: ExtensionContext,
  modeName: string,
): Promise<boolean> {
  const wasPersistedMode = modes.data.currentMode === modeName;
  delete modes.data.modes[modeName];
  let fallback: string | undefined;
  let persisted: boolean;
  if (wasPersistedMode) {
    // "default" is a forced built-in (ensureDefaultModeEntries reseeds it);
    // otherwise fall back to the first remaining mode.
    fallback = modes.data.modes.default
      ? "default"
      : (orderedModeNames(modes.data.modes)[0] ?? "default");
    modes.data.currentMode = fallback;
    persisted = await modes.persistRuntime(ctx, true);
  } else {
    persisted = await modes.persistRuntime(ctx);
    // The session may still point at the deleted mode even when it was not
    // the persisted currentMode (inference had selected it); fall back to the
    // persisted mode instead of leaving a dangling name.
    fallback = modes.data.currentMode;
  }
  if (modes.currentModeName === modeName && fallback !== undefined) {
    // Land on an adjacent real mode instead of the custom overlay.
    modes.currentModeName = fallback;
    modes.lastRealMode = fallback;
    modes.customOverlay = null;
  }
  if (modes.lastRealMode === modeName) {
    modes.lastRealMode = modes.data.currentMode;
  }
  modes.requestRender();
  return persisted;
}

/** /mode command and the mode shortcuts. */
export function registerModesUi(
  pi: ExtensionAPI,
  modes: ModesController,
): void {
  pi.registerCommand("mode", {
    description: "Select prompt mode",
    handler: async (args, ctx) => {
      const tokens = args
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(Boolean);
      // /mode
      if (tokens.length === 0) {
        await selectModeUI(modes, ctx as ExtensionContext);
        return;
      }
      // /mode store [name]
      if (tokens[0] === "store") {
        await modes.ensureRuntime(ctx as ExtensionContext);
        let target: string | undefined = tokens[1];
        if (!target) {
          if (!ctx.hasUI) return;
          const names = orderedModeNames(modes.data.modes);
          target = await ctx.ui.select(
            "Store current selection into mode",
            names,
          );
          if (!target) return;
        }
        if (target === CUSTOM_MODE_NAME) {
          if (ctx.hasUI)
            ctx.ui.notify(`Cannot store into "${CUSTOM_MODE_NAME}"`, "warning");
          return;
        }
        const selection =
          modes.customOverlay ?? modes.getCurrentSelectionSpec();
        const persisted = await modes.storeSelectionIntoMode(
          ctx as ExtensionContext,
          target,
          selection,
        );
        if (!ctx.hasUI) return;
        ctx.ui.notify(
          persisted
            ? `Stored current selection into "${target}"`
            : `Stored into "${target}" in memory only; modes.json was not saved.`,
          persisted ? "info" : "warning",
        );
        return;
      }
      // /mode <name>
      await modes.applyMode(ctx as ExtensionContext, tokens[0]!);
    },
  });

  // Guarded: minimal embedders (tests) may not provide shortcuts.
  pi.registerShortcut?.("ctrl+shift+m", {
    description: "Select prompt mode",
    handler: async (ctx) => {
      await selectModeUI(modes, ctx);
    },
  });

  pi.registerShortcut?.("ctrl+space", {
    description: "Cycle prompt mode",
    handler: async (ctx) => {
      await modes.cycleMode(ctx, 1);
    },
  });
}
