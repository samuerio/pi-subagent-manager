import assert from "node:assert/strict";
import { test } from "node:test";
import { decorateEditorTopBorder } from "../src/modes/editor-label.ts";

const border = (text: string) => text;
const color = (text: string) => `<${text}>`;

function render(
  input: Partial<Parameters<typeof decorateEditorTopBorder>[0]> & {
    width: number;
  },
) {
  return decorateEditorTopBorder({
    lines: ["──", ""],
    width: input.width,
    label: input.label ?? "work",
    bashMode: input.bashMode ?? false,
    borderColor: input.borderColor ?? border,
    labelColor: input.labelColor ?? color,
  })[0]!;
}

test("the mode label sits centered in the top border", () => {
  // "──" prefix, colored padding spaces around the label, then the right border.
  assert.equal(render({ width: 30 }), "──< ><work>< >" + "─".repeat(22));
});

test("bash mode appends the bash marker", () => {
  // The `──` between label and bash marker uses the border color (identity here).
  assert.equal(
    render({ width: 30, bashMode: true }),
    "──< ><work>< >──< bash>< >" + "─".repeat(14),
  );
});

test("a centered scroll indicator is preserved before the label", () => {
  // pi-tui renders the indicator centered: leading dashes vary with width
  // (createScrollBorder: floor((width - labelWidth) / 2)).
  for (const width of [40, 80, 120]) {
    const labelWidth = " ↑ 5 more ".length;
    const left = Math.floor((width - labelWidth) / 2);
    const top =
      "\x1b[31m" +
      "─".repeat(left) +
      " ↑ 5 more " +
      "─".repeat(width - left - labelWidth) +
      "\x1b[0m";
    const lines = decorateEditorTopBorder({
      lines: [top, ""],
      width,
      label: "work",
      bashMode: false,
      borderColor: border,
      labelColor: color,
    });
    assert.match(
      lines[0]!,
      new RegExp(`${"─".repeat(left)} ↑ 5 more <work>`),
      `width ${width}`,
    );
  }
});

test("the truncated narrow-width indicator form still matches", () => {
  const lines = decorateEditorTopBorder({
    lines: ["─── ↑ 5 more ", ""],
    width: 40,
    label: "work",
    bashMode: false,
    borderColor: border,
    labelColor: color,
  });
  assert.match(lines[0]!, /^─── ↑ 5 more <work>/);
});

test("an oversized label truncates but keeps the right border", () => {
  const line = render({ width: 10, label: "extraordinarily-long-mode" });
  // Visible width stays within the terminal width; the row never drops the
  // prefix or the trailing border entirely.
  assert.match(line, /^──/);
  assert.ok(line.replace(/<|>/g, "").length <= 10);
});
