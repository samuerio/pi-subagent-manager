import { visibleWidth } from "@earendil-works/pi-tui";

/**
 * Top-border decoration ported from the dotfiles PromptEditor: render the
 * mode name (and a bash marker) into the editor's top border line. Pure
 * function over already-rendered lines so the navigation editor can reuse it
 * without inheriting anything.
 */

export interface EditorLabelInput {
  lines: string[];
  width: number;
  /** Mode label text (already formatted; rendered as-is). */
  label: string;
  /** Bash (`!`) mode adds a ` bash` marker next to the label. */
  bashMode: boolean;
  borderColor: (text: string) => string;
  /** Label color; falls back to the border color. */
  labelColor: (text: string) => string;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function cutToDisplayWidth(text: string, width: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const charWidth = visibleWidth(char);
    if (used + charWidth > width) break;
    out += char;
    used += charWidth;
  }
  return out;
}

export function decorateEditorTopBorder(input: EditorLabelInput): string[] {
  const { lines, width, label, bashMode, borderColor, labelColor } = input;
  const topPlain = stripAnsi(lines[0] ?? "");

  // If the editor is scrolled, the built-in editor renders a scroll indicator
  // on the top border. Preserve it, but still show the label.
  // pi-tui centers the indicator (`${dashes} ↑ N more ${dashes}`), so match
  // the indicator itself and keep only the dashes before it as our prefix.
  const scrollPrefixMatch = topPlain.match(/─* ↑ \d+ more /);
  const prefix = scrollPrefixMatch?.[0] ?? "──";

  const labelParts: Array<{ text: string; color: (text: string) => string }> = [
    { text: label, color: labelColor },
  ];
  if (bashMode) {
    labelParts.push(
      { text: " ", color: labelColor },
      { text: "──", color: borderColor },
      { text: " bash", color: labelColor },
    );
  }

  // Room for the label core, never truncating the prefix.
  const labelLeftSpace = prefix.endsWith(" ") ? "" : " ";
  const labelRightSpace = " ";
  const minRightBorder = 1; // keep at least one border cell on the right
  const maxLabelLen = Math.max(
    0,
    width -
      prefix.length -
      labelLeftSpace.length -
      labelRightSpace.length -
      minRightBorder,
  );
  if (maxLabelLen <= 0) return lines;

  // Measure by terminal display width, not UTF-16 length: mode names may
  // contain CJK or other wide characters that would overflow the border.
  let labelLen = labelParts.reduce(
    (sum, part) => sum + visibleWidth(part.text),
    0,
  );
  if (labelLen > maxLabelLen) {
    let remainingLen = maxLabelLen;
    for (const part of labelParts) {
      if (remainingLen <= 0) {
        part.text = "";
        continue;
      }
      if (visibleWidth(part.text) > remainingLen) {
        part.text = cutToDisplayWidth(part.text, remainingLen);
        remainingLen = 0;
      } else {
        remainingLen -= visibleWidth(part.text);
      }
    }
    labelLen = maxLabelLen;
  }

  const labelChunkLen =
    labelLeftSpace.length + labelLen + labelRightSpace.length;
  const remaining = width - prefix.length - labelChunkLen;
  if (remaining < 0) return lines;

  const right = "─".repeat(Math.max(0, remaining));
  const coloredLabel = labelParts
    .map((part) => (part.text ? part.color(part.text) : ""))
    .join("");
  lines[0] =
    borderColor(prefix) +
    (labelLeftSpace ? labelColor(labelLeftSpace) : "") +
    coloredLabel +
    (labelRightSpace ? labelColor(labelRightSpace) : "") +
    borderColor(right);
  return lines;
}
