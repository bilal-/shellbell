import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { cursorColor, paintViewport, type TerminalRow } from "../src/terminal/adapter";

it("keeps an inferred Herdr cursor visibly fainter than an authoritative cursor", () => {
  expect(cursorColor("#80c0ff", true)).toBe("#203040");
  expect(cursorColor("#80c0ff", false)).toBe("#5a86b3");
});

function row(text: string, index = 0, wrap = false): TerminalRow {
  return {
    key: String(index),
    absoluteRow: index,
    history: false,
    line: { r: [{ t: text }], w: wrap },
  };
}
async function render(rows: TerminalRow[], cols = 20) {
  const term = new Terminal({ cols, rows: Math.max(2, rows.length), allowProposedApi: true });
  term.loadAddon(new UnicodeGraphemesAddon());
  await new Promise<void>((resolve) => term.write(paintViewport(rows, cols), resolve));
  return term;
}

describe("snapshot viewport in real xterm buffer", () => {
  it("renders iTerm's NUL cell placeholders as spaces, not replacement diamonds", async () => {
    const term = await render([row("A\u0000B")]);
    try {
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("A B");
    } finally {
      term.dispose();
    }
  });
  it("respects host-declared cell positions even when its flag width differs from xterm", async () => {
    const term = await render([{ ...row(""), line: { r: [{ t: "🇨🇦X", n: 5 }] } }]);
    try {
      expect(term.buffer.active.getLine(0)?.getCell(4)?.getChars()).toBe("X");
    } finally {
      term.dispose();
    }
  });
  it("paints styled rows and erases a previous longer update", async () => {
    const term = await render([
      { ...row(""), line: { r: [{ t: "long old content", fg: [1, 2, 3], b: true }] } },
    ]);
    try {
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("long old content");
      expect(term.buffer.active.getLine(0)?.getCell(0)?.getFgColor()).toBe(0x010203);
      await new Promise<void>((done) => term.write(paintViewport([row("new")], 20), done));
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("new");
    } finally {
      term.dispose();
    }
  });
  it("preserves contiguous soft-wrap selection semantics without bottom-row scrolling", async () => {
    const term = await render([row("abcde", 0, true), row("fghij", 1)], 5);
    try {
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("abcde");
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("fghij");
      expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
      expect(term.buffer.active.baseY).toBe(0);
    } finally {
      term.dispose();
    }
  });
  it("does not join across omitted source rows", async () => {
    const term = await render([row("abcde", 0, true), row("next", 3)], 5);
    try {
      expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);
    } finally {
      term.dispose();
    }
  });
  it("clears old wrap flags in the snapshot write without a separate terminal reset", async () => {
    const term = await render([row("abcde", 0, true), row("fghij", 1)], 5);
    try {
      expect(term.buffer.active.getLine(1)?.isWrapped).toBe(true);
      await new Promise<void>((done) =>
        term.write(paintViewport([row("a", 0), row("b", 1)], 5), done),
      );
      expect(term.buffer.active.getLine(1)?.isWrapped).toBe(false);
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("a");
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("b");
      expect(term.buffer.active.baseY).toBe(0);
    } finally {
      term.dispose();
    }
  });
  it("renders combining text, CJK and joined emoji at terminal cell positions", async () => {
    const term = await render([row("漢字 👨‍💻 cafe\u0301")]);
    try {
      const line = term.buffer.active.getLine(0)!;
      expect(line.getCell(0)?.getWidth()).toBe(2);
      expect(line.getCell(5)?.getChars()).toBe("👨‍💻");
      expect(line.getCell(8)?.getChars()).toBe("c");
      expect(line.getCell(11)?.getChars()).toBe("e\u0301");
    } finally {
      term.dispose();
    }
  });
  it("does not execute embedded escape, newline or clipboard control sequences", async () => {
    const term = await render([row("A\x1b[2J\r\nB\x9bC")]);
    try {
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("A�[2J��B�C");
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("");
    } finally {
      term.dispose();
    }
  });
  it("clips oversized source rows without spilling into the following row", async () => {
    const term = await render([row("abcdefghijk"), row("ok", 1)], 5);
    try {
      expect(term.buffer.active.getLine(0)?.translateToString(true)).toBe("abcde");
      expect(term.buffer.active.getLine(1)?.translateToString(true)).toBe("ok");
      expect(term.buffer.active.baseY).toBe(0);
    } finally {
      term.dispose();
    }
  });
});
