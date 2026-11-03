import { type TSchema, Type } from "typebox";
import { SPAWN_BASE_FIELDS } from "../types.ts";

/**
 * The shared grammar of the target-resolver agents (reviewer, simplifier):
 * typed target params instead of a free-form `task`, a code-composed first
 * message. Each agent's `<agent>/target.ts` narrows this to its own
 * vocabulary.
 */

/** One per-kind sentence for the composed first message; `ref` arrives trimmed. */
export type TargetFocus = (ref?: string) => string;

/**
 * Spawn-verb parameters for a target-resolver agent: the shared spawn
 * mechanics plus a typed target. There is no `task` field on purpose: the
 * caller chooses what the child works on, never what the child reads.
 */
export function targetParameters(
  targets: readonly string[],
  targetDescription: string,
  refDescription: string,
): TSchema {
  return Type.Object({
    ...SPAWN_BASE_FIELDS,
    target: Type.Union(
      targets.map((target) => Type.Literal(target)),
      { description: targetDescription },
    ),
    targetRef: Type.Optional(Type.String({ description: refDescription })),
  });
}

/**
 * Per-kind targetRef grammar, stated in the tool's own voice so a rejected
 * call can be re-issued correctly in the same round. Shape checks only: compose
 * stays pure, so a wrong worktree path or a stale base surfaces as the child's
 * own fast git failure, not here.
 */
const REF_GRAMMAR: Record<string, { pattern: RegExp; describe: string }> = {
  "working-tree": {
    pattern: /^\/[^\n]*$/,
    describe: "an absolute worktree path",
  },
  branch: {
    pattern: /^\S+$/,
    describe: "a base branch name without whitespace",
  },
  commit: {
    pattern: /^[0-9a-fA-F]{4,40}$/,
    describe: "a 4-40 character git SHA",
  },
  paths: {
    pattern: /^\S+$/,
    describe: "comma-separated paths without whitespace",
  },
};

/** Why this target/targetRef pair is unusable, or undefined when it is fine. */
export function targetRefError(
  targets: readonly string[],
  target: string,
  ref: string | undefined,
): string | undefined {
  if (!targets.includes(target))
    return `target must be one of ${targets.join(", ")}, got "${target}"`;
  const value = ref?.trim();
  // working-tree is the only kind whose ref is optional: omit it for the
  // current checkout.
  if (!value)
    return target === "working-tree"
      ? undefined
      : `targetRef is required for target ${target}, e.g. target: ${target}, targetRef: "..."`;
  const grammar = REF_GRAMMAR[target];
  if (!grammar) return undefined;
  return grammar.pattern.test(value)
    ? undefined
    : `${target} targetRef must be ${grammar.describe}, got "${ref}"`;
}

/**
 * The child's first message for a target-resolver agent: the TARGET
 * descriptor, the per-kind focus sentence, then the agent's self-sufficiency
 * rule. A malformed target throws here, before any child starts.
 */
export function composeTargetTask(
  params: { target: string; targetRef?: string },
  agent: {
    targets: readonly string[];
    focus: Record<string, TargetFocus>;
    instruction: string;
  },
): string {
  const error = targetRefError(agent.targets, params.target, params.targetRef);
  if (error) throw new Error(error);
  const ref = params.targetRef?.trim();
  const descriptor = ref ? `${params.target}:${ref}` : params.target;
  return `TARGET: ${descriptor}\n\n${agent.focus[params.target](ref)}\n\n${agent.instruction}`;
}
