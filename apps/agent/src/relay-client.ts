import { EventEmitter } from "node:events";
import {
  authMessage,
  type CtrlMessage,
  type CtrlMessageOf,
  decodeRoutableEnvelope,
  encodeEnvelope,
  encodeV2RelayEnvelope,
  FRAME_LIMITS,
  type Identity,
  ProtocolError,
  parseCtrl,
  type RoutableEnvelope,
  relayWsUrl,
  STREAM_LIMITS,
  sign,
} from "@shellbell/protocol";
import WebSocket from "ws";
import { type Logger, safeErrorName } from "./log.js";

export interface RelayClientOptions {
  relayUrl: string;
  fp: string;
  identity: Identity;
  name: string;
  appVersion: string;
  log: Logger;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  pingIntervalMs?: number;
  pongTimeoutMs?: number;
}

export interface RelayClientEvents {
  "auth-ok": [CtrlMessageOf<"auth-ok">];
  "auth-fail": [CtrlMessageOf<"auth-fail">["reason"]];
  ctrl: [CtrlMessage];
  /** Original received CBOR byte length, before envelope parsing strips unknown fields. */
  e2e: [RoutableEnvelope, envelopeBytes: number];
  down: [];
  superseded: [];
}

/** auth-fail reasons that mean "this identity/config will never work"; everything else is transient. */
const PERMANENT_AUTH_FAIL_REASONS = new Set<CtrlMessageOf<"auth-fail">["reason"]>([
  "bad-sig",
  "fp-mismatch",
]);
const MAX_BULK_SOCKET_BUFFER_BYTES = STREAM_LIMITS.unacked * STREAM_LIMITS.envelopeBytes;

function isAuthEnvelope(env: RoutableEnvelope): boolean {
  if (env.t !== "ctrl") return false;
  const body = env.body as { type?: unknown } | null;
  return typeof body === "object" && body !== null && body.type === "auth";
}

function envelopeKind(env: RoutableEnvelope): string {
  if (env.t !== "ctrl") return env.t;
  const body = env.body as { type?: unknown } | null;
  return typeof body === "object" && body !== null && typeof body.type === "string"
    ? body.type
    : "ctrl";
}

/** Exponential backoff with +/-20% jitter, applied before the cap so the result never exceeds maxMs. */
export function computeBackoff(attempt: number, minMs: number, maxMs: number): number {
  const raw = minMs * 2 ** attempt;
  const jitter = raw * 0.2 * (Math.random() * 2 - 1);
  return Math.min(maxMs, Math.max(0, raw + jitter));
}

export class RelayClient extends EventEmitter<RelayClientEvents> {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private pongTimer: NodeJS.Timeout | null = null;
  private authed = false;
  private readonly log: Logger;

  constructor(private readonly opts: RelayClientOptions) {
    super();
    this.log = opts.log.child({ unit: "relay" });
  }

  get online(): boolean {
    return this.authed && this.ws?.readyState === WebSocket.OPEN;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimers();
    const sock = this.ws;
    const wasOnline = this.online;
    this.ws = null;
    this.authed = false;
    // Leave this socket's own listeners in place (rather than removeAllListeners): they already
    // bail on `this.ws !== sock`, and removing the "error" listener here would turn a terminate()
    // on a still-connecting socket into an unhandled "error" event.
    sock?.terminate();
    if (wasOnline) this.emit("down");
  }

  sendCtrl(body: CtrlMessage): boolean {
    return this.sendEnvelope({ v: 1, t: "ctrl", from: this.opts.fp, seq: 0, body });
  }

  sendEnvelope(env: RoutableEnvelope): boolean {
    if (!this.authed && !isAuthEnvelope(env)) {
      this.log.debug("dropped send: not authenticated", { type: envelopeKind(env) });
      return false;
    }
    if (this.ws?.readyState !== WebSocket.OPEN) {
      this.log.debug("dropped send: socket not open", { type: envelopeKind(env) });
      return false;
    }
    this.ws.send(env.v === 2 ? encodeV2RelayEnvelope(env) : encodeEnvelope(env), { binary: true });
    return true;
  }

  sendBoundedEnvelope(env: RoutableEnvelope): boolean {
    return this.sendLimitedEnvelope(
      env,
      STREAM_LIMITS.envelopeBytes,
      (buffered, bytes) => buffered <= MAX_BULK_SOCKET_BUFFER_BYTES - bytes,
    );
  }

  sendScheduledBulkEnvelope(env: RoutableEnvelope, mode: "legacy" | "bounded"): boolean {
    if (env.t !== "e2e" || (mode !== "legacy" && mode !== "bounded")) return false;
    const limit = mode === "legacy" ? FRAME_LIMITS.e2eFromAgent : STREAM_LIMITS.envelopeBytes;
    return this.sendLimitedEnvelope(env, limit, (buffered) => buffered === 0);
  }

  private sendLimitedEnvelope(
    env: RoutableEnvelope,
    maxBytes: number,
    bufferFits: (buffered: number, envelopeBytes: number) => boolean,
  ): boolean {
    const socket = this.ws;
    if (!this.authed || socket?.readyState !== WebSocket.OPEN) return false;
    const bytes = env.v === 2 ? encodeV2RelayEnvelope(env) : encodeEnvelope(env);
    if (bytes.byteLength > maxBytes) return false;
    const buffered = socket.bufferedAmount;
    if (
      typeof buffered !== "number" ||
      !Number.isFinite(buffered) ||
      buffered < 0 ||
      !bufferFits(buffered, bytes.byteLength)
    )
      return false;
    socket.send(bytes, { binary: true });
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = relayWsUrl(this.opts.relayUrl, this.opts.fp);
    this.log.info("connecting", { attempt: this.attempt });
    const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
    const sock = ws;
    this.ws = ws;

    ws.on("open", () => {
      if (this.ws !== sock) return;
      this.log.debug("socket open");
    });

    ws.on("message", (data, isBinary) => {
      if (this.ws !== sock) return;
      if (!isBinary) return;
      const bytes = new Uint8Array(data as Buffer);
      let env: RoutableEnvelope;
      try {
        env = decodeRoutableEnvelope(bytes);
      } catch (err) {
        this.log.warn("malformed frame from relay", {
          code: err instanceof ProtocolError ? err.code : safeErrorName(err),
        });
        return;
      }
      if (env.t === "e2e") {
        if (this.authed) this.emit("e2e", env, bytes.byteLength);
        return;
      }
      let msg: CtrlMessage;
      try {
        msg = parseCtrl(env.body);
      } catch (err) {
        this.log.warn("malformed ctrl from relay", {
          code: err instanceof ProtocolError ? err.code : safeErrorName(err),
        });
        return;
      }
      this.onCtrl(msg);
    });

    ws.on("pong", () => {
      if (this.ws !== sock) return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      this.pongTimer = null;
    });

    ws.on("close", (code: number) => {
      if (this.ws !== sock) return;
      this.onClose(code);
    });

    ws.on("error", (err) => {
      if (this.ws !== sock) return;
      this.log.warn("socket error", { name: safeErrorName(err) });
    });
  }

  private onCtrl(msg: CtrlMessage): void {
    if (msg.type === "challenge") {
      const sig = sign(
        this.opts.identity.ed25519.priv,
        authMessage(msg.connId, "agent", this.opts.fp, msg.nonce),
      );
      this.sendCtrl({
        type: "auth",
        role: "agent",
        fp: this.opts.fp,
        ed25519Pub: this.opts.identity.ed25519.pub,
        sig,
        name: this.opts.name,
        appVersion: this.opts.appVersion,
      });
      return;
    }
    if (msg.type === "auth-ok") {
      this.authed = true;
      this.attempt = 0;
      this.startPing();
      this.log.info("authenticated", { minFrameMs: msg.minFrameMs });
      this.emit("auth-ok", msg);
      return;
    }
    if (msg.type === "auth-fail") {
      this.log.error("auth failed", { reason: msg.reason });
      if (PERMANENT_AUTH_FAIL_REASONS.has(msg.reason)) this.stopped = true;
      this.emit("auth-fail", msg.reason);
      return;
    }
    this.emit("ctrl", msg);
  }

  private onClose(code: number): void {
    // Note: by the time "close" fires, ws.readyState is already CLOSED, so the `online` getter
    // would always read false here — capture `authed` directly instead.
    const wasAuthed = this.authed;
    this.authed = false;
    this.clearTimers();
    this.ws = null;

    if (code === 4005) {
      this.log.warn("connection superseded by a newer agent", { code });
      this.stopped = true;
      this.emit("superseded");
      this.emit("down");
      return;
    }

    if (code === 4413 || code === 4429) {
      this.log.error("relay closed connection", { code });
    } else {
      this.log.info("socket closed", { code });
    }

    if (wasAuthed) this.emit("down");
    if (this.stopped) return;
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    const min = this.opts.backoffMinMs ?? 1000;
    const max = this.opts.backoffMaxMs ?? 30_000;
    const delay = computeBackoff(this.attempt, min, max);
    this.attempt = Math.min(this.attempt + 1, 10);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private startPing(): void {
    // Repeated auth replies must not orphan an interval or reset an active heartbeat.
    if (this.pingTimer) return;
    const interval = this.opts.pingIntervalMs ?? 45_000;
    const timeout = this.opts.pongTimeoutMs ?? 10_000;
    const sock = this.ws;
    this.pingTimer = setInterval(() => {
      if (this.ws !== sock || sock?.readyState !== WebSocket.OPEN) return;
      if (this.pongTimer) clearTimeout(this.pongTimer);
      sock.ping();
      this.pongTimer = setTimeout(() => {
        this.log.warn("pong timeout; terminating socket");
        sock.terminate();
      }, timeout);
    }, interval);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.reconnectTimer = this.pingTimer = this.pongTimer = null;
  }
}
