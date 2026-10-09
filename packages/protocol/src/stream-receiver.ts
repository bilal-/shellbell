import {
  STREAM_LIMITS,
  type StreamChunk,
  StreamChunkSchema,
  type StreamId,
  type StreamTransferMeta,
} from "./stream-wire.js";

export interface StreamReceiverOptions {
  subscriptionId: StreamId;
  sessionId: string;
  now: () => number;
  /** Synchronously validate/decode the whole record before atomically applying it; throw on failure. */
  accept: (meta: StreamTransferMeta, bytes: Uint8Array) => void;
  acknowledge: (through: number) => boolean;
}

interface Assembly {
  id: StreamId;
  meta: StreamTransferMeta;
  bytes: Uint8Array;
  count: number;
  nextIndex: number;
  startedAt: number;
  progressAt: number;
}

function sameMeta(left: StreamTransferMeta, right: StreamTransferMeta): boolean {
  return (
    left.kind === right.kind &&
    left.generation === right.generation &&
    (left.kind !== "history" ||
      (right.kind === "history" &&
        left.requestId === right.requestId &&
        left.before === right.before))
  );
}

/** Bounded byte acceptance only. The caller owns scheduling and terminal/UI validation. */
export class StreamReceiver {
  private readonly options: StreamReceiverOptions;
  private readonly lanes: [Assembly | null, Assembly | null] = [null, null];
  private state: "open" | "stalled" | "closed" = "open";
  private lastSequence = 0;
  private pendingCount = 0;
  private ackDeadline: number | null = null;

  constructor(options: StreamReceiverOptions) {
    if (
      !StreamChunkSchema.shape.subscriptionId.safeParse(options.subscriptionId).success ||
      !StreamChunkSchema.shape.sessionId.safeParse(options.sessionId).success
    ) {
      throw new Error("Invalid stream receiver identity");
    }
    this.options = { ...options };
  }

  receive(
    chunk: StreamChunk,
    envelopeBytes: number,
  ): "accepted" | "ignored" | "invalid" | "stalled" {
    if (this.state === "stalled") return "stalled";
    if (this.state === "closed") return "ignored";
    const now = this.options.now();
    if (
      !Number.isSafeInteger(envelopeBytes) ||
      envelopeBytes < 1 ||
      envelopeBytes > STREAM_LIMITS.envelopeBytes
    ) {
      return this.invalid();
    }
    const parsed = StreamChunkSchema.safeParse(chunk);
    if (!parsed.success) return this.invalid();
    const frame = parsed.data;
    if (
      frame.subscriptionId !== this.options.subscriptionId ||
      frame.sessionId !== this.options.sessionId
    )
      return "ignored";
    if (this.expire(now)) return "stalled";
    if (frame.sequence <= this.lastSequence) return "ignored";
    if (this.lastSequence === Number.MAX_SAFE_INTEGER || frame.sequence !== this.lastSequence + 1)
      return this.invalid();

    const lane = frame.meta.kind === "history" ? 1 : 0;
    let assembly = this.lanes[lane];
    if (!assembly) {
      if (frame.index !== 0 || this.lanes[1 - lane]?.id === frame.transferId) return this.invalid();
      // Schema and all declarations are validated before the bounded allocation.
      assembly = {
        id: frame.transferId,
        meta: frame.meta,
        bytes: new Uint8Array(frame.totalBytes),
        count: frame.count,
        nextIndex: 0,
        startedAt: now,
        progressAt: now,
      };
      this.lanes[lane] = assembly;
    }
    if (
      assembly.id !== frame.transferId ||
      assembly.nextIndex !== frame.index ||
      assembly.count !== frame.count ||
      assembly.bytes.length !== frame.totalBytes ||
      !sameMeta(assembly.meta, frame.meta)
    )
      return this.invalid();

    assembly.bytes.set(frame.data, frame.index * STREAM_LIMITS.chunkBytes);
    assembly.nextIndex++;
    assembly.progressAt = now;
    if (assembly.nextIndex === assembly.count) {
      try {
        this.options.accept(assembly.meta, assembly.bytes);
      } catch (error) {
        this.cancel();
        throw error;
      }
      this.lanes[lane] = null;
      if (this.state !== "open") return "ignored";
    }
    this.lastSequence = frame.sequence;
    if (this.pendingCount === 0) this.ackDeadline = now + STREAM_LIMITS.ackDelayMs;
    this.pendingCount++;
    // Screen delivery is stop-and-wait at the sender. Delaying a completed
    // screen's ACK would throttle interactive echo to the history batching timer.
    const completedScreen = lane === 0 && this.lanes[lane] === null;
    if (
      (completedScreen || this.pendingCount === STREAM_LIMITS.unacked) &&
      !this.flushAcknowledgement()
    )
      return "stalled";
    return "accepted";
  }

  tick(): "open" | "stalled" | "closed" {
    if (this.state !== "open") return this.state;
    const now = this.options.now();
    if (this.expire(now)) return this.state;
    if (this.ackDeadline !== null && now >= this.ackDeadline) this.flushAcknowledgement();
    return this.state;
  }

  nextDeadline(): number | null {
    let deadline = this.ackDeadline ?? Number.POSITIVE_INFINITY;
    for (const assembly of this.lanes) {
      if (assembly)
        deadline = Math.min(
          deadline,
          assembly.startedAt + STREAM_LIMITS.totalMs,
          assembly.progressAt + STREAM_LIMITS.progressMs,
        );
    }
    return Number.isFinite(deadline) ? deadline : null;
  }

  private expire(now: number): boolean {
    for (const assembly of this.lanes) {
      if (
        assembly &&
        (now >= assembly.startedAt + STREAM_LIMITS.totalMs ||
          now >= assembly.progressAt + STREAM_LIMITS.progressMs)
      ) {
        this.stop("stalled");
        return true;
      }
    }
    return false;
  }

  private flushAcknowledgement(): boolean {
    let sent: boolean;
    try {
      sent = this.options.acknowledge(this.lastSequence);
    } catch (error) {
      this.cancel();
      throw error;
    }
    if (this.state !== "open") return false;
    if (!sent) {
      this.stop("stalled");
      return false;
    }
    this.pendingCount = 0;
    this.ackDeadline = null;
    return true;
  }

  private invalid(): "invalid" {
    this.cancel();
    return "invalid";
  }

  cancel(): void {
    this.stop("closed");
  }

  private stop(state: "stalled" | "closed"): void {
    this.state = state;
    this.lanes[0] = null;
    this.lanes[1] = null;
    this.pendingCount = 0;
    this.ackDeadline = null;
  }

  get retainedBytes(): number {
    return (this.lanes[0]?.bytes.length ?? 0) + (this.lanes[1]?.bytes.length ?? 0);
  }
}
