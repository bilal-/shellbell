import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Line } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import {
  fakeCursor,
  fitLines,
  herdrScreen,
  lineCells,
  parseAnsiLines,
} from "../src/backends/herdr/convert.js";
import type { PaneReadResult } from "../src/backends/herdr/types.js";

const fixture = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "herdr-pane-read-visible.json"), "utf8"),
) as { result: PaneReadResult };
const TEXT = fixture.result.read.text;
const flat = (l: Line) => l.r.map((r) => r.t).join("");

describe("parseAnsiLines", () => {
  it("splits the ANSI blob into 37 styled rows and drops the trailing newline's empty row", () => {
    // Local capture: the captured pane's `pane.read visible ansi` text --
    // real terminal output from re-running `pnpm -F shellbell spike:herdr` in its own pane, CSI
    // finals all `m`. This pins the real shape rather than a synthetic screen.
    const lines = parseAnsiLines(TEXT);
    expect(lines).toHaveLength(37);
    // One styled run: the prompt segment's bold, coloured "~".
    expect(lines[0]?.r[1]).toMatchObject({ t: "~", fg: 39, bg: 234, b: true });
    expect(lines[0]?.r[4]).toMatchObject({ t: "pnpm", fg: 2 });
    // A genuinely blank row (not bottom padding -- an interior blank line in the real output).
    expect(lines[6]).toEqual({ r: [] });
    expect(lines[9]).toEqual({ r: [] });
    // The last row: the shell's still-running prompt marker.
    expect(flat(lines[36] as Line)).toBe("└─ Running...");
    expect(lines[36]?.r[0]).toMatchObject({ t: "└─", fg: 13 });
  });

  it("returns an empty array for an empty read", () => {
    expect(parseAnsiLines("")).toEqual([]);
    expect(parseAnsiLines("\n")).toEqual([{ r: [] }]);
  });
});

describe("fitLines", () => {
  it("pads at the bottom and, when overfull, keeps the BOTTOM rows", () => {
    const l = (t: string): Line => ({ r: [{ t }] });
    expect(fitLines([l("a")], 3).map(flat)).toEqual(["a", "", ""]);
    // A terminal viewport is bottom-anchored: the prompt is the row that must survive.
    expect(fitLines([l("a"), l("b"), l("c"), l("d")], 2).map(flat)).toEqual(["c", "d"]);
  });
});

describe("lineCells / fakeCursor", () => {
  it("counts cells and parks the cursor after the last non-blank row of the real capture", () => {
    const lines = parseAnsiLines(TEXT);
    // "└─ Running..." = 2 (box-drawing, narrow) + 1 (space) + 10 ("Running...") = 13 cells.
    expect(lineCells(lines[36] as Line)).toBe(13);
    expect(fakeCursor(lines, 187)).toEqual({ x: 13, y: 36 }); // the pane's real rect width
    expect(fakeCursor([{ r: [] }, { r: [] }], 80)).toEqual({ x: 0, y: 0 });
    expect(fakeCursor([], 80)).toEqual({ x: 0, y: 0 });
  });

  it("counts a wide-cell run by its cached cell count, not its code-point length", () => {
    // Herdr's ANSI reads report a wide (CJK) run's cell count explicitly when it differs from the
    // code-point count; this pins that path without depending on the spike ever
    // capturing one the captured pane never printed wide text).
    const wide: Line = { r: [{ t: "漢字", n: 4 }, { t: " wide-cell row" }] };
    expect(lineCells(wide)).toBe(18); // 4 cells + 14 code points, none double-width
    expect(fakeCursor([wide], 80)).toEqual({ x: 18, y: 0 });
  });

  it("clamps x to the last column of a full-width row", () => {
    // A row filled to `cols` would otherwise put the cursor at x === cols, outside the grid.
    const full: Line = { r: [{ t: "x".repeat(80) }] };
    expect(fakeCursor([full], 80)).toEqual({ x: 79, y: 0 });
    expect(fakeCursor([full], 1)).toEqual({ x: 0, y: 0 });
  });
});

describe("herdrScreen", () => {
  it("pads to rows, keeps cols from the layout rect, and reports rows-above-viewport", () => {
    // The real pane's rect is 187x51 its 37 captured lines pad with 14
    // blank rows at the bottom (Ghostty trims trailing blanks, so the source never sends them).
    const screen = herdrScreen({ text: TEXT, rows: 51, cols: 187, scrollMax: 0 });
    expect(screen.rows).toBe(51);
    expect(screen.cols).toBe(187);
    expect(screen.lines).toHaveLength(51);
    expect(screen.lines[37]).toEqual({ r: [] });
    expect(screen.lines[50]).toEqual({ r: [] });
    //: scrollbackTotal is max_offset_from_bottom -- the rows ABOVE the
    // viewport -- so the phone's `historyFrom` starts exactly where our history pages end.
    expect(screen.scrollbackTotal).toBe(0);
    expect(screen.cursor).toEqual({ x: 13, y: 36 });
  });

  it("keeps the bottom of a read that is longer than the viewport", () => {
    const screen = herdrScreen({ text: "a\nb\nc\nd\n", rows: 2, cols: 10, scrollMax: 0 });
    expect(screen.lines.map(flat)).toEqual(["c", "d"]);
    expect(screen.scrollbackTotal).toBe(0);
  });
});
