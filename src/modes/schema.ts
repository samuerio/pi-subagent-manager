import type { ThinkingLevel } from "../types.ts";

/**
 * modes.json schema shared by the /mode editor and subagent role routing
 * (orch/routing.ts). The file keeps the dotfiles prompt-editor layout:
 * `{ version: 1, currentMode, modes: { [name]: { roles, color? } } }`.
 */

export type ModeName = string;

export type RolePin = {
  provider: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
};

export type ModeRoles = {
  main?: RolePin;
  oracle?: RolePin;
  subagents?: RolePin;
};

export type ModeSpec = {
  /**
   * Explicit model routing for every role. `main` is the agent's own model,
   * `oracle`/`subagents` route the subagents. Modes without complete roles
   * still switch the main model but abort subagent dispatch (fail fast).
   */
  roles?: ModeRoles;
  /** Optional theme color token for the editor border; unset derives from the thinking level. */
  color?: string;
};

export type ModesFile = {
  version: 1;
  currentMode: ModeName;
  modes: Record<ModeName, ModeSpec>;
};

export const ROLE_KEYS = ["main", "oracle", "subagents"] as const;

/** Runtime-only overlay: manual model changes land here; never persisted or selectable. */
export const CUSTOM_MODE_NAME = "custom";
/** Forced built-in mode; others are user suggestions and can be renamed or deleted. */
export const DEFAULT_MODE_ORDER = ["default"] as const;

export const THINKING_LEVELS_ALL: ThinkingLevel[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

export function normalizeThinkingLevel(
  level: unknown,
): ThinkingLevel | undefined {
  if (typeof level !== "string") return undefined;
  return THINKING_LEVELS_ALL.includes(level as ThinkingLevel)
    ? (level as ThinkingLevel)
    : undefined;
}

export function sanitizeRolePin(pin: unknown): RolePin | undefined {
  const obj = (pin && typeof pin === "object" ? pin : {}) as Record<
    string,
    unknown
  >;
  const provider = typeof obj.provider === "string" ? obj.provider : undefined;
  const modelId = typeof obj.modelId === "string" ? obj.modelId : undefined;
  const thinkingLevel = normalizeThinkingLevel(obj.thinkingLevel);
  if (!provider || !modelId || !thinkingLevel) return undefined;
  return { provider, modelId, thinkingLevel };
}

export function sanitizeRoles(roles: unknown): ModeRoles | undefined {
  const obj = (roles && typeof roles === "object" ? roles : {}) as Record<
    string,
    unknown
  >;
  const out: ModeRoles = {};
  let any = false;
  for (const key of ROLE_KEYS) {
    const pin = sanitizeRolePin(obj[key]);
    if (pin) {
      out[key] = pin;
      any = true;
    }
  }
  return any ? out : undefined;
}

export function sanitizeModeSpec(spec: unknown): ModeSpec {
  const obj = (spec && typeof spec === "object" ? spec : {}) as Record<
    string,
    unknown
  >;
  const out: ModeSpec = {
    color: typeof obj.color === "string" ? obj.color : undefined,
  };
  const roles = sanitizeRoles(obj.roles);
  if (roles) out.roles = roles;
  return out;
}

export function cloneRoles(
  roles: ModeRoles | undefined,
): ModeRoles | undefined {
  return roles ? (JSON.parse(JSON.stringify(roles)) as ModeRoles) : undefined;
}

export function cloneModesFile(file: ModesFile): ModesFile {
  // Small plain data structure; a JSON clone is fine.
  return JSON.parse(JSON.stringify(file)) as ModesFile;
}

export function formatRolePin(pin: RolePin | undefined): string {
  return pin ? `${pin.modelId}/${pin.thinkingLevel}` : "(not pinned)";
}

export function describeRoles(roles: ModeRoles | undefined): string {
  const parts: string[] = [];
  if (roles?.main) parts.push(`main: ${formatRolePin(roles.main)}`);
  if (roles?.oracle) parts.push(`oracle: ${formatRolePin(roles.oracle)}`);
  if (roles?.subagents)
    parts.push(`subagents: ${formatRolePin(roles.subagents)}`);
  return parts.join(" · ");
}

export function orderedModeNames(modes: Record<ModeName, ModeSpec>): string[] {
  // Preserve insertion order from the JSON file (stable in modern runtimes).
  // "custom" is an overlay mode and must not be selectable or persisted.
  return Object.keys(modes).filter((name) => name !== CUSTOM_MODE_NAME);
}

export function isDefaultModeName(name: string): boolean {
  return (DEFAULT_MODE_ORDER as readonly string[]).includes(name);
}
