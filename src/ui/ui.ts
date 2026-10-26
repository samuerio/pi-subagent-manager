import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
  colorToRgb,
  rgbColor,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { AGENT_COLORS } from "../prefs/colors.ts";
import type { LoaderStyle, WidgetMode } from "../prefs/settings.ts";
import { AGENT_PROGRESS_INTERVAL, agentProgressIcon, isAgentLoaderGlyph } from "./agent-loader.ts";
export { AGENT_PROGRESS_INTERVAL, agentProgressIcon } from "./agent-loader.ts";
import { buildStatusTree, lastStarted, threadActivity, type StatusRow } from "./thread-tree.ts";
import type { ThreadService, ThreadView } from "../types.ts";

export type ThreadController = Pick<
  ThreadService,
  "list" | "get" | "output" | "transcript" | "observeTranscript" | "steer" | "stop"
>;

/** Plain terminal-safe text: never pass agent-supplied terminal commands through. */
export function sanitizeText(text: string): string {
  return stripTerminalSequences(text).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

type AgentBadgeTheme = Pick<Theme, "fg" | "colors" | "style">;

/** Selected type token, or accent when unset or unknown. Shared by the pill and path. */
function agentColorToken(color: string | undefined): ThemeColor {
  return AGENT_COLORS.includes(color as (typeof AGENT_COLORS)[number])
    ? (color as ThemeColor)
    : "accent";
}

/** Background pill with bold contrasting text and padding. Label is sanitized. */
function contrastPill(label: string, color: string | undefined, theme: AgentBadgeTheme): string {
  const background = theme.colors[agentColorToken(color)];
  const { r, g, b } = colorToRgb(background);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  // Pick whichever of black/white has the higher WCAG contrast ratio.
  const foreground = luminance > Math.sqrt(0.0525) - 0.05 ? 0 : 255;
  return theme.style(` ${sanitizeText(label)} `, {
    bg: background,
    fg: rgbColor(foreground, foreground, foreground),
    bold: true,
  });
}

/** Invalid/untrusted saved icons never reach the terminal. Names remain readable. */
export function agentTypeLabel(
  type: string,
  icon?: string,
  nerdFontIcons = false,
  loaderIcon?: string,
): string {
  const role =
    nerdFontIcons && typeof icon === "string" && /^\p{Co}$/u.test(icon) ? `${icon} ` : "";
  const progress =
    loaderIcon && isAgentLoaderGlyph(loaderIcon, nerdFontIcons) ? `${loaderIcon} ` : "";
  return `${progress}${role}${sanitizeText(type)}`;
}

export function agentTypeBadge(
  type: string,
  color: string | undefined,
  theme: AgentBadgeTheme,
  icon?: string,
  nerdFontIcons = false,
  loaderIcon?: string,
): string {
  return contrastPill(agentTypeLabel(type, icon, nerdFontIcons, loaderIcon), color, theme);
}

function agentPath(path: string, color: string | undefined, theme: AgentBadgeTheme): string {
  return theme.fg(agentColorToken(color), sanitizeText(path));
}

function metricCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Settled active time plus the current live run, only while starting or running. */
function elapsedTotal(thread: ThreadView, now = Date.now()): number {
  const live =
    typeof thread.startedAt === "number" &&
    Number.isFinite(thread.startedAt) &&
    (thread.state === "starting" || thread.state === "running")
      ? now - thread.startedAt
      : 0;
  const total = metricCount(thread.elapsedMs) + live;
  return Number.isFinite(total) ? total : 0;
}

function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600) % 24;
  const days = Math.floor(total / 86400);
  if (days > 0) return `${days}d${hours}h`;
  if (hours > 0) return `${hours}h${minutes}m`;
  if (minutes > 0) return `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

const compactCount = new Intl.NumberFormat("en", {
  notation: "compact",
  maximumFractionDigits: 1,
});

function formatCount(value: number | undefined): string {
  // Intl emits uppercase units (`1.2K`); the widget uses lowercase.
  return compactCount.format(metricCount(value)).toLowerCase();
}

export function threadMetrics(thread: ThreadView, now = Date.now()): string {
  const cost = thread.costUsd === undefined ? "" : ` $${thread.costUsd.toFixed(4)}`;
  return `${formatDuration(elapsedTotal(thread, now))} ↑${formatCount(thread.inputTokens)} ↓${formatCount(thread.outputTokens)}${cost}`;
}

/** Keep the right-hand counters intact; truncate the left side to the remaining columns. */
function fitLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  const rightWidth = visibleWidth(right);
  if (rightWidth >= width) return truncateToWidth(right, width, "");
  const fitted = truncateToWidth(left, width - rightWidth - 1);
  const pad = width - visibleWidth(fitted) - rightWidth;
  return fitted + " ".repeat(Math.max(0, pad)) + right;
}

function isLive(thread: ThreadView): boolean {
  return thread.path !== "/root" && (thread.state === "starting" || thread.state === "running");
}

export function renderThreads(
  threads: ThreadView[],
  width: number,
  theme: AgentBadgeTheme,
  nerdFontIcons = false,
  loaderStyle: LoaderStyle = "circle",
): string[] {
  const priority = (thread: ThreadView) =>
    thread.state === "starting" || thread.state === "running"
      ? 0
      : thread.state === "paused"
        ? 1
        : 2;
  const visible = threads
    .filter((thread) => thread.path !== "/root")
    .sort(
      (a, b) => priority(a) - priority(b) || b.updatedAt - a.updatedAt || b.createdAt - a.createdAt,
    );
  const limit = visible.length > 8 ? 7 : 8;
  const lines = visible.slice(0, limit).map((thread) => {
    const stateColor =
      thread.state === "failed" ? "error" : thread.state === "paused" ? "warning" : "accent";
    const badge = agentTypeBadge(
      thread.type,
      thread.color,
      theme,
      thread.icon,
      nerdFontIcons,
      agentProgressIcon(thread, nerdFontIcons, Date.now(), true, loaderStyle),
    );
    const path = agentPath(thread.path, thread.color, theme);
    const state = theme.fg(stateColor, `[${sanitizeText(thread.state)}]`);
    const left = `${badge} ${path} ${state} ${sanitizeText(threadActivity(thread))}`;
    return fitLine(left, theme.fg("muted", threadMetrics(thread)), Math.max(0, width));
  });
  if (visible.length > limit) {
    lines.push(
      truncateToWidth(
        theme.fg("muted", `+${visible.length - limit} more threads · /agents tree`),
        Math.max(0, width),
      ),
    );
  }
  return lines;
}

const WIDGET_ROOT = "/root";
const MAX_WIDGET_LINES = 12;
const AGENT_WIDGET_PLACEMENT = { placement: "aboveEditor" as const };
const AGENT_BROWSER_HINT = "Press ← to open subagent browser";

interface AgentWidgetRenderOptions {
  /** RPC widgets cannot open a terminal browser. */
  showBrowserHint?: boolean;
  nerdFontIcons?: boolean;
  loaderStyle?: LoaderStyle;
  /** RPC snapshots use a static running frame and never start an animation. */
  animate?: boolean;
  /** Minimal line is a session collapse of full: Left steps back to full, not the browser. */
  expandHint?: boolean;
}

function agentWidgetStatus(
  running: number,
  omitted: number,
  width: number,
  theme: Pick<Theme, "fg">,
  showBrowserHint: boolean,
): string {
  const details = [
    omitted > 0 ? `+${omitted} more agents` : "",
    showBrowserHint && running > 0 ? AGENT_BROWSER_HINT : "",
    showBrowserHint ? "→ collapse" : "",
  ].filter(Boolean);
  return truncateToWidth(
    theme.fg("accent", `${running} running`) +
      (details.length ? theme.fg("muted", ` · ${details.join(" · ")}`) : ""),
    width,
    "",
  );
}

function statePriority(state: ThreadView["state"] | undefined): number {
  if (state === "starting" || state === "running") return 0;
  if (state === "paused") return 1;
  return 2;
}

function agentStateColor(state: ThreadView["state"]): "error" | "warning" | "accent" {
  return state === "failed" ? "error" : state === "paused" ? "warning" : "accent";
}

function agentLine(
  row: StatusRow,
  width: number,
  theme: AgentBadgeTheme,
  nerdFontIcons: boolean,
  animate: boolean,
  loaderStyle: LoaderStyle,
): string {
  const thread = row.thread!;
  const badge = agentTypeBadge(
    thread.type,
    thread.color,
    theme,
    thread.icon,
    nerdFontIcons,
    agentProgressIcon(thread, nerdFontIcons, Date.now(), animate, loaderStyle),
  );
  const left = `${row.prefix}${badge} ${agentPath(thread.path, thread.color, theme)} ${theme.fg(agentStateColor(thread.state), `[${sanitizeText(thread.state)}]`)} ${sanitizeText(threadActivity(thread, thread.description ?? thread.task))}`;
  return fitLine(left, theme.fg("muted", threadMetrics(thread)), width);
}

function placeholderLine(row: StatusRow, width: number, theme: AgentBadgeTheme): string {
  return truncateToWidth(
    `${row.prefix}${theme.fg("muted", `${sanitizeText(row.path)}  missing parent`)}`,
    width,
    "",
  );
}

function takeWidgetRows(rows: StatusRow[], budget: number): StatusRow[] {
  const parents = new Map<number, number[]>();
  const stack: number[] = [];
  for (const [index, row] of rows.entries()) {
    while (stack.length && rows[stack[stack.length - 1]!]!.prefix.length >= row.prefix.length)
      stack.pop();
    parents.set(index, [...stack]);
    stack.push(index);
  }
  const rowCost = (row: StatusRow) => (row.path === WIDGET_ROOT ? 0 : 1);
  const candidates = rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => row.thread && row.path !== WIDGET_ROOT)
    .sort(
      (a, b) =>
        statePriority(a.row.thread!.state) - statePriority(b.row.thread!.state) ||
        lastStarted(b.row.thread) - lastStarted(a.row.thread) ||
        a.index - b.index,
    );
  const chosen = new Set<number>();
  let used = 0;
  for (const { index } of candidates) {
    const needed = [...parents.get(index)!, index].filter((ancestor) => !chosen.has(ancestor));
    const cost = needed.reduce((total, ancestor) => total + rowCost(rows[ancestor]!), 0);
    if (used + cost > budget) continue;
    for (const ancestor of needed) chosen.add(ancestor);
    used += cost;
  }
  // If a missing-parent chain cannot fit its agent, retain a useful tree prefix.
  if (!chosen.size) {
    for (const [index, row] of rows.entries()) {
      const cost = rowCost(row);
      if (used + cost > budget) break;
      chosen.add(index);
      used += cost;
    }
  }
  return rows.filter((row, index) => row.path !== WIDGET_ROOT && chosen.has(index));
}

/** Themed agent tree above the editor. Synthetic /root is the main conversation and is omitted. */
export function renderAgentTree(
  threads: ThreadView[],
  width: number,
  theme: AgentBadgeTheme,
  {
    showBrowserHint = true,
    nerdFontIcons = false,
    animate = true,
    loaderStyle = "circle",
  }: AgentWidgetRenderOptions = {},
): string[] {
  const columns = Math.max(0, width);
  const rows = buildStatusTree(threads, new Set());
  const agents = rows.filter((row) => row.thread && row.path !== WIDGET_ROOT);
  if (!agents.length) return [];
  const live = agents.filter(
    (row) => row.thread!.state === "starting" || row.thread!.state === "running",
  ).length;
  const paused = agents.filter((row) => row.thread!.state === "paused").length;
  const heading = fitLine(
    theme.fg("accent", "Agents"),
    theme.fg("muted", `${live} live · ${paused} paused`),
    columns,
  );
  // Reserve the last line for status and browser entry, even with no omissions.
  const visible = takeWidgetRows(rows, MAX_WIDGET_LINES - 2);
  const omitted = agents.length - visible.filter((row) => row.thread).length;
  const lines = [heading];
  for (const row of visible) {
    if (!row.thread) {
      lines.push(placeholderLine(row, columns, theme));
      continue;
    }
    lines.push(agentLine(row, columns, theme, nerdFontIcons, animate, loaderStyle));
  }
  lines.push(agentWidgetStatus(live, omitted, columns, theme, showBrowserHint));
  return lines;
}

/** One-line counts for real agents; starting agents count as running, including tokens. */
export function renderAgentSummary(
  threads: ThreadView[],
  width: number,
  theme: Pick<Theme, "fg">,
  {
    showBrowserHint = true,
    nerdFontIcons = false,
    animate = true,
    loaderStyle = "circle",
    expandHint = false,
  }: AgentWidgetRenderOptions = {},
): string[] {
  const agents = new Map<string, ThreadView>();
  for (const thread of threads) {
    if (thread?.path && thread.path !== WIDGET_ROOT && !agents.has(thread.path))
      agents.set(thread.path, thread);
  }
  if (!agents.size) return [];

  const counts: Record<Exclude<ThreadView["state"], "starting">, number> = {
    running: 0,
    stopped: 0,
    failed: 0,
    paused: 0,
    completed: 0,
  };
  let input = 0;
  let output = 0;
  for (const thread of agents.values()) {
    counts[thread.state === "starting" ? "running" : thread.state] += 1;
    if (isLive(thread)) {
      input += metricCount(thread.inputTokens);
      output += metricCount(thread.outputTokens);
    }
  }
  const statuses: [keyof typeof counts, ThemeColor][] = [
    ["running", "accent"],
    ["stopped", "muted"],
    ["failed", "error"],
    ["paused", "warning"],
    ["completed", "success"],
  ];
  const left =
    statuses
      .filter(([state]) => state === "running" || counts[state] > 0)
      .map(([state, color]) => {
        const progress =
          counts[state] > 0
            ? agentProgressIcon({ state }, nerdFontIcons, Date.now(), animate, loaderStyle)
            : undefined;
        return theme.fg(color, `${progress ? `${progress} ` : ""}${counts[state]} ${state}`);
      })
      .join(theme.fg("muted", ", ")) +
    (showBrowserHint && counts.running > 0
      ? theme.fg("muted", expandHint ? " · ← expand" : " · ← browser")
      : "");
  const right = theme.fg("muted", `↑${formatCount(input)} ↓${formatCount(output)}`);
  return [fitLine(left, right, Math.max(0, width))];
}

export function updateWidget(
  ctx: ExtensionContext,
  threads: ThreadView[],
  mode: WidgetMode = "full",
  nerdFontIcons = false,
  rootTurnEnded = false,
  loaderStyle: LoaderStyle = "circle",
  /** True while a configured-full widget is session-collapsed to the minimal line. */
  sessionCollapsed = false,
): void {
  if (!ctx.hasUI) return;
  if (!threads.some((thread) => thread.path !== "/root")) {
    ctx.ui.setWidget("pi-subagent", undefined, AGENT_WIDGET_PLACEMENT);
    return;
  }
  // Retain the tree while either the main turn or any subagent is still active.
  const settled = rootTurnEnded && !threads.some(isLive);
  const render = mode === "minimal" || settled ? renderAgentSummary : renderAgentTree;
  // RPC hosts accept string widgets only; a component factory is ignored.
  if (ctx.mode === "rpc") {
    ctx.ui.setWidget(
      "pi-subagent",
      render(threads, 80, ctx.ui.theme, {
        showBrowserHint: false,
        nerdFontIcons,
        loaderStyle,
        animate: false,
      }),
      AGENT_WIDGET_PLACEMENT,
    );
    return;
  }
  const snapshot = threads.map((thread) => ({ ...thread }));
  ctx.ui.setWidget(
    "pi-subagent",
    (tui) => {
      let timer: ReturnType<typeof setInterval> | undefined;
      if (snapshot.some(isLive)) {
        timer = setInterval(() => tui.requestRender(), AGENT_PROGRESS_INTERVAL);
        timer.unref();
      }
      return {
        render: (width) =>
          render(snapshot, width, ctx.ui.theme, {
            showBrowserHint: !settled,
            nerdFontIcons,
            loaderStyle,
            expandHint: sessionCollapsed,
          }),
        invalidate: () => {},
        dispose: () => {
          if (timer) clearInterval(timer);
          timer = undefined;
        },
      };
    },
    AGENT_WIDGET_PLACEMENT,
  );
}

export async function showThreads(
  ctx: ExtensionContext,
  controller: ThreadController,
  path?: string,
): Promise<void> {
  if (!ctx.hasUI) return;
  let selectedPath = path;
  while (true) {
    try {
      if (!selectedPath) {
        const threads = controller.list().filter((thread) => thread.path !== "/root");
        if (!threads.length) {
          ctx.ui.notify("No subagent threads.", "info");
          return;
        }
        const labels = threads.map(
          (thread) =>
            `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}] ${sanitizeText(thread.status)}`,
        );
        const selected = await ctx.ui.select("Subagent threads", labels);
        if (selected === undefined) return;
        selectedPath = threads[labels.indexOf(selected)]?.path;
        if (!selectedPath) return;
      }
      if (selectedPath === "/root")
        throw new Error("/root is the current Pi thread, not a subagent.");
      const thread = controller.get(selectedPath);
      const children = controller.list().filter((child) => child.parent === selectedPath);
      const title = `${sanitizeText(thread.path)} [${sanitizeText(thread.state)}] ${sanitizeText(thread.status)}`;
      const action = await ctx.ui.select(title, [
        "View output",
        "View transcript",
        "Send input / resume",
        "Stop",
        ...(children.length ? ["Children"] : []),
        "Back",
      ]);
      if (!action || action === "Back") {
        if (path) return;
        selectedPath = undefined;
        continue;
      }
      if (action === "View output" || action === "View transcript") {
        const text =
          action === "View output"
            ? controller.output(selectedPath)
            : await controller.transcript(selectedPath);
        // Built-in editor is a portable viewer; edits are explicitly discarded.
        await ctx.ui.editor(
          `${sanitizeText(selectedPath)} — READ ONLY (changes discarded)`,
          text.split("\n").map(sanitizeText).join("\n"),
        );
      } else if (action === "Send input / resume") {
        const message = await ctx.ui.editor("Send input / resume retained session", "");
        if (message?.trim()) await controller.steer(selectedPath, message);
      } else if (action === "Stop") {
        if (
          await ctx.ui.confirm(
            "Stop thread",
            `Stop ${sanitizeText(selectedPath)} and its descendants?`,
          )
        )
          await controller.stop(selectedPath);
      } else if (action === "Children") {
        const labels = children.map(
          (child) =>
            `${sanitizeText(child.path)} [${sanitizeText(child.state)}] ${sanitizeText(child.status)}`,
        );
        const selected = await ctx.ui.select("Children", labels);
        if (selected !== undefined)
          selectedPath = children[labels.indexOf(selected)]?.path ?? selectedPath;
      }
    } catch (error) {
      ctx.ui.notify(sanitizeText(error instanceof Error ? error.message : String(error)), "error");
      return;
    }
  }
}
