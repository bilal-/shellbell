import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import WebSocket from "ws";
import { type Logger, safeErrorName } from "../../log.js";
import { requestCookieAndKey } from "./auth.js";
import {
  type ClientOriginatedMessage,
  ClientOriginatedMessageSchema,
  type Notification,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
} from "./gen/iterm2_pb.js";

export type ClientSub = Exclude<ClientOriginatedMessage["submessage"], { case: undefined }>;

export interface ITerm2ClientOptions {
  log: Logger;
  socketPath?: string;
  /** Test-only override: dial this plain TCP ws:// URL instead of the Unix socket. */
  url?: string;
  appName?: string;
  cookieProvider?: () => Promise<{ cookie: string; key: string }>;
  requestTimeoutMs?: number;
}

export const DEFAULT_SOCKET = join(
  homedir(),
  "Library",
  "Application Support",
  "iTerm2",
  "private",
  "socket",
);

export class ITerm2Client extends EventEmitter<{ notification: [Notification]; close: [] }> {
  private ws: WebSocket | null = null;
  private nextId = 1n;
  private readonly pending = new Map<
    bigint,
    {
      resolve: (m: ServerOriginatedMessage) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private readonly log: Logger;

  constructor(private readonly opts: ITerm2ClientOptions) {
    super();
    this.log = opts.log.child({ unit: "iterm2" });
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  async connect(): Promise<void> {
    const appName = this.opts.appName ?? "Shellbell";
    const { cookie, key } = await (
      this.opts.cookieProvider ?? (() => requestCookieAndKey(appName))
    )();
    const headers = {
      origin: "ws://localhost/",
      "x-iterm2-library-version": "shellbell 0.1.0",
      "x-iterm2-disable-auth-ui": "true",
      "x-iterm2-advisory-name": appName,
      "x-iterm2-cookie": cookie,
      "x-iterm2-key": key,
    };
    const socketPath = this.opts.socketPath ?? DEFAULT_SOCKET;
    // ws 8.21.3 discards the `socketPath` option and mangles `ws+unix://` paths that contain a
    // space, so the Unix socket is dialled through the `createConnection` hook. See
    //  `url` is only used by tests.
    const ws = this.opts.url
      ? new WebSocket(this.opts.url, ["api.iterm2.com"], { headers })
      : new WebSocket("ws://localhost/", ["api.iterm2.com"], {
          headers,
          createConnection: () => netConnect({ path: socketPath }),
        });
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.off("unexpected-response", onUnexpectedResponse);
        ws.off("close", onClose);
      };
      // Settles the connect promise on any failure path (socket error, a non-101 HTTP
      // response, or the socket closing before the handshake completed — including a
      // `close()` call made while this connect() is still in flight). Frees the failed
      // socket so a later connect() attempt starts clean, and swallows any further
      // internal `error` emissions that `terminate()`/`abortHandshake` may schedule for
      // the next tick — without a listener, those would otherwise crash the process.
      const fail = (err: Error) => {
        cleanup();
        ws.on("error", () => {});
        ws.terminate();
        if (this.ws === ws) this.ws = null;
        reject(err);
      };
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (e: Error) => fail(e);
      const onUnexpectedResponse = (req: ClientRequest, res: IncomingMessage) => {
        res.destroy();
        req.destroy();
        fail(new Error(`iTerm2 API responded HTTP ${res.statusCode}`));
      };
      const onClose = () => fail(new Error("iTerm2 connection closed before open"));
      ws.once("open", onOpen);
      ws.once("error", onError);
      ws.once("unexpected-response", onUnexpectedResponse);
      ws.once("close", onClose);
    });
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      let msg: ServerOriginatedMessage;
      try {
        msg = fromBinary(ServerOriginatedMessageSchema, new Uint8Array(data as Buffer));
      } catch (err) {
        this.log.warn("undecodable message from iTerm2", { err: safeErrorName(err) });
        return;
      }
      if (msg.submessage.case === "notification") {
        this.emit("notification", msg.submessage.value);
        return;
      }
      // proto2 `optional int64 id` is typed `bigint`, defaulting to `0n` rather than
      // `undefined`, when absent. `nextId` starts at `1n`, so `0n` (and any other id with
      // no matching entry) simply misses the lookup below and is dropped.
      const p = this.pending.get(msg.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(msg.id);
      p.resolve(msg);
    });
    ws.on("close", () => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error("iTerm2 connection closed"));
        this.pending.delete(id);
      }
      this.ws = null;
      this.emit("close");
    });
    ws.on("error", (err) => this.log.warn("iTerm2 socket error", { err: safeErrorName(err) }));
    this.log.info("connected to iTerm2 API");
  }

  close(): void {
    this.ws?.close();
    this.ws = null;
  }

  request(sub: ClientSub): Promise<ServerOriginatedMessage> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN)
      return Promise.reject(new Error("iTerm2 not connected"));
    const id = this.nextId++;
    const msg = create(ClientOriginatedMessageSchema, { id, submessage: sub });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`iTerm2 request timeout (${sub.case})`));
      }, this.opts.requestTimeoutMs ?? 5000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(toBinary(ClientOriginatedMessageSchema, msg), { binary: true });
    });
  }
}
