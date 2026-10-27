import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildHistoryList,
  collectUserPromptsFromEntries,
  historiesMatch,
  MAX_HISTORY_ENTRIES,
  type PromptEntry,
} from "../src/modes/history.ts";

const entry = (text: string, timestamp: number): PromptEntry => ({
  text,
  timestamp,
});

test("ISO-string entry timestamps parse instead of becoming NaN", () => {
  const prompts = collectUserPromptsFromEntries([
    {
      type: "message",
      timestamp: "2026-01-02T03:04:05.000Z",
      message: { role: "user", content: [{ type: "text", text: "old entry" }] },
    },
    {
      type: "message",
      timestamp: 2000,
      message: {
        role: "user",
        content: [{ type: "text", text: "epoch entry" }],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: "no timestamp" }],
      },
    },
    {
      type: "message",
      timestamp: "garbage",
      message: {
        role: "user",
        content: [{ type: "text", text: "garbage ts" }],
      },
    },
  ]);
  // Input order is preserved (sorting happens in buildHistoryList); every
  // entry gets a finite numeric timestamp whatever shape pi used.
  const iso = Date.parse("2026-01-02T03:04:05.000Z");
  assert.equal(prompts[0]!.text, "old entry");
  assert.equal(prompts[0]!.timestamp, iso);
  assert.equal(prompts[1]!.text, "epoch entry");
  assert.equal(prompts[1]!.timestamp, 2000);
  assert.ok(Number.isFinite(prompts[2]!.timestamp));
  // Unparsable timestamps still get a finite sort key.
  assert.ok(Number.isFinite(prompts[3]!.timestamp));
  // The merged list sorts the ISO string after the epoch number.
  const merged = buildHistoryList(prompts, []);
  assert.deepEqual(
    merged.map((prompt) => prompt.text),
    ["epoch entry", "old entry", "no timestamp", "garbage ts"],
  );
});

test("collectUserPromptsFromEntries keeps only user messages with text", () => {
  const prompts = collectUserPromptsFromEntries([
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "text", text: " hello " }],
        timestamp: 2,
      },
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "answer" }],
        timestamp: 3,
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content: [{ type: "image", data: "x" }],
        timestamp: 4,
      },
    },
    { type: "other" },
  ]);
  assert.deepEqual(prompts, [entry("hello", 2)]);
});

test("buildHistoryList sorts by timestamp, dedupes and caps", () => {
  const merged = buildHistoryList(
    [entry("b", 2), entry("c", 9)],
    [entry("c", 9), entry("a", 1)],
  );
  assert.deepEqual(
    merged.map((p) => p.text),
    ["a", "b", "c"],
  );
  const flooded = buildHistoryList(
    Array.from({ length: MAX_HISTORY_ENTRIES + 20 }, (_, i) =>
      entry(`p${i}`, i),
    ),
    [],
  );
  assert.equal(flooded.length, MAX_HISTORY_ENTRIES);
  assert.equal(flooded[0]!.text, `p${20}`);
});

test("historiesMatch compares both text and timestamps", () => {
  assert.ok(historiesMatch([entry("a", 1)], [entry("a", 1)]));
  assert.ok(!historiesMatch([entry("a", 1)], [entry("a", 2)]));
  assert.ok(!historiesMatch([entry("a", 1)], []));
});
