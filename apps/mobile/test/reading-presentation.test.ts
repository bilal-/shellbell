import type { Line, Run } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { projectReadingRows } from "../src/screen/reading-presentation";
import type { StreamDisplayRow } from "../src/screen/stream-presentation";

function row(
  position: number | undefined,
  line: Line,
  liveRowIndex: number | null = null,
): StreamDisplayRow {
  return {
    kind: "line",
    key: `${liveRowIndex === null ? "h" : "live"}:${position}`,
    absoluteRow: position,
    liveRowIndex,
    line,
  };
}
const soft = (t: string): Line => ({ r: [{ t }], w: true });

describe("bounded reading projection", () => {
  it("joins only confirmed contiguous soft rows, retaining styled Unicode and source references", () => {
    const first: Run = { t: "hello ", fg: 1, b: true };
    const second: Run = { t: "界 e\u0301 👩‍💻", i: true, n: 7 };
    const rows = [row(10, { r: [first], w: true }), row(11, { r: [second] })];
    const before = structuredClone(rows);
    const result = projectReadingRows(rows, null);
    expect(result).toEqual([
      {
        kind: "paragraph",
        key: "h:10",
        sourceKeys: ["h:10", "h:11"],
        historyKey: "h:10",
        runs: [first, second],
        overflow: false,
      },
    ]);
    const paragraph = result[0]!;
    if (paragraph.kind !== "paragraph") throw new Error("expected paragraph");
    expect(paragraph.runs[0]).toBe(first);
    expect(paragraph.runs[1]).toBe(second);
    expect(rows).toEqual(before);
  });

  it.each([false, undefined])("does not infer a wrap from full-width text when w=%s", (w) => {
    const result = projectReadingRows(
      [row(0, { r: [{ t: "full row" }], w }), row(1, soft("next"))],
      null,
    );
    expect(result.map((p) => p.key)).toEqual(["h:0", "h:1"]);
  });

  it("keeps omitted and detached gaps exactly, even between otherwise consecutive positions", () => {
    const gap = { kind: "gap", key: "gap:detached", label: "Earlier history detached" } as const;
    const result = projectReadingRows(
      [row(0, soft("a")), gap, row(1, soft("b")), row(4, soft("c"))],
      null,
    );
    expect(result.map((p) => p.key)).toEqual(["h:0", "gap:detached", "h:1", "h:4"]);
    expect(result[1]).toBe(gap);
  });

  it.each([undefined, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "never joins with an unknown or invalid absolute row %s",
    (position) => {
      const result = projectReadingRows(
        [row(position, soft("a")), row(position === undefined ? 1 : position + 1, soft("b"))],
        null,
      );
      expect(result).toHaveLength(2);
    },
  );

  it("joins known history/live continuity while protecting a real history key", () => {
    expect(
      projectReadingRows([row(9, soft("old ")), row(10, soft("live"), 0)], null),
    ).toMatchObject([{ key: "h:9", sourceKeys: ["h:9", "live:10"], historyKey: "h:9" }]);
    expect(
      projectReadingRows([row(10, soft("live"), 0), row(11, soft("tail"), 1)], null),
    ).toMatchObject([{ key: "live:10", historyKey: null }]);
  });

  it("keeps the visible source boundary stable when soft history is prepended", () => {
    const visible = [row(11, soft("visible ")), row(12, { r: [{ t: "tail" }] })];
    const before = projectReadingRows(visible, "h:11");
    const after = projectReadingRows([row(10, soft("prepended ")), ...visible], "h:11");
    expect(after.map((p) => p.key)).toEqual(["h:10", "h:11"]);
    expect(after[1]).toEqual(before[0]);
  });

  it("breaks a long chain after64 source rows without losing or duplicating rows", () => {
    const source = Array.from({ length: 65 }, (_, i) => row(i, soft("x")));
    const result = projectReadingRows(source, null);
    expect(result.map((p) => (p.kind === "paragraph" ? p.sourceKeys.length : 0))).toEqual([64, 1]);
    expect(result.flatMap((p) => (p.kind === "paragraph" ? p.sourceKeys : []))).toEqual(
      source.map((r) => r.key),
    );
  });

  it("admits8192 UTF-16 units then breaks between rows without splitting Unicode", () => {
    const astral = "🙂".repeat(2048);
    const source = [row(0, soft(astral)), row(1, soft(astral)), row(2, soft("e\u0301"))];
    const result = projectReadingRows(source, null);
    expect(result.map((p) => (p.kind === "paragraph" ? p.sourceKeys : []))).toEqual([
      ["h:0", "h:1"],
      ["h:2"],
    ]);
    expect(result.flatMap((p) => (p.kind === "paragraph" ? p.runs.map((r) => r.t) : []))).toEqual([
      astral,
      astral,
      "e\u0301",
    ]);
  });

  it("admits256 styled runs then breaks between source rows", () => {
    const runs = Array.from({ length: 128 }, (_, i) => ({ t: "x", fg: i % 2 }));
    const result = projectReadingRows(
      [row(0, { r: runs, w: true }), row(1, { r: runs, w: true }), row(2, soft("end"))],
      null,
    );
    expect(result.map((p) => (p.kind === "paragraph" ? p.runs.length : 0))).toEqual([256, 1]);
  });

  it.each([
    {
      runs: [
        { t: "a\u0301".repeat(2048), n: 2048 },
        { t: "a\u0301".repeat(2048), n: 2048 },
        { t: "\u0301", n: 0 },
      ],
    },
    { runs: Array.from({ length: 257 }, (_, i) => ({ t: "x", fg: i % 2 })) },
  ])("keeps an individually oversized row intact in an isolated faithful fallback", ({ runs }) => {
    const result = projectReadingRows(
      [row(0, soft("before")), row(1, { r: runs, w: true }), row(2, soft("after"))],
      null,
    );
    expect(result).toHaveLength(3);
    expect(result[1]).toMatchObject({ key: "h:1", sourceKeys: ["h:1"], overflow: true, runs });
    const middle = result[1]!;
    if (middle.kind !== "paragraph") throw new Error("expected paragraph");
    expect(middle.runs[0]).toBe(runs[0]);
    expect(result[0]).toMatchObject({ overflow: false });
    expect(result[2]).toMatchObject({ overflow: false });
  });

  it("retains empty hard rows and empty input without inventing text", () => {
    expect(projectReadingRows([], null)).toEqual([]);
    expect(projectReadingRows([row(0, { r: [] }), row(1, { r: [] })], null)).toMatchObject([
      { key: "h:0", runs: [], sourceKeys: ["h:0"] },
      { key: "h:1", runs: [], sourceKeys: ["h:1"] },
    ]);
  });
});
