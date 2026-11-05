import { encodeCbor } from "./codec.js";
import {
  WEB_LIMITS,
  type WebMessage,
  type WebMessageOf,
  type WebResetReason,
  webBodyBytes,
  webCharge,
  webChargeForLength,
} from "./web-wire.js";

type Cancel = () => void;
export type WebTimer = (callback: () => void, ms: number) => Cancel;
const defaultTimer: WebTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  return () => clearTimeout(handle);
};

type Item =
  | { kind: "frame"; message: WebMessageOf<"web.open"> | WebMessageOf<"web.head"> }
  | { kind: "bytes"; data: Uint8Array }
  | { kind: "end" };

interface StreamQueue {
  items: Item[];
  /** Body bytes this stream may still send before the receiver returns credit. */
  credit: number;
  queuedBytes: number;
  paused: boolean;
  /** This side's half is over once its last frame is sent; the queue then goes. */
  ending: boolean;
}

export interface WebSenderOptions {
  /** Sends one message on the committed direct route. False means the route is gone. */
  send(message: WebMessage): boolean;
  /** Called when a stream's queue falls back below `lowWater` after passing `highWater`. */
  drained?(stream: number): void;
  connectionWindow?: number;
  streamWindow?: number;
  highWater?: number;
  lowWater?: number;
}

/**
 * Paces page traffic for one phone and direction. Everything waiting for credit stays here, so the
 * data channel never holds more than the connection window plus each frame's allowance. Streams
 * take turns one frame at a time, so a large download doesn't hold back a small request.
 */
export class WebSender {
  private available: number;
  private readonly window: number;
  private readonly streamWindow: number;
  private readonly highWater: number;
  private readonly lowWater: number;
  private readonly streams = new Map<number, StreamQueue>();
  private closed = false;
  private pumping = false;

  constructor(private readonly options: WebSenderOptions) {
    this.window = options.connectionWindow ?? WEB_LIMITS.connectionWindow;
    this.available = this.window;
    this.streamWindow = options.streamWindow ?? WEB_LIMITS.streamWindow;
    this.highWater = options.highWater ?? 65_536;
    this.lowWater = options.lowWater ?? 32_768;
  }

  /** Connection credit currently spent and not yet returned. */
  get outstanding(): number {
    return this.window - this.available;
  }

  /** Queues `web.open` or `web.head`; it is sent in order with the stream's other frames. */
  frame(message: WebMessageOf<"web.open"> | WebMessageOf<"web.head">): void {
    if (this.closed) return;
    this.queue(message.stream).items.push({ kind: "frame", message });
    this.pump();
  }

  /** Queues body bytes. Returns true while the caller may keep reading its source. */
  write(stream: number, data: Uint8Array): boolean {
    if (this.closed) return false;
    const queue = this.queue(stream);
    if (data.byteLength > 0) {
      queue.items.push({ kind: "bytes", data });
      queue.queuedBytes += data.byteLength;
    }
    this.pump();
    if (queue.queuedBytes > this.highWater) queue.paused = true;
    return !queue.paused;
  }

  end(stream: number): void {
    if (this.closed) return;
    this.queue(stream).items.push({ kind: "end" });
    this.pump();
  }

  /** Drops whatever the stream still had queued and sends the reset at once. */
  reset(stream: number, reason: WebResetReason, detail?: string): boolean {
    this.streams.delete(stream);
    if (this.closed) return false;
    return this.sendNow({ type: "web.reset", stream, reason, ...(detail && { detail }) });
  }

  /** The stream finished; frees its queue without sending anything. */
  forget(stream: number): void {
    this.streams.delete(stream);
  }

  /** Uncharged messages that never wait: `web.credit` and `web.view`. */
  control(message: WebMessageOf<"web.credit"> | WebMessageOf<"web.view">): boolean {
    if (this.closed) return false;
    return this.sendNow(message);
  }

  /** Applies returned credit. Returns false when the peer returned more than was outstanding. */
  receiveCredit(message: WebMessageOf<"web.credit">): boolean {
    if (message.stream === 0) {
      if (message.bytes > this.outstanding) return false;
      this.available += message.bytes;
    } else {
      const queue = this.streams.get(message.stream);
      // Credit for a stream that already finished is fine: it was in flight.
      if (queue) queue.credit += message.bytes;
    }
    this.pump();
    return true;
  }

  queuedBytes(stream: number): number {
    return this.streams.get(stream)?.queuedBytes ?? 0;
  }

  /** Whether this side still has anything to send on the stream, including its end. */
  sending(stream: number): boolean {
    return this.streams.has(stream);
  }

  get openStreams(): number {
    return this.streams.size;
  }

  close(): void {
    this.closed = true;
    this.streams.clear();
  }

  private queue(stream: number): StreamQueue {
    let queue = this.streams.get(stream);
    if (!queue) {
      queue = {
        items: [],
        credit: this.streamWindow,
        queuedBytes: 0,
        paused: false,
        ending: false,
      };
      this.streams.set(stream, queue);
    }
    return queue;
  }

  private settle(stream: number, queue: StreamQueue): void {
    if (queue.ending && queue.items.length === 0 && this.streams.get(stream) === queue)
      this.streams.delete(stream);
  }

  private sendNow(message: WebMessage): boolean {
    if (this.options.send(message)) return true;
    this.close();
    return false;
  }

  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    try {
      let progress = true;
      while (progress && !this.closed) {
        progress = false;
        for (const [stream, queue] of [...this.streams]) {
          if (this.closed) return;
          if (this.streams.get(stream) !== queue) continue;
          if (this.step(stream, queue)) progress = true;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Sends at most one frame for this stream. Returns whether it sent anything. */
  private step(stream: number, queue: StreamQueue): boolean {
    const item = queue.items[0];
    if (!item) return false;
    if (item.kind === "end") {
      queue.items.shift();
      queue.ending = true;
      if (!this.sendNow({ type: "web.end", stream })) return false;
      this.settle(stream, queue);
      return true;
    }
    if (item.kind === "frame") {
      const charge = webCharge(item.message);
      const body = webBodyBytes(item.message);
      if (charge > this.available || body > queue.credit) return false;
      queue.items.shift();
      this.available -= charge;
      queue.credit -= body;
      const message = item.message;
      if (
        (message.type === "web.open" && !message.body && !message.upgrade) ||
        (message.type === "web.head" && message.end === true)
      )
        queue.ending = true;
      if (!this.sendNow(message)) return false;
      this.settle(stream, queue);
      return true;
    }
    const room = this.available - WEB_LIMITS.frameAllowance - dataOverhead(stream);
    const n = Math.min(item.data.byteLength, WEB_LIMITS.dataBytes, queue.credit, room);
    // Wait for a useful frame rather than sending slivers when the window is nearly spent.
    if (n <= 0 || (n < item.data.byteLength && n < 1024 && n < queue.credit)) return false;
    const bytes = item.data.subarray(0, n);
    const message: WebMessageOf<"web.data"> = { type: "web.data", stream, bytes };
    const charge = webChargeForLength(encodeCbor(message).byteLength);
    if (n === item.data.byteLength) queue.items.shift();
    else item.data = item.data.subarray(n);
    this.available -= charge;
    queue.credit -= n;
    queue.queuedBytes -= n;
    if (!this.sendNow(message)) return false;
    this.settle(stream, queue);
    if (queue.paused && queue.queuedBytes <= this.lowWater) {
      queue.paused = false;
      this.options.drained?.(stream);
    }
    return true;
  }
}

/** Upper bound on a `web.data` frame's CBOR bytes beyond its payload. */
function dataOverhead(stream: number): number {
  // Map header, two keys and the type string, the stream integer (up to 5 bytes), and the
  // byte-string header (up to 5 bytes).
  return encodeCbor({ type: "web.data", stream, bytes: new Uint8Array(0) }).byteLength + 4;
}

export interface WebReceiverOptions {
  sendCredit(message: WebMessageOf<"web.credit">): void;
  timer?: WebTimer;
  connectionWindow?: number;
  streamWindow?: number;
}

/**
 * The receiving side of the windows: returns connection credit as soon as a frame is decoded and
 * stream credit as the consumer takes bytes, in batches. Detects a peer that sends past either
 * window.
 */
export class WebReceiver {
  private readonly connectionWindow: number;
  private readonly streamWindow: number;
  private readonly timer: WebTimer;
  private inFlight = 0;
  private pendingConnection = 0;
  private readonly pendingStream = new Map<number, number>();
  /** Per stream: body bytes received minus credit returned. */
  private readonly streamInFlight = new Map<number, number>();
  private cancelFlush: Cancel | null = null;
  private closed = false;

  constructor(private readonly options: WebReceiverOptions) {
    this.connectionWindow = options.connectionWindow ?? WEB_LIMITS.connectionWindow;
    this.streamWindow = options.streamWindow ?? WEB_LIMITS.streamWindow;
    this.timer = options.timer ?? defaultTimer;
  }

  /**
   * Charges a received frame, by its encoded inner length. Called for every `web.open`,
   * `web.head` and `web.data`, even one that failed to decode or names a reset stream.
   * Returns false when the peer exceeded the window.
   */
  charged(innerBytes: number): boolean {
    const charge = webChargeForLength(innerBytes);
    this.inFlight += charge;
    if (this.inFlight > this.connectionWindow) return false;
    this.pendingConnection += charge;
    this.schedule();
    return true;
  }

  /** Records body bytes received on a stream. Returns false when the stream exceeded its window. */
  body(stream: number, bytes: number): boolean {
    if (bytes === 0) return true;
    const total = (this.streamInFlight.get(stream) ?? 0) + bytes;
    this.streamInFlight.set(stream, total);
    return total <= this.streamWindow;
  }

  /** The consumer took `bytes` of this stream's body; their credit goes back in the next batch. */
  consumed(stream: number, bytes: number): void {
    if (bytes <= 0 || this.closed || !this.streamInFlight.has(stream)) return;
    this.pendingStream.set(stream, (this.pendingStream.get(stream) ?? 0) + bytes);
    this.schedule();
  }

  /** The stream finished: its stream credit no longer matters to the sender. */
  forget(stream: number): void {
    this.streamInFlight.delete(stream);
    this.pendingStream.delete(stream);
  }

  flush(): void {
    this.cancelFlush?.();
    this.cancelFlush = null;
    if (this.closed) return;
    if (this.pendingConnection > 0) {
      const bytes = this.pendingConnection;
      this.pendingConnection = 0;
      this.inFlight -= bytes;
      this.options.sendCredit({ type: "web.credit", stream: 0, bytes });
    }
    for (const [stream, bytes] of [...this.pendingStream]) {
      this.pendingStream.delete(stream);
      const inFlight = this.streamInFlight.get(stream);
      if (inFlight === undefined) continue;
      this.streamInFlight.set(stream, inFlight - bytes);
      this.options.sendCredit({ type: "web.credit", stream, bytes });
    }
  }

  close(): void {
    this.closed = true;
    this.cancelFlush?.();
    this.cancelFlush = null;
  }

  private schedule(): void {
    if (this.closed) return;
    let pending = this.pendingConnection;
    for (const bytes of this.pendingStream.values()) pending = Math.max(pending, bytes);
    if (pending >= WEB_LIMITS.creditFlushBytes) {
      this.flush();
      return;
    }
    this.cancelFlush ??= this.timer(() => {
      this.cancelFlush = null;
      this.flush();
    }, WEB_LIMITS.creditFlushMs);
  }
}
