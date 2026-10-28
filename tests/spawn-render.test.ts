import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ThreadView } from "../src/types.ts";
import {
  spawnCallText,
  renderSpawnCall,
  renderSpawnResult,
  spawnCollapsedText,
  liveExpandedLines,
} from "../src/ui/spawn-render.ts";
initTheme();
import { threadActivity } from "../src/ui/thread-tree.ts";

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function thread(
  patch: Partial<ThreadView & { outputTruncated?: boolean }> = {},
): ThreadView & { outputTruncated?: boolean } {
  return {
    path: "/root/worker",
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "completed",
    task: "Investigate the flaky test",
    status: "Completed; session retained",
    createdAt: 1,
    updatedAt: 2,
    elapsedMs: 1000,
    inputTokens: 1200,
    outputTokens: 300,
    costUsd: 0.0021,
    output: "## Findings\n\nThe test was flaky.",
    ...patch,
  };
}

/** Render a component to plain text; a wide line avoids wrapping. */
const rendered = (component: { render: (width: number) => string[] }) =>
  component
    .render(400)
    .map((line) => stripTerminalSequences(line))
    .join("\n");

const callResult = (details: unknown, text = "{}") => ({
  content: [{ type: "text" as const, text }],
  details,
});

// --- call rendering -------------------------------------------------------------------------

test("the call line shows the path handle plus the model-provided description", () => {
  assert.equal(
    spawnCallText(
      { path: "/root/finder", description: "Probe auth headers" },
      "finder_spawn",
    ),
    "finder_spawn /root/finder Probe auth headers",
  );
  const call = rendered(
    renderSpawnCall(
      { path: "/root/finder", description: "Probe auth headers" },
      theme,
      "finder_spawn",
    ),
  );
  assert.match(call, /finder_spawn/);
  assert.match(call, /\/root\/finder/);
  assert.match(call, /Probe auth headers/);
});

test("a missing description or path renders placeholders instead of crashing", () => {
  assert.equal(spawnCallText({}, "task_spawn"), "task_spawn ...");
  assert.equal(
    spawnCallText({ description: 42 }, "task_spawn"),
    "task_spawn ...",
  );
  assert.equal(
    spawnCallText({ description: "Probe auth headers" }, "task_spawn"),
    "task_spawn Probe auth headers",
  );
  assert.equal(
    spawnCallText(
      { path: 42, description: "Probe auth headers" },
      "task_spawn",
    ),
    "task_spawn Probe auth headers",
  );
});

// --- collapsed result -----------------------------------------------------------------------

test("the collapsed line shows state, model and metrics, not the description", () => {
  const view = thread({
    description: "Probe auth headers",
    model: "engy/deepseek-v4.1-flash",
    thinkingLevel: "high",
  });
  assert.equal(
    spawnCollapsedText(view),
    "completed  engy/deepseek-v4.1-flash:high  1s ↑1.2k ↓300 $0.0021",
  );
  assert.ok(!spawnCollapsedText(view).includes("Probe auth headers"));
  // A thread that has not reported its model yet falls back to the placeholder.
  assert.match(spawnCollapsedText(thread()), /^completed  model pending  /);
});

// --- expanded result ------------------------------------------------------------------------

test("the expanded view renders status, output, truncation and session", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        thread({
          description: "Probe auth headers",
          outputTruncated: true,
          sessionFile: "/s/worker.jsonl",
        }),
      ),
      { expanded: true },
      theme,
    ) as never,
  );
  // The expanded view reads like a report: task on top, answer in the middle,
  // state/model/metrics footer directly above the session line.
  assert.match(lines, /Investigate the flaky test/);
  assert.match(lines, /The test was flaky/);
  const lineList = lines.split("\n");
  // A blank line separates the report body from the call line above it.
  assert.equal(lineList[0], "");
  const taskIndex = lineList.findIndex((line) =>
    line.includes("Investigate the flaky test"),
  );
  const ruleIndex = lineList.findIndex((line) =>
    line.includes("\u2500\u2500\u2500"),
  );
  const outputIndex = lineList.findIndex((line) =>
    line.includes("The test was flaky"),
  );
  const statusIndex = lineList.findIndex((line) =>
    line.includes("completed · model pending"),
  );
  const sessionIndex = lineList.findIndex((line) =>
    line.includes("session: /s/worker.jsonl"),
  );
  assert.ok(taskIndex >= 0 && ruleIndex > taskIndex && ruleIndex < outputIndex);
  assert.ok(
    outputIndex >= 0 && statusIndex > outputIndex && statusIndex < sessionIndex,
  );
  assert.match(lines, /truncated at 16000/);
  // The shared fact string keeps the notification copy (index.ts) identical
  // to the renderer line.
  assert.match(lines, /agent_output \/root\/worker for the rest/);
  assert.match(lines, /session: /);
});

test("the expanded view reports a child error instead of output", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(thread({ output: undefined, error: "spawn failed: no pin" })),
      { expanded: true },
      theme,
    ) as never,
  );
  assert.match(lines, /spawn failed: no pin/);
  assert.doesNotMatch(lines, /Findings/);
});

test("the expanded view shows a placeholder when there is no output", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(thread({ output: undefined })),
      { expanded: true },
      theme,
    ) as never,
  );
  assert.match(lines, /\(no output\)/);
  assert.match(lines, /Investigate the flaky test/);
  // An empty output must not leave a rule dangling under the task.
  assert.ok(!lines.includes("\u2500\u2500\u2500"));
});

test("the expanded view stays quiet while a child is starting or running", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        thread({ state: "running", output: undefined, sessionFile: undefined }),
      ),
      { expanded: true },
      theme,
    ) as never,
  );
  assert.match(lines, /Investigate the flaky test/);
  assert.doesNotMatch(lines, /no output/);
  assert.doesNotMatch(lines, /\u2500\u2500\u2500/);
  assert.match(lines, /running · model pending/);
});

// --- throw path -----------------------------------------------------------------------------

test("a thrown result with wiped details renders dyed envelope text", () => {
  const errored = rendered(
    renderSpawnResult(
      callResult(undefined, "boom"),
      { expanded: true },
      theme,
      {
        isError: true,
      },
    ) as never,
  );
  assert.equal(errored.trim(), "boom");
  const plain = rendered(
    renderSpawnResult(
      callResult(undefined, "boom"),
      { expanded: true },
      theme,
    ) as never,
  );
  assert.equal(plain.trim(), "boom");
});

// --- activity fallback chain ----------------------------------------------------------------

test("threadActivity adds the description in front of the status, it does not replace it", () => {
  assert.equal(
    threadActivity(thread({ description: "Probe auth headers" })),
    "Probe auth headers · Completed; session retained",
  );
  // A described thread without a status sentence shows the description alone.
  assert.equal(
    threadActivity(thread({ description: "Probe auth headers", status: "" })),
    "Probe auth headers",
  );
  // No description: unchanged original behavior.
  assert.equal(threadActivity(thread()), "Completed; session retained");
});

// --- live rendering (partial updates during a blocking spawn) -------------------------------

import type { LiveToolCall } from "../src/types.ts";

const call = (patch: Partial<LiveToolCall>): LiveToolCall => ({
  name: "read",
  summary: "src/auth/retry.ts",
  state: "completed",
  nested: false,
  ...patch,
});

const liveThread = (
  patch: Partial<
    ThreadView & { recentCalls?: LiveToolCall[]; assistantPreview?: string }
  > = {},
) =>
  thread({
    state: "running",
    output: undefined,
    sessionFile: undefined,
    model: "engy/deepseek-v4.1-flash",
    thinkingLevel: "high",
    ...patch,
  }) as ThreadView & {
    recentCalls?: LiveToolCall[];
    assistantPreview?: string;
  };

test("a partial update renders the latest child call above the status line", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          recentCalls: [call({ name: "bash", summary: "$ pnpm test" })],
        }),
      ),
      { expanded: false, isPartial: true },
      theme,
    ) as never,
  );
  const list = lines.split("\n");
  assert.equal(list.length, 2);
  assert.equal(list[0].trimEnd(), "→ bash $ pnpm test");
  assert.match(
    list[1],
    /running · engy\/deepseek-v4\.1-flash:high · 1s ↑1\.2k ↓300 \$0\.0021/,
  );
});

test("a partial update without child calls renders the status line alone", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(liveThread()),
      { expanded: false, isPartial: true },
      theme,
    ) as never,
  );
  const list = lines.split("\n");
  assert.equal(list.length, 1);
  assert.match(list[0], /running · engy\/deepseek-v4\.1-flash:high · /);
});

test("the live expanded view shows the trail, the preview tail, then the status footer", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          recentCalls: [
            call({ name: "bash", summary: "$ pnpm test auth" }),
            call({ name: "edit", summary: "src/auth/retry.ts" }),
            call({ state: "running" }),
          ],
          assistantPreview:
            "1\n2\n3\nLine four of progress.\nLine five of progress.",
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  const list = lines.split("\n");
  // The skeleton mirrors the settled report: blank line, activity, blank
  // line, status footer. The trail reads before the preview.
  assert.equal(list[0], "");
  assert.match(lines, /→ bash \$ pnpm test auth/);
  assert.match(lines, /→ edit src\/auth\/retry\.ts/);
  assert.match(lines, /→ read src\/auth\/retry\.ts/);
  // The preview is the tail of the latest assistant text, not its head.
  assert.match(lines, /Line five of progress\./);
  assert.doesNotMatch(lines, /^1$/);
  const statusIndex = list.findIndex((line) =>
    line.includes("running · engy/deepseek-v4.1-flash:high"),
  );
  const previewIndex = list.findIndex((line) =>
    line.includes("Line five of progress"),
  );
  assert.ok(previewIndex >= 0 && statusIndex > previewIndex);
  assert.doesNotMatch(lines, /no output/);
});

test("the live trail collapses earlier calls into a counter", () => {
  const calls = Array.from({ length: 20 }, (_, index) =>
    call({ name: "read", summary: `src/file${index}.ts` }),
  );
  const lines = rendered(
    renderSpawnResult(
      callResult(liveThread({ recentCalls: calls })),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  assert.match(lines, /⋯ 12 earlier calls/);
  assert.match(lines, /src\/file19\.ts/);
  assert.doesNotMatch(lines, /src\/file11\.ts/);
});

test("the live preview truncates wide lines without leaking escape codes", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          // renderer-level guard: even if data-side stripping is bypassed, the
          // visible band stays clean because truncation clips to width.
          assistantPreview: `${"quote ".repeat(40)}tail`,
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  assert.match(lines, /tail/);
  assert.ok(!lines.includes("\x1b"));
});

test("the newest call stays visible even when a narrow width wraps it past the cap", () => {
  const huge = "x".repeat(400);
  const lines = liveExpandedLines(
    liveThread({
      recentCalls: [
        call({ name: "read", summary: "src/old.ts" }),
        call({ name: "bash", summary: `$ ${huge}`, state: "running" }),
      ],
    }),
    18,
    theme,
  );
  const text = lines.map((line) => stripTerminalSequences(line)).join("\n");
  // The oversized newest call is never collapsed into the "earlier" counter.
  assert.match(text, /→ bash/);
  assert.match(text, /⋯ 1 earlier calls/);
});

test("nested child calls render indented below their parent's window slot", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          recentCalls: [
            call({ name: "bash", summary: "$ pnpm test" }),
            call({ nested: true, summary: "src/a.ts" }),
          ],
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  assert.match(lines, /↳ read src\/a\.ts/);
});

test("a running call is marked interrupted once the child is no longer active", () => {
  const lines = liveExpandedLines(
    liveThread({ state: "stopped", recentCalls: [call({ state: "running" })] }),
    400,
    theme,
  );
  const text = lines.map((line) => stripTerminalSequences(line)).join("\n");
  assert.match(text, /\(interrupted\)/);
});

test("a partial update without a preview yet stays quiet about output", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(liveThread()),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  assert.doesNotMatch(lines, /no output/);
  assert.match(lines, /running · engy\/deepseek-v4\.1-flash:high/);
});

test("a settled result never renders the live view, even with live fields present", () => {
  const details = liveThread({ state: "completed", output: "## Findings" });
  const collapsed = rendered(
    renderSpawnResult(
      callResult(details),
      { expanded: false, isPartial: false },
      theme,
    ) as never,
  );
  assert.match(
    collapsed,
    /completed  engy\/deepseek-v4\.1-flash:high  1s ↑1\.2k ↓300 \$0\.0021/,
  );
  assert.doesNotMatch(collapsed, /→ read/);
  const expanded = rendered(
    renderSpawnResult(
      callResult(details),
      { expanded: true, isPartial: false },
      theme,
    ) as never,
  );
  assert.doesNotMatch(expanded, /→ read/);
  assert.match(expanded, /Findings/);
});
test("the live expanded view shows the task above a guarded rule", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          recentCalls: [call({ name: "bash", summary: "pnpm test" })],
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  const list = lines.split("\n");
  const taskIndex = list.findIndex((line) =>
    line.includes("Investigate the flaky test"),
  );
  const ruleIndex = list.findIndex((line) => line.includes("\u2500"));
  const callIndex = list.findIndex((line) => line.includes("→ bash"));
  assert.ok(taskIndex >= 0 && ruleIndex > taskIndex && ruleIndex < callIndex);
});

test("the live expanded view omits the rule without activity", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(liveThread()),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  // The starting/queued block still shows the brief, but nothing to separate.
  assert.match(lines, /Investigate the flaky test/);
  assert.doesNotMatch(lines, /\u2500/);
});

test("the live task clips at four wrapped lines with an inline marker", () => {
  const task = Array.from(
    { length: 10 },
    (_, index) => `Task line ${index}`,
  ).join("\n");
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          task,
          recentCalls: [call({ name: "bash", summary: "pnpm test" })],
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  // Source lines are wrapped individually, so even width 400 keeps ten
  // wrapped lines and engages the clip path; the marker coverage lives in
  // the width-30 re-render below.
  assert.doesNotMatch(lines, /\.\.\./);
  const narrow = renderSpawnResult(
    callResult(
      liveThread({
        task,
        recentCalls: [call({ name: "bash", summary: "pnpm test" })],
      }),
    ),
    { expanded: true, isPartial: true },
    theme,
  ) as { render: (width: number) => string[] };
  const raw = stripTerminalSequences(narrow.render(30).join("\n"));
  assert.match(raw, /Task line 0/);
  assert.match(raw, /Task line 3 …/);
  assert.ok(!raw.includes("Task line 4"));
  // truncateToWidth must not layer its own "..." under the inline " …".
  assert.ok(!raw.includes("..."));
});

test("the live task keeps its clip marker at narrow width", () => {
  const longLine = `word `.repeat(60).trim();
  const lines = renderSpawnResult(
    callResult(liveThread({ task: longLine })),
    { expanded: true, isPartial: true },
    theme,
  ) as { render: (width: number) => string[] };
  const raw = lines.render(18).join("\n");
  assert.ok(raw.includes("…"));
  // The task band itself stays within width with the marker intact; other
  // lines (status footer) are owned by their own renderers.
  const taskBand = stripTerminalSequences(raw)
    .split("\n")
    .filter((line) => line.includes("word"));
  assert.ok(taskBand.length > 0);
  assert.ok(taskBand.every((line) => line.length <= 18));
  assert.ok(taskBand.at(-1)!.trimEnd().endsWith("…"));
});

test("the settled view still renders the full multi-paragraph task", () => {
  const task = Array.from(
    { length: 12 },
    (_, index) => `Paragraph ${index}`,
  ).join("\n\n");
  const lines = rendered(
    renderSpawnResult(
      callResult(thread({ task, output: "answer" })),
      { expanded: true },
      theme,
    ),
  );
  assert.match(lines, /Paragraph 0/);
  assert.match(lines, /Paragraph 11/);
  assert.doesNotMatch(lines, /…/);
});
test("the live rule guard covers calls without task and preview-only", () => {
  // Task missing but calls present: no dangling rule above the trail.
  const callLines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          task: "",
          recentCalls: [call({ name: "bash", summary: "pnpm test" })],
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  assert.doesNotMatch(callLines, /\u2500/);
  assert.match(callLines, /→ bash/);
  // Preview only, no calls: the rule separates the task from the preview.
  const previewLines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          assistantPreview: "Line one of progress.",
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  const list = previewLines.split("\n");
  const taskIndex = list.findIndex((line) =>
    line.includes("Investigate the flaky test"),
  );
  const ruleIndex = list.findIndex((line) => line.includes("\u2500"));
  const previewIndex = list.findIndex((line) =>
    line.includes("Line one of progress"),
  );
  assert.ok(
    taskIndex >= 0 && ruleIndex > taskIndex && ruleIndex < previewIndex,
  );
});

test("the live task strips control characters before width math", () => {
  const lines = rendered(
    renderSpawnResult(
      callResult(
        liveThread({
          task: "Fix\x1b[31m the flaky\x07 test",
        }),
      ),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  assert.match(lines, /Fix the flaky  test/);
  assert.ok(!lines.includes("\x1b"));
  assert.ok(!lines.includes("\x07"));
});
test("the live task budget skips blank paragraph lines", () => {
  const task = "one\n\ntwo\n\nthree\n\nfour\n\nfive";
  const lines = rendered(
    renderSpawnResult(
      callResult(liveThread({ task })),
      { expanded: true, isPartial: true },
      theme,
    ) as never,
  );
  const list = stripTerminalSequences(lines).split("\n");
  const kept = list.filter((line) => /^(one|two|three|four|five)/.test(line));
  // The 5th visible line is dropped content: the budget line must carry the
  // inline marker (asserting "four …" exactly catches the exact-fill case
  // where the overflow check never fires).
  assert.deepEqual(kept, ["one", "two", "three", "four …"]);
  // The blank separators never render, and the budget line carries the marker.
  assert.ok(!lines.includes("five"));
});
