import * as fs from "node:fs";
import fsp from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  cloneModesFile,
  type ModeRoles,
  DEFAULT_MODE_ORDER,
  ROLE_KEYS,
  CUSTOM_MODE_NAME,
  sanitizeModeSpec,
  type ModeName,
  type ModeSpec,
  type ModesFile,
} from "./schema.ts";

/**
 * modes.json file layer shared by the /mode editor (async, locked, atomic)
 * and subagent role routing (sync, strict). One place resolves the path:
 * a project `.pi/modes.json` wins over the global `~/.pi/agent/modes.json`.
 */

export function globalModesPath(): string {
  return path.join(getAgentDir(), "modes.json");
}

export function projectModesPath(cwd: string): string {
  return path.join(cwd, ".pi", "modes.json");
}

function fileExistsSync(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Sync variant for routing's fail-fast dispatch path. */
export function resolveModesPathSync(cwd: string): string {
  const projectPath = projectModesPath(cwd);
  return fileExistsSync(projectPath) ? projectPath : globalModesPath();
}

export async function resolveModesPath(cwd: string): Promise<string> {
  const projectPath = projectModesPath(cwd);
  try {
    if ((await fsp.stat(projectPath)).isFile()) return projectPath;
  } catch {
    /* no project override; use the global file */
  }
  return globalModesPath();
}

export function getMtimeMs(p: string): Promise<number | null> {
  return fsp
    .stat(p)
    .then((st) => st.mtimeMs)
    .catch(() => null);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLockPathForFile(filePath: string): string {
  // Lock file next to the json so it works across processes.
  return `${filePath}.lock`;
}

/** Cross-process exclusive lock. A lock whose recorded holder process is dead is broken immediately (kill(pid, 0) liveness); one that cannot be verified falls back to STALE_LOCK_MS (5 minutes), so a slow but alive writer is never evicted. */
/** Generous fallback for breaking a lock whose holder cannot be verified. */
const STALE_LOCK_MS = 5 * 60_000;

/** Read the lock file raw; null when unreadable or gone. */
async function readLockRaw(lockPath: string): Promise<string | null> {
  try {
    return await fsp.readFile(lockPath, "utf8");
  } catch {
    return null;
  }
}

/**
 * true: holder alive (kill(pid, 0) succeeded or EPERM = exists, other user);
 * false: recorded pid no longer exists; null: no pid.
 */
function lockHolderAlive(pid: unknown): boolean | null {
  if (typeof pid !== "number") return null;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM" ? true : false;
  }
}

/**
 * Break a stale lock: holder provably dead, or unverifiable and older than
 * STALE_LOCK_MS. Re-checks the content right before unlink: between judging
 * and deleting, another waiter may have broken and re-acquired the lock, and
 * unlinking that fresh lock would let two writers in concurrently.
 * Returns true when the lock was broken (caller retries the acquire).
 */
async function breakStaleLock(lockPath: string): Promise<boolean> {
  const raw = await readLockRaw(lockPath);
  if (raw === null) return false;
  // A half-written or empty lock (crash between create and write, torn read)
  // must not throw past the retry/timeout loop. A live holder writes valid
  // JSON microseconds after acquiring, so content that stays malformed across
  // a re-read means the holder died before writing: break immediately. Valid
  // JSON without a pid still waits out the age threshold.
  let pid: unknown;
  let malformed = false;
  try {
    pid = (JSON.parse(raw) as { pid?: unknown }).pid;
  } catch {
    malformed = true;
  }
  const holder = lockHolderAlive(pid);
  if (holder === true) return false;
  if (!malformed && holder === null) {
    const st = await fsp.stat(lockPath).catch(() => undefined);
    if (!st || Date.now() - st.mtimeMs <= STALE_LOCK_MS) return false;
  }
  // The content we judged stale must still be the file's content; otherwise
  // another waiter already broke and re-acquired it.
  if ((await readLockRaw(lockPath)) !== raw) return false;
  await fsp.unlink(lockPath).catch(() => {});
  return true;
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = getLockPathForFile(filePath);
  await fsp.mkdir(path.dirname(lockPath), { recursive: true });

  const start = Date.now();
  while (true) {
    try {
      const handle = await fsp.open(lockPath, "wx");
      try {
        // The pid is load-bearing: breakStaleLock treats a holder without a
        // readable pid as dead. If the write fails, release the lock and
        // fail rather than running fn() under a lock other processes will
        // break.
        await handle.writeFile(
          JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }) + "\n",
          "utf8",
        );
      } catch (error) {
        await handle.close().catch(() => {});
        await fsp.unlink(lockPath).catch(() => {});
        throw new Error(
          `Could not write lock metadata ${lockPath}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fsp.unlink(lockPath).catch(() => {});
      }
    } catch (error: unknown) {
      const code = (error as { code?: string }).code;
      if (code !== "EEXIST") throw error;
      if (await breakStaleLock(lockPath)) continue;
      if (Date.now() - start > 5_000) {
        // Don't hang the UI forever.
        throw new Error(`Timed out waiting for lock: ${lockPath}`);
      }
      await sleep(40 + Math.random() * 80);
    }
  }
}

export async function atomicWriteUtf8(
  filePath: string,
  content: string,
): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${base}.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`,
  );
  await fsp.writeFile(tmpPath, content, "utf8");
  try {
    // POSIX: atomic replace.
    await fsp.rename(tmpPath, filePath);
  } catch (error: unknown) {
    const code = (error as { code?: string }).code;
    // Windows: rename can't overwrite. Copy over the destination instead of
    // unlink+rename. The copy is NOT atomic (a mid-copy crash can leave a
    // truncated destination), but the tmp file is preserved for diagnosis and
    // no path leaves both old and new content missing.
    if (code === "EEXIST" || code === "EPERM") {
      try {
        await fsp.copyFile(tmpPath, filePath);
      } finally {
        await fsp.unlink(tmpPath).catch(() => {});
      }
    } else {
      await fsp.unlink(tmpPath).catch(() => {});
      throw error;
    }
  }
}

/** Lenient parse: malformed pins and fields drop silently; the editor owns defaults. */
export function parseModesFile(raw: string, defaults: ModesFile): ModesFile {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return cloneModesFile(defaults);
  }
  const currentMode =
    typeof parsed.currentMode === "string" ? parsed.currentMode : "default";
  const modesRaw =
    parsed.modes && typeof parsed.modes === "object"
      ? (parsed.modes as Record<string, unknown>)
      : {};
  const modes: Record<string, ModeSpec> = {};
  for (const [name, spec] of Object.entries(modesRaw)) {
    modes[name] = sanitizeModeSpec(spec);
  }
  const file: ModesFile = { version: 1, currentMode, modes };
  ensureDefaultModeEntries(file, defaults);
  return file;
}

export function ensureDefaultModeEntries(
  file: ModesFile,
  defaults: ModesFile,
): void {
  for (const name of DEFAULT_MODE_ORDER) {
    if (!file.modes[name])
      file.modes[name] = cloneModesFile(defaults).modes[name] ?? { roles: {} };
  }
  // "custom" is an overlay mode; never a valid persisted current mode.
  if (file.currentMode === CUSTOM_MODE_NAME) file.currentMode = "";
  if (
    !file.currentMode ||
    !(file.currentMode in file.modes) ||
    file.currentMode === CUSTOM_MODE_NAME
  ) {
    const first = Object.keys(file.modes).find(
      (name) => name !== CUSTOM_MODE_NAME,
    );
    file.currentMode = file.modes.default ? "default" : first || "default";
  }
}

export async function loadModesFile(
  filePath: string,
  defaults: ModesFile,
): Promise<ModesFile> {
  try {
    return parseModesFile(await fsp.readFile(filePath, "utf8"), defaults);
  } catch {
    return cloneModesFile(defaults);
  }
}

const MODES_TOP_LEVEL_KEYS = new Set(["version", "currentMode", "modes"]);
const MODE_SPEC_KEYS = new Set(["roles", "color"]);

/** Unrecognized fields that a save would strip; reported so nothing vanishes silently. */
export function unknownModesFields(parsed: Record<string, unknown>): string[] {
  const unknown: string[] = [];
  for (const key of Object.keys(parsed)) {
    if (!MODES_TOP_LEVEL_KEYS.has(key)) unknown.push(key);
  }
  const modes = parsed.modes;
  if (modes && typeof modes === "object") {
    for (const [name, spec] of Object.entries(
      modes as Record<string, unknown>,
    )) {
      if (!spec || typeof spec !== "object") continue;
      for (const key of Object.keys(spec as Record<string, unknown>)) {
        if (!MODE_SPEC_KEYS.has(key)) unknown.push(`${name}.${key}`);
      }
      // sanitizeRoles keeps only the three pinned roles; report anything else
      // inside roles too, so a hand-added custom role is never wiped silently.
      const roles = (spec as Record<string, unknown>).roles;
      if (!roles || typeof roles !== "object") continue;
      for (const key of Object.keys(roles as Record<string, unknown>)) {
        if (!(ROLE_KEYS as readonly string[]).includes(key)) {
          unknown.push(`${name}.roles.${key}`);
        }
      }
    }
  }
  return unknown;
}

export type ModesRawSnapshot = {
  /** "ok": readable file; "missing": ENOENT; "unreadable": EACCES and friends. */
  status: "ok" | "missing" | "unreadable";
  /** File content; null when missing or unreadable. */
  raw: string | null;
  /** Raw JSON.parse of the file; null when missing, unreadable or unparsable. */
  parsed: Record<string, unknown> | null;
};

/**
 * Read the file as-is for the persist path. Unlike loadModesFile this never
 * falls back to defaults: the caller decides whether a corrupt or unreadable
 * file may be rewritten or must be preserved untouched.
 */
export async function readModesSnapshot(
  filePath: string,
): Promise<ModesRawSnapshot> {
  let raw: string;
  try {
    raw = await fsp.readFile(filePath, "utf8");
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT")
      return { status: "missing", raw: null, parsed: null };
    return { status: "unreadable", raw: null, parsed: null };
  }
  try {
    return {
      status: "ok",
      raw,
      parsed: JSON.parse(raw) as Record<string, unknown>,
    };
  } catch {
    return { status: "ok", raw, parsed: null };
  }
}

export async function saveModesFile(
  filePath: string,
  data: ModesFile,
): Promise<void> {
  await atomicWriteUtf8(filePath, JSON.stringify(data, null, 2) + "\n");
}

export type ModeSpecPatch = {
  roles?: ModeRoles | null;
  color?: string | null;
};

export type ModesPatch = {
  currentMode?: ModeName;
  modes?: Record<ModeName, ModeSpecPatch | null>;
};

/** Diff two snapshots so concurrent pi processes merge instead of clobber. */
export function computeModesPatch(
  base: ModesFile,
  next: ModesFile,
  includeCurrentMode: boolean,
): ModesPatch | null {
  const patch: ModesPatch = {};
  if (includeCurrentMode && base.currentMode !== next.currentMode) {
    patch.currentMode = next.currentMode;
  }
  const keys = new Set([
    ...Object.keys(base.modes),
    ...Object.keys(next.modes),
  ]);
  const modesPatch: Record<ModeName, ModeSpecPatch | null> = {};
  for (const key of keys) {
    const a = base.modes[key];
    const b = next.modes[key];
    if (!b) {
      if (a) modesPatch[key] = null;
      continue;
    }
    if (!a) {
      modesPatch[key] = { ...b };
      continue;
    }
    const diff: ModeSpecPatch = {};
    // `roles` is compared deep (JSON) because the editor mutates pins in place.
    if (JSON.stringify(a.roles ?? null) !== JSON.stringify(b.roles ?? null)) {
      diff.roles = b.roles === undefined ? null : b.roles;
    }
    if (a.color !== b.color)
      diff.color = b.color === undefined ? null : b.color;
    if (Object.keys(diff).length > 0) modesPatch[key] = diff;
  }
  if (Object.keys(modesPatch).length > 0) patch.modes = modesPatch;
  if (!patch.modes && patch.currentMode === undefined) return null;
  return patch;
}

export function applyModesPatch(target: ModesFile, patch: ModesPatch): void {
  if (patch.currentMode !== undefined) target.currentMode = patch.currentMode;
  if (!patch.modes) return;
  for (const [mode, specPatch] of Object.entries(patch.modes)) {
    if (specPatch === null) {
      delete target.modes[mode];
      continue;
    }
    const targetSpec: Record<string, unknown> = (target.modes[mode] ??=
      {}) as Record<string, unknown>;
    for (const [key, value] of Object.entries(specPatch)) {
      if (value === null || value === undefined) {
        delete targetSpec[key];
      } else {
        // Deep-copy nested values (roles) so the target does not alias the patch source.
        targetSpec[key] =
          typeof value === "object" ? JSON.parse(JSON.stringify(value)) : value;
      }
    }
  }
}
