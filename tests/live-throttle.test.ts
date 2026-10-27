import assert from "node:assert/strict";
import { test } from "node:test";
import type { TranscriptSnapshot, TranscriptToolState } from "../src/types.ts";
import { createLiveThrottler } from "../src/orch/live-throttle.ts";

let revision = 0;
const tool = (
  id: string,
  state: TranscriptToolState["state"],
): TranscriptToolState => ({
  toolCallId: id,
  toolName: "read",
  args: {},
  state,
});
const snapshot = (
  tools: TranscriptToolState[],
  generation = 1,
): TranscriptSnapshot => ({
  revision: ++revision,
  generation,
  messages: [],
  assistant: null,
  tools,
  inheritedCount: 0,
});

function harness(heartbeatMs = 0) {
  const emitted: TranscriptSnapshot[] = [];
  const throttler = createLiveThrottler({
    heartbeatMs,
    emit: (s) => emitted.push(s),
  });
  return { emitted, throttler };
}

test("a tool-call lifecycle change emits immediately, an identical one does not", () => {
  const { emitted, throttler } = harness();
  throttler.push(snapshot([]));
  assert.equal(emitted.length, 1);
  throttler.push(snapshot([]));
  assert.equal(emitted.length, 1, "unchanged fingerprint stays quiet");
  throttler.push(snapshot([tool("a", "running")]));
  throttler.push(snapshot([tool("a", "running")]));
  assert.equal(emitted.length, 2);
  throttler.push(snapshot([tool("a", "completed")]));
  assert.equal(emitted.length, 3, "running→completed is an immediate emit");
  throttler.stop();
});

test("an error flag change counts as a fingerprint change", () => {
  const { emitted, throttler } = harness();
  const failed = { ...tool("a", "completed"), isError: true };
  throttler.push(snapshot([tool("a", "completed")]));
  throttler.push(snapshot([failed]));
  assert.equal(emitted.length, 2);
  throttler.stop();
});

test("flush emits the latest snapshot once and stop clears state", () => {
  const { emitted, throttler } = harness();
  throttler.push(snapshot([]));
  throttler.push(snapshot([tool("a", "running")]));
  throttler.flush();
  throttler.flush();
  assert.equal(
    emitted.length,
    2,
    "an already-emitted snapshot flushes only once",
  );
  // A metrics-only snapshot is newer but not fingerprint-worthy; flush surfaces it.
  throttler.push(snapshot([tool("a", "running")]));
  assert.equal(
    emitted.length,
    2,
    "metrics-only pushes stay quiet until flushed",
  );
  throttler.flush();
  assert.equal(emitted.length, 3, "flush surfaces the metrics-only frame");
  throttler.stop();
  throttler.flush();
  assert.equal(emitted.length, 3, "stop discards the pending snapshot");
});

test("regressing revisions are dropped and a generation change resets the fingerprint", () => {
  const { emitted, throttler } = harness();
  const first = snapshot([tool("a", "running")]);
  throttler.push(first);
  assert.equal(emitted.length, 1);
  const stale = {
    ...snapshot([tool("a", "running")]),
    revision: 0,
    generation: 1,
  };
  throttler.push(stale);
  assert.equal(emitted.length, 1, "older revision never emits");
  throttler.push(snapshot([], 2));
  assert.equal(emitted.length, 2, "generation change emits immediately");
  throttler.push(snapshot([], 2));
  assert.equal(
    emitted.length,
    2,
    "an identical fingerprint under the new generation stays quiet",
  );
  throttler.stop();
});

test("the heartbeat re-emits the latest snapshot and is disabled at zero", async () => {
  const { emitted, throttler } = harness(20);
  throttler.push(snapshot([tool("a", "running")]));
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.ok(emitted.length >= 2, "heartbeat emitted while nothing changed");
  throttler.stop();
  const count = emitted.length;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(emitted.length, count, "stop halts the heartbeat");

  const quiet = harness(0);
  quiet.throttler.push(snapshot([]));
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(quiet.emitted.length, 1, "heartbeatMs 0 never re-emits");
  quiet.throttler.stop();
});
