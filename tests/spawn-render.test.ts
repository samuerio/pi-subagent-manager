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
  assert.match(lines, /⋯ 8 earlier calls/);
  assert.match(lines, /src\/file19\.ts/);
  assert.doesNotMatch(lines, /src\/file7\.ts/);
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
