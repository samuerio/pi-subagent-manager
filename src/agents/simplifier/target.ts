import {
  composeTargetTask,
  type TargetFocus,
  targetParameters,
  targetRefError as sharedTargetRefError,
} from "../targets.ts";

/**
 * The simplifier writes, so its vocabulary is narrower than the reviewer's:
 * only scopes that resolve to the current checkout. Descriptors must stay in
 * step with the child's "Parse the target" section.
 */
export const SIMPLIFIER_TARGETS = ["working-tree", "branch", "paths"] as const;

/**
 * Per-kind scope sentences for the composed first message, sourced from the
 * procedure's own "Parse the target" semantics. No commands and no unfilled
 * placeholders: grammar lives in the procedure, scope in this message.
 */
export const SIMPLIFIER_FOCUS: Record<
  (typeof SIMPLIFIER_TARGETS)[number],
  TargetFocus
> = {
  "working-tree": (ref) =>
    ref === undefined
      ? "Polish the current code changes (staged, unstaged and untracked files)."
      : `Polish the current code changes (staged, unstaged and untracked files) in the worktree at ${ref} (a worktree of the current repository).`,
  branch: (ref) =>
    `Polish the files this branch touched against '${ref}', in the current checkout.`,
  paths: (ref) =>
    `Polish these files or directories as they stand: ${ref}; there is no diff to compare against.`,
};

/**
 * Parameters for the simplifier's spawn verb: typed target instead of a free
 * `task`, so scope claims and pasted diffs never reach the editor.
 */
export const simplifierSpawnParameters = targetParameters(
  SIMPLIFIER_TARGETS,
  "What to polish, mapped to the child's TARGET descriptor. working-tree: omit targetRef for the current checkout or pass an absolute worktree path; branch: base branch name; paths: comma-separated paths.",
  "Value for the target: 'main' for branch, 'src/orch,docs/' for paths, '/path/to/worktree' for working-tree (a worktree of the current repository). Omit for the current checkout's working tree.",
);

/** Ref grammar bound to the simplifier's vocabulary; same voice as the tool's errors. */
export function targetRefError(
  target: string,
  ref: string | undefined,
): string | undefined {
  return sharedTargetRefError(SIMPLIFIER_TARGETS, target, ref);
}

/**
 * The simplifier's first message: TARGET descriptor, focus sentence,
 * self-sufficiency rule. A malformed target throws here, before any child
 * starts and before any file is edited.
 */
export function composeSimplifierTask(params: {
  target: string;
  targetRef?: string;
}): string {
  return composeTargetTask(params, {
    targets: SIMPLIFIER_TARGETS,
    focus: SIMPLIFIER_FOCUS,
    instruction:
      "Read AGENTS.md from the repository root yourself; resolve the scope from git and the working directory; do not ask for context.",
  });
}
