import {
  encodeCbor,
  type Line,
  STREAM_LIMITS,
  type StreamHistoryPage,
  StreamHistoryRecordSchema,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { BoundedHistoryWindow } from "../src/store/bounded-history.js";

const A = "A".repeat(22);
const B = "B".repeat(22);
const REQUEST = "R".repeat(22);
const anchor = { subscriptionId: A, generation: 7, before: 10 };

function line(text: string): Line {
  return { r: [{ t: text }] };
}

function page(
  from: number,
  before: number,
  lines: Line[] = Array.from({ length: before - from }, (_, i) => line(String(from + i))),
  generation = 7,
): StreamHistoryPage {
  return {
    kind: "history",
    status: "page",
    generation,
    requestId: REQUEST,
    before,
    from,
    to: before,
    oldestAvailable: 0,
    nextBefore: from,
    lines,
  };
}

describe("BoundedHistoryWindow", () => {
  it("starts empty, prepends the actual returned range, and rejects stale or duplicate pages atomically", () => {
    const window = new BoundedHistoryWindow(anchor);
    const empty = window.snapshot;
    expect(window.snapshot).toBe(empty);
    expect(empty).toEqual({
      anchor,
      nextBefore: 10,
      readOnly: false,
      rows: [],
      gaps: [],
      encodedBytes: 0,
    });
    const incoming = page(8, 10);
    expect(StreamHistoryRecordSchema.safeParse(incoming).success).toBe(true);
    expect(window.prepend(A, incoming)).toBe(true);
    const loaded = window.snapshot;
    expect(loaded.rows.map(({ row, key, line }) => [row, key, line.r[0]?.t])).toEqual([
      [8, `${A}:8`, "8"],
      [9, `${A}:9`, "9"],
    ]);
    expect(loaded.nextBefore).toBe(8);
    expect(loaded.gaps).toEqual([]);
    expect(loaded.encodedBytes).toBe(encodeCbor(line("8")).length + encodeCbor(line("9")).length);
    expect(window.prepend(A, incoming)).toBe(false);
    expect(window.prepend(B, page(6, 8))).toBe(false);
    expect(window.prepend(A, page(6, 8, undefined, 8))).toBe(false);
    expect(window.snapshot).toBe(loaded);
    expect(loaded.rows[0]).toBe(window.snapshot.rows[0]);
  });

  it("evicts farthest old rows at the real line limit, retaining a middle visible row and the new page", () => {
    const window = new BoundedHistoryWindow({ ...anchor, before: 5200 });
    let visible: (typeof window.snapshot.rows)[number] | undefined;
    for (let before = 5200; before > 0; before -= 200) {
      const from = before - 200;
      expect(window.prepend(A, page(from, before))).toBe(true);
      if (from === 3000) {
        visible = window.snapshot.rows.find(({ row }) => row === 3000);
        expect(window.protect(`${A}:3000`)).toBe(true);
        expect(window.protect("missing-key")).toBe(false);
      }
    }
    const snapshot = window.snapshot;
    expect(snapshot.rows).toHaveLength(STREAM_LIMITS.cacheLines);
    expect(snapshot.rows.map(({ row }) => row).slice(0, 200)).toEqual(
      Array.from({ length: 200 }, (_, i) => i),
    );
    expect(snapshot.rows.find(({ row }) => row === 3000)).toBe(visible);
    expect(snapshot.rows.some(({ row }) => row === 200)).toBe(false);
    expect(snapshot.rows.some(({ row }) => row === 400)).toBe(true);
    expect(snapshot.gaps).toEqual([{ from: 200, to: 400 }]);
    expect(snapshot.encodedBytes).toBeLessThan(STREAM_LIMITS.cacheBytes);
  });

  it("evicts the newest rows when no visible row is protected", () => {
    const window = new BoundedHistoryWindow({ ...anchor, before: 5200 });
    for (let before = 5200; before > 0; before -= 200) {
      expect(window.prepend(A, page(before - 200, before))).toBe(true);
    }
    expect(window.snapshot.rows).toHaveLength(STREAM_LIMITS.cacheLines);
    expect(window.snapshot.rows[0]?.row).toBe(0);
    expect(window.snapshot.rows.at(-1)?.row).toBe(4999);
    expect(window.snapshot.gaps).toEqual([{ from: 5000, to: 5200 }]);
    expect(window.protect(`${A}:4999`)).toBe(true);
    expect(window.protect(null)).toBe(true);
    expect(window.protect(`${A}:5199`)).toBe(false);
  });

  it("evicts on encoded multibyte styled-line bytes before the line limit", () => {
    const styled: Line = {
      r: [{ t: "界".repeat(2500), fg: [2, 31, 200], bg: [20, 40, 60], b: true }],
    };
    const lineBytes = encodeCbor(styled).length;
    expect(lineBytes * 600).toBeGreaterThan(STREAM_LIMITS.cacheBytes);
    expect(600).toBeLessThan(STREAM_LIMITS.cacheLines);
    expect(StreamHistoryRecordSchema.safeParse(page(592, 600, Array(8).fill(styled))).success).toBe(
      true,
    );
    const window = new BoundedHistoryWindow({ ...anchor, before: 600 });
    for (let before = 600; before > 0; before -= 8) {
      expect(window.prepend(A, page(before - 8, before, Array(8).fill(styled)))).toBe(true);
      if (before - 8 === 296) expect(window.protect(`${A}:300`)).toBe(true);
    }
    const snapshot = window.snapshot;
    const expectedCount = Math.floor(STREAM_LIMITS.cacheBytes / lineBytes);
    expect(snapshot.rows).toHaveLength(expectedCount);
    expect(snapshot.encodedBytes).toBe(expectedCount * lineBytes);
    expect(snapshot.encodedBytes).toBeLessThanOrEqual(STREAM_LIMITS.cacheBytes);
    expect(snapshot.rows.map(({ row }) => row).slice(0, 8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(snapshot.rows.some(({ row }) => row === 300)).toBe(true);
    expect(snapshot.gaps.length).toBeGreaterThan(0);
    const present = new Set(snapshot.rows.map(({ row }) => row));
    for (const gap of snapshot.gaps) {
      expect(gap.from).toBeLessThan(gap.to);
      for (let row = gap.from; row < gap.to; row++) expect(present.has(row)).toBe(false);
    }
    expect(snapshot.rows.length + snapshot.gaps.reduce((n, gap) => n + gap.to - gap.from, 0)).toBe(
      600,
    );
  });

  it("skips sparse huge coordinates one at a time without allocating missing rows", () => {
    const before = Number.MAX_SAFE_INTEGER;
    const window = new BoundedHistoryWindow({ ...anchor, before });
    expect(window.prepend(A, page(before - 2, before))).toBe(true);
    expect(window.skip(A, before)).toBe(false);
    for (let n = 0; n < 1000; n++) {
      expect(window.skip(A, before - 2 - n)).toBe(true);
    }
    expect(window.snapshot.nextBefore).toBe(before - 1002);
    expect(window.snapshot.rows.map(({ row }) => row)).toEqual([before - 2, before - 1]);
    expect(window.snapshot.gaps).toEqual([{ from: before - 1002, to: before - 2 }]);
    expect(window.snapshot.gaps.length).toBeLessThanOrEqual(window.snapshot.rows.length + 1);
    expect(window.skip(B, window.snapshot.nextBefore)).toBe(false);
    expect(window.skip(A, window.snapshot.nextBefore + 1)).toBe(false);
  });

  it("skips the last available coordinate to zero, then refuses underflow", () => {
    const window = new BoundedHistoryWindow({ ...anchor, before: 1 });
    expect(window.skip(A, 1)).toBe(true);
    const atZero = window.snapshot;
    expect(atZero.nextBefore).toBe(0);
    expect(atZero.gaps).toEqual([{ from: 0, to: 1 }]);
    expect(window.skip(A, 0)).toBe(false);
    expect(window.snapshot).toBe(atZero);
  });

  it("keeps retained history through detach and failed refresh, then atomically replaces with a new ID", () => {
    const window = new BoundedHistoryWindow(anchor);
    expect(window.prepend(A, page(8, 10))).toBe(true);
    const oldRow = window.snapshot.rows[0];
    if (!oldRow) throw new Error("fixture row missing");
    expect(window.protect(oldRow.key)).toBe(true);
    window.detach();
    const detached = window.snapshot;
    window.detach();
    expect(window.snapshot).toBe(detached);
    expect(detached.readOnly).toBe(true);
    expect(detached.rows[0]).toBe(oldRow);
    expect(window.protect("unknown")).toBe(false);
    expect(window.protect(oldRow.key)).toBe(true);
    expect(window.prepend(A, page(6, 8))).toBe(false);
    expect(window.skip(A, 8)).toBe(false);
    expect(window.replace(anchor, page(8, 10))).toBe(false);
    expect(
      window.replace({ subscriptionId: B, generation: 7, before: 10 }, page(8, 10, [], 7)),
    ).toBe(false);
    expect(window.replace({ subscriptionId: B, generation: 8, before: 10 }, page(8, 10))).toBe(
      false,
    );
    expect(window.snapshot).toBe(detached);
    expect(window.replace({ subscriptionId: B, generation: 7, before: 6 }, page(4, 6))).toBe(true);
    expect(window.snapshot).toEqual({
      anchor: { subscriptionId: B, generation: 7, before: 6 },
      nextBefore: 4,
      readOnly: false,
      rows: [
        { key: `${B}:4`, row: 4, line: line("4") },
        { key: `${B}:5`, row: 5, line: line("5") },
      ],
      gaps: [],
      encodedBytes: encodeCbor(line("4")).length + encodeCbor(line("5")).length,
    });
    expect(window.protect(oldRow.key)).toBe(false);
  });

  it("owns and recursively freezes normalized data without freezing caller values", () => {
    const sourceAnchor = { ...anchor };
    const sourceLine: Line = { r: [{ t: "start", fg: [1, 2, 3] }], w: true };
    const sourceRun = sourceLine.r[0];
    if (!sourceRun || !Array.isArray(sourceRun.fg)) throw new Error("fixture run missing");
    const source = page(9, 10, [sourceLine]);
    const window = new BoundedHistoryWindow(sourceAnchor);
    expect(window.prepend(A, source)).toBe(true);
    const snapshot = window.snapshot;
    sourceAnchor.before = 99;
    sourceRun.t = "changed";
    sourceRun.fg[0] = 99;
    source.lines.push(line("extra"));
    expect(snapshot.anchor.before).toBe(10);
    expect(snapshot.rows[0]?.line).toEqual({ r: [{ t: "start", fg: [1, 2, 3] }], w: true });
    expect(Object.isFrozen(sourceAnchor)).toBe(false);
    expect(Object.isFrozen(sourceRun.fg)).toBe(false);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.anchor)).toBe(true);
    expect(Object.isFrozen(snapshot.rows)).toBe(true);
    expect(Object.isFrozen(snapshot.rows[0])).toBe(true);
    const publishedColor = snapshot.rows[0]?.line.r[0]?.fg;
    if (!Array.isArray(publishedColor)) throw new Error("published color missing");
    expect(Object.isFrozen(publishedColor)).toBe(true);
    expect(Reflect.set(publishedColor, "0", 77)).toBe(false);
    expect(Reflect.set(snapshot.rows as object, "0", null)).toBe(false);
    expect(window.snapshot).toBe(snapshot);
  });

  it("rejects invalid and throwing input payload-free and fences reentrant validation", () => {
    expect(() => new BoundedHistoryWindow({ ...anchor, generation: -1 })).toThrow(
      "Invalid history anchor",
    );
    const hostileAnchor = new Proxy(anchor, {
      get() {
        throw new Error("secret anchor");
      },
    });
    expect(() => new BoundedHistoryWindow(hostileAnchor)).toThrowError(
      new TypeError("Invalid history anchor"),
    );
    const window = new BoundedHistoryWindow(anchor);
    const hostilePage = new Proxy(page(8, 10), {
      get() {
        throw new Error("secret page");
      },
    });
    const empty = window.snapshot;
    expect(window.prepend(A, hostilePage)).toBe(false);
    expect(window.snapshot).toBe(empty);
    const reentrant = page(8, 10);
    let called = false;
    Object.defineProperty(reentrant, "before", {
      get() {
        if (!called) {
          called = true;
          expect(window.skip(A, 10)).toBe(true);
        }
        return 10;
      },
    });
    expect(window.prepend(A, reentrant)).toBe(false);
    expect(window.snapshot.nextBefore).toBe(9);
    expect(window.snapshot.rows).toEqual([]);
    expect(window.snapshot.gaps).toEqual([{ from: 9, to: 10 }]);
    const refreshAnchor = { subscriptionId: B, generation: 7, before: 8 };
    let refreshCalled = false;
    Object.defineProperty(refreshAnchor, "before", {
      get() {
        if (!refreshCalled) {
          refreshCalled = true;
          window.detach();
        }
        return 8;
      },
    });
    expect(window.replace(refreshAnchor, page(6, 8))).toBe(false);
    expect(window.snapshot.readOnly).toBe(true);
    expect(window.snapshot.anchor.subscriptionId).toBe(A);
  });

  it("atomically replaces after explicit leading skips while retaining the original anchor and gap", () => {
    const window = new BoundedHistoryWindow(anchor);
    expect(window.prepend(A, page(8, 10))).toBe(true);
    const old = window.snapshot;
    const freshAnchor = { subscriptionId: B, generation: 11, before: 10 };
    const freshPage = page(6, 8, [line("older 6"), line("older 7")], 11);
    expect(window.replace(freshAnchor, freshPage, -1)).toBe(false);
    expect(window.replace(freshAnchor, freshPage, Number.MAX_SAFE_INTEGER + 1)).toBe(false);
    expect(window.replace(freshAnchor, freshPage, 11)).toBe(false);
    expect(window.replace(freshAnchor, freshPage)).toBe(false);
    expect(window.snapshot).toBe(old);
    expect(window.replace(freshAnchor, freshPage, 2)).toBe(true);
    expect(window.snapshot.anchor).toEqual(freshAnchor);
    expect(window.snapshot.nextBefore).toBe(6);
    expect(window.snapshot.rows.map(({ row }) => row)).toEqual([6, 7]);
    expect(window.snapshot.gaps).toEqual([{ from: 8, to: 10 }]);
    freshPage.lines[0]!.r[0]!.t = "mutated";
    expect(window.snapshot.rows[0]?.line.r[0]?.t).toBe("older 6");
    expect(old.rows.map(({ row }) => row)).toEqual([8, 9]);
  });
});
