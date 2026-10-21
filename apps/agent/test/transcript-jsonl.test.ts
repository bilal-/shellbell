import { describe, expect, it } from "vitest";
import { TRANSCRIPT_READ_BYTES } from "../src/conversation/transcript-file.js";
import {
  TRANSCRIPT_BATCH_LINES,
  TRANSCRIPT_LINE_BYTES,
  TranscriptJsonl,
  type TranscriptLine,
} from "../src/conversation/transcript-jsonl.js";

/** Consume a synthetic file in bounded windows, respecting decoder backpressure. */
function feed(decoder: TranscriptJsonl, bytes: Buffer, window = TRANSCRIPT_READ_BYTES) {
  const lines: TranscriptLine[] = [];
  let consumed = 0;
  while (consumed < bytes.length) {
    const result = decoder.push(bytes.subarray(consumed, consumed + window));
    expect(result.consumed).toBeGreaterThan(0);
    expect(result.lines.length).toBeLessThanOrEqual(TRANSCRIPT_BATCH_LINES);
    lines.push(...result.lines);
    consumed += result.consumed;
  }
  return lines;
}

describe("bounded transcript JSONL framing", () => {
  it("holds a half-written final record until its newline, including split UTF-8", () => {
    const decoder = new TranscriptJsonl();
    const record = Buffer.from('{"text":"hello 🐈"}');
    for (const byte of record) {
      expect(decoder.push(Buffer.from([byte])).lines).toEqual([]);
      expect(decoder.boundary).toBe(0);
    }
    expect(decoder.push(Buffer.alloc(0))).toEqual({ consumed: 0, lines: [] });
    expect(decoder.offset).toBe(record.length);
    expect(decoder.bufferedBytes).toBe(record.length);
    expect(decoder.push(Buffer.from("\n")).lines).toEqual([
      { kind: "record", start: 0, end: record.length + 1, value: { text: "hello 🐈" } },
    ]);
    expect(decoder.boundary).toBe(record.length + 1);
    expect(decoder.bufferedBytes).toBe(0);
    decoder.close();
  });

  it.each([1, 2, 3, 7, 29, 64, TRANSCRIPT_READ_BYTES])(
    "preserves exact byte cursors with window %s",
    (window) => {
      const decoder = new TranscriptJsonl(23);
      const first = Buffer.from('{"type":"user","text":"héllo"}\r\n');
      const gap = Buffer.from("\r\n \t\n");
      const second = Buffer.from('{"type":"assistant","text":"世界"}\n');
      const lines = feed(decoder, Buffer.concat([first, gap, second]), window);
      expect(lines).toEqual([
        {
          kind: "record",
          start: 23,
          end: 23 + first.length,
          value: { type: "user", text: "héllo" },
        },
        {
          kind: "record",
          start: 23 + first.length + gap.length,
          end: 23 + first.length + gap.length + second.length,
          value: { type: "assistant", text: "世界" },
        },
      ]);
      expect(decoder.boundary).toBe(decoder.offset);
      decoder.close();
    },
  );

  it("discards an oversized line without retaining its bytes or losing the next record", () => {
    const decoder = new TranscriptJsonl();
    const chunk = Buffer.alloc(TRANSCRIPT_READ_BYTES, 120);
    for (let n = 0; n < 40; n++) {
      expect(decoder.push(chunk).lines).toEqual([]);
      expect(decoder.bufferedBytes).toBeLessThanOrEqual(TRANSCRIPT_LINE_BYTES);
      if (n >= 2) expect(decoder.bufferedBytes).toBe(0);
    }
    const end = chunk.length * 40 + 1;
    expect(decoder.push(Buffer.from('\n{"ok":true}\n')).lines).toEqual([
      { kind: "skipped", reason: "line-too-large", start: 0, end },
      { kind: "record", value: { ok: true }, start: end, end: end + 12 },
    ]);
    decoder.close();
  });

  it("allows a record exactly at the line cap, with the newline in another window", () => {
    const decoder = new TranscriptJsonl();
    const text = "x".repeat(TRANSCRIPT_LINE_BYTES - 11);
    const record = Buffer.from(JSON.stringify({ text }));
    expect(record.length).toBe(TRANSCRIPT_LINE_BYTES);
    expect(feed(decoder, record)).toEqual([]);
    expect(decoder.push(Buffer.from("\n")).lines).toEqual([
      { kind: "record", value: { text }, start: 0, end: record.length + 1 },
    ]);
    decoder.close();
  });

  it("emits bounded placeholders for invalid JSON, primitive values and invalid UTF-8", () => {
    const decoder = new TranscriptJsonl();
    const invalid = ["{secret: 1}\n", "null\n", "[]\n", '"text"\n', "4\n"];
    const lines = feed(decoder, Buffer.from(invalid.join("")));
    expect(lines.map((line) => line.kind === "skipped" && line.reason)).toEqual(
      invalid.map(() => "invalid-json"),
    );
    const offset = decoder.offset;
    expect(decoder.push(Buffer.from([0xc0, 0x80, 10])).lines).toEqual([
      { kind: "skipped", reason: "invalid-utf8", start: offset, end: offset + 3 },
    ]);
    // Neither malformed contents nor the parser's exception message are retained.
    expect(JSON.stringify(lines)).not.toContain("secret");
    expect(decoder.push(Buffer.from('{"ok":true}\n')).lines[0]).toMatchObject({
      kind: "record",
      value: { ok: true },
    });
    decoder.close();
  });

  it("limits complete lines per batch even when a window is full of tiny or blank records", () => {
    const decoder = new TranscriptJsonl();
    const bytes = Buffer.from("{}\n".repeat(300));
    const first = decoder.push(bytes);
    expect(first.lines).toHaveLength(TRANSCRIPT_BATCH_LINES);
    expect(first.consumed).toBe(TRANSCRIPT_BATCH_LINES * 3);
    const rest = feed(decoder, bytes.subarray(first.consumed));
    expect([...first.lines, ...rest]).toHaveLength(300);
    expect(decoder.offset).toBe(bytes.length);
    const blank = decoder.push(Buffer.alloc(300, 10));
    expect(blank).toEqual({ consumed: TRANSCRIPT_BATCH_LINES, lines: [] });
    decoder.close();
  });

  it("can start a window in the middle of a record without parsing an unrelated suffix", () => {
    const decoder = new TranscriptJsonl(100, true);
    expect(decoder.boundary).toBeNull();
    expect(decoder.push(Buffer.from('{"sensitive":"suffix"}')).lines).toEqual([]);
    expect(decoder.boundary).toBeNull();
    expect(decoder.bufferedBytes).toBe(0);
    const start = decoder.offset + 1;
    expect(decoder.push(Buffer.from('\n{"good":1}\n')).lines).toEqual([
      { kind: "skipped", reason: "partial-prefix", start: 100, end: start },
      { kind: "record", value: { good: 1 }, start, end: start + 11 },
    ]);
    expect(decoder.boundary).toBe(start + 11);
    decoder.close();
  });

  it.each(["gap", "overlap", "large", "overflow"])("invalidates on %s input", (mode) => {
    const decoder = new TranscriptJsonl(mode === "overflow" ? Number.MAX_SAFE_INTEGER : 0);
    if (mode !== "overflow") decoder.push(Buffer.from('{"private":'));
    const offset = decoder.offset + (mode === "gap" ? 1 : mode === "overlap" ? -1 : 0);
    const bytes = Buffer.alloc(mode === "large" ? TRANSCRIPT_READ_BYTES + 1 : 1);
    expect(() => decoder.push(bytes, offset)).toThrow("Invalid transcript window");
    expect(decoder.bufferedBytes).toBe(0);
    expect(() => decoder.push(Buffer.alloc(0))).toThrow("closed");
  });

  it("discards incomplete records permanently on close", () => {
    const decoder = new TranscriptJsonl();
    decoder.push(Buffer.from('{"private":'));
    decoder.close();
    decoder.close();
    expect(decoder.bufferedBytes).toBe(0);
    expect(() => decoder.push(Buffer.from('"text"}\n'))).toThrow("closed");
  });
});
