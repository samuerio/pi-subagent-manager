import fuzzysort, { type SnapshotKeys } from "fuzzysort";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  type ExtensionCommandContext,
  type ScopedModel,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  getKeybindings,
  Input,
  Key,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import { modelIdentity } from "../prefs/models.ts";
import { dialogHeight, frameDialog, DIALOG_OPTIONS } from "./dialog.ts";

type AvailableModel = Pick<Model<Api>, "provider" | "id" | "name">;

function sanitizeModelText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

function renderModelIdentity(identity: string): string {
  return sanitizeModelText(identity);
}

function modelSearchText(text: string): string {
  // Providers spell the same version differently (sonnet-5.5 vs sonnet-5-5).
  // Strip separators rather than splitting them into repeated numeric terms;
  // raw identities and labels remain untouched.
  return sanitizeModelText(text).replace(/[._:/-]+/g, "");
}

function sortModels(models: readonly AvailableModel[]): AvailableModel[] {
  const unique = new Map<string, AvailableModel>();
  for (const model of models) unique.set(modelIdentity(model), model);
  return [...unique.values()].sort(
    (a, b) =>
      a.provider.localeCompare(b.provider) ||
      a.id.localeCompare(b.id) ||
      sanitizeModelText(a.name).localeCompare(sanitizeModelText(b.name)),
  );
}

export const HOUSEKEEPING_PICKER_CANCEL = Symbol("housekeeping-picker-cancel");

interface HousekeepingRow {
  /** `provider/model-id`; empty string clears the selection. */
  value: string;
  label: string;
  description: string;
  group: string;
}

const HOUSEKEEPING_TITLE = "[lab] Housekeeping model";
const CLEAR_GROUP = "Selection";
const SCOPED_GROUP = "Scoped models";
const OTHER_GROUP = "Other available models";

/**
 * Single-select picker over available models, scoped models listed first.
 * Typing searches; Enter selects; Esc cancels. "No model" clears the selection.
 */
export class HousekeepingModelPickerComponent extends Container {
  private readonly tui: { requestRender(force?: boolean): void; terminal?: { rows: number } };
  private readonly theme: Theme;
  private readonly allModels: readonly AvailableModel[];
  private readonly modelSearch: SnapshotKeys<AvailableModel>;
  private readonly scopedIdentities: ReadonlySet<string>;
  private readonly current: string;
  private readonly onDone: (identity: string) => void;
  private readonly onCancel: () => void;
  private readonly searchInput = new Input({ placeholder: "Search models" });
  private rows: HousekeepingRow[] = [];
  private selected = 0;
  private _focused = false;

  constructor(options: {
    tui: { requestRender(force?: boolean): void; terminal?: { rows: number } };
    theme: Theme;
    availableModels: readonly AvailableModel[];
    scopedModels: readonly ScopedModel[];
    current?: string;
    onDone(identity: string): void;
    onCancel(): void;
  }) {
    super();
    this.tui = options.tui;
    this.theme = options.theme;
    this.allModels = sortModels(options.availableModels);
    this.modelSearch = fuzzysort.snapshot(this.allModels, {
      keys: [
        (model) => modelSearchText(modelIdentity(model)),
        (model) => modelSearchText(model.name),
      ],
    });
    this.scopedIdentities = new Set(options.scopedModels.map((entry) => modelIdentity(entry.model)));
    this.current = options.current ?? "";
    this.onDone = options.onDone;
    this.onCancel = options.onCancel;
    this.refresh();
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.searchInput.focused = value;
  }

  getRows(): readonly HousekeepingRow[] {
    return this.rows;
  }

  getSelectedValue(): string | undefined {
    return this.rows[this.selected]?.value;
  }

  render(width: number): string[] {
    const height = dialogHeight(this.tui);
    const inner = Math.max(1, width - 4);
    const hint = this.scopedIdentities.size
      ? "Scoped models first, then every other available model. Type to search."
      : "No scoped models in this session; all available models are listed. Type to search.";
    const header = [truncateToWidth(this.theme.fg("muted", hint), inner, ""), ...this.searchInput.render(inner)];
    const budget = Math.max(1, height - 4 - header.length);
    const display: (HousekeepingRow | string)[] = [];
    let previous: string | undefined;
    for (const row of this.rows) {
      if (row.group !== previous) display.push(row.group);
      previous = row.group;
      display.push(row);
    }
    const selectedRow = this.rows[this.selected];
    const index = Math.max(0, display.findIndex((row) => row === selectedRow));
    const start = Math.max(0, Math.min(index - budget + 1, display.length - budget));
    const lines = display.slice(start, start + budget).map((row) => {
      if (typeof row === "string") return this.theme.fg("muted", row);
      const text = `${row === selectedRow ? "›" : " "} ${row.label}  ${this.theme.fg("muted", row.description)}`;
      return row === selectedRow ? this.theme.fg("accent", text) : text;
    });
    return frameDialog(
      this.theme,
      width,
      height,
      this.theme.fg("accent", HOUSEKEEPING_TITLE),
      [...header, ...lines].map((line) => ` ${line}`),
      this.theme.fg("dim", "↑↓ select · Enter choose · Esc cancel"),
    );
  }

  handleInput(keyData: string): void {
    const kb = getKeybindings();
    if (kb.matches(keyData, "tui.select.cancel")) return this.onCancel();
    if (kb.matches(keyData, "tui.select.confirm")) {
      const row = this.rows[this.selected];
      if (row) this.onDone(row.value);
      return;
    }
    if (kb.matches(keyData, "tui.select.up")) this.selected = Math.max(0, this.selected - 1);
    else if (kb.matches(keyData, "tui.select.down"))
      this.selected = Math.min(this.rows.length - 1, this.selected + 1);
    else if (matchesKey(keyData, Key.pageUp)) this.selected = Math.max(0, this.selected - 10);
    else if (matchesKey(keyData, Key.pageDown))
      this.selected = Math.min(this.rows.length - 1, this.selected + 10);
    else {
      const before = this.searchInput.getValue();
      this.searchInput.handleInput(keyData);
      if (this.searchInput.getValue() !== before) this.refresh(true);
    }
    this.tui.requestRender();
  }

  private refresh(resetSelection = false): void {
    const query = modelSearchText(this.searchInput.getValue()).trim();
    let matches: AvailableModel[] = [...this.allModels];
    if (query) {
      const scores = new Map<string, number>();
      for (const result of fuzzysort.go(query, this.modelSearch, { limit: 0, threshold: 0 }))
        scores.set(modelIdentity(result.obj), result.score);
      matches = matches
        .filter((model) => scores.has(modelIdentity(model)))
        .sort((a, b) => scores.get(modelIdentity(b))! - scores.get(modelIdentity(a))!);
    }
    const describe = (model: AvailableModel) =>
      [sanitizeModelText(model.name), modelIdentity(model) === this.current ? "current" : ""]
        .filter(Boolean)
        .join(" · ");
    const row = (model: AvailableModel, group: string): HousekeepingRow => ({
      value: modelIdentity(model),
      label: renderModelIdentity(modelIdentity(model)),
      description: describe(model),
      group,
    });
    const known = this.allModels.some((model) => modelIdentity(model) === this.current);
    const rows: HousekeepingRow[] = [
      {
        value: "",
        label: "No model",
        description: "Leave housekeeping without a model (summaries stay inactive)",
        group: CLEAR_GROUP,
      },
      ...(this.current && !known
        ? [
            {
              value: this.current,
              label: renderModelIdentity(this.current),
              description: "current · unavailable in current model registry",
              group: CLEAR_GROUP,
            },
          ]
        : []),
      ...matches.filter((m) => this.scopedIdentities.has(modelIdentity(m))).map((m) => row(m, SCOPED_GROUP)),
      ...matches.filter((m) => !this.scopedIdentities.has(modelIdentity(m))).map((m) => row(m, OTHER_GROUP)),
    ];
    const previous = this.rows[this.selected]?.value;
    this.rows = rows;
    if (resetSelection) {
      // Land on the best matching available model, never the clear row or an unavailable saved one.
      const first = query ? rows.findIndex((r) => r.group !== CLEAR_GROUP) : -1;
      this.selected = Math.max(0, first);
    } else {
      const kept = rows.findIndex((r) => r.value === previous);
      const initial = rows.findIndex((r) => r.value === this.current && this.current !== "");
      this.selected = kept >= 0 ? kept : Math.max(0, initial);
    }
  }
}

export async function pickHousekeepingModel(
  ctx: ExtensionCommandContext,
  current: string,
): Promise<string | typeof HOUSEKEEPING_PICKER_CANCEL> {
  if (ctx.mode !== "tui") {
    if (ctx.hasUI)
      ctx.ui.notify("The housekeeping model picker requires interactive TUI mode.", "warning");
    return HOUSEKEEPING_PICKER_CANCEL;
  }
  const availableModels = ctx.modelRegistry.getAvailable().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name,
  }));
  return ctx.ui.custom<string | typeof HOUSEKEEPING_PICKER_CANCEL>(
    (tui, theme, _keys, done) =>
      new HousekeepingModelPickerComponent({
        tui,
        theme,
        availableModels,
        scopedModels: ctx.scopedModels,
        current,
        onDone: (identity) => done(identity),
        onCancel: () => done(HOUSEKEEPING_PICKER_CANCEL),
      }),
    DIALOG_OPTIONS,
  );
}
