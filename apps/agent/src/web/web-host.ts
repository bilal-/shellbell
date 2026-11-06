import http from "node:http";
import net from "node:net";
import type zlib from "node:zlib";
import {
  connectAddresses,
  isWebChargedType,
  type LocalOrigin,
  parseLocalOrigin,
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
import type { CookieJars } from "./cookie-jar.js";
import { compressedHeaders, createGzip, shouldCompress } from "./web-compress.js";
import { headerText, phoneResponseHeaders, upstreamRequestHeaders } from "./web-rewrite.js";

export const WEB_HOST_TIMEOUTS = {
  connectMs: 10_000,
  headMs: 60_000,
  /** A WebSocket or streamed response idle in both directions this long is closed. */
  idleMs: 10 * 60_000,
} as const;

export interface WebHostOptions {
  phoneFp: string;
  /** Sends on the committed direct route; false when it's gone. */
  send(message: WebMessage): boolean;
  jars: CookieJars;
  log: {
    info(message: string, fields?: object): void;
    warn(message: string, fields?: object): void;
  };
  now?: () => number;
  timer?: WebTimer;
  timeouts?: Partial<typeof WEB_HOST_TIMEOUTS>;
}

interface Stream {
  id: number;
  target: LocalOrigin;
  method: string;
  path: string;
  upgrade: boolean;
  /** The page view's Accept-Encoding, to decide whether to gzip the response. */
  acceptEncoding?: string;
  family?: 4 | 6;
  socket?: net.Socket;
  req?: http.ClientRequest;
  res?: http.IncomingMessage;
  /** Set when the web host compresses this response; it, not `res`, feeds the phone. */
  gzip?: zlib.Gzip;
  upgraded?: net.Socket;
  /** Bytes the phone sent before the target was ready for them, in order. */
  pending: Uint8Array[];
  phoneEnded: boolean;
  hostEnded: boolean;
  cancelTimer?: () => void;
}

const defaultTimer: WebTimer = (callback, ms) => {
  const handle = setTimeout(callback, ms);
  handle.unref?.();
  return () => clearTimeout(handle);
};

const targetKey = (target: WebTarget) =>
  "page" in target ? `page:${target.page}` : `origin:${parseLocalOrigin(target.origin)?.origin}`;

/**
 * Serves one phone's page requests from loopback servers on this computer. Owned by the phone's
 * route lease: a route change or lost phone closes it, aborting every upstream request.
 */
export class WebHost {
  private readonly streams = new Map<number, Stream>();
  private readonly sender: WebSender;
  private readonly receiver: WebReceiver;
  private readonly now: () => number;
  private readonly timer: WebTimer;
  private readonly timeouts: typeof WEB_HOST_TIMEOUTS;
  /** Targets whose next `web.head` tells the phone the page's authority and family. */
  private readonly authorityDue = new Set<string>();
  private lastStream = 0;
  private closed = false;

  constructor(private readonly options: WebHostOptions) {
    this.now = options.now ?? Date.now;
    this.timer = options.timer ?? defaultTimer;
    this.timeouts = { ...WEB_HOST_TIMEOUTS, ...options.timeouts };
    this.sender = new WebSender({
      send: (message) => !this.closed && options.send(message),
      drained: (id) => {
        const stream = this.streams.get(id);
        (stream?.gzip ?? stream?.res)?.resume();
        stream?.upgraded?.resume();
      },
    });
    this.receiver = new WebReceiver({
      sendCredit: (message) => this.sender.control(message),
      timer: this.timer,
    });
  }

  /** A `web.*` message from the phone. `innerBytes` is its encoded length, for credit. */
  receive(message: WebMessage, innerBytes: number): void {
    if (this.closed) return;
    if (isWebChargedType(message.type) && !this.receiver.charged(innerBytes)) {
      this.protocolError("connection window exceeded");
      return;
    }
    switch (message.type) {
      case "web.open":
        this.open(message);
        return;
      case "web.data":
        this.data(message);
        return;
      case "web.end":
        this.phoneEnd(message.stream);
        return;
      case "web.credit":
        if (!this.sender.receiveCredit(message)) this.protocolError("credit exceeds outstanding");
        return;
      case "web.reset":
        this.finish(message.stream, null);
        return;
      case "web.view":
        if (message.open) this.authorityDue.add(targetKey(message.target));
        else this.authorityDue.delete(targetKey(message.target));
        return;
      case "web.head":
        return; // only the computer sends heads
    }
  }

  /** A charged frame that couldn't be decoded still returns its credit. */
  undecodable(innerBytes: number): void {
    if (!this.closed && !this.receiver.charged(innerBytes))
      this.protocolError("connection window exceeded");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of [...this.streams.keys()]) this.finish(id, null);
    this.sender.close();
    this.receiver.close();
  }

  get openStreams(): number {
    return this.streams.size;
  }

  private protocolError(reason: string): void {
    this.options.log.warn("web protocol error", {
      reason,
      phone: this.options.phoneFp.slice(0, 8),
    });
    for (const id of [...this.streams.keys()]) this.finish(id, "closed");
  }

  private refuse(id: number, reason: WebResetReason): void {
    this.sender.reset(id, reason);
  }

  private open(message: WebMessageOf<"web.open">): void {
    const id = message.stream;
    if (id <= this.lastStream) {
      this.refuse(id, "refused");
      return;
    }
    this.lastStream = id;
    if (this.streams.size >= WEB_LIMITS.streamsPerPhone) {
      this.refuse(id, "refused");
      return;
    }
    // Registered pages arrive with the Pages step.
    if ("page" in message.target) {
      this.refuse(id, "not-found");
      return;
    }
    const target = parseLocalOrigin(message.target.origin);
    if (!target) {
      this.refuse(id, "refused");
      return;
    }
    const stream: Stream = {
      id,
      target,
      method: message.method,
      path: message.path,
      upgrade: message.upgrade,
      acceptEncoding: acceptEncoding(message),
      pending: [],
      phoneEnded: !message.body && !message.upgrade,
      hostEnded: false,
    };
    this.streams.set(id, stream);
    this.arm(stream, this.timeouts.connectMs);
    this.connect(stream, connectAddresses(target.host), message);
  }

  private connect(
    stream: Stream,
    addresses: Array<{ address: string; family: 4 | 6 }>,
    message: WebMessageOf<"web.open">,
  ): void {
    const [first, ...rest] = addresses;
    if (!first) {
      this.finish(stream.id, "unreachable");
      return;
    }
    const socket = net.connect({
      host: first.address,
      port: stream.target.port,
      family: first.family,
    });
    stream.socket = socket;
    const failed = (error: NodeJS.ErrnoException) => {
      if (this.streams.get(stream.id) !== stream) return;
      socket.destroy();
      stream.socket = undefined;
      // Many tools bind only one family; a name tries the other one.
      if (error.code === "ECONNREFUSED" && rest.length) this.connect(stream, rest, message);
      else this.finish(stream.id, "unreachable");
    };
    socket.once("error", failed);
    socket.once("connect", () => {
      socket.off("error", failed);
      if (this.streams.get(stream.id) !== stream) return socket.destroy();
      stream.family = first.family;
      this.request(stream, socket, message);
    });
  }

  private request(stream: Stream, socket: net.Socket, message: WebMessageOf<"web.open">): void {
    const jar = this.options.jars.jar(this.options.phoneFp, cookieHost(stream.target));
    const headers = upstreamRequestHeaders({
      method: stream.method,
      path: stream.path,
      headers: message.headers,
      upgrade: stream.upgrade,
      target: stream.target,
      jar,
      now: this.now(),
    });
    const req = http.request({
      method: stream.method,
      path: stream.path,
      headers,
      setHost: false,
      createConnection: () => socket,
    });
    stream.req = req;
    this.arm(stream, this.timeouts.headMs);
    req.on("response", (res) => this.response(stream, res));
    req.on("upgrade", (res, upgraded, head) => this.upgraded(stream, res, upgraded, head));
    req.on("error", () => {
      if (this.streams.get(stream.id) === stream) this.finish(stream.id, "closed");
    });
    if (stream.upgrade) {
      // Bytes before the 101 wait for the upgraded socket.
      req.end();
      return;
    }
    for (const bytes of stream.pending.splice(0)) this.writeBody(stream, bytes);
    if (stream.phoneEnded) req.end();
  }

  private data(message: WebMessageOf<"web.data">): void {
    const bytes = webBodyBytes(message);
    if (!this.receiver.body(message.stream, bytes)) {
      this.protocolError("stream window exceeded");
      return;
    }
    const stream = this.streams.get(message.stream);
    if (!stream || stream.phoneEnded) return;
    this.touch(stream);
    if (stream.upgraded) this.writeUpgraded(stream, message.bytes);
    else if (stream.req && !stream.upgrade) this.writeBody(stream, message.bytes);
    else stream.pending.push(message.bytes);
  }

  private writeBody(stream: Stream, bytes: Uint8Array): void {
    stream.req?.write(bytes, () => this.receiver.consumed(stream.id, bytes.byteLength));
  }

  private writeUpgraded(stream: Stream, bytes: Uint8Array): void {
    stream.upgraded?.write(bytes, () => this.receiver.consumed(stream.id, bytes.byteLength));
  }

  private phoneEnd(id: number): void {
    const stream = this.streams.get(id);
    if (!stream || stream.phoneEnded) return;
    stream.phoneEnded = true;
    if (stream.upgraded) stream.upgraded.end();
    else if (stream.req && !stream.upgrade) stream.req.end();
    this.finishIfDone(stream);
  }

  private head(stream: Stream, status: number, rawHeaders: string[], end: boolean) {
    const jar = this.options.jars.jar(this.options.phoneFp, cookieHost(stream.target));
    const key = `origin:${stream.target.origin}`;
    const due = this.authorityDue.delete(key);
    const head: WebMessageOf<"web.head"> = {
      type: "web.head",
      stream: stream.id,
      status,
      headers: phoneResponseHeaders({
        rawHeaders,
        requestPath: stream.path,
        target: stream.target,
        family: stream.family ?? 4,
        jar,
        now: this.now(),
      }),
      ...(end && { end: true }),
      ...(due && { authority: { authority: stream.target.authority, family: stream.family ?? 4 } }),
    };
    this.sender.frame(head);
  }

  private response(stream: Stream, res: http.IncomingMessage): void {
    if (this.streams.get(stream.id) !== stream) return void res.destroy();
    stream.res = res;
    const status = res.statusCode ?? 502;
    // An upgrade the target declined ends as an ordinary response.
    if (stream.upgrade) {
      stream.phoneEnded = true;
      stream.pending = [];
    }
    const noBody = stream.method === "HEAD" || status === 204 || status === 304;
    const gzip =
      !noBody && shouldCompress(status, res.rawHeaders, stream.acceptEncoding)
        ? createGzip()
        : null;
    this.head(stream, status, gzip ? compressedHeaders(res.rawHeaders) : res.rawHeaders, noBody);
    if (noBody) {
      res.resume();
      stream.hostEnded = true;
      this.cancel(stream);
      this.finishIfDone(stream);
      return;
    }
    this.arm(stream, this.timeouts.idleMs);
    const body: NodeJS.ReadableStream & { pause(): unknown; resume(): unknown } = gzip ?? res;
    if (gzip) {
      stream.gzip = gzip;
      res.on("data", () => this.touch(stream));
      res.pipe(gzip);
      gzip.on("error", () => {
        if (this.streams.get(stream.id) === stream) this.finish(stream.id, "closed");
      });
    }
    body.on("data", (chunk: Buffer) => {
      this.touch(stream);
      if (!this.sender.write(stream.id, new Uint8Array(chunk))) body.pause();
    });
    body.on("end", () => {
      if (this.streams.get(stream.id) !== stream) return;
      this.sender.end(stream.id);
      stream.hostEnded = true;
      this.finishIfDone(stream);
    });
    res.on("error", () => {
      if (this.streams.get(stream.id) === stream) this.finish(stream.id, "closed");
    });
  }

  private upgraded(
    stream: Stream,
    res: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): void {
    if (this.streams.get(stream.id) !== stream) return void socket.destroy();
    stream.upgraded = socket;
    this.head(stream, 101, res.rawHeaders, false);
    if (head.byteLength) this.sender.write(stream.id, new Uint8Array(head));
    this.arm(stream, this.timeouts.idleMs);
    for (const bytes of stream.pending.splice(0)) this.writeUpgraded(stream, bytes);
    if (stream.phoneEnded) socket.end();
    socket.on("data", (chunk: Buffer) => {
      this.touch(stream);
      if (!this.sender.write(stream.id, new Uint8Array(chunk))) socket.pause();
    });
    socket.on("end", () => {
      if (this.streams.get(stream.id) !== stream) return;
      this.sender.end(stream.id);
      stream.hostEnded = true;
      this.finishIfDone(stream);
    });
    socket.on("error", () => {
      if (this.streams.get(stream.id) === stream) this.finish(stream.id, "closed");
    });
    socket.on("close", () => {
      if (this.streams.get(stream.id) === stream && !stream.hostEnded)
        this.finish(stream.id, "closed");
    });
  }

  private finishIfDone(stream: Stream): void {
    if (stream.phoneEnded && stream.hostEnded) this.finish(stream.id, null, true);
  }

  /** Ends a stream: with a reset to the phone, silently (the phone reset it), or cleanly. */
  private finish(id: number, reset: WebResetReason | null, clean = false): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    this.receiver.forget(id);
    this.cancel(stream);
    if (!clean) {
      stream.res?.destroy();
      stream.gzip?.destroy();
      stream.upgraded?.destroy();
      stream.req?.destroy();
      stream.socket?.destroy();
    }
    if (reset) this.sender.reset(id, reset);
    else if (!clean) this.sender.forget(id);
  }

  private arm(stream: Stream, ms: number): void {
    this.cancel(stream);
    stream.cancelTimer = this.timer(() => {
      stream.cancelTimer = undefined;
      if (this.streams.get(stream.id) === stream) this.finish(stream.id, "timeout");
    }, ms);
  }

  private touch(stream: Stream): void {
    if (stream.res || stream.upgraded) this.arm(stream, this.timeouts.idleMs);
  }

  private cancel(stream: Stream): void {
    stream.cancelTimer?.();
    stream.cancelTimer = undefined;
  }
}

function acceptEncoding(message: WebMessageOf<"web.open">): string | undefined {
  const found = message.headers.find(([name]) => name.toLowerCase() === "accept-encoding");
  return found ? headerText(found[1]) : undefined;
}

/** Cookies belong to the host name, not the port (RFC 6265). */
function cookieHost(target: LocalOrigin): string {
  const host = target.host;
  return host.kind === "ipv4" ? "127.0.0.1" : host.kind === "ipv6" ? "[::1]" : host.name;
}
