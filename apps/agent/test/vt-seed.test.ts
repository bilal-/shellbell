import { describe, expect, it } from "vitest";
import { buildSeed, seedCommands } from "../src/backends/tmux/vt-seed.js";

// history_size, pane_width, pane_height, cursor x/y, scroll region, origin, wrap, insert,
// cursor, keypad cursor, keypad, alternate on, alternate saved x/y, tabs, shape, blinking.
const state = (overrides: Record<number, string> = {}) =>
  [
    "0",
    "10",
    "2",
    "3",
    "1",
    "0",
    "1",
    "0",
    "1",
    "0",
    "1",
    "0",
    "0",
    "0",
    "0",
    "0",
    "8",
    "default",
    "0",
  ]
    .map((value, i) => overrides[i] ?? value)
    .join("\t");

describe("seedCommands", () => {
  it("targets only a well-formed pane id", () => {
    expect(seedCommands("%12")).toHaveLength(5);
    expect(() => seedCommands("%1; kill-server")).toThrow("invalid tmux pane id");
  });
});

describe("buildSeed", () => {
  it("ignores the history reply when tmux reports no history", () => {
    // With no history tmux answers `-E -1` with the first visible row instead.
    const seed = buildSeed([[state()], ["row0"], ["row0", "row1"], [""], [""]]);
    expect(seed).toMatchObject({ cols: 10, rows: 2 });
    expect(seed.data).toContain("\x1b[Hrow0\r\nrow1\x1b[0m");
    expect(seed.data.match(/row0/g)).toHaveLength(1);
  });

  it("writes the normal grid, then the alternate screen, while the alternate screen is on", () => {
    const { data } = buildSeed([
      [state({ 0: "1", 13: "1", 14: "4", 15: "1" })],
      ["old"],
      ["alt0", "alt1"],
      ["norm0", "norm1"],
      [""],
    ]);
    expect(data).toContain("old\r\nnorm0\r\nnorm1\x1b[0m\x1b[2;5H\x1b[?1049halt0\r\nalt1");
  });

  it("refuses a state reply it does not understand", () => {
    expect(() => buildSeed([["1\t2"], [], [], [], []])).toThrow("unexpected tmux pane state");
    expect(() => buildSeed([[state({ 3: "" })], [], [], [], []])).toThrow(
      "unexpected tmux cursor_x",
    );
  });
});
