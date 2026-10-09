import { createConnection, type Socket } from "node:net";
import type { Agent } from "./agent.js";
import { ControlEndpoint } from "./control-endpoint.js";
import {
  CONTROL_LIMITS,
  ControlLineDecoder,
  encodeControlLine,
  writeControlLine,
} from "./control-framing.js";
import { ControlV2Hub, type ControlV2Peer } from "./control-v2-server.js";
import type { LocalStatus } from "./local-status.js";
import type { Logger } from "./log.js";

export type { ControlFrameError } from "./control-framing.js";
export {
  CONTROL_LIMITS,
  ControlLineDecoder,
  encodeControlLine,
  writeControlLine,
} from "./control-framing.js";
export type { ControlV2Client } from "./control-v2-client.js";
export { ControlV2ClientError, connectControlV2 } from "./control-v2-client.js";
export type {
  ControlPairingOpen,
  ControlRuntime,
  ControlV2ErrorCode,
  ControlV2Event,
  ControlV2Request,
  ControlV2Response,
} from "./control-v2-protocol.js";
export {
  ControlPairingOpenSchema,
  ControlRuntimeSchema,
  ControlV2DataSchemas,
  ControlV2ErrorCodeSchema,
  ControlV2EventSchema,
  ControlV2RequestSchema,
  ControlV2ResponseSchema,
} from "./control-v2-protocol.js";

type Req = { cmd: string; args?: Record<string, unknown> };

export type StatusData = LocalStatus;

export class ControlServer {
  private readonly endpoint: ControlEndpoint;
  private pending = new Map<string, (accept: boolean) => void>();
  private pairClients = new Set<Socket>();
  private controlSockets = new Set<Socket>();
  private readonly v2: ControlV2Hub;
  /** The agent's confirm hook: resolves when a `confirm` command arrives (or after 60 s → false). */
  readonly pairingConfirm = (phoneFp: string, name: string): Promise<boolean> =>
    new Promise((resolve) => {
      if (this.pending.has(phoneFp)) {
        // Should not happen: PairingManager itself refuses a second concurrent request
        // (`pendingFp !== null` -> "too-many"). Guard anyway rather than clobber the first
        // caller's resolver.
        this.log.warn(
          "pairing confirm requested twice for the same phone; declining the newer one",
          {
            phone: phoneFp.slice(0, 8),
          },
        );
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(phoneFp);
        resolve(false);
      }, 60_000);
      this.pending.set(phoneFp, (accept) => {
        clearTimeout(timer);
        this.pending.delete(phoneFp);
        resolve(accept);
      });
      for (const c of this.pairClients)
        if (!this.writeLegacy(c, { event: "request", phoneFp, name })) this.pairClients.delete(c);
    });

  constructor(
    sockPath: string,
    private readonly agent: Agent,
    private readonly log: Logger,
    /** Optional PID publication for both foreground and temporary pairing owners. */
    pidPath?: string,
    admit?: () => void,
    private readonly admission?: (start: () => Promise<void>) => Promise<void>,
    private readonly pairingMode: "terminal" | "native" = "terminal",
  ) {
    this.endpoint = new ControlEndpoint(
      sockPath,
      (socket) => this.handle(socket),
      log,
      pidPath,
      admit,
    );
    this.v2 = new ControlV2Hub(agent, log);
  }

  get hasPairClients(): boolean {
    return this.pairClients.size > 0;
  }

  get hasNativePairOwner(): boolean {
    return this.v2.hasPairOwner;
  }

  readonly nativePairingConfirm = (phoneFp: string, name: string): Promise<boolean> =>
    this.v2.confirm(phoneFp, name);

  /** Broadcasts `{event:"closed"}` to every client currently watching a pairing window, then
   * stops tracking them -- a fresh `pair-open` re-subscribes. Call whenever the window closes
   * (expiry, explicit close, a completed pairing, too many bad codes). */
  notifyClosed(): void {
    for (const confirm of this.pending.values()) confirm(false);
    this.pending.clear();
    for (const c of this.pairClients)
      if (!this.writeLegacy(c, { event: "closed" })) this.pairClients.delete(c);
    this.pairClients.clear();
    this.v2.notifyClosed();
  }

  async start(): Promise<void> {
    if (this.admission) await this.admission(() => this.endpoint.start());
    else await this.endpoint.start();
  }

  async stop(): Promise<void> {
    for (const confirm of this.pending.values()) confirm(false);
    for (const c of this.controlSockets) c.destroy();
    this.controlSockets.clear();
    for (const c of this.pairClients) c.destroy();
    this.pairClients.clear();
    this.v2.stop();
    await this.endpoint.stop();
  }

  private handle(socket: Socket): void {
    if (this.controlSockets.size >= CONTROL_LIMITS.connections) {
      socket.destroy();
      return;
    }
    this.controlSockets.add(socket);
    let firstRequest = true;
    let mode: "legacy" | "v2" | undefined;
    let v2Peer: ControlV2Peer | undefined;
    const initialTimer = setTimeout(() => socket.destroy(), CONTROL_LIMITS.initialRequestMs);
    const decoder = new ControlLineDecoder({
      onLine: (line) => {
        if (socket.destroyed) return;
        let value: unknown;
        try {
          value = JSON.parse(line) as unknown;
        } catch {
          if (mode === "v2") {
            socket.destroy();
            return;
          }
          this.writeLegacy(socket, { ok: false, error: "bad json" });
          return;
        }
        if (mode === "v2") {
          v2Peer?.handle(value);
          if (firstRequest && v2Peer?.handshaken) {
            firstRequest = false;
            clearTimeout(initialTimer);
          }
          return;
        }
        if (mode === undefined && value && typeof value === "object" && Object.hasOwn(value, "v")) {
          mode = "v2";
          v2Peer = this.v2.accept(socket);
          v2Peer.handle(value);
          if (v2Peer.handshaken) {
            firstRequest = false;
            clearTimeout(initialTimer);
          }
          return;
        }
        if (mode === "legacy" && value && typeof value === "object" && Object.hasOwn(value, "v")) {
          socket.destroy();
          return;
        }
        mode = "legacy";
        const req = value as Req;
        if (!req || typeof req !== "object" || typeof req.cmd !== "string") {
          this.writeLegacy(socket, { ok: false, error: "bad request" });
          return;
        }
        if (firstRequest) {
          firstRequest = false;
          clearTimeout(initialTimer);
        }
        try {
          const data = this.dispatch(req, socket);
          this.writeLegacy(socket, { ok: true, data });
        } catch (err) {
          this.writeLegacy(socket, { ok: false, error: (err as Error).message });
        }
      },
      onError: () => socket.destroy(),
    });
    socket.on("data", (chunk: Buffer) => decoder.push(new Uint8Array(chunk)));
    socket.once("end", () => decoder.finish());
    socket.once("close", () => {
      clearTimeout(initialTimer);
      this.controlSockets.delete(socket);
      this.pairClients.delete(socket);
      v2Peer?.close();
    });
    socket.on("error", () => this.log.debug("control socket error"));
  }

  private writeLegacy(socket: Socket, value: unknown): boolean {
    const frame = encodeControlLine(value);
    if (frame && writeControlLine(socket, frame)) return true;
    const fallback = encodeControlLine({ ok: false, error: "response too large" });
    return fallback !== null && writeControlLine(socket, fallback);
  }

  private dispatch(req: Req, socket: Socket): unknown {
    const a = this.agent;
    if (this.pairingMode === "native" && ["pair-open", "pair-close", "confirm"].includes(req.cmd)) {
      throw new Error("pairing is managed by the Shellbell app");
    }
    if (this.v2.hasPairOwner && ["pair-open", "pair-close", "confirm"].includes(req.cmd)) {
      throw new Error("native pairing active");
    }
    switch (req.cmd) {
      case "status":
        return {
          ...a.localStatus,
          relayOnline: a.relayOnline,
          sessions: a.sessionList.length,
          phones: a.pairingList.map((p) => ({
            phoneFp: p.phoneFp,
            name: p.name,
            lastSeenAt: p.lastSeenAt,
          })),
          connected: a.connectedPhones,
        } satisfies StatusData;
      case "devices":
        return a.pairingList.map((p) => ({
          phoneFp: p.phoneFp,
          name: p.name,
          lastSeenAt: p.lastSeenAt,
        }));
      case "unpair":
        return { removed: a.unpair(String(req.args?.target ?? "")) };
      case "pair-open": {
        // Open first: openPairing() may synchronously close a previous window, which broadcasts
        // `closed` to every registered client -- this client must not be one of them yet.
        const opened = a.openPairing();
        this.pairClients.add(socket);
        return opened;
      }
      case "pair-close":
        a.closePairing();
        return {};
      case "confirm": {
        const fp = String(req.args?.phoneFp ?? "");
        const cb = this.pending.get(fp);
        if (!cb) throw new Error("no pending request");
        cb(Boolean(req.args?.accept));
        return {};
      }
      default:
        throw new Error(`unknown command: ${req.cmd}`);
    }
  }
}

const REQUEST_TIMEOUT_MS = 5_000;

export function controlRequest(
  sockPath: string,
  cmd: string,
  args?: Record<string, unknown>,
  options?: { timeoutMs?: number; maxResponseBytes?: number },
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = encodeControlLine({ cmd, args });
    if (!request) {
      reject(new Error("control socket request too large"));
      return;
    }
    let settled = false;
    const socket = createConnection(sockPath);
    const timeoutMs = options?.timeoutMs ?? REQUEST_TIMEOUT_MS;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error("control socket timed out"))),
      timeoutMs,
    );
    const decoder = new ControlLineDecoder({
      maxBytes: options?.maxResponseBytes,
      onError: (code) =>
        finish(() =>
          reject(
            new Error(
              code === "line-too-large"
                ? "control socket response too large"
                : "control socket sent a malformed response",
            ),
          ),
        ),
      onLine: (line) => {
        decoder.finish();
        finish(() => {
          let res: { ok: boolean; data?: unknown; error?: string };
          try {
            res = JSON.parse(line) as { ok: boolean; data?: unknown; error?: string };
            if (res === null || typeof res !== "object" || typeof res.ok !== "boolean")
              throw new Error();
          } catch {
            reject(new Error("control socket sent a malformed response"));
            return;
          }
          if (res.ok) resolve(res.data);
          else reject(new Error(res.error ?? "control error"));
        });
      },
    });
    socket.on("error", (err) => finish(() => reject(err)));
    socket.once("connect", () => {
      if (!writeControlLine(socket, request))
        finish(() => reject(new Error("control socket write failed")));
    });
    socket.once("close", () =>
      finish(() => reject(new Error("control socket closed without a response"))),
    );
    socket.once("end", () =>
      finish(() => reject(new Error("control socket closed without a response"))),
    );
    socket.on("data", (chunk: Buffer) => {
      if (!settled) decoder.push(new Uint8Array(chunk));
    });
    socket.once("end", () => decoder.finish());
  });
}

/** Streaming pair session: opens a window and reports requests until the socket closes. */
export function controlPairSession(
  sockPath: string,
  handlers: {
    onOpen: (qrText: string, expiresAt: number) => void;
    onRequest: (phoneFp: string, name: string) => Promise<boolean>;
    /** The pairing window this session opened has closed (expiry, success, or explicit close). */
    onClose: () => void;
    onError: (e: Error) => void;
  },
): { close: () => void } {
  const socket = createConnection(sockPath);
  let closing = false;
  let decoder: ControlLineDecoder | undefined;
  const close = () => {
    if (closing) return;
    closing = true;
    decoder?.finish();
    socket.end();
  };
  socket.on("error", handlers.onError);
  const open = encodeControlLine({ cmd: "pair-open" });
  socket.once("connect", () => {
    if (open === null || !writeControlLine(socket, open))
      handlers.onError(new Error("control socket write failed"));
  });
  decoder = new ControlLineDecoder({
    onError: () => {
      socket.destroy();
      handlers.onError(new Error("control socket sent a malformed message"));
    },
    onLine: (line) => {
      if (closing) return;
      let m: {
        ok?: boolean;
        data?: { qrText: string; expiresAt: number };
        event?: string;
        phoneFp?: string;
        name?: string;
        error?: string;
      };
      try {
        m = JSON.parse(line) as typeof m;
      } catch {
        handlers.onError(new Error("control socket sent a malformed message"));
        return;
      }
      if (m.event === "request" && m.phoneFp) {
        void handlers
          .onRequest(m.phoneFp, m.name ?? "")
          .then((accept) => {
            if (closing) return;
            const confirm = encodeControlLine({
              cmd: "confirm",
              args: { phoneFp: m.phoneFp, accept },
            });
            if (confirm === null || !writeControlLine(socket, confirm))
              throw new Error("control socket write failed");
          })
          // `askYesNo` never rejects today, but `socket.write` on an already-destroyed socket
          // throws -- without this the rejection would escape as an unhandled rejection.
          .catch((e) => handlers.onError(e as Error));
      } else if (m.event === "closed") {
        handlers.onClose();
      } else if (m.ok && m.data?.qrText) handlers.onOpen(m.data.qrText, m.data.expiresAt);
      else if (m.ok === false) handlers.onError(new Error(m.error ?? "control error"));
    },
  });
  socket.on("data", (chunk: Buffer) => decoder.push(new Uint8Array(chunk)));
  socket.once("end", () => {
    closing = true;
    decoder?.finish();
  });
  socket.once("close", () => {
    closing = true;
    decoder?.finish();
  });
  return { close };
}
