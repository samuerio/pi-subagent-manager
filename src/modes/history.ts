import fsp from "node:fs/promises";
import type fsPromises from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Cross-session prompt history for the editor, ported from the dotfiles
 * prompt-editor: user prompts from recent session files of the same cwd,
 * deduplicated and capped. Only data; the editor consumes plain strings.
 */

export const MAX_HISTORY_ENTRIES = 100;
const MAX_RECENT_PROMPTS = 30;
const TAIL_BYTES = 256 * 1024;

export interface PromptEntry {
  text: string;
  timestamp: number;
}

/**
 * pi records entry-level timestamps as ISO strings and message-level ones as
 * epoch numbers. Number() on the string form yields NaN, which corrupts the
 * sort in buildHistoryList; parse both shapes and fall back on garbage.
 */
function entryTimestamp(
  messageTimestamp: unknown,
  entryTimestamp: unknown,
): number {
  const raw = messageTimestamp ?? entryTimestamp;
  const parsed =
    typeof raw === "number" ? raw : raw ? Date.parse(String(raw)) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function extractText(content: Array<{ type: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text ?? "")
    .join("")
    .trim();
}

export function collectUserPromptsFromEntries(
  entries: Array<any>,
): PromptEntry[] {
  const prompts: PromptEntry[] = [];
  for (const entry of entries) {
    if (entry?.type !== "message") continue;
    const message = entry?.message;
    if (!message || message.role !== "user" || !Array.isArray(message.content))
      continue;
    const text = extractText(message.content);
    if (!text) continue;
    const timestamp = entryTimestamp(message.timestamp, entry.timestamp);
    prompts.push({ text, timestamp });
  }
  return prompts;
}

function getSessionDirForCwd(cwd: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(getAgentDir(), "sessions", safePath);
}

/** Read the tail of a large session file without loading it whole. */
async function readTail(
  filePath: string,
  maxBytes = TAIL_BYTES,
): Promise<string> {
  let fileHandle: fsPromises.FileHandle | undefined;
  try {
    const stats = await fsp.stat(filePath);
    const size = stats.size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return "";
    const buffer = Buffer.alloc(length);
    fileHandle = await fsp.open(filePath, "r");
    const { bytesRead } = await fileHandle.read(buffer, 0, length, start);
    if (bytesRead === 0) return "";
    let chunk = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) {
      const firstNewline = chunk.indexOf("\n");
      if (firstNewline !== -1) chunk = chunk.slice(firstNewline + 1);
    }
    return chunk;
  } catch (error) {
    // A missing file is normal (concurrent cleanup); anything else is worth a
    // line so the caller's failure path is not dead code.
    if ((error as { code?: string }).code !== "ENOENT") {
      console.warn(
        `Prompt history read failed for ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return "";
  } finally {
    await fileHandle?.close();
  }
}

export async function loadPromptHistoryForCwd(
  cwd: string,
  excludeSessionFile?: string,
): Promise<PromptEntry[]> {
  const sessionDir = getSessionDirForCwd(path.resolve(cwd));
  const resolvedExclude = excludeSessionFile
    ? path.resolve(excludeSessionFile)
    : undefined;
  const prompts: PromptEntry[] = [];

  let entries: Dirent[] = [];
  try {
    entries = await fsp.readdir(sessionDir, { withFileTypes: true });
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") {
      console.warn(
        `Prompt history unavailable for ${sessionDir}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return prompts;
  }

  // Session file names start with a timestamp, so directory name order is
  // newest-last; only stat a bounded tail to keep startup IO flat.
  const MAX_SESSION_FILES = 20;
  const candidates = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
    .map((entry) => entry.name)
    .sort()
    .slice(-MAX_SESSION_FILES);

  const files = await Promise.all(
    candidates.map(async (name) => {
      const filePath = path.join(sessionDir, name);
      try {
        const stats = await fsp.stat(filePath);
        return { filePath, mtimeMs: stats.mtimeMs };
      } catch {
        return undefined;
      }
    }),
  );

  const sortedFiles = files
    .filter((file): file is { filePath: string; mtimeMs: number } =>
      Boolean(file),
    )
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const file of sortedFiles) {
    if (resolvedExclude && path.resolve(file.filePath) === resolvedExclude)
      continue;
    const tail = await readTail(file.filePath);
    if (!tail) continue;
    const lines = tail.split("\n").filter(Boolean);
    for (const line of lines) {
      let entry: any;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (entry?.type !== "message") continue;
      const message = entry?.message;
      if (
        !message ||
        message.role !== "user" ||
        !Array.isArray(message.content)
      )
        continue;
      const text = extractText(message.content);
      if (!text) continue;
      const timestamp = entryTimestamp(message.timestamp, entry.timestamp);
      prompts.push({ text, timestamp });
      if (prompts.length >= MAX_RECENT_PROMPTS) break;
    }
    if (prompts.length >= MAX_RECENT_PROMPTS) break;
  }

  return prompts;
}

export function buildHistoryList(
  currentSession: PromptEntry[],
  previousSessions: PromptEntry[],
): PromptEntry[] {
  const all = [...currentSession, ...previousSessions];
  all.sort((a, b) => a.timestamp - b.timestamp);
  // Dedup by text alone: forked sessions re-record the same prompt with fresh
  // timestamps, and timestamp-keyed dedup would keep those copies.
  const seen = new Set<string>();
  const deduped: PromptEntry[] = [];
  for (const prompt of all) {
    if (seen.has(prompt.text)) continue;
    seen.add(prompt.text);
    deduped.push(prompt);
  }
  return deduped.slice(-MAX_HISTORY_ENTRIES);
}

export function historiesMatch(a: PromptEntry[], b: PromptEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i]?.text !== b[i]?.text || a[i]?.timestamp !== b[i]?.timestamp)
      return false;
  }
  return true;
}
