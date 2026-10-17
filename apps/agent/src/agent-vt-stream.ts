import {
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  StreamMessageSchema,
  StreamSender,
} from "@shellbell/protocol";
import type { VtSource, VtSourceEnd } from "./backends/types.js";

export type VtStreamCloseReason =
  | "cancelled"
  | "stalled"
  | "session-gone"
  | "invalid-transfer"
  | "unsupported";

export interface AgentVtStreamOptions {
  subscriptionId: string;
  sessionId: string;
  source: VtSource;
  now: () => number;
  newTransferId: () => string;
  sendChunk: (chunk: StreamChunk) => boolean;
  sendControl: (message: StreamMessage) => boolean;
  /** New output or a new seed is waiting; the owner should pump. */
  onReady: () => void;
  onClosed: (reason: VtStreamCloseReason) => void;
}

/** Output held while a transfer is in flight; past it the phone is reseeded instead. */
export const VT_BACKLOG_BYTES = 256 * 1024;
/** History lines in the first seed; halved while a seed exceeds one screen transfer. */
export const VT_HISTORY_LINES = 2000;

const encoder = new TextEncoder();

/**
 * A raw terminal subscription: one seed, then the terminal's bytes, on the screen lane. Output
 * that arrives while a transfer is in flight is batched into the next one. When the phone falls
 * too far behind, held output is dropped and a fresh seed is taken once the lane is free, so the
 * phone catches up to the present instead of replaying everything it missed.
 */
export class AgentVtStream {
  private readonly sender: StreamSender;
  private open = true;
  private sending = false;
  private chunkAdmitted = false;
  private generation = 0;
  private state: { cols: number; rows: number; bytes: Uint8Array } | null = null;
  private backlog: Uint8Array[] = [];
  private backlogBytes = 0;
  private offset = 0;
  /** Output was dropped; send nothing more until the next seed. */
  private behind = false;
  private reseedRequested = false;
  private historyLines = VT_HISTORY_LINES;

  constructor(private readonly options: AgentVtStreamOptions) {
    this.sender = new StreamSender({
      subscriptionId: options.subscriptionId,
      sessionId: options.sessionId,
      now: () => this.readClock(),
      newTransferId: () => options.newTransferId(),
      send: (chunk) => this.admitChunk(chunk),
    });
    const { source } = options;
    source.on("seed", (seed) => {
      if (!this.open) return;
      const bytes = encoder.encode(seed.data);
      if (bytes.length > STREAM_LIMITS.screenBytes) {
        // A long history; the visible screen alone always fits a 512 KiB transfer.
        if (this.historyLines > 1) {
          this.historyLines = Math.max(1, Math.floor(this.historyLines / 2));
          void source.reseed(this.historyLines);
        } else this.close("invalid-transfer");
        return;
      }
      this.generation = seed.generation;
      this.state = { cols: seed.cols, rows: seed.rows, bytes };
      this.backlog = [];
      this.backlogBytes = 0;
      this.offset = 0;
      this.behind = false;
      this.reseedRequested = false;
      this.ready();
    });
    source.on("bytes", (data, generation) => {
      // Nothing to send; holding it would grow the backlog without counting against its bound.
      if (data.length === 0) return;
      if (!this.open || this.behind || generation !== this.generation) return;
      if (this.backlogBytes + data.length > VT_BACKLOG_BYTES) {
        this.behind = true;
        this.backlog = [];
        this.backlogBytes = 0;
        this.ready();
        return;
      }
      this.backlog.push(new Uint8Array(data));
      this.backlogBytes += data.length;
      this.ready();
    });
    source.on("end", (reason) => this.close(endReason(reason)));
  }

  start(): Promise<void> {
    return this.options.source.start(this.historyLines);
  }

  receive(message: StreamMessage, envelopeBytes: number): void {
    if (!this.open || message.subscriptionId !== this.options.subscriptionId) return;
    this.tick();
    if (!this.open) return;
    if (
      !Number.isSafeInteger(envelopeBytes) ||
      envelopeBytes < 1 ||
      envelopeBytes > STREAM_LIMITS.envelopeBytes ||
      !StreamMessageSchema.safeParse(message).success
    ) {
      this.close("invalid-transfer");
      return;
    }
    if (message.type === "stream.cancel") {
      this.cancel();
      return;
    }
    if (message.type === "stream.refresh") {
      this.requestReseed();
      return;
    }
    if (message.type === "stream.history.get") {
      // xterm keeps the history itself; the seed already carried tmux's.
      this.sendControl({
        type: "stream.error",
        subscriptionId: this.options.subscriptionId,
        requestId: message.requestId,
        code: "history-unavailable",
      });
      return;
    }
    if (message.type !== "stream.ack") {
      this.close("invalid-transfer");
      return;
    }
    let result: ReturnType<StreamSender["acknowledge"]>;
    try {
      result = this.sender.acknowledge(message.subscriptionId, message.through);
    } catch {
      this.close("invalid-transfer");
      return;
    }
    if (result === "invalid") this.close("invalid-transfer");
    else if (result === "advanced") this.ready();
  }

  /** Offers the next transfer when the lane is free, then sends at most one chunk. */
  sendOne(): boolean {
    if (this.sending) return false;
    this.tick();
    if (!this.open) return false;
    this.sending = true;
    try {
      if (this.sender.canOffer("vt")) this.offerNext();
      if (!this.open) return false;
      this.sender.pump();
      this.reconcileSender();
      return this.chunkAdmitted;
    } catch {
      this.close("invalid-transfer");
      return false;
    } finally {
      this.chunkAdmitted = false;
      this.sending = false;
    }
  }

  tick(): void {
    if (!this.open) return;
    try {
      this.reconcileSender();
    } catch {
      this.close("invalid-transfer");
    }
  }

  nextDeadline(): number | null {
    return this.open ? this.sender.nextDeadline() : null;
  }

  cancel(): void {
    this.close("cancelled");
  }

  terminate(reason: "session-gone" | "invalid-transfer"): void {
    this.close(reason);
  }

  private offerNext(): void {
    if (this.state) {
      const { cols, rows, bytes } = this.state;
      const offered = this.sender.offer(
        { kind: "vt-state", generation: this.generation, cols, rows },
        bytes,
      );
      if (offered.accepted) this.state = null;
      return;
    }
    if (this.behind) {
      // The lane is free, so a seed taken now goes out at once and is as fresh as possible.
      this.requestReseed();
      return;
    }
    if (this.backlogBytes === 0) return;
    const bytes = new Uint8Array(this.backlogBytes);
    let at = 0;
    for (const part of this.backlog) {
      bytes.set(part, at);
      at += part.length;
    }
    const offered = this.sender.offer(
      { kind: "vt", generation: this.generation, offset: this.offset },
      bytes,
    );
    if (offered.accepted) {
      this.offset += bytes.length;
      this.backlog = [];
      this.backlogBytes = 0;
    }
  }

  private requestReseed(): void {
    if (this.reseedRequested) return;
    this.reseedRequested = true;
    void this.options.source.reseed(this.historyLines);
  }

  private ready(): void {
    try {
      this.options.onReady();
    } catch {
      /* the owner's pump is best effort */
    }
  }

  private readClock(): number {
    const now = this.options.now();
    if (!Number.isFinite(now)) throw new Error("Invalid vt stream clock");
    return now;
  }

  private reconcileSender(): void {
    const state = this.sender.tick();
    if (this.open && state !== "open")
      this.close(state === "stalled" ? "stalled" : "invalid-transfer");
  }

  private admitChunk(chunk: StreamChunk): boolean {
    if (!this.open || this.chunkAdmitted) return false;
    const sent = this.options.sendChunk(chunk);
    if (sent) this.chunkAdmitted = true;
    return sent;
  }

  private sendControl(message: StreamMessage): void {
    try {
      this.options.sendControl(message);
    } catch {
      /* control delivery is best effort */
    }
  }

  private close(reason: VtStreamCloseReason): void {
    if (!this.open) return;
    this.open = false;
    this.sender.cancel();
    this.state = null;
    this.backlog = [];
    this.backlogBytes = 0;
    this.options.source.close();
    if (reason !== "cancelled") {
      this.sendControl({
        type: "stream.error",
        subscriptionId: this.options.subscriptionId,
        code: reason,
      });
    }
    try {
      this.options.onClosed(reason);
    } catch {
      /* closure notification is best effort */
    }
  }
}

/** A pane that closed ends the view; anything else asks the phone to fall back to snapshots. */
function endReason(reason: VtSourceEnd): VtStreamCloseReason {
  return reason === "pane-gone" ? "session-gone" : "unsupported";
}
