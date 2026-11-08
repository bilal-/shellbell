import {
  classifyWebLink,
  type LocalOrigin,
  sameLocalPage,
  type WebHeader,
  type WebMessageOf,
  type WebResetReason,
  type WebTarget,
} from "@shellbell/protocol";
import {
  ChunkedDecoder,
  concat,
  headEnd,
  header,
  latin1,
  latin1Bytes,
  MAX_HEAD_BYTES,
  parseRequestHead,
  type RequestHead,
  serializeHead,
  showable,
  utf8Bytes,
} from "./http";
import type { NativeWebDoor } from "./native-door";
import type { WebOpen, WebStreamHandler } from "./web-session";

/** The part of a `WebSession` the door uses; the page screen supplies the current one. */
export interface DoorSession {
  open(open: WebOpen, handler: WebStreamHandler): number | null;
  write(stream: number, bytes: Uint8Array): boolean;
  end(stream: number): void;
  reset(stream: number, reason?: WebResetReason): void;
  consumed(stream: number, bytes: number): void;
}

export interface DoorEvents {
  authority?(authority: string): void;
  /** A redirect left the page; `document` when it was a navigation. */
  leave(address: string, document: boolean): void;
  /** The page tried a load the CSP refused; `blocked` is the address when the report had one. */
  blocked(blocked: string): void;
  download(): void;
  /** A page navigation failed before any response, such as nothing answering. */
  failed(reason: WebResetReason, detail?: string): void;
}

export interface DoorOptions {
  native: Pick<
    NativeWebDoor,
    "listen" | "stop" | "read" | "write" | "shutdownOutput" | "close" | "addListener"
  >;
  target: WebTarget;
  /** The session for the next request, or null while the computer can't take one (503). */
  session(): DoorSession | null;
  events: DoorEvents;
  random(bytes: number): Uint8Array;
  now?: () => number;
}

const NONCE_MS = 10_000;
const HEAD_TIMEOUT_MS = 10_000;
const READ_CHUNK = 16 * 1024;
const MAX_REPORT = 4096;
const ENTER = "/__shellbell/enter?";
const LEAVE = "/__shellbell/leave?";
const CSP_PATH = "/__shellbell/csp/";

type Phase =
  | { kind: "head"; since: number }
  | { kind: "body"; remaining: number; chunked?: ChunkedDecoder }
  | { kind: "waiting" } // request sent; waiting for the response to finish
  | { kind: "upgraded" }
  | { kind: "closing" };

interface Socket {
  id: number;
  buffer: Uint8Array;
  phase: Phase;
  stream: number | null;
  /** The request is fully sent to the session. */
  requestDone: boolean;
  /** The response's framing towards the web view. */
  framing: "none" | "length" | "chunked" | "raw";
  responseDone: boolean;
  keepAlive: boolean;
  method: string;
  document: boolean;
  /** Body bytes per native write, in order, so credit returns when the web view takes them. */
  writes: Array<{ stream: number | null; body: number }>;
  /** Waiting for `drained` before reading more of the page's bytes. */
  paused: boolean;
  headTimer: ReturnType<typeof setTimeout> | null;
}

const b64url = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

/**
 * The phone's local web door. The page view loads `http://127.0.0.1:<port>`; every request it
 * makes becomes a `web.*` stream to the computer. Only the page view may use it: each request
 * must carry the door's key cookie, which the door sets itself through a one-time `/enter`
 * nonce, and the door's own `Host`. Keys, ports and nonces are new for every door.
 */
export class WebDoor {
  readonly port: number;
  readonly origin: string;
  private readonly generation: number;
  private readonly key: string;
  private readonly reportToken: string;
  private nonce: { value: string; expires: number } | null = null;
  private readonly sockets = new Map<number, Socket>();
  private readonly subscriptions: Array<{ remove(): void }>;
  private readonly scratch = new Uint8Array(READ_CHUNK);
  private readonly now: () => number;
  private stopped = false;
  /** The page's own address and the family that answered, from the computer's first answer. */
  private page: { origin: LocalOrigin; family: 4 | 6 } | null = null;

  constructor(private readonly options: DoorOptions) {
    this.now = options.now ?? Date.now;
    this.key = b64url(options.random(32));
    this.reportToken = b64url(options.random(16));
    const native = options.native;
    this.subscriptions = [
      native.addListener("accepted", (e) => this.current(e) && this.accepted(e.id)),
      native.addListener("readable", (e) => this.current(e) && this.readable(e.id)),
      native.addListener("written", (e) => this.current(e) && this.written(e.id)),
      native.addListener("closed", (e) => this.current(e) && this.drop(e.id, true)),
    ];
    const [port, generation] = native.listen();
    this.port = port;
    this.generation = generation;
    this.origin = `http://127.0.0.1:${port}`;
  }

  /** The address the page view loads first: it spends a nonce and lands on `path`. */
  enter(path: string): string {
    const value = b64url(this.options.random(32));
    this.nonce = { value, expires: this.now() + NONCE_MS };
    return `${this.origin}${ENTER}n=${value}&p=${encodeURIComponent(path)}`;
  }

  /** Whether an address is this door's own, so the page view may load it. */
  owns(url: string): boolean {
    return url === this.origin || url.startsWith(`${this.origin}/`);
  }

  /**
   * The door address for a link to this page, under the name it was opened with or another name
   * for the same server (3.4's alias rule), or null when the link is somewhere else. The page
   * view loads these in place instead of asking to open a second page.
   */
  inPage(url: string): string | null {
    const link = classifyWebLink(url);
    if (link.kind !== "local" || link.path.startsWith("/__shellbell/")) return null;
    const opened = "origin" in this.options.target ? this.options.target.origin : null;
    const target = opened === null ? null : classifyWebLink(opened);
    const same =
      (target?.kind === "local" && target.origin.origin === link.origin.origin) ||
      (this.page !== null && sameLocalPage(this.page.origin, this.page.family, link.origin));
    if (!same) return null;
    const hash = url.indexOf("#");
    return this.origin + link.path + (hash === -1 ? "" : url.slice(hash));
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const subscription of this.subscriptions) subscription.remove();
    for (const id of [...this.sockets.keys()]) this.drop(id, true);
    this.options.native.stop();
  }

  private current(e: { generation: number }): boolean {
    return !this.stopped && e.generation === this.generation;
  }

  private csp(): string {
    const self = `${this.origin} ws://127.0.0.1:${this.port}`;
    return (
      `default-src 'self' ${self} https: wss: data: blob: 'unsafe-inline' 'unsafe-eval'; ` +
      `worker-src 'self' blob:; form-action 'self'; report-uri ${CSP_PATH}${this.reportToken}`
    );
  }

  private accepted(id: number): void {
    const socket: Socket = {
      id,
      buffer: new Uint8Array(0),
      phase: { kind: "head", since: this.now() },
      stream: null,
      requestDone: false,
      framing: "none",
      responseDone: false,
      keepAlive: true,
      method: "GET",
      document: false,
      writes: [],
      paused: false,
      headTimer: null,
    };
    this.sockets.set(id, socket);
    this.armHead(socket);
  }

  private armHead(socket: Socket): void {
    if (socket.headTimer) clearTimeout(socket.headTimer);
    socket.headTimer = setTimeout(() => {
      socket.headTimer = null;
      if (socket.phase.kind === "head") this.drop(socket.id, true);
    }, HEAD_TIMEOUT_MS);
  }

  private readable(id: number): void {
    const socket = this.sockets.get(id);
    if (!socket) return;
    while (!socket.paused && this.sockets.get(id) === socket) {
      const n = this.options.native.read(id, this.scratch);
      if (n < 0) {
        this.pageEnded(socket);
        return;
      }
      if (n === 0) return;
      this.receive(socket, this.scratch.slice(0, n));
    }
  }

  private pageEnded(socket: Socket): void {
    // The web view closed its side. An unfinished request or open WebSocket ends with it.
    if (socket.stream !== null && socket.phase.kind === "upgraded")
      this.options.session()?.end(socket.stream);
    if (!socket.requestDone || socket.phase.kind === "head") this.drop(socket.id, true);
  }

  private receive(socket: Socket, bytes: Uint8Array): void {
    const phase = socket.phase;
    if (phase.kind === "upgraded") {
      this.forward(socket, bytes);
      return;
    }
    if (phase.kind === "body") {
      this.body(socket, bytes);
      return;
    }
    // Waiting for a response, or between requests: keep bytes for the next head.
    socket.buffer = concat(socket.buffer, bytes);
    if (phase.kind === "head") this.nextRequest(socket);
  }

  private nextRequest(socket: Socket): void {
    const end = headEnd(socket.buffer);
    if (end < 0) {
      if (socket.buffer.length > MAX_HEAD_BYTES) this.reply(socket, 431, "Request too large", true);
      return;
    }
    if (end > MAX_HEAD_BYTES) {
      this.reply(socket, 431, "Request too large", true);
      return;
    }
    const head = parseRequestHead(latin1(socket.buffer.subarray(0, end - 4)));
    const rest = socket.buffer.subarray(end);
    socket.buffer = new Uint8Array(0);
    if (socket.headTimer) clearTimeout(socket.headTimer);
    socket.headTimer = null;
    if (!head) {
      this.reply(socket, 400, "Bad request", true);
      return;
    }
    this.request(socket, head, rest);
  }

  private request(socket: Socket, head: RequestHead, rest: Uint8Array): void {
    const path = head.target;
    const cookie = header(head.headers, "cookie") ?? "";
    const keyed = cookie.split(/;\s*/).includes(`__sb_${this.port}=${this.key}`);
    const host = header(head.headers, "host");
    const lengthText = header(head.headers, "content-length");
    const chunked = (header(head.headers, "transfer-encoding") ?? "")
      .toLowerCase()
      .includes("chunked");
    if (lengthText !== undefined && chunked) {
      this.reply(socket, 400, "Bad request", true);
      return;
    }
    const length = lengthText === undefined ? 0 : Number(lengthText);
    if (!Number.isSafeInteger(length) || length < 0) {
      this.reply(socket, 400, "Bad request", true);
      return;
    }
    socket.method = head.method;
    socket.keepAlive =
      head.version === "HTTP/1.1" &&
      (header(head.headers, "connection") ?? "").toLowerCase() !== "close";
    socket.document =
      header(head.headers, "sec-fetch-dest") === "document" ||
      (header(head.headers, "sec-fetch-dest") === undefined &&
        (header(head.headers, "accept") ?? "").startsWith("text/html"));

    if (path.startsWith(ENTER)) {
      const query = new URLSearchParams(path.slice(ENTER.length));
      const nonce = this.nonce;
      this.nonce = null; // spent whether or not it matched
      if (!nonce || query.get("n") !== nonce.value || this.now() > nonce.expires) {
        this.reply(socket, 403, "This page link has expired.", false, rest);
        return;
      }
      const to = query.get("p") ?? "/";
      this.reply(socket, 302, "", false, rest, [
        ["Set-Cookie", `__sb_${this.port}=${this.key}; HttpOnly; SameSite=Strict; Path=/`],
        ["Referrer-Policy", "no-referrer"],
        ["Clear-Site-Data", '"cache", "storage"'],
        ["Location", to.startsWith("/") && !to.startsWith("//") ? to : "/"],
      ]);
      return;
    }
    if (path.startsWith(`${CSP_PATH}${this.reportToken}`)) {
      // Accepted without the key: the browser may not send cookies with reports.
      socket.phase = { kind: "body", remaining: Math.min(length, MAX_REPORT) };
      const report = rest.subarray(0, Math.min(length, MAX_REPORT));
      try {
        const parsed = JSON.parse(new TextDecoder().decode(report)) as {
          "csp-report"?: { "blocked-uri"?: string };
        };
        const blocked = parsed["csp-report"]?.["blocked-uri"];
        if (typeof blocked === "string") this.options.events.blocked(blocked);
      } catch {
        // A partial or odd report is only shown, never acted on; skip it.
      }
      this.reply(socket, 204, "", true);
      return;
    }
    if (!keyed || host !== `127.0.0.1:${this.port}`) {
      this.reply(socket, 403, "Forbidden", true);
      return;
    }
    if (path.startsWith(LEAVE)) {
      const to = new URLSearchParams(path.slice(LEAVE.length)).get("to");
      if (to) this.options.events.leave(to, socket.document);
      this.reply(socket, 204, "", false, rest);
      return;
    }
    if (header(head.headers, "service-worker") === "script") {
      this.reply(socket, 403, "No service workers", false, rest, [["Vary", "Service-Worker"]]);
      return;
    }
    if (!path.startsWith("/")) {
      this.reply(socket, 400, "Bad request", true);
      return;
    }

    const session = this.options.session();
    if (!session) {
      this.reply(socket, 503, "Reconnecting to your computer", false, rest);
      return;
    }
    const upgrade =
      (header(head.headers, "connection") ?? "").toLowerCase().includes("upgrade") &&
      (header(head.headers, "upgrade") ?? "").toLowerCase() === "websocket";
    const hasBody = chunked || length > 0;
    const headers: WebHeader[] = head.headers.map(([name, value]) => [name, latin1Bytes(value)]);
    const open: WebOpen = {
      target: this.options.target,
      method: head.method,
      path,
      headers,
      body: hasBody && !upgrade,
      upgrade,
    };
    socket.framing = "none";
    socket.responseDone = false;
    socket.requestDone = !hasBody && !upgrade;
    const stream = session.open(open, this.handler(socket));
    if (stream === null) {
      this.reply(socket, 503, "Too many requests at once", false, rest);
      return;
    }
    socket.stream = stream;
    if (upgrade) {
      socket.phase = { kind: "upgraded" };
      if (rest.length) this.forward(socket, rest);
      return;
    }
    if (!hasBody) {
      socket.phase = { kind: "waiting" };
      socket.buffer = rest;
      return;
    }
    socket.phase = chunked
      ? { kind: "body", remaining: Number.POSITIVE_INFINITY, chunked: new ChunkedDecoder() }
      : { kind: "body", remaining: length };
    if (rest.length) this.body(socket, rest);
  }

  private body(socket: Socket, bytes: Uint8Array): void {
    const phase = socket.phase;
    if (phase.kind !== "body" || socket.stream === null) {
      // A CSP report body or an unkeyed request's body: discard it.
      if (phase.kind === "body") {
        phase.remaining -= bytes.length;
        if (phase.remaining <= 0) socket.phase = { kind: "waiting" };
      }
      return;
    }
    const session = this.options.session();
    let data = bytes;
    let rest: Uint8Array = new Uint8Array(0);
    let complete = false;
    if (phase.chunked) {
      const decoded = phase.chunked.push(bytes);
      if (decoded.error) {
        this.drop(socket.id, true);
        return;
      }
      data = decoded.bytes;
      if (phase.chunked.done) {
        complete = true;
        rest = phase.chunked.rest;
      }
    } else {
      data = bytes.subarray(0, phase.remaining);
      rest = bytes.subarray(data.length);
      phase.remaining -= data.length;
      complete = phase.remaining === 0;
    }
    if (data.length && session && !session.write(socket.stream, data)) socket.paused = true;
    if (complete) {
      session?.end(socket.stream);
      socket.requestDone = true;
      socket.phase = { kind: "waiting" };
      socket.buffer = rest;
    }
  }

  private forward(socket: Socket, bytes: Uint8Array): void {
    if (socket.stream === null) return;
    if (!this.options.session()?.write(socket.stream, bytes)) socket.paused = true;
  }

  private handler(socket: Socket): WebStreamHandler {
    return {
      head: (message) => this.head(socket, message),
      data: (bytes) => this.data(socket, bytes),
      end: () => this.end(socket),
      reset: (reason, detail) => this.failed(socket, reason, detail),
      drained: () => {
        if (!socket.paused) return;
        socket.paused = false;
        this.readable(socket.id);
      },
    };
  }

  private head(socket: Socket, message: WebMessageOf<"web.head">): void {
    if (message.authority) {
      const link = classifyWebLink(`http://${message.authority.authority}/`);
      if (link.kind === "local") {
        this.page = { origin: link.origin, family: message.authority.family };
        this.options.events.authority?.(link.origin.authority);
      }
    }
    if (!this.sockets.has(socket.id)) return;
    const headers = message.headers.map(([n, v]) => [n, latin1(v)] as [string, string]);
    const status = message.status;
    const type = header(headers, "content-type");
    const disposition = (header(headers, "content-disposition") ?? "").toLowerCase();
    if (
      status !== 101 &&
      (disposition.startsWith("attachment") || (socket.document && status < 300 && !showable(type)))
    ) {
      // The web view would hand this to the system download manager, through the door.
      if (socket.stream !== null) this.options.session()?.reset(socket.stream);
      socket.stream = null;
      this.options.events.download();
      this.reply(socket, 204, "", true);
      return;
    }
    const out = headers.filter(([n]) => {
      const lower = n.toLowerCase();
      return lower !== "content-length" && lower !== "transfer-encoding" && lower !== "connection";
    });
    const bytes = message.bytes ?? new Uint8Array(0);
    const noBody = socket.method === "HEAD" || status === 204 || status === 304;
    if (status === 101) {
      socket.framing = "raw";
      out.push(["Connection", "Upgrade"], ["Upgrade", "websocket"]);
    } else if (noBody) {
      socket.framing = "none";
      const length = header(headers, "content-length");
      if (length !== undefined && socket.method === "HEAD") out.push(["Content-Length", length]);
    } else if (message.end) {
      socket.framing = "length";
      out.push(["Content-Length", String(bytes.length)]);
    } else if (header(headers, "content-length") !== undefined) {
      socket.framing = "length";
      out.push(["Content-Length", header(headers, "content-length") as string]);
    } else {
      socket.framing = "chunked";
      out.push(["Transfer-Encoding", "chunked"]);
    }
    if (status !== 101) {
      // An upgrade the target declined ends as an ordinary response.
      if (socket.phase.kind === "upgraded") {
        socket.phase = { kind: "waiting" };
        socket.requestDone = true;
        socket.keepAlive = false;
      }
      out.push(["Connection", socket.keepAlive ? "keep-alive" : "close"]);
    }
    out.push(["Content-Security-Policy", this.csp()], ["Vary", "Service-Worker"]);
    this.write(socket, serializeHead(status, out), 0);
    if (bytes.length) this.data(socket, bytes);
    if (message.end) this.end(socket);
  }

  private data(socket: Socket, bytes: Uint8Array): void {
    if (!this.sockets.has(socket.id) || socket.framing === "none") {
      if (socket.stream !== null) this.options.session()?.consumed(socket.stream, bytes.length);
      return;
    }
    if (socket.framing === "chunked")
      this.write(
        socket,
        concat(concat(latin1Bytes(`${bytes.length.toString(16)}\r\n`), bytes), latin1Bytes("\r\n")),
        bytes.length,
      );
    else this.write(socket, bytes, bytes.length);
  }

  private end(socket: Socket): void {
    if (!this.sockets.has(socket.id)) return;
    if (socket.framing === "chunked") this.write(socket, latin1Bytes("0\r\n\r\n"), 0);
    socket.responseDone = true;
    if (socket.framing === "raw") {
      // The target closed its side of the WebSocket.
      this.options.native.shutdownOutput(socket.id);
      return;
    }
    this.responseFinished(socket);
  }

  private responseFinished(socket: Socket): void {
    socket.stream = null;
    if (!socket.keepAlive || !socket.requestDone) {
      this.close(socket);
      return;
    }
    socket.phase = { kind: "head", since: this.now() };
    this.armHead(socket);
    if (socket.buffer.length) this.nextRequest(socket);
  }

  private failed(socket: Socket, reason: WebResetReason, detail?: string): void {
    if (!this.sockets.has(socket.id) || socket.stream === null) return;
    socket.stream = null;
    if (socket.framing !== "none" || socket.phase.kind === "upgraded") {
      // A response was already under way: all the door can do is cut it.
      this.drop(socket.id, true);
      return;
    }
    if (socket.document) this.options.events.failed(reason, detail);
    const status = reason === "timeout" ? 504 : reason === "not-found" ? 404 : 502;
    this.reply(socket, status, detail ?? "Your computer couldn't load this.", true);
  }

  /** Answers from the door itself, never from the computer. */
  private reply(
    socket: Socket,
    status: number,
    text: string,
    close: boolean,
    rest: Uint8Array = new Uint8Array(0),
    extra: Array<[string, string]> = [],
  ): void {
    const body = utf8Bytes(text);
    const keep = !close && socket.keepAlive;
    const headers: Array<[string, string]> = [
      ...extra,
      ["Content-Type", "text/plain; charset=utf-8"],
      ["Content-Length", String(body.length)],
      ["Cache-Control", "no-store"],
      ["Connection", keep ? "keep-alive" : "close"],
    ];
    this.write(socket, concat(serializeHead(status, headers), body), 0);
    socket.stream = null;
    socket.framing = "none";
    if (!keep) {
      this.close(socket);
      return;
    }
    socket.requestDone = true;
    socket.phase = { kind: "head", since: this.now() };
    socket.buffer = rest;
    this.armHead(socket);
    if (rest.length) this.nextRequest(socket);
  }

  private write(socket: Socket, bytes: Uint8Array, body: number): void {
    if (this.options.native.write(socket.id, bytes)) {
      socket.writes.push({ stream: socket.stream, body });
      return;
    }
    if (socket.stream !== null && body) this.options.session()?.consumed(socket.stream, body);
  }

  private written(id: number): void {
    const entry = this.sockets.get(id)?.writes.shift();
    if (entry?.body && entry.stream !== null)
      this.options.session()?.consumed(entry.stream, entry.body);
  }

  private close(socket: Socket): void {
    socket.phase = { kind: "closing" };
    if (socket.headTimer) clearTimeout(socket.headTimer);
    socket.headTimer = null;
    this.options.native.close(socket.id);
    this.sockets.delete(socket.id);
  }

  private drop(id: number, abort: boolean): void {
    const socket = this.sockets.get(id);
    if (!socket) return;
    this.sockets.delete(id);
    if (socket.headTimer) clearTimeout(socket.headTimer);
    if (abort && socket.stream !== null) this.options.session()?.reset(socket.stream);
    socket.stream = null;
    this.options.native.close(id);
  }
}
