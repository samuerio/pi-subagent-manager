import * as fs from "node:fs";
import type { AgentRole, ThinkingLevel } from "../types.ts";
import { resolveModesPathSync } from "../modes/file.ts";

export interface RoleRouting {
  /** `provider/model-id` for `--model`-style selection. */
  model: string;
  thinking: ThinkingLevel;
}

/**
 * Resolve a subagent role's model routing from the active mode in modes.json
 * (the same file the prompt-editor extension manages). Both roles are explicitly
 * pinned and a missing/malformed pin is a hard error: dispatch aborts with an
 * error naming the file and the missing piece. There is no fallback to a spec's
 * baked-in model or to the parent's model, because a silently wrong model is
 * worse than a loud failure.
 *
 * Path resolution lives in modes/file.ts: a project `.pi/modes.json` wins
 * over the global `~/.pi/agent/modes.json`.
 */
export function resolveRoleRouting(cwd: string, role: AgentRole): RoleRouting {
  const modesPath = resolveModesPathSync(cwd);

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(modesPath, "utf-8"));
  } catch (error) {
    throw new Error(
      `modes.json: failed to read/parse ${modesPath}: ${(error as Error).message}`,
    );
  }

  const currentMode = parsed?.currentMode;
  if (typeof currentMode !== "string" || !currentMode)
    throw new Error(
      `modes.json: "currentMode" must be a non-empty string in ${modesPath}`,
    );
  const modeSpec = parsed?.modes?.[currentMode];
  if (!modeSpec || typeof modeSpec !== "object")
    throw new Error(
      `modes.json: modes["${currentMode}"] is missing in ${modesPath}`,
    );
  const pin = modeSpec.roles?.[role];
  if (!pin || typeof pin !== "object")
    throw new Error(
      `modes.json: modes["${currentMode}"].roles.${role} is required (subagent dispatches need an explicit pin) in ${modesPath}`,
    );
  for (const field of ["provider", "modelId", "thinkingLevel"] as const) {
    if (typeof pin[field] !== "string" || !pin[field])
      throw new Error(
        `modes.json: modes["${currentMode}"].roles.${role}.${field} must be a non-empty string in ${modesPath}`,
      );
  }
  return {
    model: `${pin.provider}/${pin.modelId}`,
    thinking: pin.thinkingLevel as ThinkingLevel,
  };
}
