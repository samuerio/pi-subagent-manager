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
