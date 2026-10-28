import assert from "node:assert/strict";
import { test } from "node:test";
import { testSpec } from "./helpers/spec.ts";
import { ThreadManager } from "../src/orch/manager.ts";
import { agentTools } from "../src/orch/tools.ts";
import type { AgentDriver, ThreadEvent } from "../src/types.ts";

const OUTPUT = "a".repeat(20000);
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

type Page = {
  path: string;
  text: string;
  totalCharacters: number;
  nextOffset: number | null;
};

function fixture(driverOutput = OUTPUT) {
  let finish = () => {};
  const manager = new ThreadManager({
    rootSnapshot: () => [],
    getType: (name) => testSpec(name),
    toolsFor: () => [],
    onEvent: (_event: ThreadEvent) => {},
    createDriver: async (options) => {
      const driver: AgentDriver = {
        sessionFile: `/tmp/${options.path.replaceAll("/", "-")}.jsonl`,
        prompt: async () => {
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        },
        steer: async () => {},
        snapshot: () => [],
        output: () => driverOutput,
        abort: async () => finish(),
        dispose: () => {},
        sendUpdate: () => {},
      };
      return driver;
    },
  });
  const tools = agentTools(() => manager, "/root");
  const call = async (params: Record<string, unknown>): Promise<Page> => {
    const tool = tools.find((entry) => entry.name === "agent_output")!;
    const returned = await tool.execute!(
      "id",
      params as never,
      undefined as never,
      undefined as never,
      undefined as never,
    );
    return JSON.parse(
      (returned.content[0] as { type: string; text: string }).text,
    ) as Page;
  };
  const spawnCompleted = async () => {
    const waiting = manager.spawn("/root", {
      path: "worker",
      type: "worker",
      task: "t",
    });
    await tick();
    finish();
    await waiting;
  };
  return { manager, call, spawnCompleted };
}

test("agent_output pages the full output and appends the continuation directive", async () => {
  const { manager, call, spawnCompleted } = fixture();
  await spawnCompleted();

  // The default first page carries the "more" directive pointing at nextOffset.
  const first = await call({ path: "worker" });
  assert.equal(first.totalCharacters, 20000);
  assert.equal(first.nextOffset, 8000);
  assert.match(
    first.text,
    /\[12000 more characters in this output\. Use offset=8000 to continue\.\]$/,
  );
  assert.equal(first.text.startsWith("a".repeat(8000)), true);

  // A mid-output page pages the true content (no compounding of directives).
  const second = await call({ path: "worker", offset: 8000 });
  assert.equal(second.text.startsWith("a".repeat(8000)), true);
  assert.equal(second.nextOffset, 16000);

  // The last page is clean: no directive, nextOffset null.
  const last = await call({ path: "worker", offset: 16000 });
  assert.equal(last.text.length, 4000);
  assert.equal(last.nextOffset, null);
  assert.doesNotMatch(last.text, /more characters/);

  await manager.shutdown();
});

test("agent_output reports an overshooting offset in the page body", async () => {
  const { manager, call, spawnCompleted } = fixture();
  await spawnCompleted();

  const past = await call({ path: "worker", offset: 45210 });
  assert.equal(past.nextOffset, null);
  assert.equal(past.totalCharacters, 20000);
  assert.match(
    past.text,
    /\(no content at offset 45210; the output is 20000 characters\)/,
  );

  await manager.shutdown();
});

test("compact() carries the true output length beside outputTruncated", async () => {
  const { manager, spawnCompleted } = fixture();
  await spawnCompleted();

  const tools = agentTools(() => manager, "/root");
  const wait = tools.find((entry) => entry.name === "agent_wait")!;
  const returned = await wait.execute!(
    "id",
    { path: "worker" },
    undefined as never,
    undefined as never,
    undefined as never,
  );
  const view = returned.details as {
    output: string;
    outputTruncated?: boolean;
    outputCharacters?: number;
  };
  assert.equal(view.output.length, 16000);
  assert.equal(view.outputTruncated, true);
  assert.equal(view.outputCharacters, 20000);

  await manager.shutdown();
});

test("agent_output explains an empty output instead of a blank page", async () => {
  const { manager, call, spawnCompleted } = fixture("");
  await spawnCompleted();

  const empty = await call({ path: "worker" });
  assert.equal(empty.totalCharacters, 0);
  assert.equal(empty.nextOffset, null);
  assert.equal(
    empty.text,
    "(no content available; the thread may be paused or its output empty)",
  );

  const overshoot = await call({ path: "worker", offset: 5 });
  assert.equal(
    overshoot.text,
    "(no content available; the thread may be paused or its output empty)",
  );
  assert.equal(overshoot.nextOffset, null);

  await manager.shutdown();
});
