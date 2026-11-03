import {
  composeTargetTask,
  type TargetFocus,
  targetParameters,
  targetRefError as sharedTargetRefError,
} from "../targets.ts";

/**
 * The reviewer's dispatch vocabulary: the TARGET descriptors its procedure
 * section 1 resolves. The child prompt is the reader side, this table the
 * writer side, so descriptors change in both places together. `pr` is not a
 * kind: the spawn side cannot fill a PR descriptor's placeholders ({title},
 * {baseBranch}, {mergeBaseSha}) without running gh/git, and the child cannot
 * resolve one honestly either, so the whole entry was dropped with the
 * reviewer-focus-alignment spec.
 */
export const REVIEWER_TARGETS = [
  "working-tree",
  "branch",
  "commit",
  "paths",
] as const;

/**
 * Per-kind focus sentences for the composed first message, transplanted from
 * review.ts' per-target prompts (the caller of /review was the resolving
 * agent there; the child is here). Two transplant rules keep this aligned
 * without importing its mechanism prose: no sentence carries a placeholder
 * the spawn side cannot fill, and no sentence carries git/gh commands (the
 * procedure's section 2 owns those, and its recipes are better than review.ts'
 * fallback variants). The closing "provide prioritized findings" line stays
 * in the rubric's Output format section.
 */
export const REVIEWER_FOCUS: Record<
  (typeof REVIEWER_TARGETS)[number],
  TargetFocus
> = {
  "working-tree": (ref) =>
    ref === undefined
      ? "Review the current code changes (staged, unstaged, and untracked files)."
      : `Review the current code changes (staged, unstaged, and untracked files) in the worktree at ${ref} (a worktree of the current repository).`,
  branch: (ref) => {
    const asked = ref === undefined ? "<base>" : ref;
    return `Review the code changes against the base branch '${asked}'. An unresolvable base is a pause, not a guess: run \`git rev-parse --abbrev-ref '${asked}@{upstream}'\`; on success get the merge base with \`git merge-base HEAD <upstream>\`, on failure with \`git merge-base HEAD '${asked}'\`; then inspect the changes with \`git diff <mergeBase>\`. If both merge-base attempts fail, call agent_pause and ask for the correct base instead of reviewing a wrong diff.`;
  },
  commit: (ref) => `Review the code changes introduced by commit ${ref}.`,
  paths: (ref) =>
    `Review the code in the following paths: ${ref}. This is a snapshot review (not a diff). Read the files directly in these paths.`,
};

/**
 * Parameters for the reviewer's spawn verb: typed target instead of a free
 * `task`, so the composed first message keeps the caller's prose out of the
 * child's context and adversarial review stays adversarial.
 */
export const reviewerSpawnParameters = targetParameters(
  REVIEWER_TARGETS,
  "What to review, mapped to the child's TARGET descriptor. working-tree: omit targetRef for the current checkout or pass an absolute worktree path; branch: base branch name; commit: SHA; paths: comma-separated paths.",
  "Value for the target: 'main' for branch, 'abc1234' for commit, 'src/orch,docs/' for paths, '/path/to/worktree' for working-tree (a worktree of the current repository). Omit for the current checkout's working tree.",
);

/** Ref grammar bound to the reviewer's vocabulary; same voice as the tool's errors. */
export function targetRefError(
  target: string,
  ref: string | undefined,
): string | undefined {
  return sharedTargetRefError(REVIEWER_TARGETS, target, ref);
}

/** The reviewer's first message: TARGET descriptor, focus sentence, self-sufficiency rule. */
export function composeReviewerTask(params: {
  target: string;
  targetRef?: string;
}): string {
  return composeTargetTask(params, {
    targets: REVIEWER_TARGETS,
    focus: REVIEWER_FOCUS,
    instruction:
      "Read AGENTS.md / CLAUDE.md / REVIEW_GUIDELINES.md yourself; resolve the change from git; do not ask for context.",
  });
}
