import {
  STREAM_LIMITS,
  type StreamChunk,
  StreamChunkSchema,
  type StreamId,
  type StreamTransferMeta,
  StreamTransferMetaSchema,
} from "./stream-wire.js";

export type StreamOffer =
  | { accepted: true; transferId: StreamId }
  | { accepted: false; reason: "busy" | "too-large" | "closed" };

export interface StreamSenderOptions {
  subscriptionId: StreamId;
  sessionId: string;
  now: () => number;
  newTransferId: () => StreamId;
  /**
   * Check actual encrypted size, shared wire budget and socket capacity before accepting.
   * Return acceptance before delivering any peer ACK to this sender. A synchronous synthetic
   * transport must queue peer delivery until this call returns, as a real socket does.
   */
  send: (chunk: StreamChunk) => boolean;
}

interface Transfer {
  id: StreamId;
  meta: StreamTransferMeta;
  bytes: Uint8Array;
  count: number;
  nextIndex: number;
  acknowledged: number;
  startedAt: number | null;
  progressAt: number | null;
}

/** Owns bounded raw records and credits, but no socket, timers or terminal interpretation. */
export class StreamSender {
  private readonly options: StreamSenderOptions;
  private readonly lanes: [Transfer | null, Transfer | null] = [null, null];
  private outstanding: { sequence: number; transfer: Transfer }[] = [];
  private state: "open" | "stalled" | "closed" = "open";
  private nextLane = 0;
  private lastSequence = 0;
  private acknowledgedThrough = 0;

  constructor(options: StreamSenderOptions) {
    if (
      !StreamChunkSchema.shape.subscriptionId.safeParse(options.subscriptionId).success ||
      !StreamChunkSchema.shape.sessionId.safeParse(options.sessionId).success
    ) {
      throw new Error("Invalid stream sender identity");
    }
    this.options = { ...options };
  }

  canOffer(kind: StreamTransferMeta["kind"]): boolean {
    return this.tick() === "open" && this.lanes[kind === "history" ? 1 : 0] === null;
  }

  offer(meta: StreamTransferMeta, bytes: Uint8Array): StreamOffer {
    if (this.tick() !== "open") return { accepted: false, reason: "closed" };
    const parsed = StreamTransferMetaSchema.safeParse(meta);
    if (!parsed.success || !(bytes instanceof Uint8Array) || bytes.length === 0) {
      throw new Error("Invalid stream transfer");
    }
    const lane = parsed.data.kind === "history" ? 1 : 0;
    const limit = lane === 1 ? STREAM_LIMITS.historyBytes : STREAM_LIMITS.screenBytes;
    if (bytes.length > limit) return { accepted: false, reason: "too-large" };
    if (this.lanes[lane]) return { accepted: false, reason: "busy" };

    let id: StreamId;
    try {
      id = this.options.newTransferId();
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (!StreamChunkSchema.shape.transferId.safeParse(id).success) {
      throw new Error("Invalid stream transfer identity");
    }
    if (this.state !== "open") return { accepted: false, reason: "closed" };
    this.lanes[lane] = {
      id,
      meta: parsed.data,
      // Constructing a Uint8Array also copies Node Buffers (whose slice aliases its input).
      bytes: new Uint8Array(bytes),
      count: Math.ceil(bytes.length / STREAM_LIMITS.chunkBytes),
      nextIndex: 0,
      acknowledged: 0,
      startedAt: null,
      progressAt: null,
    };
    return { accepted: true, transferId: id };
  }

  pump(): number {
    if (this.tick() !== "open") return 0;
    let accepted = 0;
    while (accepted < STREAM_LIMITS.unacked && this.inFlight < STREAM_LIMITS.unacked) {
      if (this.tick() !== "open") break;
      let lane = this.nextLane;
      let transfer = this.lanes[lane];
      if (!transfer || transfer.nextIndex === transfer.count) {
        lane = 1 - lane;
        transfer = this.lanes[lane];
      }
      if (!transfer || transfer.nextIndex === transfer.count) break;
      if (this.lastSequence === Number.MAX_SAFE_INTEGER) {
        this.cancel();
        break;
      }
      const sequence = this.lastSequence + 1;
      const index = transfer.nextIndex;
      const chunk: StreamChunk = {
        type: "stream.chunk",
        subscriptionId: this.options.subscriptionId,
        sessionId: this.options.sessionId,
        transferId: transfer.id,
        sequence,
        index,
        count: transfer.count,
        totalBytes: transfer.bytes.length,
        data: transfer.bytes.slice(
          index * STREAM_LIMITS.chunkBytes,
          (index + 1) * STREAM_LIMITS.chunkBytes,
        ),
        meta: { ...transfer.meta },
      };
      let sent: boolean;
      try {
        sent = this.options.send(chunk);
      } catch (error) {
        this.cancel();
        throw error;
      }
      if (sent) accepted++;
      if (this.state !== "open" || !sent) break;
      this.lastSequence = sequence;
      transfer.nextIndex++;
      if (transfer.startedAt === null) {
        transfer.startedAt = this.options.now();
        transfer.progressAt = transfer.startedAt;
      }
      this.outstanding.push({ sequence, transfer });
      this.nextLane = 1 - lane;
    }
    return accepted;
  }

  acknowledge(
    subscriptionId: StreamId,
    through: number,
  ): "advanced" | "duplicate" | "invalid" | "ignored" {
    if (subscriptionId !== this.options.subscriptionId || this.tick() !== "open") return "ignored";
    if (!Number.isSafeInteger(through) || through < 1 || through > this.lastSequence)
      return "invalid";
    if (through <= this.acknowledgedThrough) return "duplicate";
    const now = this.options.now();
    for (const frame of this.outstanding) {
      if (frame.sequence > through) break;
      frame.transfer.acknowledged++;
      frame.transfer.progressAt = now;
      if (frame.transfer.acknowledged === frame.transfer.count) {
        this.lanes[frame.transfer.meta.kind === "history" ? 1 : 0] = null;
      }
    }
    this.outstanding = this.outstanding.filter((frame) => frame.sequence > through);
    this.acknowledgedThrough = through;
    return "advanced";
  }

  tick(): "open" | "stalled" | "closed" {
    const deadline = this.nextDeadline();
    if (deadline !== null && this.options.now() >= deadline) this.stop("stalled");
    return this.state;
  }

  nextDeadline(): number | null {
    let deadline = Number.POSITIVE_INFINITY;
    for (const transfer of this.lanes) {
      if (transfer && transfer.startedAt !== null && transfer.progressAt !== null) {
        deadline = Math.min(
          deadline,
          transfer.startedAt + STREAM_LIMITS.totalMs,
          transfer.progressAt + STREAM_LIMITS.progressMs,
        );
      }
    }
    return Number.isFinite(deadline) ? deadline : null;
  }

  cancel(): void {
    this.stop("closed");
  }

  private stop(state: "stalled" | "closed"): void {
    this.state = state;
    this.lanes[0] = null;
    this.lanes[1] = null;
    this.outstanding = [];
  }

  get inFlight(): number {
    return this.outstanding.length;
  }

  get retainedBytes(): number {
    return (this.lanes[0]?.bytes.length ?? 0) + (this.lanes[1]?.bytes.length ?? 0);
  }
}
