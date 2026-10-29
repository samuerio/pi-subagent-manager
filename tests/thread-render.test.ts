import assert from "node:assert/strict";
import { test } from "node:test";
import { initTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ThreadView } from "../src/types.ts";
import {
  renderThreadCall,
  renderThreadResult,
  settledThreadView,
} from "../src/ui/spawn-render.ts";
import { agentTools } from "../src/orch/tools.ts";

initTheme();

const theme = {
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function thread(patch: Partial<ThreadView> = {}): ThreadView {
  return {
    path: "/root/worker",
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "completed",
    model: "opencode-go/deepseek-v4.1-flash",
    task: "Investigate the flaky test",
    status: "Completed; session retained",
    createdAt: 1,
    updatedAt: 2,
    elapsedMs: 19127,
    inputTokens: 39562,
    outputTokens: 1577,
    output: "Found it in tools.ts.",
    ...patch,
  };
}

/** Render a component to plain text; a wide line avoids wrapping. */
const rendered = (component: { render: (width: number) => string[] }) =>
  component
    .render(400)
    .map((line) => stripTerminalSequences(line))
    .join("\n");

const envelope = (details: unknown, text = "{}") => ({
  content: [{ type: "text" as const, text }],
  details,
});

// --- collapsed single thread -------------------------------------------------

test("agent_wait collapses to the same status line as spawn results", () => {
  const view = renderThreadResult(
    envelope(thread()),
    { expanded: false },
    theme,
  );
  const text = (view as { render: (width: number) => string[] }).render(400);
  assert.match(stripTerminalSequences(text.join("\n")), /completed.*deepseek/);
  assert.match(
    stripTerminalSequences(text.join("\n")),
    /19s \u219139\.6k \u21931\.6k/,
  );
});

// --- expanded single thread --------------------------------------------------

test("agent_wait expands into the settled report layout", () => {
  const container = renderThreadResult(
    envelope(thread()),
    { expanded: true },
    theme,
  );
  const report = rendered(container as { render: (width: number) => string[] });
  assert.match(report, /Investigate the flaky test/);
  assert.match(report, /Found it in tools\.ts\./);
  assert.match(report, /completed/);
});

test("a running thread expands without the (no output) filler", () => {
  const container = settledThreadView(
    thread({ state: "running", output: undefined }),
    theme,
  );
  assert.doesNotMatch(rendered(container), /\(no output\)/);
});

test("a completed thread without output says so", () => {
  const container = settledThreadView(thread({ output: undefined }), theme);
  assert.match(rendered(container), /\(no output\)/);
});

// --- agent_status list -------------------------------------------------------

test("the status list collapses to a state census", () => {
  const view = renderThreadResult(
    envelope([thread(), thread({ path: "/root/b", state: "running" })]),
    { expanded: false },
    theme,
  );
  const text = stripTerminalSequences(
    (view as { render: (width: number) => string[] }).render(400).join("\n"),
  );
  assert.match(text, /2 threads/);
  assert.match(text, /completed 1/);
  assert.match(text, /running 1/);
});

test("the status list expands to one status line per thread", () => {
  const container = renderThreadResult(
    envelope([thread(), thread({ path: "/root/b", state: "running" })]),
    { expanded: true },
    theme,
  );
  const text = stripTerminalSequences(
    (container as { render: (width: number) => string[] })
      .render(400)
      .join("\n"),
  );
  assert.match(text, /\/root\/worker  completed/);
  assert.match(text, /\/root\/b  running/);
});

// --- agent_output pagination page ---------------------------------------------

// Pagination guidance is data-side (the execute appends the "[N more
// characters …]" directive to the page text), so the renderer stays silent:
// collapsed pages render nothing and expanded pages are just the body.

test("an output page collapses to silence; the call line carries the range", () => {
  const view = renderThreadResult(
    envelope({
      path: "/root/worker",
      text: "x".repeat(16000),
      totalCharacters: 45210,
      nextOffset: 16000,
    }),
    { expanded: false },
    theme,
  );
  const text = stripTerminalSequences(
    (view as { render: (width: number) => string[] }).render(400).join("\n"),
  ).trim();
  assert.equal(text, "");
});

test("an output page expands into just the markdown body", () => {
  const container = renderThreadResult(
    envelope({
      path: "/root/worker",
      text: "## Findings\n\nThe test was flaky.",
      totalCharacters: 32,
      nextOffset: null,
    }),
    { expanded: true },
    theme,
  );
  const report = rendered(container as { render: (width: number) => string[] });
  assert.match(report, /Findings/);
  assert.match(report, /The test was flaky/);
  assert.doesNotMatch(report, /chars /);
  assert.doesNotMatch(report, /· more/);
});

test("an empty page expands into a placeholder", () => {
  const container = renderThreadResult(
    envelope({
      path: "/root/worker",
      text: "",
      totalCharacters: 0,
      nextOffset: null,
    }),
    { expanded: true },
    theme,
  );
  assert.match(
    rendered(container as { render: (width: number) => string[] }),
    /\(empty page\)/,
  );
});

// --- fallbacks ---------------------------------------------------------------

test("error results without a thread render as error text", () => {
  const view = renderThreadResult(
    envelope(undefined, "Thread not found: /root/nope"),
    { expanded: false },
    theme,
    { isError: true },
  );
  const text = (view as { render: (width: number) => string[] }).render(400);
  assert.match(text.join("\n"), /Thread not found/);
});

test("non-thread payloads fall back to the envelope text", () => {
  const payload = {
    path: "/root/worker",
    pauseRequested: true,
    status: "paused",
  };
  const view = renderThreadResult(
    envelope(payload, JSON.stringify(payload)),
    { expanded: false },
    theme,
  );
  const text = (view as { render: (width: number) => string[] }).render(400);
  assert.match(text.join("\n"), /pauseRequested/);
});

// --- call line ---------------------------------------------------------------

test("the thread call line is the tool name plus the path handle", () => {
  const text = (
    renderThreadCall({ path: "/root/worker" }, theme, "agent_wait") as {
      render: (width: number) => string[];
    }
  ).render(400);
  assert.equal(
    stripTerminalSequences(text.join("\n")).trim(),
    "agent_wait /root/worker",
  );
});

test("an explicit timeoutMs is appended in bash-tool style", () => {
  const render = (args: unknown) =>
    stripTerminalSequences(
      (
        renderThreadCall(args, theme, "agent_wait") as {
          render: (width: number) => string[];
        }
      )
        .render(400)
        .join("\n"),
    ).trim();
  assert.equal(
    render({ path: "/root/worker", timeoutMs: 120000 }),
    "agent_wait /root/worker (timeout 120s)",
  );
  // Sub-second precision keeps the bash convention readable.
  assert.match(
    render({ path: "/root/worker", timeoutMs: 30500 }),
    /\(timeout 30\.5s\)/,
  );
  // Garbage values are ignored, not rendered.
  assert.equal(
    render({ path: "/root/worker", timeoutMs: "soon" }),
    "agent_wait /root/worker",
  );
});

test("agent_steer's re-armed report timer renders the same way", () => {
  const text = stripTerminalSequences(
    (
      renderThreadCall(
        { path: "/root/worker", timeoutMs: 30000 },
        theme,
        "agent_steer",
        true,
      ) as { render: (width: number) => string[] }
    )
      .render(400)
      .join("\n"),
  ).trim();
  assert.equal(text, "agent_steer /root/worker (timeout 30s)");
});

test("agent_output's call line renders the requested character range", () => {
  const render = (args: unknown) =>
    stripTerminalSequences(
      (
        renderThreadCall(args, theme, "agent_output") as {
          render: (width: number) => string[];
        }
      )
        .render(400)
        .join("\n"),
    ).trim();
  // Presence-based: only explicitly passed args produce a range.
  assert.equal(render({ path: "/root/worker" }), "agent_output /root/worker");
  assert.equal(
    render({ path: "/root/worker", offset: 0, limit: 8000 }),
    "agent_output /root/worker:C1-C8000",
  );
  assert.equal(
    render({ path: "/root/worker", offset: 8000 }),
    "agent_output /root/worker:C8001-C16000",
  );
  assert.equal(
    render({ path: "/root/worker", limit: 2000 }),
    "agent_output /root/worker:C1-C2000",
  );
  // Strict schemas emit null for omitted optionals; null counts as absent.
  assert.equal(
    render({ path: "/root/worker", offset: null, limit: null }),
    "agent_output /root/worker",
  );
  // Streamed partial or garbage values render nothing, never :CNaN.
  assert.equal(
    render({ path: "/root/worker", offset: "x" }),
    "agent_output /root/worker",
  );
  // A zero limit is outside the schema (minimum 1); never render :C1-C0.
  assert.equal(
    render({ path: "/root/worker", limit: 0 }),
    "agent_output /root/worker",
  );
});

test("the truncation line reports the payload length and points at agent_output", () => {
  const truncated = {
    ...thread(),
    outputTruncated: true,
    outputCharacters: 24000,
  };
  assert.match(
    rendered(settledThreadView(truncated, theme)),
    /output truncated at 24000 characters · agent_output \/root\/worker for the rest/,
  );
  // The fallback keeps pre-payload fixtures on the historical cap.
  assert.match(
    rendered(settledThreadView({ ...thread(), outputTruncated: true }, theme)),
    /output truncated at 16000 characters/,
  );
});

test(
  "agent_steer's call line previews its message before the timeout badge",
  () => {
    const render = (args: unknown, messagePreview = true) =>
      stripTerminalSequences(
        (
          renderThreadCall(args, theme, "agent_steer", messagePreview) as {
            render: (width: number) => string[];
          }
        )
          .render(400)
          .join("\n"),
      ).trim();

    assert.equal(
      render({ path: "/root/worker", message: "fix the flaky test" }),
      "agent_steer /root/worker fix the flaky test",
    );
    // Order: body before badge; a message that imitates chrome cannot
    // displace the real tail.
    assert.equal(
      render({ path: "/root/worker", message: "go", timeoutMs: 30000 }),
      "agent_steer /root/worker go (timeout 30s)",
    );
    // >60 chars: clipped with a mandatory ellipsis.
    const long = "x".repeat(120);
    assert.equal(
      render({ path: "/root/worker", message: long }),
      `agent_steer /root/worker ${"x".repeat(60)}…`,
    );
    // Boundary: exactly 60 columns fits without an ellipsis…
    assert.equal(
      render({ path: "/root/worker", message: "x".repeat(60) }),
      `agent_steer /root/worker ${"x".repeat(60)}`,
    );
    // …and one more column flips to the ellipsis.
    assert.equal(
      render({ path: "/root/worker", message: "x".repeat(61) }),
      `agent_steer /root/worker ${"x".repeat(60)}…`,
    );
    // ANSI, newlines and control characters collapse to one muted line.
    assert.equal(
      render({ path: "/root/worker", message: "fix\nthe\x1b[31m  flaky\x02" }),
      "agent_steer /root/worker fix the flaky",
    );
    // Wide characters: width-based clipping keeps CJK inside one line-budget
    // (a code-unit slice would render 31 of them) and never splits neighbors.
    assert.match(
      render({ path: "/root/worker", message: "漢".repeat(40) }),
      /^agent_steer \/root\/worker 漢{29,30}…$/,
    );
    assert.doesNotMatch(render({ path: "/root/worker", message: "漢".repeat(29) }), /…/);
    // Whitespace-only message: no preview, and no trailing space.
    assert.equal(
      render({ path: "/root/worker", message: "   " }),
      "agent_steer /root/worker",
    );
    // null (strict-schema omitted optional) renders nothing.
    assert.equal(
      render({ path: "/root/worker", message: null }),
      "agent_steer /root/worker",
    );
    // Other thread tools ignore a stray message arg: preview is opt-in.
    assert.equal(
      stripTerminalSequences(
        (
          renderThreadCall(
            { path: "/root/worker", message: "fix the flaky test" },
            theme,
            "agent_wait",
          ) as { render: (width: number) => string[] }
        )
          .render(400)
          .join("\n"),
      ).trim(),
      "agent_wait /root/worker",
    );
  },
);

test(
  "agent_steer's expanded report carries the full message as a pinned footer note",
  () => {
    const report = (patch: Partial<ThreadView>, message: unknown, steerNote = true) =>
      rendered(
        renderThreadResult(
          envelope(
            thread({
              output: "All tests pass.",
              sessionFile: "/s/worker.jsonl",
              ...patch,
            }),
          ),
          { expanded: true },
          theme,
          { args: { path: "/root/worker", message } },
          steerNote,
        ) as { render: (width: number) => string[] },
      );
    const reportWith = (message: unknown) => report({}, message);
    assert.match(reportWith("fix the flaky test"), /steered: fix the flaky test/);

    // Pin the placement: after the status footer, before the session line.
    const lines = report({}, "fix the flaky test").split("\n");
    const statusIdx = lines.findIndex((line) => /completed ·/.test(line));
    const noteIdx = lines.findIndex((line) => /steered: /.test(line));
    const sessionIdx = lines.findIndex((line) => /session: \/s\/worker\.jsonl/.test(line));
    assert.equal(statusIdx >= 0 && noteIdx >= 0 && sessionIdx >= 0, true);
    assert.equal(statusIdx < noteIdx && noteIdx < sessionIdx, true);
    // Exactly one blank separates the status footer from the note.
    const statusToNote = lines.slice(statusIdx + 1, noteIdx);
    assert.equal(statusToNote.some((line) => line.trim().length > 0), false);
    assert.equal(statusToNote.length, 1);

    // A multi-line message keeps its line structure in the note.
    const multi = report({}, "fix the parser side\nthen rerun the suite");
    assert.match(multi, /steered: fix the parser side/);
    assert.match(multi, /^then rerun the suite.*$/m);

    // null (strict-schema omitted optional) and whitespace-only stay silent.
    assert.doesNotMatch(report({}, null), /steered:/);
    assert.equal(report({}, "   ").includes("steered: "), false);

    // Raw output check (bypasses any ANSI-stripping view helpers): the note
    // surface must not leak terminal escape sequences into the terminal.
    const raw = (
      renderThreadResult(
        envelope(thread({ output: "All tests pass." })),
        { expanded: true },
        theme,
        { args: { path: "/root/worker", message: "fix\x1b[31m the\x1b[0m flaky\ncheck \x02 later" } },
        true,
      ) as { render: (width: number) => string[] }
    )
      .render(400)
      .join("\n");
    assert.match(raw, /steered: fix the flaky/);
    assert.match(raw, /^check +later.*$/m);
    assert.equal(/\x1b/.test(raw.slice(raw.indexOf("steered: "))), false);

    // The note rides the steerUi opt-in; other verbs never gain it, and a
    // replay without args renders the report bare.
    assert.doesNotMatch(report({}, "fix the flaky test", false), /steered:/);
    const bare = renderThreadResult(
      envelope(thread({ output: "All tests pass.", sessionFile: "/s/worker.jsonl" })),
      { expanded: true },
      theme,
    ) as { render: (width: number) => string[] };
    assert.doesNotMatch(rendered(bare), /steered:/);
    // Without a note the session line directly follows the status line: the
    // guard deleting incident (an unconditional Spacer before it) stays seen.
    const bareLines = rendered(bare).split("\n");
    const bareStatusIdx = bareLines.findIndex((line) => /completed ·/.test(line));
    const bareSessionIdx = bareLines.findIndex((line) => /session: \/s\/worker\.jsonl/.test(line));
    assert.equal(bareStatusIdx >= 0 && bareSessionIdx >= 0, true);
    assert.equal(bareSessionIdx - bareStatusIdx, 1);
  },
);

test("the steerUi switch keys both affordances to agent_steer's registration", () => {
  const tools = agentTools(() => null as never, "/root");
  const call = (name: string, args: unknown) =>
    stripTerminalSequences(
      (
        tools.find((tool) => tool.name === name)!.renderCall!(
          args,
          theme,
          {} as never,
        ) as { render: (width: number) => string[] }
      )
        .render(400)
        .join("\n"),
    ).trim();
  // The registered steer tool carries the preview…
  assert.equal(
    call("agent_steer", { path: "/root/worker", message: "go" }),
    "agent_steer /root/worker go",
  );
  // …and the same args on any other verb stay bare, so moving the switch
  // away from the steer registration would fail here.
  for (const name of ["agent_wait", "agent_stop", "agent_status"])
    assert.equal(
      call(name, { path: "/root/worker", message: "go" }),
      `${name} /root/worker`,
    );

  // Both affordances ride one switch: the registered renderResult half too.
  const expandReport = (name: string, args: unknown) =>
    rendered(
      tools.find((tool) => tool.name === name)!.renderResult!(
        envelope(thread({ output: "All tests pass." })),
        { expanded: true, isPartial: false },
        theme,
        { args } as never,
      ) as { render: (width: number) => string[] },
    );
  assert.match(
    expandReport("agent_steer", { path: "/root/worker", message: "go" }),
    /steered: go/,
  );
  assert.doesNotMatch(
    expandReport("agent_wait", { path: "/root/worker", message: "go" }),
    /steered:/,
  );
});

test(
  "the clipped preview is stripped of the truncation reset before the ellipsis",
  () => {
    // truncateToWidth injects \x1b[0m when it clips — even with the identity
    // theme, because the reset is emitted by the helper itself. The ellipsis
    // must be appended after that reset is stripped, so the raw render must
    // not carry any escape at all.
    const raw = (
      renderThreadCall(
        { path: "/root/worker", message: "x".repeat(61), timeoutMs: 30000 },
        theme,
        "agent_steer",
        true,
      ) as { render: (width: number) => string[] }
    )
      .render(400)
      .join("\n");
    assert.equal(/\x1b/.test(raw), false);
    assert.equal(raw.trimEnd().endsWith("(timeout 30s)"), true);
  },
);
