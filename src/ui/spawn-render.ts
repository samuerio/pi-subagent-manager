import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Markdown,
  Spacer,
  Text,
  truncateToWidth,
  wrapTextWithAnsi,
  type Component,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { LiveToolCall, SpawnLiveDetails, ThreadView } from "../types.ts";
import { OUTPUT_PAGE_CHARS, truncationNote } from "../types.ts";
import { modelLabel } from "./thread-tree.ts";
import { threadMetrics } from "./ui.ts";

/**
 * Shared display layer for the five spawn verbs. Everything here is pure
 * presentation: the model-facing content (the ThreadView envelope) is produced
 * in orch/tools.ts and is unaffected by these renderers.
 */

type SpawnCallArgs = { path?: unknown; description?: unknown };

function callDescription(args: unknown): string {
  const description = (args as SpawnCallArgs | undefined)?.description;
  return typeof description === "string" ? description : "...";
}

function callPath(args: unknown): string {
  const path = (args as SpawnCallArgs | undefined)?.path;
  return typeof path === "string" ? path : "";
}

/**
 * One-line call preview: agent name, its path handle (the key agent_wait and the
 * widget/tree use), then the short description. Result renderers stay path-free:
 * by then the description and metrics already identify the line.
 */
export function spawnCallText(args: SpawnCallArgs, name: string): string {
  const path = callPath(args);
  return `${name}${path ? ` ${path}` : ""} ${callDescription(args)}`;
}

export function renderSpawnCall(
  args: unknown,
  theme: Theme,
  name: string,
): Text {
  const path = callPath(args);
  const pathPart = path ? ` ${path}` : "";
  const description = callDescription(args);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(name))}${pathPart} ${theme.fg("muted", description)}`,
    0,
    0,
  );
}

/**
 * One-line collapsed result: state, model, metrics. The description stays on the
 * call line directly above, so repeating it here would be noise.
 */
export function spawnCollapsedText(thread: ThreadView): string {
  return `${thread.state}  ${modelLabel(thread)}  ${threadMetrics(thread)}`;
}
/**
 * Collapsed live block, activity first and status last (the same order as the
 * Agent widget rows and the settled report): the latest child call, then the
 * status line. No call yet means the status line alone.
 */
export function liveCollapsedLines(thread: SpawnLiveDetails): string[] {
  const last = [...(thread.recentCalls ?? [])]
    .reverse()
    .find((call) => !call.nested);
  const lines: string[] = [];
  if (last) lines.push(`→ ${last.name} ${last.summary}`);
  lines.push(statusLine(thread));
  return lines;
}

function statusLine(thread: ThreadView): string {
  const model = thread.model
    ? `${thread.model}${thread.thinkingLevel ? `:${thread.thinkingLevel}` : ""}`
    : "model pending";
  return `${thread.state} · ${model} · ${threadMetrics(thread)}`;
}
const MAX_LIVE_TRAIL_LINES = 12;
const LIVE_PREVIEW_LINES = 4;

function callColor(call: LiveToolCall, childActive: boolean): ThemeColor {
  if (call.isError) return "error";
  if (call.state === "running") return childActive ? "accent" : "muted";
  return "muted";
}
type ThemeColor = Parameters<Theme["fg"]>[0];

function callText(call: LiveToolCall, childActive: boolean): string {
  const prefix = call.nested ? "  ↳ " : "→ ";
  const body = `${call.name} ${call.summary}`;
  // A child aborted mid-call leaves a running marker behind; never present it as live.
  return call.state === "running" && !childActive
    ? `${prefix}${body} (interrupted)`
    : prefix + body;
}

/**
 * Live expanded view: status line, then a rolling window of the child's tool
 * calls (newest at the bottom, earlier ones collapsed into a counter), then a
 * tail of the latest assistant text. The window is capped inside render(width)
 * because renderResult never sees a width.
 */
export function liveExpandedLines(
  thread: SpawnLiveDetails,
  width: number,
  theme: Theme,
): string[] {
  // Same skeleton as the settled report: breathing room, the body, then the
  // status footer — with the trail in the activity-first order of the
  // collapsed live block. A child with no output yet just shows its trail.
  const lines: string[] = [""];
  const childActive = thread.state === "starting" || thread.state === "running";
  const calls = thread.recentCalls ?? [];
  if (calls.length) {
    const rendered = calls.map((call) => ({
      color: callColor(call, childActive),
      line: callText(call, childActive),
    }));
    const kept: typeof rendered = [];
    let used = 0;
    for (let index = rendered.length - 1; index >= 0; index--) {
      const cost = wrapTextWithAnsi(
        rendered[index].line,
        Math.max(1, width),
      ).length;
      // The newest call stays visible even when a narrow terminal wraps it
      // past the cap; the cap only bounds the older trail behind it.
      if (index < rendered.length - 1 && used + cost > MAX_LIVE_TRAIL_LINES)
        break;
      used += cost;
      kept.unshift(rendered[index]);
    }
    const dropped = rendered.length - kept.length;
    if (dropped > 0) lines.push(theme.fg("dim", `⋯ ${dropped} earlier calls`));
    for (const entry of kept)
      lines.push(
        truncateToWidth(theme.fg(entry.color, entry.line), Math.max(1, width)),
      );
  }
  const preview = thread.assistantPreview?.trim();
  if (preview) {
    const wrapped = preview
      .split("\n")
      .flatMap((line) => wrapTextWithAnsi(line, Math.max(1, width)));
    for (const line of wrapped.slice(-LIVE_PREVIEW_LINES))
      lines.push(truncateToWidth(line, Math.max(1, width)));
  }
  lines.push("", theme.fg("muted", statusLine(thread)));
  return lines;
}

export function renderSpawnResult(
  result: unknown,
  options: unknown,
  theme: Theme,
  context?: unknown,
): Text | Container | Component {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.[0]?.type === "text" ? content[0].text : undefined;
  const expanded =
    (options as { expanded?: boolean } | undefined)?.expanded === true;
  const isError =
    (context as { isError?: boolean } | undefined)?.isError === true;
  // On the throw path createErrorToolResult wipes details; render the envelope
  // text alone, dyed in error color, without an extra header row.
  const thread = (result as { details?: unknown }).details as
    SpawnLiveDetails | undefined;
  if (!thread?.path) {
    if (isError)
      return new Text(theme.fg("error", text ?? "(no output)"), 0, 0);
    return new Text(text ?? "(no output)", 0, 0);
  }

  // In-flight updates stream a live view; the authoritative partial flag guards
  // the settled state, whose report layout is the final render below.
  const partial =
    (options as { isPartial?: boolean } | undefined)?.isPartial === true;
  if (partial && (thread.state === "starting" || thread.state === "running")) {
    if (!expanded)
      return new Text(
        theme.fg("muted", liveCollapsedLines(thread).join("\n")),
        0,
        0,
      );
    return {
      render: (width: number) =>
        liveExpandedLines(thread, Math.max(1, width), theme),
      invalidate: () => {},
    };
  }

  if (!expanded)
    return new Text(theme.fg("muted", spawnCollapsedText(thread)), 0, 0);
  return settledThreadView(thread, theme);
}

/**
 * Settled expanded report: what was asked (task, muted), a full-width rule
 * separating instruction from answer, then the output, and finally the footer
 * (state, model, metrics) right above the session file. Shared by the spawn
 * verbs and the thread-management tools (agent_wait/steer/status/stop).
 */
export function settledThreadView(
  thread: ThreadView & {
    outputTruncated?: boolean;
    outputCharacters?: number;
  },
  theme: Theme,
): Container {
  const settled = thread.state !== "starting" && thread.state !== "running";
  const container = new Container();
  // Breathing room between the call line above and the report body.
  container.addChild(new Spacer(1));
  const task = thread.task?.trim();
  const output = thread.error ?? thread.output;
  if (task) container.addChild(new Text(theme.fg("muted", task), 0, 0));
  if (task && output?.trim()) {
    // The rule takes the spacer's slot: task/answer stay separated at any scroll
    // position without spending an extra line.
    container.addChild({
      render: (width: number) => [
        theme.fg("muted", "\u2500".repeat(Math.max(0, width))),
      ],
      invalidate: () => {},
    });
  }
  if (output?.trim()) {
    container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
  } else if (settled) {
    container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
  }
  // An unsettled child has not produced output yet; saying so would be noise.
  // UI-only line: the model-facing channel for truncation is the structured
  // outputTruncated/outputCharacters fields (compact()) plus the async
  // completion message copy in index.ts, which shares this exact wording.
  if (thread.outputTruncated) {
    container.addChild(
      new Text(
        theme.fg(
          "muted",
          `(${truncationNote(thread.outputCharacters, thread.path)})`,
        ),
        0,
        0,
      ),
    );
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", statusLine(thread)), 0, 0));
  if (thread.sessionFile) {
    container.addChild(
      new Text(theme.fg("dim", `session: ${thread.sessionFile}`), 0, 0),
    );
  }
  return container;
}

/**
 * Thread tools take no description: the call line is just the name and path.
 * An explicit timeoutMs (agent_wait's wait ceiling, agent_steer's re-armed
 * report timer) is appended in pi's bash-tool style, muted and in seconds.
 */
export function renderThreadCall(
  args: unknown,
  theme: Theme,
  name: string,
): Text {
  const path = callPath(args);
  const timeout = (args as { timeoutMs?: unknown } | undefined)?.timeoutMs;
  const timeoutPart =
    typeof timeout === "number" && Number.isFinite(timeout)
      ? theme.fg("muted", ` (timeout ${formatTimeoutSeconds(timeout)}s)`)
      : "";
  const range = callRange(args);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(name))}${path ? ` ${path}` : ""}${range ? theme.fg("muted", range) : ""}${timeoutPart}`,
    0,
    0,
  );
}

function formatTimeoutSeconds(timeoutMs: number): string {
  const seconds = timeoutMs / 1000;
  return Number.isInteger(seconds) ? String(seconds) : seconds.toFixed(1);
}

/**
 * agent_output's read range, 1-based inclusive like read's `:1-80`, rendered
 * whenever the model passed offset and/or limit (null counts as absent —
 * strict schemas emit null for omitted optionals). For a full page the end
 * numeral equals the follow-up call's offset, so the model can copy it over.
 * An absent limit is filled from the shared execute default. The end numeral
 * is the request boundary, not the actual-content boundary: on a short last
 * page it can overshoot the true end, but it still equals the follow-up
 * call's offset, which is what the model copies over.
 */
function callRange(args: unknown): string {
  const { offset, limit } = (args ?? {}) as {
    offset?: unknown;
    limit?: unknown;
  };
  const start =
    typeof offset === "number" && Number.isFinite(offset)
      ? Math.max(0, offset)
      : null;
  const size =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? limit
      : null;
  if (start === null && size === null) return "";
  const from = start ?? 0;
  return `:C${from + 1}-C${from + (size ?? OUTPUT_PAGE_CHARS)}`;
}

/**
 * Renderer for the thread-management tools. Same visual language as the spawn
 * verbs: a single ThreadView collapses to the status line and expands into the
 * settled report; agent_status's list collapses to a state census and expands
 * to one status line per thread. Anything else falls back to the envelope text.
 */
export function renderThreadResult(
  result: unknown,
  options: unknown,
  theme: Theme,
  context?: unknown,
): Text | Container | Component {
  const content = (
    result as { content?: Array<{ type: string; text?: string }> }
  ).content;
  const text = content?.[0]?.type === "text" ? content[0].text : undefined;
  const expanded =
    (options as { expanded?: boolean } | undefined)?.expanded === true;
  const isError =
    (context as { isError?: boolean } | undefined)?.isError === true;
  const fallback = () =>
    isError
      ? new Text(theme.fg("error", text ?? "(no output)"), 0, 0)
      : new Text(text ?? "(no output)", 0, 0);

  const details = (result as { details?: unknown }).details;
  if (Array.isArray(details)) {
    const threads = details.filter(
      (entry): entry is ThreadView =>
        !!entry &&
        typeof (entry as ThreadView).path === "string" &&
        typeof (entry as ThreadView).state === "string",
    );
    if (!threads.length) return fallback();
    if (!expanded) {
      const counts = new Map<string, number>();
      for (const thread of threads)
        counts.set(thread.state, (counts.get(thread.state) ?? 0) + 1);
      const census = [...counts]
        .map(([state, n]) => `${state} ${n}`)
        .join(", ");
      return new Text(
        theme.fg("muted", `${threads.length} threads: ${census}`),
        0,
        0,
      );
    }
    const container = new Container();
    for (const thread of threads)
      container.addChild(
        new Text(
          theme.fg("muted", `${thread.path}  ${spawnCollapsedText(thread)}`),
          0,
          0,
        ),
      );
    return container;
  }

  // agent_output's pagination payload: {path, text, totalCharacters, nextOffset}.
  const page = details as
    | {
        path?: unknown;
        text?: unknown;
        totalCharacters?: unknown;
        nextOffset?: unknown;
      }
    | undefined;
  if (
    typeof page?.path === "string" &&
    typeof page.text === "string" &&
    typeof page.totalCharacters === "number"
  )
    return renderOutputPage({ text: page.text }, expanded, theme);

  // The state duck-check separates real views from lookalikes: error results
  // arrive with details wiped by createErrorToolResult, and any unexpected
  // payload shape renders as its envelope text instead of garbage fields.
  const thread = details as ThreadView | undefined;
  if (!thread?.path || typeof thread.state !== "string") return fallback();
  if (!expanded)
    return new Text(theme.fg("muted", spawnCollapsedText(thread)), 0, 0);
  return settledThreadView(thread, theme);
}

/**
 * One page of a thread's output. Pagination guidance is data-side: the
 * execute appends the "[N more characters … Use offset=X to continue.]"
 * directive to the page text, so the expanded view is just the body and the
 * collapsed view is silent — the call line's :C range carries the position,
 * and the JSON envelope's nextOffset carries it to the model.
 */
function renderOutputPage(
  page: { text: string },
  expanded: boolean,
  theme: Theme,
): Text | Container {
  if (!expanded) return new Text("", 0, 0);
  const container = new Container();
  container.addChild(new Spacer(1));
  if (page.text.trim())
    container.addChild(new Markdown(page.text, 0, 0, getMarkdownTheme()));
  else container.addChild(new Text(theme.fg("muted", "(empty page)"), 0, 0));
  return container;
}
