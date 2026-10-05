import { encodeCbor, type Line, STREAM_LIMITS } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../src/store/screen.js";

const L = (t: string): Line => ({ r: [{ t }] });
const snap = (lines: Line[], scrollbackTotal: number, gen: number) => ({
  cols: 10,
  rows: lines.length,
  cursor: { x: 0, y: 0 },
  lines,
  scrollbackTotal,
  gen,
});

describe("keyed screen state", () => {
  it("keeps keys for unchanged rows and moves scrolled-out rows to history", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("a"), L("b"), L("c")], 0, 1));
    const keys1 = v1.keyed.map((k) => k.key);
    const r = applyDiffKeyed(v1, {
      scroll: 1,
      changed: [{ i: 2, line: L("d") }],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 1,
      gen: 2,
    });
    expect(r.gap).toBe(false);
    expect(r.view.keyed.map((k) => k.r[0]?.t)).toEqual(["a", "b", "c", "d"]);
    expect(r.view.keyed.slice(0, 3).map((k) => k.key)).toEqual(keys1);
    expect(r.view.keyed[3]?.key).not.toBe(keys1[2]);
  });

  it("returns the same view and gap=true when gen jumps", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("a")], 0, 1));
    const r = applyDiffKeyed(v1, {
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 0,
      gen: 9,
    });
    expect(r).toEqual({ view: v1, gap: true });
  });

  it("prepends history pages and moves historyFrom back", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("z")], 5, 1));
    const v2 = prependHistoryKeyed(v1, [L("x"), L("y")], 5);
    expect(v2.keyed.map((k) => k.r[0]?.t)).toEqual(["x", "y", "z"]);
    expect(v2.state.historyFrom).toBe(3);
  });

  it("ignores a history page whose `before` no longer matches", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("z")], 5, 1));
    expect(prependHistoryKeyed(v1, [L("x")], 4)).toBe(v1);
  });

  it("caps prepended history at HISTORY_CAP", () => {
    const v1 = applySnapshotKeyed(undefined, snap([L("z")], 6000, 1));
    const page = Array.from({ length: 200 }, (_, i) => L(`h${i}`));
    let v = v1;
    let before = 6000;
    for (let i = 0; i < 30; i++) {
      v = prependHistoryKeyed(v, page, before);
      before -= 200;
    }
    expect(v.state.history.length).toBeLessThanOrEqual(5000);
    expect(v.keyed.length).toBe(v.state.history.length + v.state.lines.length);
  });

  it("bounds aggregate styled multibyte legacy history bytes", () => {
    const wide = L("界".repeat(900));
    wide.r[0] = { t: "界".repeat(900), fg: [12, 34, 56] };
    let view = applySnapshotKeyed(undefined, snap([L("live")], 4000, 1));
    for (let before = 4000; before > 0; before -= 100) {
      view = prependHistoryKeyed(
        view,
        Array.from({ length: 100 }, () => wide),
        before,
      );
    }
    expect(view.state.history.length).toBeLessThanOrEqual(STREAM_LIMITS.cacheLines);
    expect(
      view.state.history.reduce((sum, row) => sum + encodeCbor(row).length, 0),
    ).toBeLessThanOrEqual(STREAM_LIMITS.cacheBytes);
    expect(view.keyed.length).toBe(view.state.history.length + view.state.lines.length);
  });
});
