import assert from "node:assert/strict";
import test from "node:test";
import {
  colorToRgb,
  rgbColor,
  stripTerminalSequences,
  styleText,
  visibleWidth,
  type Color,
} from "@earendil-works/pi-tui";
import { Theme, type ExtensionContext, type ThemeColor } from "@earendil-works/pi-coding-agent";
import type { ThreadView } from "../src/types.ts";
import { AGENT_COLORS } from "../src/prefs/colors.ts";
import {
  AGENT_PROGRESS_INTERVAL,
  agentProgressIcon,
  renderThreads,
  sanitizeText,
  updateWidget,
} from "../src/ui/ui.ts";

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

function thread(path: string, overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    path,
    parent: "/root",
    owner: "/root",
    type: "worker",
    state: "running",
    task: "Task",
    status: "Working",
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

function testTheme(
  appearance: "dark" | "light",
  mode: "truecolor" | "256color" = "truecolor",
): Theme {
  const foreground = appearance === "dark" ? "#eeeeee" : "#111111";
  const background = appearance === "dark" ? "#111111" : "#eeeeee";
  const colors = {
    ...Object.fromEntries(AGENT_COLORS.map((token) => [token, foreground])),
    accent: appearance === "dark" ? "#60a5fa" : "#1e40af",
    success: appearance === "dark" ? "#166534" : "#b7e4c7",
    warning: "#facc15",
    error: "#b91c1c",
  } as ConstructorParameters<typeof Theme>[0];
  const backgrounds = Object.fromEntries(
    [
      "selectedBg",
      "searchMatchBg",
      "userMessageBg",
      "customMessageBg",
      "toolPendingBg",
      "toolSuccessBg",
      "toolErrorBg",
    ].map((token) => [token, background]),
  ) as ConstructorParameters<typeof Theme>[1];
  return new Theme(colors, backgrounds, mode, { appearance });
}

const darkTheme = testTheme("dark");
const lightTheme = testTheme("light");

/** Black text above the WCAG black/white crossover (~0.179), otherwise white. */
function contrastChannel(color: Color): 0 | 255 {
  const { r, g, b } = colorToRgb(color);
  const linear = (channel: number) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return luminance > Math.sqrt(0.0525) - 0.05 ? 0 : 255;
}

function badgeToken(color: string | undefined): ThemeColor {
  return AGENT_COLORS.includes(color as (typeof AGENT_COLORS)[number])
    ? (color as ThemeColor)
    : "accent";
}

function expectedBadge(theme: Theme, name: string, color?: string): string {
  const background = theme.colors[badgeToken(color)];
  const channel = contrastChannel(background);
  return styleText(
    ` ${sanitizeText(name)} `,
    { bg: background, fg: rgbColor(channel, channel, channel), bold: true },
    theme.getColorMode(),
  );
}

function expectedPath(theme: Theme, path: string, color?: string): string {
  return theme.fg(badgeToken(color), sanitizeText(path));
}

/** Zero-metric fixtures only. Counters are the literal unset label, padded, not truncated. */
function expectedThreadLine(theme: Theme, view: ThreadView, width = 80) {
  const token = view.state === "failed" ? "error" : view.state === "paused" ? "warning" : "accent";
  const badge = expectedBadge(theme, `${agentProgressIcon(view, false)} ${view.type}`, view.color);
  const left = `${badge} ${expectedPath(theme, view.path, view.color)} ${theme.fg(token, `[${sanitizeText(view.state)}]`)} ${sanitizeText(view.status || view.task)}`;
  const right = theme.fg("muted", "0s ↑0 ↓0");
  return left + " ".repeat(width - visibleWidth(left) - visibleWidth(right)) + right;
}

/** Visible text inside each background-color span. Resets are not part of the span. */
function backgroundCoveredText(line: string): string[] {
  const spans: string[] = [];
  const pattern = /\x1b\[48;(?:2(?:;\d+){3}|5;\d+)m/g;
  for (let match = pattern.exec(line); match; match = pattern.exec(line)) {
    const close = line.indexOf("\x1b[49m", match.index);
    assert.ok(close > match.index, "background SGR must reset");
    spans.push(stripTerminalSequences(line.slice(match.index, close)));
    pattern.lastIndex = close + "\x1b[49m".length;
  }
  return spans;
}

type WidgetComponent = { render(width: number): string[]; dispose(): void };

test("widget is compact, excludes current root, and reports hidden threads", () => {
  const threads = [
    thread("/root"),
    ...Array.from({ length: 10 }, (_, i) =>
      thread(`/worker${i}`, { state: "completed", updatedAt: i }),
    ),
    thread("/working", { updatedAt: 10 }),
    thread("/paused", { state: "paused", updatedAt: 12 }),
    thread("/starting", { state: "starting", updatedAt: 11 }),
  ];
  const lines = renderThreads(threads, 80, darkTheme);
  assert.equal(lines.length, 8);
  assert.ok(!lines.some((line) => line.includes("/root")));
  assert.match(lines[0]!, /\/starting/);
  assert.match(lines[1]!, /\/working/);
  assert.match(lines[2]!, /\/paused/);
  assert.match(lines[3]!, /\/worker9/);
  assert.match(lines.at(-1)!, /\+6 more threads · \/agents tree/);
  assert.equal(renderThreads(threads.slice(1, 9), 80, darkTheme).length, 8);
});

test("widget sanitizes hostile text, fits narrow widths, and keeps counters right-aligned", () => {
  assert.equal(sanitizeText("\x1b]0;owned\x07hello\r\nthere"), "hello  there");
  const hostile = "\x1b[31mred\x1b[0m\x1b]0;owned\x07\n\x00" + "界".repeat(30);
  const view = thread("/root/" + "p".repeat(180), {
    type: "researcher" + hostile,
    status: hostile,
    task: hostile,
    color: "success",
    elapsedMs: 65_000,
    inputTokens: 1_200,
    outputTokens: 34,
  });
  const styled = darkTheme.fg("muted", "1m5s ↑1.2k ↓34");
  for (const width of [0, 1, 4, 8, 16, 40, 80]) {
    const line = renderThreads([view], width, darkTheme)[0]!;
    assert.ok(visibleWidth(line) <= width);
    assert.ok(!CONTROL.test(stripTerminalSequences(line)));
    if (width >= visibleWidth(styled)) {
      assert.ok(line.endsWith(styled));
      assert.equal(visibleWidth(line), width);
    }
  }
});

test("widget counter literals cover duration steps and count boundaries", () => {
  const cases = [
    [65_000, 999, 1_000, "1m5s ↑999 ↓1k"],
    [3_600_000, 1_200, 999_999, "1h0m ↑1.2k ↓1m"],
    [86_400_000, 1_000_000, 1_500_000, "1d0h ↑1m ↓1.5m"],
    [-5, Number.NaN, -1, "0s ↑0 ↓0"],
  ] as const;
  for (const [elapsedMs, inputTokens, outputTokens, counters] of cases) {
    const line = stripTerminalSequences(
      renderThreads(
        [
          thread("/job", {
            state: "completed",
            elapsedMs,
            inputTokens,
            outputTokens,
          }),
        ],
        80,
        darkTheme,
      )[0]!,
    );
    assert.ok(line.endsWith(` ${counters}`), line);
  }
});

test("thread pills use the type color with contrasting text; state colors only the state label", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const channels = new Set<0 | 255>();
  for (const theme of [
    darkTheme,
    lightTheme,
    testTheme("dark", "256color"),
    testTheme("light", "256color"),
  ]) {
    for (const color of ["accent", "success", "warning", "text", "error"] as const) {
      const view = thread("/root/controller-security-research", {
        type: "researcher",
        color,
      });
      const line = renderThreads([view], 120, theme)[0]!;
      channels.add(contrastChannel(theme.colors[color]));
      assert.equal(line, expectedThreadLine(theme, view, 120));
      assert.deepEqual(backgroundCoveredText(line), [" | researcher "]);
    }
  }
  assert.ok(channels.has(0), "a light background must use black text");
  assert.ok(channels.has(255), "a dark background must use white text");

  for (const state of ["failed", "paused", "starting", "completed", "stopped"] as const) {
    const view = thread("/worker", {
      type: "researcher",
      state,
      color: "success",
      status: "Busy",
      task: "Ignored",
    });
    const line = renderThreads([view], 80, darkTheme)[0]!;
    assert.equal(line, expectedThreadLine(darkTheme, view));
  }

  // Unknown colors fall back to accent; hostile type/path text is sanitized.
  const invalid = thread("/owned\x1b[31m", {
    type: "bad\x1b[31m",
    color: "\x1b[31mnot-a-token",
    state: "failed",
    status: "",
    task: "Recover",
  });
  const fallback = renderThreads([invalid], 100, darkTheme)[0]!;
  assert.equal(fallback, expectedThreadLine(darkTheme, invalid, 100));
  assert.ok(!CONTROL.test(stripTerminalSequences(fallback)));
});

test("widget resolves the theme at render time", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  let content: unknown;
  let marker = "first";
  const tokenColor = (name: string) =>
    rgbColor(AGENT_COLORS.indexOf(name as (typeof AGENT_COLORS)[number]) + 1, 8, 9);
  const ctx = {
    hasUI: true,
    ui: {
      get theme() {
        const current = marker;
        return {
          fg: (color: string, text: string) => `${current}<fg:${color}>${text}</fg>`,
          colors: Object.fromEntries(AGENT_COLORS.map((name) => [name, tokenColor(name)])),
          style: (text: string, style: { bg?: Color }) =>
            `${current}<bg:${colorToRgb(style.bg!).r}>${text}</bg>`,
        };
      },
      setWidget: (_key: string, value: unknown) => {
        content = value;
      },
    },
  } as unknown as ExtensionContext;
  updateWidget(ctx, [
    thread("/worker", { color: "success" }),
    thread("/fallback", { type: "fallback", color: "\x1b[31m" }),
  ]);
  const widget = (content as (tui: unknown) => WidgetComponent)({
    requestRender() {},
  });
  assert.match(widget.render(200)[0]!, /first<fg:accent>Agents<\/fg>/);
  marker = "second";
  const second = widget.render(200).join("\n");
  assert.doesNotMatch(second, /first</);
  const bg = (name: string) => colorToRgb(tokenColor(name)).r;
  assert.ok(
    second.includes(`second<bg:${bg("accent")}> | fallback </bg> second<fg:accent>/fallback</fg>`),
  );
  assert.ok(
    second.includes(`second<bg:${bg("success")}> | worker </bg> second<fg:success>/worker</fg>`),
  );
  widget.dispose();
});

test("widget timer rerenders live elapsed and does not run when settled or headless", (t) => {
  t.mock.timers.enable({ apis: ["setInterval", "Date"], now: 1_000_000 });
  const intervals = globalThis.setInterval;
  let unrefs = 0;
  globalThis.setInterval = ((fn: TimerHandler, ms?: number) => {
    const timer = intervals(fn, ms as number) as unknown as NodeJS.Timeout;
    const unref = timer.unref.bind(timer);
    timer.unref = () => {
      unrefs += 1;
      return unref();
    };
    return timer;
  }) as unknown as typeof setInterval;
  try {
    let renders = 0;
    let component: WidgetComponent | undefined;
    const tui = { requestRender: () => void (renders += 1) };
    const ctx = {
      hasUI: true,
      ui: {
        theme: darkTheme,
        setWidget: (_key: string, factory: unknown) => {
          component?.dispose();
          component = typeof factory === "function" ? (factory(tui) as WidgetComponent) : undefined;
        },
      },
    } as unknown as ExtensionContext;
    const line = () =>
      stripTerminalSequences(
        component!.render(100).find((row) => stripTerminalSequences(row).includes("↑")) ?? "",
      );
    const job = (patch: Partial<ThreadView>) =>
      thread("/root/job", { type: "researcher", ...patch });

    updateWidget(ctx, [
      job({ startedAt: 995_000, elapsedMs: 2_000, inputTokens: 10, outputTokens: 3 }),
    ]);
    assert.equal(unrefs, 1);
    assert.match(line(), /7s ↑10 ↓3$/);
    t.mock.timers.tick(1000);
    assert.equal(renders, Math.floor(1000 / AGENT_PROGRESS_INTERVAL));
    assert.match(line(), /8s ↑10 ↓3$/);

    renders = 0;
    updateWidget(ctx, [job({ startedAt: Date.now(), elapsedMs: 65_000 })]);
    t.mock.timers.tick(1000);
    assert.equal(
      renders,
      Math.floor(1000 / AGENT_PROGRESS_INTERVAL),
      "replacing a live widget must dispose the previous timer",
    );
    assert.match(line(), /1m6s ↑0 ↓0$/);

    renders = 0;
    updateWidget(ctx, [thread("/done", { state: "completed", startedAt: 1, elapsedMs: 9_000 })]);
    assert.match(line(), /9s ↑0 ↓0$/);
    t.mock.timers.tick(5000);
    assert.equal(renders, 0);
    assert.equal(unrefs, 2);

    updateWidget(
      {
        hasUI: false,
        ui: {
          setWidget() {
            throw new Error("no ui");
          },
        },
      } as unknown as ExtensionContext,
      [thread("/hidden", { startedAt: 1_000_000 })],
    );
    t.mock.timers.tick(2000);
    assert.equal(renders, 0);
  } finally {
    globalThis.setInterval = intervals;
    t.mock.timers.reset();
  }
});
