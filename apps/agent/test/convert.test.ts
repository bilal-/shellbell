import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { create, fromJson } from "@bufbuild/protobuf";
import { codePoints } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { bufferToScreen, lineContentsToLine } from "../src/backends/iterm2/convert.js";
import {
  AlternateColor,
  CellStyleSchema,
  CodePointsPerCellSchema,
  LineContents_Continuation,
  LineContentsSchema,
  RGBColorSchema,
  ServerOriginatedMessageSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";

const style = (init: Parameters<typeof create<typeof CellStyleSchema>>[1]) =>
  create(CellStyleSchema, init);

describe("lineContentsToLine", () => {
  it("unstyled text becomes one run", () => {
    const lc = create(LineContentsSchema, { text: "hello" });
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "hello" }] });
  });

  it("RLE styles split into runs; fgStandard/bgRgb/bold map; trailing spaces trimmed", () => {
    const lc = create(LineContentsSchema, {
      text: "abcd   ",
      style: [
        style({ fgColor: { case: "fgStandard", value: 1 }, bold: true, repeats: 2 }),
        style({
          bgColor: { case: "bgRgb", value: create(RGBColorSchema, { red: 9, green: 8, blue: 7 }) },
          repeats: 2,
        }),
        style({ repeats: 3 }),
      ],
    });
    expect(lineContentsToLine(lc)).toEqual({
      r: [
        { t: "ab", fg: 1, b: true },
        { t: "cd", bg: [9, 8, 7] },
      ],
    });
  });

  it("inverse swaps with 15/0 defaults; alternate colors are undefined; invisible becomes spaces", () => {
    const lc = create(LineContentsSchema, {
      text: "xyzA",
      style: [
        style({ inverse: true, repeats: 1 }),
        style({ fgColor: { case: "fgAlternate", value: AlternateColor.DEFAULT }, repeats: 1 }),
        style({ invisible: true, fgColor: { case: "fgStandard", value: 2 }, repeats: 1 }),
        style({ repeats: 1 }),
      ],
    });
    // "A" keeps the invisible cell off the end of the line, so trimTrailing leaves it alone.
    expect(lineContentsToLine(lc)).toEqual({
      r: [{ t: "x", fg: 0, bg: 15 }, { t: "y" }, { t: " ", fg: 2 }, { t: "A" }],
    });
  });

  it("a trailing space-only run with no bg is dropped (shipped trimTrailing)", () => {
    const lc = create(LineContentsSchema, {
      text: "xz",
      style: [
        style({ repeats: 1 }),
        style({ invisible: true, fgColor: { case: "fgStandard", value: 2 }, repeats: 1 }),
      ],
    });
    // screen.ts trimTrailing() pops any trailing run whose text trims to "" and that has no bg,
    // so the invisible cell disappears entirely when it is last on the line.
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "x" }] });
  });

  it("code_points_per_cell: uninitialized cell → space, combining mark folds into one cell, n set when cells ≠ code points", () => {
    // The `text` literal below is DECOMPOSED on purpose: it is the two code points n + U+0303,
    // not the precomposed U+00F1. Editors and "fix mojibake" passes love to normalise it to NFC,
    // which is one code point -- that would make cells === codePoints, silently drop `n`, and fail
    // this test for a reason invisible in a diff. Verify with
    // `node -e 'console.log([..."<the literal>"].length)'` -> must print 3, not 2.
    // display: "a<uninitialized cell><n + combining tilde>".
    const lc = create(LineContentsSchema, {
      text: "a" + "n\u0303",
      codePointsPerCell: [
        create(CodePointsPerCellSchema, { numCodePoints: 1, repeats: 1 }),
        create(CodePointsPerCellSchema, { numCodePoints: 0, repeats: 1 }),
        create(CodePointsPerCellSchema, { numCodePoints: 2, repeats: 1 }),
      ],
    });
    const line = lineContentsToLine(lc);
    expect(line.r).toHaveLength(1);
    expect(line.r[0]?.t).toBe("a " + "n\u0303");
    expect(line.r[0]?.n).toBe(3);
    expect(codePoints(line.r[0]?.t ?? "")).toBe(4);
  });

  it("soft wrap sets w", () => {
    const lc = create(LineContentsSchema, {
      text: "x",
      continuation: LineContents_Continuation.SOFT_EOL,
    });
    expect(lineContentsToLine(lc)).toEqual({ r: [{ t: "x" }], w: true });
  });

  it.each([
    { text: "hello ", hardRuns: [{ t: "hello" }] },
    { text: "   ", hardRuns: [] },
  ])("preserves soft-row boundary spaces in $text", ({ text, hardRuns }) => {
    const soft = create(LineContentsSchema, {
      text,
      continuation: LineContents_Continuation.SOFT_EOL,
    });
    expect(lineContentsToLine(soft)).toEqual({ r: [{ t: text }], w: true });
    const hard = create(LineContentsSchema, { text });
    expect(lineContentsToLine(hard)).toEqual({ r: hardRuns });
  });

  it("retains styles on soft-row spaces but never reveals invisible trailing text", () => {
    const lc = create(LineContentsSchema, {
      text: "hello X",
      continuation: LineContents_Continuation.SOFT_EOL,
      style: [
        style({ repeats: 5 }),
        style({ italic: true, repeats: 1 }),
        style({ invisible: true, repeats: 1 }),
      ],
    });
    expect(lineContentsToLine(lc)).toEqual({
      r: [{ t: "hello" }, { t: " ", i: true }, { t: " " }],
      w: true,
    });
  });
});

describe("real fixtures", () => {
  const dir = join(import.meta.dirname, "fixtures");
  const files = readdirSync(dir).filter((f) => f.startsWith("getbuffer-") && f.endsWith(".json"));

  it("has at least one committed GetBuffer fixture", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(files)("%s converts with invariants", (file) => {
    const msg = fromJson(
      ServerOriginatedMessageSchema,
      JSON.parse(readFileSync(join(dir, file), "utf8")),
    );
    if (msg.submessage.case !== "getBufferResponse")
      throw new Error("fixture is not a GetBufferResponse");
    const resp = msg.submessage.value;
    let sawRun = false;
    for (const lc of resp.contents) {
      const line = lineContentsToLine(lc);
      const cells = line.r.reduce((n, r) => n + (r.n ?? codePoints(r.t)), 0);
      const totalCells =
        lc.codePointsPerCell.reduce((n, c) => n + (c.repeats || 1), 0) || codePoints(lc.text);
      // 1. Conversion never invents cells.
      expect(cells).toBeLessThanOrEqual(totalCells);
      for (const run of line.r) {
        sawRun = true;
        // 2. mergeRuns never leaves an empty run behind.
        expect(run.t.length).toBeGreaterThan(0);
        // 3. `n` is present only when it differs from the code-point count.
        if (run.n !== undefined) expect(run.n).not.toBe(codePoints(run.t));
        // 4. Palette colors stay in range.
        if (typeof run.fg === "number") expect(run.fg).toBeLessThanOrEqual(255);
        if (typeof run.bg === "number") expect(run.bg).toBeLessThanOrEqual(255);
      }
      // Hard-EOL padding is trimmed; soft-row boundary spaces are meaningful.
      const last = line.r[line.r.length - 1];
      if (line.w !== true && last && last.bg === undefined)
        expect(last.t.replace(/ +$/, "")).not.toBe("");
    }
    expect(sawRun).toBe(true);
    const rows = resp.contents.length || 1;
    const screen = bufferToScreen(resp, rows, 80);
    expect(screen.lines.length).toBe(rows);
    expect(screen.cols).toBe(80);
    expect(screen.scrollbackTotal).toBeGreaterThanOrEqual(0);
    expect(screen.cursor.y).toBeGreaterThanOrEqual(-1);
    expect(screen.cursor.y).toBeLessThanOrEqual(rows - 1);
  });
});
