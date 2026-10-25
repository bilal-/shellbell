/**
 * Which parts of an oversized record to keep: listed object keys and array items. A listed
 * object or array with no shape of its own is kept empty, so its presence and type survive.
 */
export interface TranscriptOutline {
  readonly keys?: Readonly<Record<string, TranscriptOutline>>;
  readonly items?: TranscriptOutline;
}
/** Replaces kept text that is too long, or that arrives after the outline's text budget. */
export const TRANSCRIPT_OMITTED = "Too large to show here";

const STRING_CHARS = 16 * 1024;
const OUTLINE_CHARS = 128 * 1024;
/**
 * Short strings such as IDs, types and timestamps have their own allowance. Claude Code writes
 * `uuid` and `parentUuid` after `message`, so long text must not use up the room they need.
 */
const SHORT_CHARS = 256;
const SHORT_TOTAL = 64 * 1024;
const KEY_CHARS = 256;
const LITERAL_CHARS = 512;
const DEPTH = 512;
/** One more than the decoder's block limit, so it still sees that an array was cut. */
const ITEMS = 65;
// biome-ignore lint/suspicious/noControlCharactersInRegex: JSON strings may not contain them raw.
const SPECIAL = /["\\\u0000-\u001f]/g;
const LITERAL = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/;

type Mode = "value" | "first-item" | "first-key" | "key" | "colon" | "after" | "string" | "literal";
interface Frame {
  readonly array: boolean;
  readonly value: Record<string, unknown> | unknown[] | null;
  readonly shape: TranscriptOutline | null;
  /** Shape of the value after the pending key, or null when that value is dropped. */
  child: TranscriptOutline | null;
  key: string | null;
  count: number;
}
export type TranscriptOutlineResult =
  | { kind: "record"; value: Record<string, unknown> }
  | { kind: "skipped"; reason: "invalid-utf8" | "invalid-json" };

/**
 * Streams one JSONL line too large to buffer, keeping only what the outline lists. It
 * accepts and rejects the same input JSON.parse does, except nesting past its depth
 * limit, so the kept record classifies like one that fit in the line buffer.
 */
export class TranscriptOutlineReader {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly stack: Frame[] = [];
  private mode: Mode = "value";
  private root: unknown;
  private rooted = false;
  private failed: "invalid-utf8" | "invalid-json" | null = null;
  private budget = OUTLINE_CHARS;
  private shortBudget = SHORT_TOTAL;
  private keyString = false;
  private keep: TranscriptOutline | null = null;
  private raw = "";
  private length = 0;
  private escape = 0;
  private literal = "";

  constructor(private readonly outline: TranscriptOutline) {}

  push(bytes: Uint8Array): void {
    if (this.failed) return;
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      this.failed = "invalid-utf8";
      return;
    }
    this.scan(text);
  }

  /** Null for a whitespace-only line, which the buffered path also ignores. */
  finish(): TranscriptOutlineResult | null {
    if (!this.failed) {
      let text: string;
      try {
        text = this.decoder.decode();
      } catch {
        this.failed = "invalid-utf8";
        text = "";
      }
      this.scan(text);
      if (this.mode === "literal") this.endLiteral();
    }
    const value = this.root;
    this.root = undefined;
    this.raw = "";
    if (this.failed) return { kind: "skipped", reason: this.failed };
    if (!this.rooted && this.mode === "value") return null;
    if (
      this.stack.length ||
      this.mode !== "after" ||
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value)
    )
      return { kind: "skipped", reason: "invalid-json" };
    return { kind: "record", value: value as Record<string, unknown> };
  }

  private fail(): void {
    this.failed = "invalid-json";
  }

  private scan(text: string): void {
    let i = 0;
    while (i < text.length && !this.failed) {
      if (this.mode === "string") {
        i = this.string(text, i);
        continue;
      }
      const c = text.charCodeAt(i);
      if (this.mode === "literal") {
        if (/[0-9a-zA-Z+.-]/.test(text[i]!)) {
          this.literal += text[i];
          if (this.literal.length > LITERAL_CHARS) this.fail();
          i++;
          continue;
        }
        this.endLiteral();
        if (this.failed) break;
      }
      i++;
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) continue;
      const top = this.stack.at(-1);
      if (this.mode === "first-item" && c === 0x5d) {
        this.close();
        continue;
      }
      switch (this.mode) {
        case "first-item":
        case "value":
          if (c === 0x7b) this.open(false);
          else if (c === 0x5b) this.open(true);
          else if (c === 0x22) this.beginString(false);
          else if (/[-0-9tfn]/.test(text[i - 1]!)) {
            this.keep = this.slot();
            this.literal = text[i - 1]!;
            this.mode = "literal";
          } else this.fail();
          break;
        case "first-key":
          if (c === 0x7d) this.close();
          else if (c === 0x22) this.beginString(true);
          else this.fail();
          break;
        case "key":
          if (c === 0x22) this.beginString(true);
          else this.fail();
          break;
        case "colon":
          if (c === 0x3a) this.mode = "value";
          else this.fail();
          break;
        case "after":
          if (!top) this.fail();
          else if (c === 0x2c) this.mode = top.array ? "value" : "key";
          else if (c === (top.array ? 0x5d : 0x7d)) this.close();
          else this.fail();
          break;
      }
    }
  }

  /** Where the next value goes: its shape, or null when it is parsed and dropped. */
  private slot(): TranscriptOutline | null {
    const top = this.stack.at(-1);
    if (!top) return this.outline;
    if (top.array) return top.shape?.items && top.count < ITEMS ? top.shape.items : null;
    return top.child;
  }

  private open(array: boolean): void {
    if (this.stack.length >= DEPTH) {
      this.fail();
      return;
    }
    const shape = this.slot();
    this.stack.push({
      array,
      value: shape ? (array ? [] : {}) : null,
      shape,
      child: null,
      key: null,
      count: 0,
    });
    this.mode = array ? "first-item" : "first-key";
  }

  private close(): void {
    const frame = this.stack.pop()!;
    this.place(frame.value, frame.value !== null);
  }

  private place(value: unknown, kept: boolean): void {
    const top = this.stack.at(-1);
    this.mode = "after";
    if (!top) {
      this.root = value;
      this.rooted = true;
    } else if (top.array) {
      if (kept) (top.value as unknown[]).push(value);
      top.count++;
    } else if (kept && top.key !== null) (top.value as Record<string, unknown>)[top.key] = value;
  }

  private beginString(key: boolean): void {
    this.keyString = key;
    this.keep = key ? null : this.slot();
    this.raw = "";
    this.length = 0;
    this.escape = 0;
    this.mode = "string";
  }

  private append(chunk: string): void {
    this.length += chunk.length;
    if (!this.keyString && !this.keep) return;
    if (this.length <= (this.keyString ? KEY_CHARS : STRING_CHARS)) this.raw += chunk;
    else this.raw = "";
  }

  private string(text: string, start: number): number {
    let i = start;
    while (i < text.length) {
      if (this.escape === 1) {
        const ch = text[i]!;
        if (ch === "u") this.escape = 2;
        else if ('"\\/bfnrt'.includes(ch)) this.escape = 0;
        else {
          this.fail();
          return i;
        }
        this.append(ch);
        i++;
        continue;
      }
      if (this.escape >= 2) {
        if (!/[0-9a-fA-F]/.test(text[i]!)) {
          this.fail();
          return i;
        }
        this.escape = this.escape === 5 ? 0 : this.escape + 1;
        this.append(text[i]!);
        i++;
        continue;
      }
      SPECIAL.lastIndex = i;
      const match = SPECIAL.exec(text);
      const end = match ? match.index : text.length;
      if (end > i) this.append(text.slice(i, end));
      i = end;
      if (!match) break;
      const c = text.charCodeAt(i);
      if (c === 0x22) {
        this.endString();
        return i + 1;
      }
      if (c !== 0x5c) {
        this.fail();
        return i;
      }
      this.append("\\");
      this.escape = 1;
      i++;
    }
    return i;
  }

  private endString(): void {
    const top = this.stack.at(-1)!;
    const over = this.length > (this.keyString ? KEY_CHARS : STRING_CHARS);
    const text = over ? null : (JSON.parse(`"${this.raw}"`) as string);
    this.raw = "";
    if (this.keyString) {
      const keys = top.shape?.keys;
      top.key = text;
      top.child = text !== null && keys && Object.hasOwn(keys, text) ? keys[text]! : null;
      this.mode = "colon";
      return;
    }
    if (!this.keep) {
      this.place(undefined, false);
      return;
    }
    const short = text !== null && text.length <= SHORT_CHARS && text.length <= this.shortBudget;
    const fits = short || (text !== null && text.length <= this.budget);
    if (short) this.shortBudget -= text!.length;
    else if (fits) this.budget -= text!.length;
    this.place(fits ? text : TRANSCRIPT_OMITTED, true);
  }

  private endLiteral(): void {
    if (!LITERAL.test(this.literal)) {
      this.fail();
      return;
    }
    this.place(this.keep ? JSON.parse(this.literal) : undefined, this.keep !== null);
    this.literal = "";
  }
}
