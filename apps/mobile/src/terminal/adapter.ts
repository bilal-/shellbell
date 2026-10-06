// xterm.js (MIT), https://github.com/xtermjs/xterm.js, is installed unchanged.
// This file adapts Shellbell snapshots; it is not a fork of the renderer.
import { type Line, type Run, stringCells } from "@shellbell/protocol";
import { safeText } from "../screen/display-text";

export interface TerminalRow {
  key: string;
  line: Line;
  absoluteRow?: number;
  history: boolean;
  liveRow?: number;
}

const CSI = "\x1b[";
const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Preserve the previous cursor opacity against the terminal's black background. */
export function cursorColor(accent: string, inferred = false): string {
  if (!/^#[\da-f]{6}$/i.test(accent)) return accent;
  const opacity = inferred ? 0.25 : 0.7;
  return `#${[1, 3, 5]
    .map((offset) =>
      Math.round(Number.parseInt(accent.slice(offset, offset + 2), 16) * opacity)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

function style(run: Run): string {
  const codes = [0];
  for (const [enabled, code] of [
    [run.b, 1],
    [run.f, 2],
    [run.i, 3],
    [run.u, 4],
    [run.s, 9],
  ] as const) {
    if (enabled) codes.push(code);
  }
  for (const [color, base] of [
    [run.fg, 38],
    [run.bg, 48],
  ] as const) {
    if (Array.isArray(color)) codes.push(base, 2, ...color);
    else if (color !== undefined) codes.push(base, 5, color);
  }
  return `${CSI}${codes.join(";")}m`;
}

export function encodeLine(line: Line, cols: number): { text: string; cells: number } {
  let text = "";
  let cells = 0;
  for (const run of line.r) {
    const budget = Math.min(cols - cells, run.n ?? cols);
    const graphemes = [...segments.segment(safeText(run.t))].map(({ segment }) => segment);
    const flags = graphemes.filter((segment) =>
      /^\p{Regional_Indicator}{2}$/u.test(segment),
    ).length;
    const sourceWidth = run.n ?? [...run.t].length;
    const wideFlags =
      flags > 0 &&
      sourceWidth === graphemes.reduce((sum, segment) => sum + stringCells(segment), 0) + flags * 2;
    let used = 0;
    let value = "";
    for (const segment of graphemes) {
      const flag = /^\p{Regional_Indicator}{2}$/u.test(segment);
      const width = flag && wideFlags ? 4 : stringCells(segment);
      if (used + width > budget) break;
      value += segment;
      // xterm's grapheme provider uses two cells for a flag. Some source backends
      // report four; preserve their grid rather than shifting following text.
      if (flag && width > 2) value += " ".repeat(width - 2);
      used += width;
    }
    const occupied = run.n === undefined ? used : Math.min(cols - cells, run.n);
    text += style(run) + value + " ".repeat(Math.max(0, occupied - used));
    cells += occupied;
    if (cells >= cols) break;
  }
  return { text, cells };
}

/** Paint only the host live grid, preserving xterm's imported scrollback. */
export function paintViewport(rows: readonly TerminalRow[], cols: number): string {
  let text = `${CSI}?25l${CSI}?7h${CSI}0m${CSI}2J${CSI}H`;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const previous = rows[index - 1];
    const wrapped =
      previous?.line.w === true &&
      previous.absoluteRow !== undefined &&
      row.absoluteRow === previous.absoluteRow + 1;
    if (index > 0 && !wrapped) text += `${CSI}${index + 1};1H`;
    const encoded = encodeLine(row.line, cols);
    // A printable blank makes even an empty continuation acquire isWrapped.
    text += encoded.text || " ";
    const next = rows[index + 1];
    if (row.line.w && row.absoluteRow !== undefined && next?.absoluteRow === row.absoluteRow + 1) {
      text += `${CSI}0m${" ".repeat(Math.max(0, cols - Math.max(1, encoded.cells)))}`;
    }
  }
  return `${text}${CSI}0m${CSI}H`;
}
