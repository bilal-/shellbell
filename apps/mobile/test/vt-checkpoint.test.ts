import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { Terminal } from "@xterm/headless";
import { afterEach, describe, expect, it } from "vitest";
import { checkpointVtHistory, restoreVtHistory, writeVt } from "../src/terminal/vt-checkpoint";

const encoder = new TextEncoder();
const terminals: Terminal[] = [];
function terminal(cols = 40, rows = 4) {
  const term = new Terminal({ cols, rows, scrollback: 10000, allowProposedApi: true });
  terminals.push(term);
  const serializer = new SerializeAddon();
  term.loadAddon(new UnicodeGraphemesAddon() as unknown as Parameters<Terminal["loadAddon"]>[0]);
  term.loadAddon(serializer as unknown as Parameters<Terminal["loadAddon"]>[0]);
  return { term, serializer };
}
const write = (term: Terminal, data: string | Uint8Array) =>
  writeVt(term, typeof data === "string" ? encoder.encode(data) : data);
const lines = (term: Terminal, normal = false) => {
  const buffer = normal ? term.buffer.normal : term.buffer.active;
  return Array.from({ length: buffer.length }, (_, i) =>
    buffer.getLine(i)?.translateToString(true),
  );
};
function state(term: Terminal) {
  const snapshot = (buffer: Terminal["buffer"]["active"]) => ({
    baseY: buffer.baseY,
    cursorX: buffer.cursorX,
    cursorY: buffer.cursorY,
    lines: Array.from({ length: buffer.length }, (_, index) => {
      const line = buffer.getLine(index)!;
      return {
        wrapped: line.isWrapped,
        cells: Array.from({ length: term.cols }, (_, column) => {
          const cell = line.getCell(column)!;
          return [
            cell.getChars(),
            cell.getWidth(),
            cell.getFgColor(),
            cell.getBgColor(),
            cell.isBold(),
            cell.isDim(),
            cell.isItalic(),
            cell.isUnderline(),
            cell.isInverse(),
          ];
        }),
      };
    }),
  });
  return {
    cols: term.cols,
    rows: term.rows,
    modes: term.modes,
    convertEol: term.options.convertEol,
    cursorBlink: term.options.cursorBlink,
    active: term.buffer.active.type,
    normal: snapshot(term.buffer.normal),
    alternate: snapshot(term.buffer.alternate),
  };
}
afterEach(() => {
  for (const term of terminals.splice(0)) term.dispose();
});

describe("VT history checkpoint", () => {
  it("retains scrollback with a divider and excludes the old live screen before resize", async () => {
    const { term, serializer } = terminal(40, 4);
    await write(term, "old 0\r\nold 1\r\nobsolete 0\r\nobsolete 1\r\nobsolete 2\r\nobsolete 3");
    const history = await checkpointVtHistory(term, serializer, 20, 3);
    expect(history.rows).toBe(3);
    expect(history.dropped).toBe(false);
    expect(lines(term)).toEqual(["old 0", "old 1", "[History may have a ", "", "", ""]);
    const restored = terminal(80, 24).term;
    await restoreVtHistory(restored, history, 20, 3);
    expect(state(restored)).toEqual(state(term));
  });

  it("preserves styled and wrapped scrollback through a narrower geometry", async () => {
    const { term, serializer } = terminal(12, 3);
    await write(
      term,
      "\x1b[31mabcdefghijklmnopqrstuvwx\x1b[0m\r\nline 2\r\nlive 0\r\nlive 1\r\nlive 2",
    );
    const history = await checkpointVtHistory(term, serializer, 8, 4);
    expect(lines(term).join("\n")).not.toContain("live");
    expect(lines(term).slice(0, 3).join("")).toBe("abcdefghijklmnopqrstuvwx");
    expect(term.buffer.normal.getLine(0)!.getCell(0)!.getFgColor()).toBe(1);
    expect(term.buffer.normal.getLine(1)!.isWrapped).toBe(true);
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 8, 4);
    expect(state(restored)).toEqual(state(term));
  });

  it.each([1, 2])("does not lose retained history when growing a %s-row viewport", async (rows) => {
    const { term, serializer } = terminal(40, rows);
    await write(
      term,
      "old 0\r\nold 1\r\nold 2\r\n" +
        Array.from({ length: rows }, (_, i) => `live ${i}`).join("\r\n"),
    );
    const history = await checkpointVtHistory(term, serializer, 40, 10);
    expect(lines(term).slice(0, 3)).toEqual(["old 0", "old 1", "old 2"]);
    expect(history.rows).toBe(4);
    expect(term.buffer.normal.baseY).toBe(4);
    expect(lines(term)[3]).toBe("[History may have a gap or overlap]");
    expect(lines(term).slice(4)).toEqual(Array(10).fill(""));
  });

  it.each([
    ["UTF-8", new Uint8Array([0xf0, 0x9f]), new Uint8Array([0x98, 0x80])],
    ["CSI", encoder.encode("\x1b[38;2;13;"), encoder.encode("27;49mcolored")],
    ["OSC", encoder.encode("\x1b]0;unfinished"), encoder.encode(" title\x07visible")],
    ["DCS", encoder.encode("\x1bP$q"), encoder.encode("m\x1b\\visible")],
    ["APC", encoder.encode("\x1b_unfinished"), encoder.encode("\x1b\\visible")],
  ])(
    "replays a partial %s seed and identical subsequent bytes",
    async (_name, seed, continuation) => {
      const { term, serializer } = terminal();
      await write(term, "old\r\n1\r\n2\r\n3\r\n4");
      const history = await checkpointVtHistory(term, serializer, 40, 4);
      await write(term, seed);
      const restored = terminal().term;
      // Even an already-used WebView/parser must be canceled before restoration.
      await write(restored, "\x1b]0;stale");
      await restoreVtHistory(restored, history, 40, 4);
      await write(restored, seed);
      await write(term, continuation);
      await write(restored, continuation);
      expect(state(restored)).toEqual(state(term));
    },
  );

  it("replays tabs, saved cursor, charset, modes and alternate screen from the seed and tail", async () => {
    const { term, serializer } = terminal();
    await write(term, "before\r\n1\r\n2\r\n3\r\n4\x1b[3g\x1b[?1h\x1b[?2004h\x1b(0\x1b7");
    const history = await checkpointVtHistory(term, serializer, 40, 4);
    const seed =
      "\x1b[20h\x1b[?12h\x1b[2;4H\x1b[32m\x1b7\x1b[?1h\x1b[?2004h\x1b[?1049h\x1b(0qqq\x1b(B";
    const tail = "\x1b[3g\x1b[1;6H\x1bH\x1b[H\tT";
    await write(term, seed + tail);
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 40, 4);
    await write(restored, seed);
    await write(restored, tail);
    expect(state(restored)).toEqual(state(term));
    const next = "\x1b[?1049l\x1b8R\x1b[H\tT\x1b(0qq\x1b(B";
    await write(term, next);
    await write(restored, next);
    expect(state(restored)).toEqual(state(term));
  });

  it("resets newline and cursor-blink options inherited from the previous source", async () => {
    const { term, serializer } = terminal();
    await write(term, "old\r\n1\r\n2\r\n3\r\n4\x1b[20h\x1b[?12h");
    expect(term.options.convertEol).toBe(true);
    expect(term.options.cursorBlink).toBe(true);
    const history = await checkpointVtHistory(term, serializer, 40, 4);
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 40, 4);
    await write(term, "a\nb");
    await write(restored, "a\nb");
    expect(term.options.convertEol).toBe(false);
    expect(term.options.cursorBlink).toBe(false);
    expect(state(restored)).toEqual(state(term));
  });

  it("cancels an old alternate screen and partial parser at cutover", async () => {
    const { term, serializer } = terminal();
    await write(term, "old\r\n1\r\n2\r\n3\r\n4\x1b[?1049hprivate old screen\x1b]0;unfinished");
    const history = await checkpointVtHistory(term, serializer, 40, 4);
    expect(term.buffer.active.type).toBe("normal");
    expect(lines(term).join("\n")).not.toContain("private old screen");
    expect(lines(term)[0]).toBe("old");
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 40, 4);
    await write(term, "next");
    await write(restored, "next");
    expect(state(restored)).toEqual(state(term));
  });

  it.each([
    new Uint8Array([0xf0, 0x9f]),
    encoder.encode("\x1b[38;2;13;"),
    encoder.encode("\x1bPunfinished"),
    encoder.encode("\x1b_unfinished"),
  ])("cancels partial old parser bytes without retaining them", async (partial) => {
    const { term, serializer } = terminal();
    await write(term, "old\r\n1\r\n2\r\n3\r\n4");
    await write(term, partial);
    await checkpointVtHistory(term, serializer, 40, 4);
    await write(term, "new");
    expect(lines(term)[0]).toBe("old");
    expect(lines(term)[term.buffer.normal.baseY]).toBe("new");
  });

  it("restores background colors and wide grapheme wraps with the runtime Unicode addon", async () => {
    const { term, serializer } = terminal(16, 3);
    const content = "ab界👩‍💻e\u0301cd".repeat(12);
    await write(term, `\x1b[44m${content}\x1b[0m\r\nlive 0\r\nlive 1\r\nlive 2`);
    const history = await checkpointVtHistory(term, serializer, 10, 3);
    expect(lines(term).join("")).toContain(content);
    expect(term.buffer.normal.getLine(0)!.getCell(0)!.getBgColor()).toBe(4);
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 10, 3);
    expect(state(restored)).toEqual(state(term));
    await write(term, "more\r\nnext");
    await write(restored, "more\r\nnext");
    expect(state(restored)).toEqual(state(term));
  });

  it("drops oldest retained rows to stay within the byte budget", async () => {
    const { term, serializer } = terminal(40, 4);
    await write(term, Array.from({ length: 100 }, (_, i) => `row ${i}`).join("\r\n"));
    const history = await checkpointVtHistory(term, serializer, 40, 4, 150);
    expect(history.data.byteLength).toBeLessThanOrEqual(150);
    expect(history.dropped).toBe(true);
    expect(history.rows).toBeGreaterThan(0);
    expect(lines(term)).not.toContain("row 0");
    expect(lines(term)).toContain("row 95");
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 40, 4);
    expect(state(restored)).toEqual(state(term));
  });

  it("bounds probes when plain recent rows hide much denser older styled rows", async () => {
    const { term, serializer } = terminal(512, 4);
    const styled = Array.from({ length: 512 }, (_, i) => `\x1b[38;2;${i % 251};27;49mX`).join("");
    await write(
      term,
      `${Array(200).fill(styled).join("\r\n")}\x1b[0m\r\n${Array(2000).fill("plain").join("\r\n")}\r\nlive0\r\nlive1\r\nlive2\r\nlive3`,
    );
    const budget = 64 * 1024;
    let largest = 0;
    const history = await checkpointVtHistory(
      term,
      {
        serialize(options) {
          const value = serializer.serialize(options);
          largest = Math.max(largest, encoder.encode(value).byteLength);
          return value;
        },
      },
      512,
      4,
      budget,
    );
    expect(largest).toBeLessThanOrEqual(budget * 2);
    expect(history.data.byteLength).toBeLessThanOrEqual(budget);
    expect(history.rows).toBeGreaterThan(2000);
    expect(history.dropped).toBe(true);
  });

  it("can restore an empty checkpoint without creating fake scrollback", async () => {
    const { term, serializer } = terminal();
    await write(term, "old\r\n1\r\n2\r\n3\r\n4");
    const history = await checkpointVtHistory(term, serializer, 40, 4, 0);
    expect(history).toEqual({ data: new Uint8Array(), rows: 0, dropped: true });
    expect(term.buffer.normal.baseY).toBe(0);
    expect(lines(term)).toEqual(["", "", "", ""]);
  });

  it.each([1, 2, 512])("restores a one-row terminal at source width %s", async (cols) => {
    const { term, serializer } = terminal(cols, 1);
    await write(term, "a\r\nb\r\nc");
    const history = await checkpointVtHistory(term, serializer, cols, 1);
    const restored = terminal().term;
    await restoreVtHistory(restored, history, cols, 1);
    expect(state(restored)).toEqual(state(term));
    expect(lines(term).slice(0, 2)).toEqual(["a", "b"]);
  });

  it("keeps no more than 10000 scrollback rows", async () => {
    const { term, serializer } = terminal(40, 4);
    await write(term, Array.from({ length: 10010 }, (_, i) => `row ${i}`).join("\r\n"));
    const history = await checkpointVtHistory(term, serializer, 40, 4);
    expect(history.rows).toBe(10000);
    expect(history.dropped).toBe(true);
    expect(term.buffer.normal.baseY).toBe(10000);
    expect(lines(term)).not.toContain("row 0");
    expect(lines(term)).toContain("row 10005");
    const restored = terminal().term;
    await restoreVtHistory(restored, history, 40, 4);
    expect(lines(restored)).toEqual(lines(term));
  });

  it("rejects invalid bounds before mutating the terminal", async () => {
    const { term, serializer } = terminal();
    await write(term, "still here");
    for (const [cols, rows, budget] of [
      [513, 4, 10],
      [40, 257, 10],
      [NaN, 4, 10],
      [40, 4, -1],
    ]) {
      await expect(checkpointVtHistory(term, serializer, cols!, rows!, budget!)).rejects.toThrow(
        "Invalid",
      );
    }
    expect(lines(term)[0]).toBe("still here");
  });

  it("reports oldest rows evicted by narrowing reflow during checkpoint creation", async () => {
    const { term, serializer } = terminal(40, 4);
    await write(
      term,
      Array.from({ length: 9000 }, (_, i) => `${i}:abcdefghijklmnopqrstuvwx`).join("\r\n"),
    );
    expect(term.buffer.normal.baseY).toBeLessThan(10000);
    const history = await checkpointVtHistory(term, serializer, 20, 4);
    expect(history.rows).toBe(10000);
    expect(history.dropped).toBe(true);
    expect(lines(term)[0]).not.toBe("0:abcdefghijklmnopqr");
  });

  it("leaves a clean parser and screen when a saved row boundary cannot be restored", async () => {
    const { term } = terminal();
    await expect(
      restoreVtHistory(term, { data: encoder.encode("old"), rows: 3, dropped: false }, 40, 4),
    ).rejects.toThrow("row boundary");
    expect(term.buffer.normal.baseY).toBe(0);
    expect(lines(term)).toEqual(["", "", "", ""]);
    await write(term, "new");
    expect(lines(term)[0]).toBe("new");
  });
});
