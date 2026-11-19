import assert from "node:assert/strict";
import test from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  readRegistry,
  REGISTRY_DELTA_ENTRY,
  REGISTRY_ENTRY,
  RegistryWriter,
  type RegistryDelta,
  type SavedRegistry,
} from "../src/orch/registry.ts";
import type { SavedThread } from "../src/types.ts";
import { testSpec } from "./helpers/spec.ts";

const ROOT = "root-session";

const thread = (name: string, leaf: string, extra: Partial<SavedThread> = {}): SavedThread => ({
  view: {
    path: `/root/${name}`,
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "running",
    task: `task ${name}`,
    status: "Working",
    createdAt: 1,
    sessionFile: `/sessions/${name}.jsonl`,
    sessionLeafId: leaf,
  },
  definition: testSpec("worker", { systemPrompt: "a long system prompt" }),
  ...extra,
});
const withView = (saved: SavedThread, view: Partial<SavedThread["view"]>): SavedThread => ({
  ...saved,
  view: { ...saved.view, ...view },
});

const custom = (customType: string, data: unknown): SessionEntry => ({
  type: "custom",
  id: String(Math.random()),
  parentId: null,
  timestamp: new Date().toISOString(),
  customType,
  data,
});

/** A branch as Pi reloads it: JSON round-tripped entries, with unrelated entries interleaved. */
const recordingWriter = () => {
  const branch: SessionEntry[] = [];
  const entries: { customType: string; data: SavedRegistry | RegistryDelta }[] = [];
  const writer = new RegistryWriter((customType, data) => {
    entries.push({ customType, data });
    branch.push(custom(customType, JSON.parse(JSON.stringify(data))));
    branch.push(custom("other:v1", { unrelated: true }));
  });
  return { branch, entries, writer };
};

test("writes the whole registry once, then only what changed", () => {
  const { branch, entries, writer } = recordingWriter();
  const a = withView(thread("a", "a1"), { state: "completed", status: "Completed", output: "A" });
  const b = thread("b", "b1");
  writer.write(ROOT, [a, b]);
  writer.write(ROOT, [a, b]);
  const checkpoint = withView(b, { sessionLeafId: "b2", inputTokens: 5 });
  writer.write(ROOT, [a, checkpoint]);
  const restarted = withView(checkpoint, { output: undefined, lastStartedAt: 2 });
  const retyped = { ...restarted, definition: { ...restarted.definition, systemPrompt: "new" } };
  const c = thread("c", "c1");
  writer.write(ROOT, [withView(a, { output: undefined }), retyped, c]);

  assert.deepEqual(entries, [
    { customType: REGISTRY_ENTRY, data: { version: 1, rootSessionId: ROOT, threads: [a, b] } },
    {
      customType: REGISTRY_DELTA_ENTRY,
      data: {
        version: 1,
        rootSessionId: ROOT,
        changes: [{ path: "/root/b", view: { sessionLeafId: "b2", inputTokens: 5 } }],
      },
    },
    {
      customType: REGISTRY_DELTA_ENTRY,
      data: {
        version: 1,
        rootSessionId: ROOT,
        changes: [
          { path: "/root/a", view: {}, cleared: ["output"] },
          { thread: retyped },
          { thread: c },
        ],
      },
    },
  ]);
  assert.deepEqual(readRegistry(branch), {
    version: 1,
    rootSessionId: ROOT,
    threads: JSON.parse(JSON.stringify([withView(a, { output: undefined }), retyped, c])),
  });
});

test("removals, reordering, another root session and reset write the whole registry", () => {
  const { branch, entries, writer } = recordingWriter();
  const [a, b, c] = [thread("a", "a1"), thread("b", "b1"), thread("c", "c1")];
  writer.write(ROOT, [a, b, c]);
  writer.write(ROOT, [a, c]);
  writer.write(ROOT, [c, a]);
  writer.write("forked-session", [c, a]);
  writer.reset();
  writer.write("forked-session", [c, a]);
  assert.deepEqual(
    entries.map((entry) => entry.customType),
    Array(5).fill(REGISTRY_ENTRY),
  );
  assert.deepEqual(readRegistry(branch), {
    version: 1,
    rootSessionId: "forked-session",
    threads: [c, a],
  });
});

test("every branch point replays the registry written at that point", () => {
  const { branch, writer } = recordingWriter();
  const a = thread("a", "a1", { inherited: [] });
  const steps: SavedThread[][] = [
    [a],
    [withView(a, { sessionLeafId: "a2", costUsd: 0.25 })],
    [withView(a, { sessionLeafId: "a2", costUsd: 0.25 }), thread("b", "b1")],
    [
      withView(thread("a", "a3"), { state: "completed", sessionLeafId: null }),
      withView(thread("b", "b1"), { error: "failed" }),
    ],
    [thread("b", "b2")],
    [thread("b", "b3"), thread("c", "c1")],
  ];
  const checkpoints = steps.map((threads) => {
    writer.write(ROOT, threads);
    return branch.length;
  });
  for (const [step, length] of checkpoints.entries())
    assert.deepEqual(readRegistry(branch.slice(0, length))?.threads, steps[step], `step ${step}`);
});

test("a failed append is retried instead of becoming the base of the next delta", () => {
  const branch: SessionEntry[] = [];
  let fail = true;
  const writer = new RegistryWriter((customType, data) => {
    if (fail) throw new Error("disk full");
    branch.push(custom(customType, data));
  });
  assert.throws(() => writer.write(ROOT, [thread("a", "a1")]), /disk full/);
  fail = false;
  writer.write(ROOT, [thread("a", "a1")]);
  assert.equal(branch.length, 1);
  assert.equal(branch[0]!.type === "custom" && branch[0]!.customType, REGISTRY_ENTRY);
});

test("reads legacy full-only branches and rejects deltas without a valid base", () => {
  const a = thread("a", "a1");
  const full = (rootSessionId: string, threads: SavedThread[]) =>
    // Literal: sessions written by earlier releases use this entry type.
    custom("pi-subagent:registry:v1", { version: 1, rootSessionId, threads });
  const delta = (rootSessionId: string, changes: RegistryDelta["changes"]) =>
    custom(REGISTRY_DELTA_ENTRY, { version: 1, rootSessionId, changes });
  const leaf = { path: "/root/a", view: { sessionLeafId: "a2" } };

  assert.equal(readRegistry([custom("other:v1", {})]), undefined);
  assert.deepEqual(readRegistry([full(ROOT, []), full(ROOT, [a])])?.threads, [a]);
  assert.throws(() => readRegistry([delta(ROOT, [leaf])]), /delta without a full registry/);
  assert.throws(() => readRegistry([full(ROOT, [a]), delta("other", [leaf])]), /another root/);
  assert.throws(() => readRegistry([full(ROOT, []), delta(ROOT, [leaf])]), /unknown thread/);
  assert.throws(() => readRegistry([full(ROOT, [a, a]), delta(ROOT, [leaf])]), /duplicate/);
  assert.throws(
    () => readRegistry([full(ROOT, [a]), custom(REGISTRY_DELTA_ENTRY, { version: 2 })]),
    /Invalid registry format/,
  );
});
