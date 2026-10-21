import { STREAM_LIMITS, type StreamTransferMeta } from "@shellbell/protocol";
import { TERMINAL_BUFFER_LIMIT } from "./buffer";
import { VT_CHECKPOINT_BYTES, VT_HISTORY_BYTES, type VtHistoryCheckpoint } from "./vt-checkpoint";
import { VT_MESSAGE_BYTES } from "./vt-limits";

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

/** Small writes share bounded segments instead of imposing a limit on the number of writes. */
export const VT_REPLAY_SEGMENT_BYTES = 16 * 1024;
export const VT_HISTORY_PART_BYTES = VT_MESSAGE_BYTES;
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
  private reported = -1;
  private disposed = false;

  constructor(meta: VtSeed, seed: Uint8Array) {
    if (seed.byteLength > STREAM_LIMITS.screenBytes)
      throw new Error("Terminal seed exceeds its byte budget");
    this.meta = Object.freeze({ ...meta });
    this.generation = meta.generation;
    this.cols = meta.cols;
    this.rows = meta.rows;
    this.seedBytes = new Uint8Array(seed);
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
  get history(): VtHistoryCheckpoint | null {
    return this.retained;
  }
  get receivedOffset(): number {
    return this.tailBytes;
  }
  get appliedOffset(): number {
    return this.parsed;
  }
  /** Allocated bytes plus the history reservation, including unused tail-segment capacity. */
  get bytes(): number {
    return (
      this.seedBytes.byteLength +
      this.allocated +
      (this.retained?.data.byteLength ??
        this.stage?.data.byteLength ??
        (this.disposed ? 0 : VT_HISTORY_BYTES))
    );
  }
  /** Only a complete, previously applied checkpoint may be advertised on reconnect. */
  get hasRetained(): boolean {
    return !this.disposed && this.retained !== null && this.parsed >= 0;
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
      !this.retained ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset < this.parsed ||
      offset > this.tailBytes
    )
      return false;
    this.parsed = offset;
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
    this.seedBytes = new Uint8Array();
    this.tail.length = 0;
    this.tailBytes = 0;
    this.allocated = 0;
    this.retained = null;
    this.stage = null;
    this.parsed = -1;
    this.reported = -1;
  }
}
