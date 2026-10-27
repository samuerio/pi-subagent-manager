import type { LiveToolCall, TranscriptToolState } from "../types.ts";
import { stripTerminalSequences } from "@earendil-works/pi-tui";

/**
 * Data-side formatting of child tool calls into bounded single-line summaries.
 * Colors are applied by the renderer; summaries here stay plain so they can be
 * embedded into live details without unbounded argument payloads.
 */

const SUMMARY_LIMIT = 200;
const COMMAND_PREVIEW = 60;

function argsOf(args: unknown): Record<string, unknown> {
  return args && typeof args === "object"
    ? (args as Record<string, unknown>)
    : {};
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** One line, bounded: raw arguments never reach the parent transcript. */
function bound(value: string): string {
  // Sub-agent arguments can echo untrusted file/network content; terminal
  // commands never reach the operator's screen (same convention as ui.ts).
  const flat = stripTerminalSequences(value)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > SUMMARY_LIMIT
    ? `${flat.slice(0, SUMMARY_LIMIT)}…`
    : flat;
}

/** cwd-relative when the path lives under cwd, otherwise $HOME collapsed to `~`. */
function shortenPath(raw: string, cwd: string): string {
  if (!raw) return "...";
  const resolved = raw.startsWith("/") ? raw : `${cwd}/${raw}`;
  if (resolved === cwd || resolved.startsWith(`${cwd}/`)) {
    const relative = resolved.slice(cwd.length + 1);
    return relative || ".";
  }
  const home = process.env.HOME;
  return home && resolved.startsWith(`${home}/`)
    ? `~${resolved.slice(home.length)}`
    : resolved;
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = str(args[key]);
    if (value) return value;
  }
  const fallback = Object.values(args).find(
    (value) => typeof value === "string" && value,
  );
  return typeof fallback === "string" ? fallback : "";
}

/**
 * The human-readable part of a tool-call line; the tool name is rendered by the
 * caller (`→ read src/auth/retry.ts`). Mirrors the dotfiles subagents summaries.
 */
export function toolCallSummary(
  toolName: string,
  args: unknown,
  cwd: string,
): string {
  const a = argsOf(args);
  switch (toolName) {
    case "bash": {
      const command = str(a.command) || str(a.cmd) || "...";
      const preview =
        command.length > COMMAND_PREVIEW
          ? `${command.slice(0, COMMAND_PREVIEW)}…`
          : command;
      return bound(`$ ${preview}`);
    }
    case "read": {
      const raw = firstString(a, ["file_path", "path", "notebook_path"]);
      const filePath = shortenPath(raw, cwd);
      const start = typeof a.offset === "number" ? a.offset : undefined;
      const limit = typeof a.limit === "number" ? a.limit : undefined;
      if (start === undefined && limit === undefined) return bound(filePath);
      const from = start ?? 1;
      const range = limit !== undefined ? `-${from + limit - 1}` : "";
      return bound(`${filePath}:${from}${range}`);
    }
    case "write":
    case "edit": {
      const raw = firstString(a, ["file_path", "path"]);
      const lines =
        typeof a.content === "string"
          ? a.content.split("\n").length
          : undefined;
      return bound(
        lines && lines > 1
          ? `${shortenPath(raw, cwd)} (${lines} lines)`
          : shortenPath(raw, cwd),
      );
    }
    case "grep": {
      const pattern = firstString(a, ["pattern", "query"]);
      const target = firstString(a, ["path"]);
      return bound(
        target ? `"${pattern}" in ${shortenPath(target, cwd)}` : `"${pattern}"`,
      );
    }
    case "glob":
      return bound(firstString(a, ["pattern"]));
    case "ls":
    case "find": {
      const target = firstString(a, ["path", "dir"]);
      return bound(shortenPath(target, cwd));
    }
    case "fetch":
    case "webfetch":
    case "open":
      return bound(firstString(a, ["url"]));
    default:
      return bound(firstString(a, []));
  }
}

/** Map a transcript tool state onto its bounded live entry. */
export function captureToolCall(
  tool: TranscriptToolState,
  cwd: string,
): LiveToolCall {
  return {
    name: tool.toolName,
    summary: toolCallSummary(tool.toolName, tool.args, cwd),
    state: tool.state,
    ...(tool.isError ? { isError: true } : {}),
    nested: !!tool.parentToolCallId,
  };
}
