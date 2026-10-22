import { describe, expect, it } from "vitest";
import { customTerminalSize, InitialTerminalSizer } from "../src/terminal/initial-size";

describe("initial terminal sizing", () => {
  it("accepts bounded custom cell counts and rejects malformed or oversized dimensions", () => {
    expect(customTerminalSize("40", "24")).toEqual({ cols: 40, rows: 24 });
    expect(customTerminalSize("240", "100")).toEqual({ cols: 240, rows: 100 });
    for (const [cols, rows] of [
      ["39", "24"],
      ["240", "101"],
      ["54", "23"],
      ["241", "40"],
      ["", "40"],
      ["54.5", "40"],
      ["1e2", "40"],
      ["54", "-1"],
    ])
      expect(customTerminalSize(cols!, rows!)).toBeUndefined();
  });
  it("uses the intended-font terminal measurement and keeps it through keyboard shrinkage", () => {
    const s = new InitialTerminalSizer();
    s.remember({ cols: 54, rows: 38, width: 390, height: 610, fontSize: 12 }, 844);
    s.remember({ cols: 54, rows: 8, width: 390, height: 130, fontSize: 12 }, 844);
    expect(s.forWindow({ width: 390, height: 400 }, 12, {}, true)).toEqual({ cols: 54, rows: 38 });
    // Even a modest reduction must compare app-window heights, not content height.
    expect(s.forWindow({ width: 390, height: 700 }, 12, { top: 47, bottom: 34 })).toEqual({
      cols: 54,
      rows: 26,
    });
    // A genuinely shorter app window must not reuse a taller full-screen sample.
    expect(s.forWindow({ width: 390, height: 400 }, 12)).toEqual({ cols: 54, rows: 24 });
    s.remember({ cols: 54, rows: 29, width: 390, height: 460, fontSize: 12 }, 700);
    expect(s.forWindow({ width: 390, height: 700 }, 12)).toEqual({ cols: 54, rows: 29 });
    expect(s.forWindow({ width: 390, height: 844 }, 12)).toEqual({ cols: 54, rows: 40 });
  });
  it("estimates usable space before a terminal exists and discards stale font/orientation measurements", () => {
    const s = new InitialTerminalSizer();
    expect(s.forWindow({ width: 390, height: 844 }, 12, { top: 47, bottom: 34 })).toEqual({
      cols: 54,
      rows: 35,
    });
    s.remember({ cols: 54, rows: 38, width: 390, height: 610, fontSize: 12 }, 844);
    expect(s.forWindow({ width: 844, height: 390 }, 12, { left: 47, right: 47 })).toEqual({
      cols: 104,
      rows: 24,
    });
    expect(s.forWindow({ width: 390, height: 844 }, 18)).toEqual({ cols: 40, rows: 27 });
  });
  it("bounds tiny and huge viewports and ignores malformed samples", () => {
    const s = new InitialTerminalSizer();
    expect(s.forWindow({ width: 100, height: 100 }, 24)).toEqual({ cols: 40, rows: 24 });
    expect(s.forWindow({ width: 3000, height: 3000 }, 5)).toEqual({ cols: 240, rows: 100 });
    s.remember({ cols: Infinity, rows: 5, width: 390, height: 610, fontSize: 12 }, 844);
    expect(s.forWindow({ width: 390, height: 844 }, 12)).toEqual({ cols: 54, rows: 40 });
    expect(s.forWindow({ width: 0, height: 100 }, 12)).toBeUndefined();
    expect(s.forWindow({ width: 390, height: 844 }, NaN)).toBeUndefined();
  });
});
