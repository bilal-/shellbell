import {
  isWebChargedType,
  WEB_LIMITS,
  type WebMessage,
  type WebMessageOf,
  WebReceiver,
  type WebResetReason,
  WebSender,
  type WebTarget,
  type WebTimer,
  webBodyBytes,
} from "@shellbell/protocol";

/** What a stream's owner (the door) hears from the computer. */
export interface WebStreamHandler {
  head(message: WebMessageOf<"web.head">): void;
  data(bytes: Uint8Array): void;
  end(): void;
  /** The stream is over: the computer reset it, or the session closed. */
  reset(reason: WebResetReason, detail?: string): void;
  /** The phone may send body bytes again after `write` returned false. */
  drained?(): void;
}

export type WebOpen = Omit<WebMessageOf<"web.open">, "type" | "stream">;

export interface WebSessionOptions {
  /** Sends on the committed direct route; false when refused (locked, quiet) or the route is gone. */
  send(message: WebMessage): boolean;
  timer?: WebTimer;
  /** Called once when the session can no longer carry streams. */
  closed?(): void;
}

/**
 * One phone's page streams to one computer, for one route. Stream IDs only increase, and the
 * session ends with the route: every stream is reset with `closed` and a new session starts.
 */
export class WebSession {
  private readonly sender: WebSender;
  private readonly receiver: WebReceiver;
  private readonly handlers = new Map<number, WebStreamHandler>();
  /** Streams whose computer half is over while the phone's half is still sending. */
  private readonly computerDone = new Set<number>();
  private nextStream = 1;
  private done = false;

  constructor(private readonly options: WebSessionOptions) {
    this.sender = new WebSender({
      send: (message) => {
        if (this.done) return false;
        if (options.send(message)) return true;
        // A refused send means the route or the lock rule ended page traffic.
        queueMicrotask(() => this.close());
        return false;
      },
      drained: (stream) => this.handlers.get(stream)?.drained?.(),
    });
    this.receiver = new WebReceiver({
      sendCredit: (message) => this.sender.control(message),
      ...(options.timer && { timer: options.timer }),
    });
  }

  get closed(): boolean {
    return this.done;
  }

  get streams(): number {
    return this.handlers.size;
  }

  /** Opens a stream. Returns its ID, or null when the session can't take another. */
  open(open: WebOpen, handler: WebStreamHandler): number | null {
    if (this.done || this.handlers.size >= WEB_LIMITS.streamsPerPhone) return null;
    const stream = this.nextStream++;
    this.handlers.set(stream, handler);
    this.sender.frame({ type: "web.open", stream, ...open });
    return this.done ? null : stream;
  }

  /** Queues request body or WebSocket bytes. False asks the caller to wait for `drained`. */
  write(stream: number, bytes: Uint8Array): boolean {
    if (!this.handlers.has(stream)) return false;
    return this.sender.write(stream, bytes);
  }

  end(stream: number): void {
    if (!this.handlers.has(stream)) return;
    this.sender.end(stream);
    this.settle(stream);
  }

  /** Abandons a stream from the phone's side. */
  reset(stream: number, reason: WebResetReason = "closed"): void {
    this.computerDone.delete(stream);
    if (!this.handlers.delete(stream)) return;
    this.receiver.forget(stream);
    this.sender.reset(stream, reason);
  }

  /** The page took `bytes` of the stream's body; its credit goes back to the computer. */
  consumed(stream: number, bytes: number): void {
    this.receiver.consumed(stream, bytes);
  }

  view(target: WebTarget, open: boolean): boolean {
    if (this.done) return false;
    return this.sender.control({ type: "web.view", target, open });
  }

  /** A `web.*` message from the computer, with its encoded inner length. */
  receive(message: WebMessage, innerBytes: number): void {
    if (this.done) return;
    if (isWebChargedType(message.type) && !this.receiver.charged(innerBytes)) {
      this.close();
      return;
    }
    switch (message.type) {
      case "web.head": {
        const body = webBodyBytes(message);
        if (!this.receiver.body(message.stream, body)) {
          this.fail(message.stream);
          return;
        }
        const handler = this.handlers.get(message.stream);
        handler?.head(message);
        if (message.end) this.finish(message.stream);
        return;
      }
      case "web.data":
        if (!this.receiver.body(message.stream, message.bytes.byteLength)) {
          this.fail(message.stream);
          return;
        }
        this.handlers.get(message.stream)?.data(message.bytes);
        return;
      case "web.end": {
        const handler = this.handlers.get(message.stream);
        this.finish(message.stream);
        handler?.end();
        return;
      }
      case "web.credit":
        if (!this.sender.receiveCredit(message)) this.close();
        return;
      case "web.reset": {
        const handler = this.handlers.get(message.stream);
        this.handlers.delete(message.stream);
        this.computerDone.delete(message.stream);
        this.receiver.forget(message.stream);
        this.sender.forget(message.stream);
        handler?.reset(message.reason, message.detail);
        return;
      }
      default:
        return; // web.open and web.view only travel to the computer
    }
  }

  /** A charged frame that couldn't be decoded still returns its credit. */
  undecodable(innerBytes: number): void {
    if (!this.done && !this.receiver.charged(innerBytes)) this.close();
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    this.sender.close();
    this.receiver.close();
    const handlers = [...this.handlers.values()];
    this.handlers.clear();
    this.computerDone.clear();
    for (const handler of handlers) handler.reset("closed");
    this.options.closed?.();
  }

  /**
   * The computer finished its half. The stream stays known until the phone's half ends too, so
   * the page's remaining request bytes and its `web.end` still go out.
   */
  private finish(stream: number): void {
    this.receiver.forget(stream);
    this.computerDone.add(stream);
    this.settle(stream);
  }

  private settle(stream: number): void {
    if (!this.computerDone.has(stream) || this.sender.sending(stream)) return;
    this.computerDone.delete(stream);
    this.handlers.delete(stream);
  }

  private fail(stream: number): void {
    // The computer sent past this stream's window: a protocol error that ends the session.
    void stream;
    this.close();
  }
}
