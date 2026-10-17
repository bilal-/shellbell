import type { TerminalRow } from "./adapter";

export interface TerminalModel {
  rows: readonly TerminalRow[];
  cols: number;
  fontSize: number;
  fitWidth: boolean;
  mouse?: boolean;
  liveRows?: number;
  inputReady?: boolean;
  hostPaste?: boolean;
  hardwareKeyboard?: boolean;
  screenReader?: boolean;
  /** Raw mode: the screen comes from `TerminalVtMessage`s, not rows. */
  vt?: boolean;
  cursor: { key: string; x: number; accent: string; blinking: boolean; inferred?: boolean } | null;
}
export interface TerminalFrame extends Omit<TerminalModel, "rows"> {
  document: string;
  revision: number;
  initialAnchor?: string | null;
  order?: string[];
  upsert: TerminalRow[];
}

/** One ordered piece of a raw terminal stream; `reset` starts a new starting point. */
export interface TerminalVtMessage {
  document: string;
  sequence: number;
  reset?: { cols: number; rows: number };
  /** Base64, at most `VT_MESSAGE_BYTES` decoded. */
  data: string;
}

/** Decoded bytes per WebView message, so one large starting point never blocks the bridge. */
export const VT_MESSAGE_BYTES = 256 * 1024;

export interface VtSource {
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  readonly seed: Uint8Array;
  readonly chunks: readonly Uint8Array[];
}

/**
 * Sends a raw terminal log to the WebView in order, one message at a time, each after the last
 * was written. A new generation, a new document or a reload replays the log from its start.
 */
export class TerminalVtBridge {
  private document: string | null = null;
  private source: VtSource | null = null;
  private sequence = 0;
  private inFlight = false;
  /** Next chunk index to send; -1 means the starting point is next. */
  private next = -1;
  private pendingParts: Uint8Array[] = [];
  private pendingReset = false;
  constructor(private readonly send: (message: TerminalVtMessage) => void) {}

  ready(document: string): void {
    this.document = document;
    this.sequence = 0;
    this.inFlight = false;
    this.restart();
    this.pump();
  }

  /** Called whenever the log may have grown or been replaced. */
  present(source: VtSource | null): void {
    if (source !== this.source) {
      const sameGeneration = source && this.source && source.generation === this.source.generation;
      this.source = source;
      if (!sameGeneration) this.restart();
    }
    this.pump();
  }

  acknowledge(document: string, sequence: number): void {
    if (document !== this.document || sequence !== this.sequence || !this.inFlight) return;
    this.inFlight = false;
    this.pump();
  }

  /** The WebView lost its place; start the log again from its starting point. */
  replay(): void {
    this.inFlight = false;
    this.restart();
    this.pump();
  }

  private restart(): void {
    this.next = -1;
    this.pendingParts = [];
    this.pendingReset = false;
  }

  private pump(): void {
    const source = this.source;
    if (!this.document || !source || this.inFlight) return;
    if (this.pendingParts.length === 0) {
      if (this.next === -1) {
        this.pendingParts = split(source.seed);
        this.pendingReset = true;
        this.next = 0;
      } else if (this.next < source.chunks.length) {
        this.pendingParts = split(source.chunks[this.next]!);
        this.next++;
      } else return;
    }
    const part = this.pendingParts.shift()!;
    const reset = this.pendingReset ? { cols: source.cols, rows: source.rows } : undefined;
    this.pendingReset = false;
    this.inFlight = true;
    this.send({
      document: this.document,
      sequence: ++this.sequence,
      ...(reset ? { reset } : {}),
      data: toBase64(part),
    });
  }
}

function split(bytes: Uint8Array): Uint8Array[] {
  if (bytes.length === 0) return [bytes];
  const parts: Uint8Array[] = [];
  for (let at = 0; at < bytes.length; at += VT_MESSAGE_BYTES)
    parts.push(bytes.subarray(at, at + VT_MESSAGE_BYTES));
  return parts;
}

const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function toBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += BASE64[n >> 18]! + BASE64[(n >> 12) & 63]! + BASE64[(n >> 6) & 63]! + BASE64[n & 63]!;
  }
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += BASE64[n >> 18]! + BASE64[(n >> 12) & 63]!;
    out += i + 1 < bytes.length ? `${BASE64[(n >> 6) & 63]}=` : "==";
  }
  return out;
}

export class TerminalBridge {
  private document: string | null = null;
  private revision = 0;
  private latest: TerminalModel | null = null;
  private baseline: TerminalModel | null = null;
  private pending: TerminalModel | null = null;
  private initialAnchor: string | null = null;
  constructor(private readonly send: (frame: TerminalFrame) => void) {}
  present(model: TerminalModel): void {
    this.latest = model;
    this.pump();
  }

  isPresented(model: TerminalModel): boolean {
    return this.document !== null && this.pending === null && this.baseline === model;
  }
  ready(document: string, initialAnchor: string | null = null): void {
    this.document = document;
    this.initialAnchor = initialAnchor;
    this.revision = 0;
    this.baseline = null;
    this.pending = null;
    this.pump();
  }
  acknowledge(document: string, revision: number): void {
    if (document !== this.document || revision !== this.revision || !this.pending) return;
    this.baseline = this.pending;
    this.pending = null;
    this.pump();
  }
  private pump(): void {
    if (!this.document || !this.latest || this.pending || this.latest === this.baseline) return;
    const next = this.latest;
    const previous = new Map(this.baseline?.rows.map((row) => [row.key, row]));
    const orderChanged =
      !this.baseline ||
      next.rows.length !== this.baseline.rows.length ||
      next.rows.some((row, i) => row.key !== this.baseline?.rows[i]?.key);
    const upsert = next.rows.filter((row) => {
      const old = previous.get(row.key);
      return (
        !old ||
        old.line !== row.line ||
        old.absoluteRow !== row.absoluteRow ||
        old.history !== row.history ||
        old.liveRow !== row.liveRow
      );
    });
    this.pending = next;
    this.send({
      document: this.document,
      revision: ++this.revision,
      ...(orderChanged ? { order: next.rows.map((row) => row.key) } : {}),
      upsert,
      cols: next.cols,
      fontSize: next.fontSize,
      fitWidth: next.fitWidth,
      mouse: next.mouse,
      liveRows: next.liveRows,
      inputReady: next.inputReady,
      hostPaste: next.hostPaste,
      hardwareKeyboard: next.hardwareKeyboard,
      screenReader: next.screenReader,
      vt: next.vt,
      cursor: next.cursor,
      initialAnchor: this.initialAnchor,
    });
  }
}
