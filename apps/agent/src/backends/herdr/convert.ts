import { type Cursor, emptyLine, type Line, parseSgrLine, stringCells } from "@shellbell/protocol";
import type { Screen } from "../types.js";

export interface HerdrScreenInput {
  /** `pane.read {source:"visible", format:"ansi"}` -> `result.read.text`. */
  text: string;
  /** The pane's viewport height: the layout rect's height, else `scroll.viewport_rows`. */
  rows: number;
  /** The pane's layout rect width. */
  cols: number;
  /** `scroll.max_offset_from_bottom` — rows of scrollback ABOVE the viewport. */
  scrollMax: number;
}

/**
 * One row per line. Herdr's ANSI reads go through Ghostty's VT selection formatter with
 * `trim: true`, so rows carry real SGR sequences but no CUP/erase sequences, no padding to `cols`,
 * and no trailing blanks — exactly what `parseSgrLine` expects. Control bytes below 0x20 (a stray
 * CR included) are dropped by `parseSgrLine` itself.
 */
export function parseAnsiLines(text: string): Line[] {
  if (text === "") return [];
  const rows = text.split("\n");
  // A trailing newline yields one empty tail element that is not a row.
  if (rows.length > 1 && rows[rows.length - 1] === "") rows.pop();
  return rows.map(parseSgrLine);
}

/**
 * Exactly `rows` lines. Padding goes at the bottom (Ghostty trims trailing blank rows), and an
 * overfull read keeps the LAST `rows`: a terminal viewport is bottom-anchored, so dropping the
 * bottom would throw away the prompt and the newest output.
 */
export function fitLines(lines: Line[], rows: number): Line[] {
  if (lines.length > rows) return lines.slice(lines.length - rows);
  const out = lines.slice();
  while (out.length < rows) out.push(emptyLine());
  return out;
}

export function lineCells(line: Line): number {
  return line.r.reduce((n, r) => n + (r.n ?? stringCells(r.t)), 0);
}

/**
 * Herdr exposes no cursor anywhere in its API, so we place one at the end of the last
 * non-blank visible row and the app dims it for `herdr` sessions. `x` is clamped to `cols - 1`: a
 * row filled to the full width would otherwise report a column outside the grid.
 */
export function fakeCursor(lines: Line[], cols: number): Cursor {
  const maxX = Math.max(0, cols - 1);
  for (let y = lines.length - 1; y >= 0; y--) {
    const line = lines[y] as Line;
    if (line.r.some((r) => r.t.trim().length > 0)) return { x: Math.min(maxX, lineCells(line)), y };
  }
  return { x: 0, y: 0 };
}

export function herdrScreen(input: HerdrScreenInput): Screen {
  const rows = Math.max(1, input.rows);
  const cols = Math.max(1, input.cols);
  const lines = fitLines(parseAnsiLines(input.text), rows);
  return {
    cols,
    rows,
    cursor: fakeCursor(lines, cols),
    lines,
    //: the rows above the viewport, i.e. the absolute index of the screen's
    // first row. `capabilities.absoluteLines` stays false because Herdr's counter is not stable
    // once its scrollback saturates, but the ORIGIN matches what `history` pages against.
    scrollbackTotal: Math.max(0, input.scrollMax),
  };
}
