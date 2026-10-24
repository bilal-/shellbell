import { TRANSCRIPT_READ_BYTES } from "./transcript-file.js";
import { type TranscriptOutline, TranscriptOutlineReader } from "./transcript-outline.js";

export const TRANSCRIPT_LINE_BYTES = 128 * 1024;
export const TRANSCRIPT_BATCH_LINES = 64;
type SkipReason = "partial-prefix" | "line-too-large" | "invalid-utf8" | "invalid-json";
interface LineRange {
  /** File byte offsets; end excludes the next line and includes this line's newline. */
  start: number;
  end: number;
}
export type TranscriptLine = LineRange &
  (
    | {
        kind: "record";
        value: Record<string, unknown>;
        /** Read through an outline because the line was too large to buffer whole. */
        outlined?: true;
      }
    | { kind: "skipped"; reason: SkipReason }
  );

/**
 * Bounded, forward JSONL framing for a single proven file generation. This does not
 * interpret an agent's format or authorize delivery. Callers must normalize records
 * through an allowlist and revalidate the generation before sending anything.
 */
export class TranscriptJsonl {
  private buffer: Buffer | null = null;
  private length = 0;
  private skipped: SkipReason | null;
  private outlining: TranscriptOutlineReader | null = null;
  private closed = false;
  private next: number;
  private start: number;
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });

  /**
   * A window starting inside a line discards that prefix until its first newline. With an
   * outline, a line too large to buffer is streamed and kept only down to that outline.
   */
  constructor(
    offset = 0,
    skipPrefix = false,
    private readonly outline: TranscriptOutline | null = null,
  ) {
    if (!Number.isSafeInteger(offset) || offset < 0)
      throw new RangeError("Invalid transcript cursor");
    this.next = offset;
    this.start = offset;
    this.skipped = skipPrefix ? "partial-prefix" : null;
  }

  get offset(): number {
    return this.next;
  }
  /** Beginning of the unfinished line, or unknown while discarding a partial prefix. */
  get boundary(): number | null {
    return this.skipped === "partial-prefix" ? null : this.start;
  }
  get bufferedBytes(): number {
    return this.length;
  }

  /**
   * At most one bounded file window and 64 complete lines per call. If consumed is
   * shorter than bytes.length, reuse the remaining window at the returned offset.
   * An unfinished final line waits for a later append; EOF never publishes it.
   */
  push(bytes: Uint8Array, offset = this.next): { consumed: number; lines: TranscriptLine[] } {
    if (this.closed) throw new Error("Transcript decoder is closed");
    if (
      offset !== this.next ||
      bytes.byteLength > TRANSCRIPT_READ_BYTES ||
      !Number.isSafeInteger(this.next + bytes.byteLength)
    ) {
      this.close();
      throw new RangeError("Invalid transcript window");
    }
    const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const lines: TranscriptLine[] = [];
    let consumed = 0;
    let completed = 0;
    while (consumed < input.length && completed < TRANSCRIPT_BATCH_LINES) {
      const newline = input.indexOf(10, consumed);
      const end = newline === -1 ? input.length : newline;
      const count = end - consumed;
      if (this.outlining) this.outlining.push(input.subarray(consumed, end));
      else if (!this.skipped) {
        if (this.length + count > TRANSCRIPT_LINE_BYTES) {
          if (this.outline) {
            this.outlining = new TranscriptOutlineReader(this.outline);
            if (this.length) this.outlining.push(this.buffer!.subarray(0, this.length));
            this.outlining.push(input.subarray(consumed, end));
          } else this.skipped = "line-too-large";
          this.clearBuffer();
        } else if (count) {
          this.buffer ??= Buffer.alloc(TRANSCRIPT_LINE_BYTES);
          input.copy(this.buffer, this.length, consumed, end);
          this.length += count;
        }
      }
      const advance = count + (newline === -1 ? 0 : 1);
      consumed += advance;
      this.next += advance;
      if (newline !== -1) {
        const line = this.finishLine();
        if (line) lines.push(line);
        this.clearBuffer();
        this.skipped = null;
        this.outlining = null;
        this.start = this.next;
        completed++;
      }
    }
    return { consumed, lines };
  }

  /** Discard any incomplete private text when its session/generation is cleared. */
  close(): void {
    this.clearBuffer();
    this.buffer = null;
    this.skipped = null;
    this.outlining = null;
    this.closed = true;
  }

  private finishLine(): TranscriptLine | null {
    const range = { start: this.start, end: this.next };
    if (this.skipped) return { ...range, kind: "skipped", reason: this.skipped };
    if (this.outlining) {
      const line = this.outlining.finish();
      if (!line) return null;
      return line.kind === "record"
        ? { ...range, kind: "record", value: line.value, outlined: true }
        : { ...range, ...line };
    }
    if (!this.length) return null;
    let text: string;
    try {
      text = this.decoder.decode(this.buffer!.subarray(0, this.length));
    } catch {
      return { ...range, kind: "skipped", reason: "invalid-utf8" };
    }
    if (!text.trim()) return null;
    try {
      const value: unknown = JSON.parse(text);
      if (typeof value === "object" && value !== null && !Array.isArray(value))
        return { ...range, kind: "record", value: value as Record<string, unknown> };
    } catch {
      // Parser error messages may contain transcript text. Never retain or log them.
    }
    return { ...range, kind: "skipped", reason: "invalid-json" };
  }

  private clearBuffer(): void {
    this.buffer?.fill(0, 0, this.length);
    this.length = 0;
  }
}
