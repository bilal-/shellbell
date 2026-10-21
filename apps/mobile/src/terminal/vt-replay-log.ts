import {
  STREAM_LIMITS,
  type StreamHistoryPage,
  type StreamTransferMeta,
} from "@shellbell/protocol";
import { VT_CHECKPOINT_BYTES, VT_HISTORY_BYTES, type VtHistoryCheckpoint } from "./vt-checkpoint";
import { TERMINAL_BUFFER_LIMIT, VT_MESSAGE_BYTES } from "./vt-limits";
import { encodeNativeHistoryPage } from "./vt-native-page";

export type VtSeed = Extract<StreamTransferMeta, { kind: "vt-seed" }>;
export interface VtApplied {
  readonly generation: number;
  readonly capture: string;
  readonly offset: number;
}
export interface VtHistoryHeader {
  readonly bytes: number;
  readonly rows: number;
  readonly dropped: boolean;
}
export interface VtReplayOwner {
  /** One focused computer/session lifetime, shared across its safe reconnects. */
  readonly scope: object;
  readonly subscriptionId: string;
  readonly onApplied?: (log: VtReplayLog) => void;
}

/** Small writes share bounded segments instead of imposing a limit on the number of writes. */
export const VT_REPLAY_SEGMENT_BYTES = 16 * 1024;
export const VT_HISTORY_PART_BYTES = VT_MESSAGE_BYTES;
/** Leave room for arriving output while both prefixes are retained during a rebuild. */
export const VT_NATIVE_TAIL_RESERVE_BYTES = 256 * 1024;
interface TailSegment {
  readonly data: Uint8Array;
  readonly start: number;
  length: number;
}
interface HistoryStage {
  readonly header: VtHistoryHeader;
  readonly data: Uint8Array;
  received: number;
}
interface NativePrepend {
  readonly previous: VtHistoryCheckpoint;
  readonly addedRows: number;
  readonly proof: string;
  readonly nextBefore: number;
  rendered: number;
  visibleRendered: number;
}

/**
 * React Native memory owned by one negotiated source capture. History, exact seed
 * and received byte tail share one budget. Receipt and parser progress are separate:
 * transport can acknowledge an appended record before xterm has parsed any of it.
 * The WebView bridge fences document/source identity before calling these methods.
 * It also releases the old source log before creating its replacement, so the
 * per-view budget is not doubled during a cutover.
 */
export class VtReplayLog {
  readonly generation: number;
  readonly cols: number;
  readonly rows: number;
  readonly meta: Readonly<VtSeed>;
  private seedBytes: Uint8Array;
  private readonly tail: TailSegment[] = [];
  private tailBytes = 0;
  private allocated = 0;
  private retained: VtHistoryCheckpoint | null;
  private stage: HistoryStage | null = null;
  private parsed = -1;
  private rendered = -1;
  private restoreThrough = 0;
  private reported = -1;
  private disposed = false;
  private nativeVerified = false;
  private nativeStopped = false;
  private nativeBefore: number | null = null;
  private nativeStage: NativePrepend | null = null;
  private nativeRevision = 0;
  private nativeRows: number | null = null;

  constructor(
    meta: VtSeed,
    seed: Uint8Array,
    readonly owner?: VtReplayOwner,
  ) {
    if (seed.byteLength > STREAM_LIMITS.screenBytes)
      throw new Error("Terminal seed exceeds its byte budget");
    this.meta = Object.freeze({ ...meta });
    this.generation = meta.generation;
    this.cols = meta.cols;
    this.rows = meta.rows;
    this.seedBytes = new Uint8Array(seed);
    this.nativeBefore = meta.historyBefore ?? null;
    // Initial/full replacement seeds have no preceding phone history to checkpoint.
    this.retained =
      meta.disposition === "discontinuity"
        ? null
        : { data: new Uint8Array(), rows: 0, dropped: false };
  }

  get seed(): Uint8Array {
    return this.seedBytes;
  }
  get isDisposed(): boolean {
    return this.disposed;
  }
  /** Changes only when a native page requires an atomic hidden rebuild. */
  get revision(): number {
    return this.nativeRevision;
  }
  get nativeRowCount(): number | null {
    return this.nativeRows;
  }
  get nativeHistoryStopped(): boolean {
    return this.nativeStopped;
  }
  get pendingPrepend(): Readonly<{ addedRows: number; proof: string }> | null {
    return this.nativeStage
      ? { addedRows: this.nativeStage.addedRows, proof: this.nativeStage.proof }
      : null;
  }
  get olderBefore(): number | null {
    return !this.disposed && this.nativeVerified && !this.nativeStopped && !this.nativeStage
      ? this.nativeBefore
      : null;
  }
  /** The bridge calls this only for the matching seed operation after renderer verification. */
  verifyNativeHistory(valid: boolean, normalRows?: number): void {
    if (this.disposed || !this.meta.historyProof || this.meta.disposition === "discontinuity")
      return;
    if (!valid) this.nativeStopped = true;
    else this.nativeVerified = true;
    if (!this.nativeStage && normalRows !== undefined) this.observeNativeRows(normalRows, valid);
    this.owner?.onApplied?.(this);
  }
  stopNativeHistory(): void {
    if (this.nativeStopped) return;
    this.nativeStopped = true;
    this.owner?.onApplied?.(this);
  }
  observeNativeRows(rows: number, valid: boolean, presenting = false): void {
    if (this.disposed || !this.meta.historyProof || (this.nativeStage && !presenting)) return;
    if (!Number.isSafeInteger(rows) || rows < 0 || rows > TERMINAL_BUFFER_LIMIT) return;
    const changed = this.nativeRows !== rows;
    this.nativeRows = rows;
    if (
      !valid ||
      rows < (this.retained?.rows ?? 0) + (this.meta.historyRows ?? 0) ||
      (!this.nativeStage && rows >= TERMINAL_BUFFER_LIMIT)
    )
      this.stopNativeHistory();
    else if (changed) this.owner?.onApplied?.(this);
  }
  /** A replaced document can replay the last applied prefix; the unshown page is abandoned. */
  discardNativeHistory(): void {
    const stage = this.nativeStage;
    if (!stage) return;
    this.retained = stage.previous;
    this.rendered = stage.visibleRendered;
    this.nativeStage = null;
    this.nativeRevision++;
    this.stopNativeHistory();
    if (this.rendered >= this.parsed) this.apply(this.rendered);
  }

  /**
   * Stage one page without dropping any current history. During hidden rebuild both prefix
   * allocations count against the same 4 MiB budget; receipt ACK need not await the renderer.
   */
  prependNativeHistory(
    page: StreamHistoryPage,
    capture: string,
    normalRows: number,
  ): "ok" | "full" | "invalid" {
    const retained = this.retained;
    if (
      this.disposed ||
      !retained ||
      !this.nativeVerified ||
      this.nativeStopped ||
      this.nativeStage ||
      this.meta.capture !== capture ||
      this.meta.generation !== page.generation ||
      page.before !== this.nativeBefore ||
      page.to !== page.before ||
      page.nextBefore !== page.from ||
      !Number.isSafeInteger(page.from) ||
      page.from < 0 ||
      page.from + page.lines.length !== page.before ||
      page.lines.length === 0 ||
      !Number.isSafeInteger(normalRows) ||
      normalRows < 0 ||
      normalRows > TERMINAL_BUFFER_LIMIT ||
      normalRows < retained.rows + (this.meta.historyRows ?? 0) ||
      retained.dropped ||
      this.rendered < 0
    )
      return "invalid";
    if (normalRows + page.lines.length > TERMINAL_BUFFER_LIMIT) return "full";
    const encoded = encodeNativeHistoryPage(page.lines, this.cols);
    if (!encoded) return "invalid";
    const separator = retained.rows > 0 ? 2 : 0;
    const size = encoded.data.length + separator + retained.data.length;
    // Count the incoming encoded page as well as old+new checkpoints at peak allocation.
    if (
      size > VT_HISTORY_BYTES ||
      this.bytes + size + encoded.data.length + VT_NATIVE_TAIL_RESERVE_BYTES > VT_CHECKPOINT_BYTES
    )
      return "full";
    const data = new Uint8Array(size);
    data.set(encoded.data);
    if (separator) data.set([13, 10], encoded.data.length);
    data.set(retained.data, encoded.data.length + separator);
    this.nativeStage = {
      previous: retained,
      addedRows: encoded.rows,
      proof: encoded.proof,
      nextBefore: page.from,
      rendered: -1,
      visibleRendered: this.rendered,
    };
    this.retained = { data, rows: retained.rows + encoded.rows, dropped: false };
    this.nativeRevision++;
    return "ok";
  }

  /** A previously admitted operation may still finish on the old visible parser. */
  renderVisible(offset: number): boolean {
    const stage = this.nativeStage;
    if (
      !stage ||
      !Number.isSafeInteger(offset) ||
      offset < stage.visibleRendered ||
      offset > this.tailBytes
    )
      return false;
    stage.visibleRendered = offset;
    return true;
  }

  /** After the hidden terminal catches up and is presented, its progress becomes visible. */
  commitNativeHistory(): boolean {
    const stage = this.nativeStage;
    if (this.disposed || !stage || stage.rendered < this.restoreThrough || stage.rendered < 0)
      return false;
    this.nativeBefore = stage.nextBefore;
    this.nativeStage = null;
    if ((this.nativeRows ?? 0) >= TERMINAL_BUFFER_LIMIT) this.nativeStopped = true;
    this.rendered = stage.rendered;
    return this.apply(stage.rendered);
  }
  get history(): VtHistoryCheckpoint | null {
    return this.retained;
  }
  get receivedOffset(): number {
    return this.tailBytes;
  }
  get appliedOffset(): number {
    return this.parsed;
  }
  /** Current document progress can restart without regressing the computer's applied floor. */
  get renderedOffset(): number {
    return this.nativeStage?.rendered ?? this.rendered;
  }
  get isRestoring(): boolean {
    return this.nativeStage !== null || this.rendered < this.restoreThrough;
  }
  beginRender(): void {
    if (this.disposed) return;
    if (this.nativeStage) this.nativeStage.rendered = -1;
    else this.rendered = -1;
    this.restoreThrough = this.tailBytes;
    this.owner?.onApplied?.(this);
  }
  /** Parser work can keep its watchdog alive without claiming visible application. */
  noteRenderProgress(): void {
    if (!this.disposed) this.owner?.onApplied?.(this);
  }
  render(offset: number): boolean {
    if (
      this.disposed ||
      !this.retained ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset < this.renderedOffset ||
      offset > this.tailBytes
    )
      return false;
    if (this.nativeStage) {
      this.nativeStage.rendered = offset;
      return true;
    }
    this.rendered = offset;
    if (offset >= this.parsed) return this.apply(offset);
    this.owner?.onApplied?.(this);
    return true;
  }
  /** Allocated bytes plus the history reservation, including unused tail-segment capacity. */
  get bytes(): number {
    return (
      this.seedBytes.byteLength +
      this.allocated +
      (this.nativeStage?.previous.data.byteLength ?? 0) +
      (this.retained?.data.byteLength ??
        this.stage?.data.byteLength ??
        (this.disposed ? 0 : VT_HISTORY_BYTES))
    );
  }
  /** Only a complete, previously applied checkpoint may be advertised on reconnect. */
  get hasRetained(): boolean {
    return !this.disposed && this.retained !== null && this.parsed >= 0 && !this.nativeStage;
  }

  append(offset: number, data: Uint8Array): "ok" | "full" | "invalid" {
    if (
      this.disposed ||
      offset !== this.tailBytes ||
      data.byteLength === 0 ||
      data.byteLength > STREAM_LIMITS.screenBytes
    )
      return "invalid";
    let last = this.tail.at(-1);
    const free = last ? last.data.byteLength - last.length : 0;
    if (this.bytes + Math.max(0, data.byteLength - free) > VT_CHECKPOINT_BYTES) return "full";
    for (let at = 0; at < data.byteLength; ) {
      if (!last || last.length === last.data.byteLength) {
        const capacity = Math.min(VT_REPLAY_SEGMENT_BYTES, VT_CHECKPOINT_BYTES - this.bytes);
        last = { data: new Uint8Array(capacity), start: this.tailBytes + at, length: 0 };
        this.tail.push(last);
        this.allocated += capacity;
      }
      const length = Math.min(last.data.byteLength - last.length, data.byteLength - at);
      last.data.set(data.subarray(at, at + length), last.length);
      last.length += length;
      at += length;
    }
    this.tailBytes += data.byteLength;
    return "ok";
  }

  /** Consume by byte offset: a segment's populated suffix can grow after an earlier read. */
  read(offset: number, limit = VT_HISTORY_PART_BYTES): Uint8Array | null {
    if (
      this.disposed ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > VT_HISTORY_PART_BYTES
    )
      return null;
    const segment = this.tail.find(
      (part) => offset >= part.start && offset < part.start + part.length,
    );
    if (!segment) return null;
    const start = offset - segment.start;
    const length = Math.min(limit, this.tailBytes - offset);
    if (start + length <= segment.length) return segment.data.subarray(start, start + length);
    const result = new Uint8Array(length);
    let written = 0;
    for (const part of this.tail) {
      const local = Math.max(0, offset + written - part.start);
      if (local >= part.length) continue;
      const take = Math.min(part.length - local, length - written);
      result.set(part.data.subarray(local, local + take), written);
      written += take;
      if (written === length) break;
    }
    return result;
  }

  /** Replace the initial maximum reservation with the actual bounded history allocation. */
  beginHistory(header: VtHistoryHeader): boolean {
    if (
      this.disposed ||
      this.retained ||
      this.stage ||
      !Number.isSafeInteger(header.bytes) ||
      header.bytes < 0 ||
      header.bytes > VT_HISTORY_BYTES ||
      !Number.isSafeInteger(header.rows) ||
      header.rows < 0 ||
      header.rows > TERMINAL_BUFFER_LIMIT ||
      typeof header.dropped !== "boolean" ||
      (header.rows === 0) !== (header.bytes === 0) ||
      this.seedBytes.byteLength + this.allocated + header.bytes > VT_CHECKPOINT_BYTES
    )
      return false;
    this.stage = { header: { ...header }, data: new Uint8Array(header.bytes), received: 0 };
    return true;
  }

  historyPart(offset: number, data: Uint8Array): boolean {
    const stage = this.stage;
    if (
      this.disposed ||
      !stage ||
      offset !== stage.received ||
      data.byteLength === 0 ||
      data.byteLength > VT_HISTORY_PART_BYTES ||
      offset + data.byteLength > stage.data.byteLength
    )
      return false;
    stage.data.set(data, offset);
    stage.received += data.byteLength;
    return true;
  }

  commitHistory(): boolean {
    const stage = this.stage;
    if (this.disposed || !stage || stage.received !== stage.data.byteLength) return false;
    this.retained = { data: stage.data, rows: stage.header.rows, dropped: stage.header.dropped };
    this.stage = null;
    return true;
  }

  /** Called only after xterm's byte-write callback, never by a transport receipt ACK. */
  apply(offset: number): boolean {
    if (
      this.disposed ||
      this.nativeStage !== null ||
      !this.retained ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset < this.parsed ||
      offset > this.tailBytes
    )
      return false;
    this.parsed = offset;
    this.rendered = offset;
    this.owner?.onApplied?.(this);
    return true;
  }

  /** Coalesces parsed progress; failed control sends must not consume the pending report. */
  get pendingApplied(): VtApplied | null {
    if (this.disposed || !this.retained || this.parsed <= this.reported) return null;
    return { generation: this.generation, capture: this.meta.capture, offset: this.parsed };
  }

  didReport(offset: number): boolean {
    if (
      this.disposed ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset < this.reported ||
      offset > this.parsed
    )
      return false;
    this.reported = offset;
    return true;
  }

  /** Leaving/revoking/ending the owning view releases every replay reference. No disk storage. */
  dispose(): void {
    this.disposed = true;
    this.nativeStage = null;
    this.nativeBefore = null;
    this.nativeRows = null;
    this.nativeStopped = true;
    this.seedBytes = new Uint8Array();
    this.tail.length = 0;
    this.tailBytes = 0;
    this.allocated = 0;
    this.retained = null;
    this.stage = null;
    this.parsed = -1;
    this.rendered = -1;
    this.restoreThrough = 0;
    this.reported = -1;
  }
}
