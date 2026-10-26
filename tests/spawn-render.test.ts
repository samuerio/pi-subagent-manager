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
    spawnCallText({ path: "/root/finder", description: "Probe auth headers" }, "finder_spawn"),
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
  assert.equal(spawnCallText({ description: 42 }, "task_spawn"), "task_spawn ...");
  assert.equal(
    spawnCallText({ description: "Probe auth headers" }, "task_spawn"),
    "task_spawn Probe auth headers",
  );
  assert.equal(
    spawnCallText({ path: 42, description: "Probe auth headers" }, "task_spawn"),
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
  const taskIndex = lineList.findIndex((line) => line.includes("Investigate the flaky test"));
  const ruleIndex = lineList.findIndex((line) => line.includes("\u2500\u2500\u2500"));
  const outputIndex = lineList.findIndex((line) => line.includes("The test was flaky"));
  const statusIndex = lineList.findIndex((line) => line.includes("completed · model pending"));
  const sessionIndex = lineList.findIndex((line) => line.includes("session: /s/worker.jsonl"));
  assert.ok(taskIndex >= 0 && ruleIndex > taskIndex && ruleIndex < outputIndex);
  assert.ok(outputIndex >= 0 && statusIndex > outputIndex && statusIndex < sessionIndex);
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
      callResult(thread({ state: "running", output: undefined, sessionFile: undefined })),
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
    renderSpawnResult(callResult(undefined, "boom"), { expanded: true }, theme, {
      isError: true,
    }) as never,
  );
  assert.equal(errored.trim(), "boom");
  const plain = rendered(
    renderSpawnResult(callResult(undefined, "boom"), { expanded: true }, theme) as never,
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
