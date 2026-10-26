import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_SPECS } from "../src/agents/specs.ts";
import type { ThreadView } from "../src/types.ts";
import { withOfflineHarness } from "./helpers/integrationHarness.ts";

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
const review = `Verdict: correct

No blocking findings.

## Human Reviewer Callouts (Non-Blocking)
- (none)`;

test(
  "reviewer_spawn runs the real spec end to end and hands back the verdict",
  { timeout: 30000 },
  async () => {
    await withOfflineHarness(
      {
        specs: [...AGENT_SPECS],
        onRequest: (request) =>
          request.path === "/root/review" ? answer(review) : answer("parent answer"),
      },
      async ({ cwd, open, close, errors, requests, tool }) => {
        // Pin every role to a different model id so routing is observable: the harness
        // default uses one model for all roles, which would make the check vacuous.
        const modes = {
          version: 1,
          currentMode: "default",
          modes: {
            default: {
              roles: {
                main: { provider: "integration-test", modelId: "offline", thinkingLevel: "off" },
                oracle: { provider: "integration-test", modelId: "offline", thinkingLevel: "off" },
                subagents: {
                  provider: "integration-test",
                  modelId: "offline-alt",
                  thinkingLevel: "off",
                },
              },
            },
          },
        };
        await mkdir(path.join(cwd, ".pi"), { recursive: true });
        await writeFile(path.join(cwd, ".pi", "modes.json"), JSON.stringify(modes));
        const session = await open(SessionManager.create(cwd));
        const thread = await tool<ThreadView>(session, "reviewer_spawn", {
          description: "Test spawn",
          path: "review",
          task: "TARGET: working-tree\nFocus on the new spawn parameter handling.",
          wait: true,
        });

        assert.equal(thread.type, "reviewer");
        assert.equal(thread.state, "completed");
        assert.match(thread.output ?? "", /^Verdict: correct/);
        assert.deepEqual(errors, []);

        const child = requests.find((request) => request.path === "/root/review");
        assert.ok(child, "the reviewer session ran");
        // The rubric and the procedure both reach the child, and neither reaches the parent prompt.
        assert.match(child.system, /# Review Guidelines/);
        assert.match(child.system, /# Review Procedure/);
        assert.match(child.messagesText, /TARGET: working-tree/);
        // Read-only allowlist is enforced at declaration time, not just by the prompt.
        for (const name of ["read", "bash", "grep", "find", "ls", "agent_update", "agent_pause"])
          assert.ok(child.toolNames.includes(name), name);
        for (const name of ["write", "edit", "reviewer_spawn", "task_spawn", "agent_wait"])
          assert.equal(child.toolNames.includes(name), false, name);
        // Role routing applies the subagents pin instead of reusing the parent model.
        assert.equal(`${child.provider}/${child.modelId}`, "integration-test/offline-alt");

        // The rubric is a child-role prompt: no other session ever sees it.
        for (const request of requests.filter((entry) => entry.path !== "/root/review"))
          assert.doesNotMatch(request.system, /# Review Guidelines/);
        assert.equal(thread.model, "integration-test/offline-alt");
        await close(session);
      },
    );
  },
);
