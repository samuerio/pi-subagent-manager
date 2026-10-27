import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import path from "node:path";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";
import { testSpec } from "./helpers/spec.ts";
import type { SpawnLiveDetails } from "../src/types.ts";

const answer = (text: string): AssistantMessage => ({
  role: "assistant",
  content: [{ type: "text", text }],
  provider: "integration-test",
  model: "offline",
  api: "openai-completions",
  stopReason: "stop",
  timestamp: Date.now(),
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const toolUse = (
  id: string,
  name: string,
  args: Record<string, unknown>,
): AssistantMessage => ({
  ...answer(""),
  content: [
    { type: "toolCall", id, name, arguments: args },
  ] as AssistantMessage["content"],
  stopReason: "toolUse",
});
const offlineAgent = testSpec("offline", {
  description: "Offline lifecycle worker",
  tools: ["agent_pause"],
  systemPrompt: "ONLY OFFLINE CHILD",
});

// The throttler's timing is unit-tested; here only the wiring is asserted, so
// the number of partials stays timing-dependent and assertions stay loose.
test(
  "a foreground spawn streams live details and settles stripped of live fields",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        specs: [offlineAgent],
        onRequest: (request) =>
          request.path !== null && request.pathCall === 1
            ? toolUse("tool-1", "read", { file_path: "/etc/hosts" })
            : answer(`child answer ${request.pathCall}`),
      },
      async ({ cwd, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(cwd, "parents"));
        const session = await open(root);
        const partials: SpawnLiveDetails[] = [];
        const final = await tool<SpawnLiveDetails>(
          session,
          "offline_spawn",
          { description: "Live spawn", path: "worker", task: "Answer now" },
          (partial) => {
            const details = (partial as { details?: SpawnLiveDetails }).details;
            if (details?.path) partials.push(details);
          },
        );
        assert.equal(final.state, "completed");
        assert.ok(
          !("recentCalls" in final),
          "live fields never leak into the settled result",
        );
        assert.ok(
          !("assistantPreview" in final),
          "live fields never leak into the settled result",
        );
        for (const partial of partials) {
          assert.equal(partial.path, "/root/worker");
          assert.ok(typeof partial.elapsedMs === "number");
        }
        await close(session);
      },
    );
  },
);

test(
  "the spawn description reaches the settled view on both the foreground and detached paths",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        specs: [offlineAgent],
        onRequest: (request) =>
          request.path !== null && request.pathCall === 1
            ? toolUse("pause-1", "agent_pause", { reason: "Holding" })
            : answer(`child answer ${request.pathCall}`),
      },
      async ({ cwd, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(cwd, "parents"));
        const session = await open(root);
        // Foreground: the streaming path must forward the model-provided label.
        const foreground = await tool<SpawnLiveDetails>(
          session,
          "offline_spawn",
          {
            description: "Foreground label",
            path: "fg",
            task: "Pause until more input",
          },
        );
        assert.equal(foreground.description, "Foreground label");
        // Detached: the single-shot path forwards it too.
        const detached = await tool<SpawnLiveDetails>(
          session,
          "offline_spawn",
          {
            description: "Detached label",
            path: "detached",
            task: "Work in the background",
            wait: false,
          },
        );
        assert.equal(detached.description, "Detached label");
        await close(session);
      },
    );
  },
);

test(
  "a pre-aborted foreground spawn rejects deterministically without settling",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        specs: [offlineAgent],
        onRequest: () => answer("unused"),
      },
      async ({ cwd, open, close, tool }) => {
        const root = SessionManager.create(cwd, path.join(cwd, "parents"));
        const session = await open(root);
        const controller = new AbortController();
        controller.abort();
        await assert.rejects(
          tool(
            session,
            "offline_spawn",
            { description: "Aborted spawn", path: "worker", task: "Task" },
            undefined,
            controller.signal,
          ),
          /Waiting cancelled|This operation was aborted/,
        );
        await close(session);
      },
    );
  },
);
