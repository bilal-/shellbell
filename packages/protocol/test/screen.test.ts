import { describe, expect, it } from "vitest";
import { parseInner } from "../src/inner.js";
import {
  applyDiff,
  applySnapshot,
  codePoints,
  emptyLine,
  type Line,
  lineKey,
  mergeRuns,
  type ScreenState,
  stripStyles,
  trimTrailing,
} from "../src/screen.js";

const L = (t: string, extra: Partial<Line["r"][number]> = {}): Line => ({ r: [{ t, ...extra }] });

describe("runs", () => {
  it("strips styles without changing wide or combining cell geometry", () => {
    expect(stripStyles({ r: [{ t: "界", n: 2, fg: 1 }] })).toEqual({
      r: [{ t: "界", n: 2 }],
    });
    expect(stripStyles({ r: [{ t: "e\u0301", n: 1, b: true }] })).toEqual({
      r: [{ t: "e\u0301", n: 1 }],
    });
  });

  it("bounds plain merging by UTF-16 length and cells, preserving wrap flags and inputs", () => {
    const line: Line = {
      r: [
        { t: "a".repeat(4096), n: 1, fg: 1 },
        { t: "b", n: 4096, b: true },
      ],
      w: false,
    };
    const copy = structuredClone(line);
    expect(stripStyles(line)).toEqual({
      r: [
        { t: "a".repeat(4096), n: 1 },
        { t: "b", n: 4096 },
      ],
      w: false,
    });
    expect(line).toEqual(copy);
    expect(stripStyles({ r: [{ t: "界", n: 4095 }, { t: "!" }, { t: "x" }] })).toEqual({
      r: [{ t: "界!", n: 4096 }, { t: "x" }],
    });
    expect(stripStyles({ r: [{ t: "", n: 2, b: true }], w: true })).toEqual({
      r: [{ t: "", n: 2 }],
      w: true,
    });
  });

  it("merges adjacent runs with identical style and sums n", () => {
    expect(
      mergeRuns([
        { t: "a", fg: 1 },
        { t: "b", fg: 1 },
        { t: "c", fg: 2 },
      ]),
    ).toEqual([
      { t: "ab", fg: 1 },
      { t: "c", fg: 2 },
    ]);
    expect(
      mergeRuns([
        { t: "漢", n: 2 },
        { t: "字", n: 2 },
      ]),
    ).toEqual([{ t: "漢字", n: 4 }]);
    expect(mergeRuns([{ t: "a" }, { t: "漢", n: 2 }])).toEqual([{ t: "a漢", n: 3 }]);
  });
  it("treats rgb colors by value", () => {
    expect(
      mergeRuns([
        { t: "a", fg: [1, 2, 3] },
        { t: "b", fg: [1, 2, 3] },
      ]),
    ).toEqual([{ t: "ab", fg: [1, 2, 3] }]);
  });
  it("trims trailing space-only runs without bg", () => {
    expect(trimTrailing([{ t: "hi" }, { t: "   " }])).toEqual([{ t: "hi" }]);
    expect(trimTrailing([{ t: "hi" }, { t: "   ", bg: 4 }])).toEqual([
      { t: "hi" },
      { t: "   ", bg: 4 },
    ]);
    expect(trimTrailing([{ t: "  " }])).toEqual([]);
  });
  it("trims trailing spaces from the last run if no bg, adjusting n arithmetically", () => {
    expect(trimTrailing([{ t: "hi   " }])).toEqual([{ t: "hi" }]);
    expect(trimTrailing([{ t: "漢字  ", n: 6 }])).toEqual([{ t: "漢字", n: 4 }]);
    expect(trimTrailing([{ t: "hi   ", bg: 1 }])).toEqual([{ t: "hi   ", bg: 1 }]);
  });
  it("cascades trimming across multiple empty space-only runs", () => {
    expect(trimTrailing([{ t: "a  " }, { t: "   " }])).toEqual([{ t: "a" }]);
    expect(trimTrailing([{ t: "a" }, { t: "  " }, { t: "   " }])).toEqual([{ t: "a" }]);
  });
  it("trims only literal spaces, not tabs", () => {
    expect(trimTrailing([{ t: "x\t" }])).toEqual([{ t: "x\t" }]);
  });
  it("counts code points and strips styles", () => {
    expect(codePoints("a🚀b")).toBe(3);
    expect(
      stripStyles({
        r: [
          { t: "a", fg: 1, b: true, n: 1 },
          { t: "b", bg: 2 },
        ],
      }),
    ).toEqual({ r: [{ t: "ab" }] });
  });
});

describe("lineKey", () => {
  it("distinguishes soft wraps without confusing unknown/hard rows or marker-like text", () => {
    expect(lineKey({ ...L("hello "), w: true })).not.toBe(lineKey(L("hello ")));
    expect(lineKey({ ...L("hello "), w: false })).toBe(lineKey(L("hello ")));
    expect(lineKey({ ...L("x"), w: true })).not.toBe(lineKey(L("soft:x")));
    expect(lineKey({ ...L("x"), w: true })).not.toBe(lineKey(L("x\x00w")));
    expect(lineKey({ r: [], w: true })).not.toBe(lineKey({ r: [] }));
  });
  it("is the documented format", () => {
    expect(
      lineKey({
        r: [
          { t: "ab", fg: 1, b: true },
          { t: "c", bg: [9, 8, 7], f: true, n: 2 },
        ],
      }),
    ).toBe("ab|1||10000|\x1fc||9,8,7|00001|2");
  });
  it("differs for different styles and is stable", () => {
    expect(lineKey(L("x"))).toBe(lineKey(L("x")));
    expect(lineKey(L("x"))).not.toBe(lineKey(L("x", { b: true })));
  });
});

describe("applySnapshot / applyDiff", () => {
  const snap = {
    cols: 10,
    rows: 3,
    cursor: { x: 0, y: 2 },
    lines: [L("a"), L("b"), L("c")],
    scrollbackTotal: 100,
    gen: 1,
  };

  it("first snapshot starts with empty history", () => {
    const st = applySnapshot(undefined, snap);
    expect(st.lines.map((l) => l.r[0]?.t)).toEqual(["a", "b", "c"]);
    expect(st.history).toEqual([]);
    expect(st.historyFrom).toBe(100);
  });

  it("scroll moves rows into history and appends empties, then applies changes", () => {
    const st = applySnapshot(undefined, snap);
    const { state, gap } = applyDiff(st, {
      scroll: 1,
      changed: [{ i: 2, line: L("d") }],
      cursor: { x: 0, y: 2 },
      scrollbackTotal: 101,
      gen: 2,
    });
    expect(gap).toBe(false);
    expect(state.history.map((l) => l.r[0]?.t)).toEqual(["a"]);
    expect(state.historyFrom).toBe(100);
    expect(state.lines.map((l) => l.r[0]?.t)).toEqual(["b", "c", "d"]);
    expect(state.scrollbackTotal).toBe(101);
  });

  it("a later snapshot keeps history when scrollbackTotal is unchanged, drops it otherwise or on reset", () => {
    let st = applySnapshot(undefined, snap);
    st = applyDiff(st, {
      scroll: 1,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 101,
      gen: 2,
    }).state;
    expect(st.history.length).toBe(1);
    const keep = applySnapshot(st, { ...snap, scrollbackTotal: 101, gen: 3 });
    expect(keep.history.length).toBe(1);
    const drop = applySnapshot(st, { ...snap, scrollbackTotal: 105, gen: 3 });
    expect(drop.history).toEqual([]);
    const reset = applySnapshot(st, { ...snap, scrollbackTotal: 101, gen: 3, reset: true });
    expect(reset.history).toEqual([]);
  });

  it("detects gen gaps and leaves state untouched", () => {
    const st = applySnapshot(undefined, snap);
    const r = applyDiff(st, {
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 100,
      gen: 5,
    });
    expect(r.gap).toBe(true);
    expect(r.state).toBe(st);
  });

  it("caps history at 5000 and advances historyFrom", () => {
    let st: ScreenState = applySnapshot(undefined, { ...snap, rows: 1, lines: [L("0")] });
    for (let g = 2; g <= 5002; g++) {
      st = applyDiff(st, {
        scroll: 1,
        changed: [{ i: 0, line: L(String(g)) }],
        cursor: { x: 0, y: 0 },
        scrollbackTotal: 100 + g - 1,
        gen: g,
      }).state;
    }
    expect(st.history.length).toBe(5000);
    expect(st.historyFrom).toBe(101);
  });

  it("emptyLine has no runs", () => {
    expect(emptyLine()).toEqual({ r: [] });
  });

  it("bounds scroll so lines.length never exceeds the original row count", () => {
    const st = applySnapshot(undefined, { ...snap, rows: 2, lines: [L("a"), L("b")] });
    const { state } = applyDiff(st, {
      scroll: 5,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 101,
      gen: 2,
    });
    expect(state.lines.length).toBe(2);
  });

  it("rejects scroll over 1000 in parseInner", () => {
    expect(() =>
      parseInner({
        type: "screen.diff",
        sessionId: "iterm2:x",
        scroll: 1001,
        changed: [],
        cursor: { x: 0, y: 0 },
        scrollbackTotal: 1,
        gen: 2,
      }),
    ).toThrow(/malformed/);
  });
});
