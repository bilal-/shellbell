import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import type { TerminalRow } from "../src/terminal/adapter";
import { TerminalBuffer } from "../src/terminal/buffer";

const row = (key: string, text: string, liveRow?: number): TerminalRow => ({
  key,
  history: liveRow === undefined,
  liveRow,
  line: { r: [{ t: text }] },
});
const lines = (term: Terminal) =>
  Array.from({ length: term.buffer.active.length }, (_, index) =>
    term.buffer.active.getLine(index)?.translateToString(true),
  );

describe("xterm-owned source buffer", () => {
  it("preserves a soft-wrapped history/live boundary through live updates", async () => {
    const term = new Terminal({ cols: 5, rows: 2, scrollback: 10000, allowProposedApi: true });
    const buffer = new TerminalBuffer(term);
    const history: TerminalRow = {
      key: "h:0",
      history: true,
      absoluteRow: 0,
      line: { r: [{ t: "abcde" }], w: true },
    };
    await buffer.present([history, { ...row("live:0", "fgh", 0), absoluteRow: 1 }], 5, 2);
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
    await buffer.present([history, { ...row("live:0", "xyz", 0), absoluteRow: 1 }], 5, 2);
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
    term.dispose();
  });
  it("loads all retained history into the real buffer, beyond the visible screen", async () => {
    const term = new Terminal({ cols: 20, rows: 2, scrollback: 10000, allowProposedApi: true });
    const buffer = new TerminalBuffer(term);
    const history = Array.from({ length: 250 }, (_, i) => row(`h:${i}`, `old ${i}`));
    await buffer.present([...history, row("live:0", "now", 0), row("live:1", "prompt", 1)], 20, 2);
    expect(term.buffer.active.baseY).toBe(250);
    expect(lines(term)[0]).toBe("old 0");
    expect(lines(term).at(-1)).toBe("prompt");
    term.dispose();
  });
  it("updates the source grid without rewriting or losing history", async () => {
    const term = new Terminal({ cols: 12, rows: 2, scrollback: 10000, allowProposedApi: true });
    const buffer = new TerminalBuffer(term);
    const history = [row("h:0", "retained")];
    await buffer.present([...history, row("live:0", "before", 0)], 12, 2);
    expect(await buffer.present([...history, row("live:0", "after", 0)], 12, 2)).toBe("update");
    expect(lines(term)).toEqual(["retained", "after", " "]);
    term.dispose();
  });
  it("appends ordinary history through xterm scrolling and preserves source columns", async () => {
    const term = new Terminal({ cols: 12, rows: 2, scrollback: 10000, allowProposedApi: true });
    const buffer = new TerminalBuffer(term);
    const first = row("h:0", "first");
    await buffer.present([first, row("live:0", "old live", 0)], 12, 2);
    expect(
      await buffer.present(
        [first, row("h:1", "second"), row("h:2", "third"), row("live:0", "new live", 0)],
        12,
        2,
      ),
    ).toBe("append");
    expect(lines(term)).toEqual(["first", "second", "third", "new live", " "]);
    term.dispose();
  });
  it("preserves soft-wrap relationships and styles through source-buffer replay", async () => {
    const term = new Terminal({ cols: 5, rows: 2, scrollback: 10000, allowProposedApi: true });
    const buffer = new TerminalBuffer(term);
    await buffer.present(
      [
        {
          key: "h:0",
          history: true,
          absoluteRow: 0,
          line: { r: [{ t: "abcde", fg: 1 }], w: true },
        },
        { ...row("live:0", "fgh", 0), absoluteRow: 1 },
      ],
      5,
      2,
    );
    expect(lines(term)).toEqual(["abcde", "fgh", " "]);
    expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
    expect(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(1);
    term.dispose();
  });
});
