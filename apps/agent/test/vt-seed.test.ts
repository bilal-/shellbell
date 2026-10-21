import { VT_CONTINUATION_PREAMBLE } from "@shellbell/protocol";
import xterm from "@xterm/headless";
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

  it("keeps a row's background from spilling into the next row", () => {
    // tmux resets a full row's background only at the start of the next captured row.
    const { data } = buildSeed([
      [state({ 0: "1" })],
      ["\x1b[48;5;234mprompt \x1b[38;5;70mok"],
      ["\x1b[49mhello", "\x1b[41;1mred"],
      [""],
      [""],
    ]);
    expect(data).toContain(
      "\x1b[48;5;234mprompt \x1b[38;5;70mok\x1b[49m\r\n\x1b[48;5;234m\x1b[49mhello\r\n\x1b[41;1mred\x1b[0m",
    );
  });

  it("does not take colour indexes for backgrounds", () => {
    const { data } = buildSeed([
      [state()],
      [],
      ["\x1b[38;5;41;58;2;1;2;44mfg", "next"],
      [""],
      [""],
    ]);
    expect(data).toContain("fg\r\nnext");
  });

  it("refuses a state reply it does not understand", () => {
    expect(() => buildSeed([["1\t2"], [], [], [], []])).toThrow("unexpected tmux pane state");
    expect(() => buildSeed([[state({ 3: "" })], [], [], [], []])).toThrow(
      "unexpected tmux cursor_x",
    );
  });
});

describe("screen-only continuation seeds", () => {
  const write = (term: InstanceType<typeof xterm.Terminal>, data: string) =>
    new Promise<void>((resolve) => term.write(new TextEncoder().encode(data), resolve));
  const lines = (term: InstanceType<typeof xterm.Terminal>) =>
    Array.from({ length: term.buffer.normal.length }, (_, i) =>
      term.buffer.normal.getLine(i)!.translateToString(true),
    );

  it("replaces the live grid without importing source history or scrolling old cells", async () => {
    const term = new xterm.Terminal({ cols: 10, rows: 2, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "retained\r\nold1\r\nold2");
      const seed = buildSeed([[state({ 0: "1" })], ["duplicate"], ["new1", "new2"], [], []], true);
      await write(term, seed.data);
      expect(lines(term)).toEqual(["retained", "new1", "new2"]);
      expect(term.buffer.normal.baseY).toBe(1);
    } finally {
      term.dispose();
    }
  });

  it("keeps retained history through normal-to-alternate and alternate-to-normal replacement", async () => {
    const term = new xterm.Terminal({ cols: 10, rows: 2, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "retained\r\nold1\r\nold2");
      await write(
        term,
        buildSeed(
          [[state({ 0: "1", 13: "1" })], ["duplicate"], ["alt1", "alt2"], ["saved1", "saved2"], []],
          true,
        ).data,
      );
      expect(term.buffer.active.type).toBe("alternate");
      expect(lines(term)).toEqual(["retained", "saved1", "saved2"]);
      await write(term, buildSeed([[state()], [], ["new1", "new2"], [], []], true).data);
      expect(term.buffer.active.type).toBe("normal");
      expect(lines(term)).toEqual(["retained", "new1", "new2"]);
    } finally {
      term.dispose();
    }
  });

  it("preserves rows when the renderer clears before changing geometry", async () => {
    const term = new xterm.Terminal({ cols: 10, rows: 3, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "retained\r\nold1\r\nold2\r\nold3");
      await write(term, VT_CONTINUATION_PREAMBLE);
      term.resize(8, 2);
      await write(term, "boundary\r\n\r\n");
      await write(term, buildSeed([[state({ 1: "8" })], [], ["new1", "new2"], [], []], true).data);
      expect(lines(term)).toEqual(["retained", "boundary", "new1", "new2"]);
    } finally {
      term.dispose();
    }
  });

  it("clears newline and cursor-blink modes inherited from the previous source", async () => {
    const term = new xterm.Terminal({ cols: 10, rows: 2, scrollback: 100, allowProposedApi: true });
    try {
      await write(term, "retained\r\nold1\r\nold2\x1b[20h\x1b[?12h");
      await write(term, VT_CONTINUATION_PREAMBLE);
      await write(term, "a\nb");
      expect(lines(term)).toEqual(["retained", "a", " b"]);
      expect(term.options.convertEol).toBe(false);
      expect(term.options.cursorBlink).toBe(false);
    } finally {
      term.dispose();
    }
  });
});

it.each([
  new Uint8Array([0xf0, 0x9f]),
  new TextEncoder().encode("\x1b]8;;https://example.test/unfinished"),
  new TextEncoder().encode("\x1bP0;0qunfinished"),
  new TextEncoder().encode("\x1b[38;2;"),
])(
  "starts a continuation outside an unfinished parser token and a saved alternate-screen charset",
  async (tail) => {
    const term = new xterm.Terminal({ cols: 10, rows: 2, scrollback: 100, allowProposedApi: true });
    const write = (data: string | Uint8Array) =>
      new Promise<void>((resolve) =>
        term.write(typeof data === "string" ? new TextEncoder().encode(data) : data, resolve),
      );
    try {
      await write("retained\r\nold1\r\nold2\x1b(0\x1b[41m\x1b[?1049h");
      await write(tail);
      await write(buildSeed([[state()], [], ["qqqq", "xxxx"], [], []], true).data);
      expect(term.buffer.active.type).toBe("normal");
      expect(
        Array.from({ length: term.buffer.normal.length }, (_, i) =>
          term.buffer.normal.getLine(i)!.translateToString(true),
        ),
      ).toEqual(["retained", "qqqq", "xxxx"]);
      expect(term.buffer.normal.getLine(1)!.getCell(0)!.isBgDefault()).toBeTruthy();
    } finally {
      term.dispose();
    }
  },
);
