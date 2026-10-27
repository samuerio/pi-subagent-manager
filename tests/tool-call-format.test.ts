import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureToolCall,
  toolCallSummary,
} from "../src/ui/tool-call-format.ts";

const cwd = "/home/zhe/workspace/proj";

test("bash calls summarize the command with a bounded preview", () => {
  assert.equal(
    toolCallSummary("bash", { command: "pnpm test auth" }, cwd),
    "$ pnpm test auth",
  );
  const long = "x".repeat(80);
  assert.equal(toolCallSummary("bash", { command: long }, cwd).length, 60 + 3);
  // Multi-line commands collapse to one line.
  assert.equal(toolCallSummary("bash", { command: "a\nb" }, cwd), "$ a b");
});

test("read calls summarize the path with an optional line range", () => {
  assert.equal(
    toolCallSummary("read", { file_path: `${cwd}/src/a.ts` }, cwd),
    "src/a.ts",
  );
  assert.equal(
    toolCallSummary(
      "read",
      { file_path: `${cwd}/src/a.ts`, offset: 12, limit: 29 },
      cwd,
    ),
    "src/a.ts:12-40",
  );
  assert.equal(
    toolCallSummary("read", { path: "/home/zhe/notes/a.md" }, cwd),
    "~/notes/a.md",
  );
});

test("write and edit calls summarize the target path", () => {
  assert.equal(
    toolCallSummary(
      "write",
      { file_path: `${cwd}/src/a.ts`, content: "a\nb\nc" },
      cwd,
    ),
    "src/a.ts (3 lines)",
  );
  assert.equal(
    toolCallSummary("edit", { file_path: `${cwd}/src/a.ts` }, cwd),
    "src/a.ts",
  );
});

test("grep, glob, ls, find and fetch calls summarize their primary argument", () => {
  assert.equal(
    toolCallSummary("grep", { pattern: "retry", path: `${cwd}/src` }, cwd),
    '"retry" in src',
  );
  assert.equal(toolCallSummary("glob", { pattern: "**/*.ts" }, cwd), "**/*.ts");
  assert.equal(toolCallSummary("ls", { path: `${cwd}/src` }, cwd), "src");
  assert.equal(
    toolCallSummary("fetch", { url: "https://example.com" }, cwd),
    "https://example.com",
  );
});

test("unknown tools fall back to their first string argument", () => {
  assert.equal(
    toolCallSummary("custom_tool", { target: "src/a.ts" }, cwd),
    "src/a.ts",
  );
  assert.equal(toolCallSummary("custom_tool", {}, cwd), "");
});

test("summaries are bounded and single-line regardless of argument size", () => {
  const summary = toolCallSummary(
    "bash",
    { command: `${"y".repeat(500)}\n${"z".repeat(500)}` },
    cwd,
  );
  assert.ok(summary.length <= 201);
  assert.ok(!summary.includes("\n"));
});

test("summaries strip terminal escape sequences and control characters", () => {
  assert.equal(
    toolCallSummary(
      "bash",
      { command: "echo hi\x1b[2J\x1b[31mRED\x1b[0m" },
      cwd,
    ),
    "$ echo hiRED",
  );
  assert.equal(
    toolCallSummary("bash", { command: "a\x07b\x1b[1;5Hc\x9bd" }, cwd),
    "$ a bc d",
  );
  assert.equal(
    captureToolCall(
      {
        toolCallId: "3",
        toolName: "bash",
        args: { command: "x\x1b[2Jy" },
        state: "running",
      },
      cwd,
    ).summary,
    "$ xy",
  );
});

test("captureToolCall preserves lifecycle and nesting flags", () => {
  assert.deepEqual(
    captureToolCall(
      {
        toolCallId: "1",
        toolName: "bash",
        args: { command: "ls" },
        state: "running",
      },
      cwd,
    ),
    { name: "bash", summary: "$ ls", state: "running", nested: false },
  );
  assert.deepEqual(
    captureToolCall(
      {
        toolCallId: "2",
        toolName: "read",
        args: { file_path: "/etc/hosts" },
        state: "completed",
        isError: true,
        parentToolCallId: "1",
      },
      cwd,
    ),
    {
      name: "read",
      summary: "/etc/hosts",
      state: "completed",
      isError: true,
      nested: true,
    },
  );
});
