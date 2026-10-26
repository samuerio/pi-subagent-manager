import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../types.ts";
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

export function renderSpawnCall(args: unknown, theme: Theme, name: string): Text {
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

function statusLine(thread: ThreadView): string {
  const model = thread.model
    ? `${thread.model}${thread.thinkingLevel ? `:${thread.thinkingLevel}` : ""}`
    : "model pending";
  return `${thread.state} · ${model} · ${threadMetrics(thread)}`;
}

export function renderSpawnResult(
  result: unknown,
  options: unknown,
  theme: Theme,
  context?: unknown,
): Text | Container {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content;
  const text = content?.[0]?.type === "text" ? content[0].text : undefined;
  const expanded = (options as { expanded?: boolean } | undefined)?.expanded === true;
  const isError = (context as { isError?: boolean } | undefined)?.isError === true;
  // On the throw path createErrorToolResult wipes details; render the envelope
  // text alone, dyed in error color, without an extra header row.
  const thread = (result as { details?: unknown }).details as
    (ThreadView & { outputTruncated?: boolean }) | undefined;
  if (!thread?.path) {
    if (isError) return new Text(theme.fg("error", text ?? "(no output)"), 0, 0);
    return new Text(text ?? "(no output)", 0, 0);
  }

  if (!expanded) return new Text(theme.fg("muted", spawnCollapsedText(thread)), 0, 0);

  // Expanded reads top-down like a report: what was asked (task, muted), a
  // full-width rule separating instruction from answer, then the output, and
  // finally the footer (state, model, metrics) right above the session file.
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
      render: (width: number) => [theme.fg("muted", "\u2500".repeat(Math.max(0, width)))],
      invalidate: () => {},
    });
  }
  if (output?.trim()) {
    container.addChild(new Markdown(output.trim(), 0, 0, getMarkdownTheme()));
  } else {
    container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
  }
  if (thread.outputTruncated) {
    container.addChild(new Text(theme.fg("muted", "(output truncated at 16000 characters)"), 0, 0));
  }
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("muted", statusLine(thread)), 0, 0));
  if (thread.sessionFile) {
    container.addChild(new Text(theme.fg("dim", `session: ${thread.sessionFile}`), 0, 0));
  }
  return container;
}
