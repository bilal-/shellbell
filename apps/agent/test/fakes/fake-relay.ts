import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  authMessage,
  bytesEqual,
  type CtrlMessage,
  type CtrlMessageOf,
  decodeRoutableEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  parseCtrl,
  randomBytes,
  sha256,
  toBase64Url,
  verify,
} from "@shellbell/protocol";
import { type WebSocket, WebSocketServer } from "ws";

interface PairingWindow {
  gateHash: Uint8Array;
  expiresAt: number;
}

interface Peer {
  ws: WebSocket;
  fp: string;
  role: "agent" | "phone" | "pairing";
  connId: string;
}

export interface FakeRelayOptions {
  /** Capabilities advertised in the initial authentication reply. */
  features?: string[];
  /** Forwarded to `WebSocketServer` — set false to simulate a peer that never answers pings. */
  autoPong?: boolean;
}

/** Minimal in-process relay double: one computer, any number of phones. */
export class FakeRelay {
  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  url = "";
  agent: Peer | null = null;
  phones = new Map<string, Peer>();
  pairing = new Map<string, Peer>();
  received: { from: Peer; env: Envelope }[] = [];
  /** Original serialized WebSocket payload bytes at the relay boundary, including auth/control. */
  wire = { ingressFrames: 0, ingressBytes: 0, egressFrames: 0, egressBytes: 0, maxE2eBytes: 0 };
  ctrlFromAgent: CtrlMessage[] = [];
  /** Ctrl messages received from `role: "phone"` sockets, in arrival order. */
  ctrlFromPhones: { fp: string; msg: CtrlMessage }[] = [];
  /** Mirrors the shipped relay's `pairing_window` row (computer-do.ts onAuth's pairing branch):
   * set by the agent's `pairing-open`, cleared by `pairing-close`. A `role:"pairing"` auth is
   * gated on this exactly like the real relay -- this is what catches a `pairing-open` that never
   * reached the relay (C1) instead of admitting every pairing socket unconditionally. */
  window: PairingWindow | null = null;
  /** Total sockets ever accepted, including ones that never completed auth. */
  v2Frames = 0;
  v2ToPhoneDelayMs = 0;
  connections = 0;
  connectionTimes: number[] = [];
  /** One-shot fault injection: next agent auth attempt gets this auth-fail reason instead of the real check. */
  nextAuthFailReason: CtrlMessageOf<"auth-fail">["reason"] | null = null;
  /** While set, every newly accepted connection is closed immediately with this code, before any challenge. */
  rejectCode: number | null = null;
  rejectReason = "";
  private waiters: ((m: CtrlMessage) => void)[] = [];
  private ctrlBuffer: CtrlMessage[] = [];

  constructor(
    private readonly computerFp: string,
    private readonly opts: FakeRelayOptions = {},
  ) {}

  async start(): Promise<void> {
    this.server = createServer();
    this.wss = new WebSocketServer({ server: this.server, autoPong: this.opts.autoPong });
    this.wss.on("connection", (ws, req) => {
      this.connections++;
      this.connectionTimes.push(Date.now());
      if (this.rejectCode !== null) {
        ws.close(this.rejectCode, this.rejectReason);
        return;
      }
      const fpInUrl = (req.url ?? "").split("/").pop();
      if (fpInUrl !== this.computerFp) {
        ws.close(4001, "unknown computer");
        return;
      }
      const nonce = randomBytes(32);
      const connId = toBase64Url(randomBytes(16));
      let peer: Peer | null = null;
      this.sendCtrl(ws, { type: "challenge", nonce, connId });
      ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const originalBytes = new Uint8Array(data as Buffer);
        this.wire.ingressFrames++;
        this.wire.ingressBytes += originalBytes.byteLength;
        const routed = decodeRoutableEnvelope(originalBytes);
        if (routed.v === 2) {
          if (!peer || routed.from !== peer.fp) {
            ws.close(4403);
            return;
          }
          const target = peer.role === "agent" ? this.phones.get(routed.to)?.ws : this.agent?.ws;
          this.v2Frames += 1;
          if (target) {
            this.wire.egressFrames++;
            this.wire.egressBytes += originalBytes.byteLength;
            if (peer.role === "agent" && this.v2ToPhoneDelayMs)
              setTimeout(() => {
                if (target.readyState === 1) target.send(data, { binary: true });
              }, this.v2ToPhoneDelayMs);
            else target.send(data, { binary: true });
          }
          return;
        }
        const env = routed;
        if (env.t === "e2e")
          this.wire.maxE2eBytes = Math.max(this.wire.maxE2eBytes, originalBytes.byteLength);
        if (!peer) {
          const msg = parseCtrl(env.body);
          if (msg.type !== "auth") return ws.close(4403);
          if (msg.role === "agent" && this.nextAuthFailReason) {
            const reason = this.nextAuthFailReason;
            this.nextAuthFailReason = null;
            this.sendCtrl(ws, { type: "auth-fail", reason });
            return ws.close(4001);
          }
          const ok =
            fingerprint(msg.ed25519Pub) === msg.fp &&
            verify(msg.ed25519Pub, authMessage(connId, msg.role, msg.fp, nonce), msg.sig);
          if (!ok) {
            this.sendCtrl(ws, { type: "auth-fail", reason: "bad-sig" });
            return ws.close(4001);
          }
          if (msg.role === "agent" && msg.fp !== this.computerFp) {
            this.sendCtrl(ws, { type: "auth-fail", reason: "fp-mismatch" });
            return ws.close(4001);
          }
          peer = { ws, fp: msg.fp, role: msg.role, connId };
          const okMsg: CtrlMessage = {
            type: "auth-ok",
            role: msg.role,
            agentOnline: this.agent !== null || msg.role === "agent",
            computerName: "FakeMac",
            serverTime: Date.now(),
            minFrameMs: 125,
            ...(this.opts.features ? { features: this.opts.features } : {}),
          };
          if (msg.role === "agent") {
            this.agent?.ws.close(4005, "superseded");
            this.agent = peer;
            this.sendCtrl(ws, okMsg);
            this.sendCtrl(ws, { type: "unpaired", phoneFps: [] });
            this.sendCtrl(ws, {
              type: "phones",
              connected: [...this.phones.values()].map((p) => ({
                phoneFp: p.fp,
                connId: p.connId,
                name: "phone",
              })),
            });
          } else if (msg.role === "phone") {
            this.phones.get(msg.fp)?.ws.close(4005);
            this.phones.set(msg.fp, peer);
            this.sendCtrl(ws, okMsg);
            if (this.agent)
              this.sendCtrl(this.agent.ws, {
                type: "phone-connected",
                phoneFp: msg.fp,
                connId,
                name: msg.name,
              });
          } else {
            // pairing: mirror apps/relay/src/computer-do.ts onAuth's pairing branch -- admit only
            // a socket that presents the gate for the currently open, unexpired window. This is
            // the exact gate C1 needed: a `pairing-open` that never reached the relay (or reached
            // a stale window) must fail here instead of silently admitting the phone.
            const win = this.window;
            const gateOk =
              win !== null &&
              Date.now() < win.expiresAt &&
              msg.gate !== undefined &&
              bytesEqual(sha256(msg.gate), win.gateHash);
            if (!gateOk) {
              this.sendCtrl(ws, { type: "auth-fail", reason: "no-window" });
              return ws.close(4001, "no-window");
            }
            this.pairing.set(msg.fp, peer);
            this.sendCtrl(ws, okMsg);
          }
          return;
        }
        if (env.t === "ctrl") {
          const msg = parseCtrl(env.body);
          if (peer.role === "agent") {
            this.ctrlFromAgent.push(msg);
            const waiter = this.waiters.shift();
            if (waiter) waiter(msg);
            else this.ctrlBuffer.push(msg);
            if (msg.type === "pairing-open") {
              this.window = { gateHash: msg.gateHash, expiresAt: msg.expiresAt };
            } else if (msg.type === "pairing-close") {
              this.window = null;
            } else if (msg.type === "pairing-response" || msg.type === "pairing-reject") {
              const target = this.pairing.get(msg.phoneFp);
              if (target) this.sendCtrl(target.ws, msg);
            }
          } else if (peer.role === "phone") {
            this.ctrlFromPhones.push({ fp: peer.fp, msg });
          } else if (peer.role === "pairing" && msg.type === "pairing-request" && this.agent) {
            this.sendCtrl(this.agent.ws, msg);
          }
          return;
        }
        this.received.push({ from: peer, env });
        const target = peer.role === "agent" ? this.phones.get(env.to ?? "")?.ws : this.agent?.ws;
        if (target) {
          this.wire.egressFrames++;
          this.wire.egressBytes += originalBytes.byteLength;
          target.send(data as Buffer, { binary: true });
        }
      });
      ws.on("close", () => {
        if (!peer) return;
        if (peer.role === "agent" && this.agent === peer) {
          this.agent = null;
          // Mirrors apps/relay/src/computer-do.ts webSocketClose: "Agent offline -> pairing
          // window closed". Without this, the I1 regression test below would pass
          // even without `readvertise()`, since the stale window would simply survive the drop.
          this.window = null;
        }
        if (peer.role === "phone" && this.phones.get(peer.fp) === peer) {
          this.phones.delete(peer.fp);
          if (this.agent)
            this.sendCtrl(this.agent.ws, {
              type: "phone-disconnected",
              phoneFp: peer.fp,
              connId: peer.connId,
            });
        }
        if (peer.role === "pairing") this.pairing.delete(peer.fp);
      });
    });
    await new Promise<void>((r) => this.server?.listen(0, "127.0.0.1", r));
    this.url = `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  sendCtrl(ws: WebSocket, body: CtrlMessage): void {
    const bytes = encodeEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body });
    this.wire.egressFrames++;
    this.wire.egressBytes += bytes.length;
    ws.send(bytes, { binary: true });
  }

  sendToAgent(body: CtrlMessage): void {
    if (this.agent) this.sendCtrl(this.agent.ws, body);
  }

  /** Force-close the current agent socket with an arbitrary close code (e.g. 4413/4429). */
  closeAgent(code: number, reason = ""): void {
    this.agent?.ws.close(code, reason);
  }

  nextCtrlFromAgent(timeoutMs = 2000): Promise<CtrlMessage> {
    const buffered = this.ctrlBuffer.shift();
    if (buffered !== undefined) return Promise.resolve(buffered);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("timeout waiting for agent ctrl")), timeoutMs);
      this.waiters.push((m) => {
        clearTimeout(t);
        resolve(m);
      });
    });
  }

  dropAgent(): void {
    this.agent?.ws.terminate();
  }

  async stop(): Promise<void> {
    for (const c of this.wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => this.wss?.close(() => r()));
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
