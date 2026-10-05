import {
  decodeCbor,
  encodeCbor,
  type Identity,
  type InnerMessage,
  type InnerMessageOf,
  type NativeDirectFactory,
  parseInner,
  type RoutableEnvelope,
  V2PairEndpoint,
} from "@shellbell/protocol";
import { createDirectPeer } from "./direct-peer.js";
import type { Logger } from "./log.js";

export interface V2PhoneLinkOptions {
  phoneFp: string;
  connId: string;
  name: string;
  computerFp: string;
  identity: Identity;
  kPair: Uint8Array;
  remoteStatic: Uint8Array;
  send(env: RoutableEnvelope): boolean;
  commitFloor(): Promise<void>;
  prepareReady(): boolean;
  terminal(link: V2PhoneLink, msg: InnerMessage, frameBytes: number): void;
  ready(link: V2PhoneLink): void;
  log: Logger;
  native?: NativeDirectFactory;
}
/** Pair lifetime is independent of the relay's socket presence. */
export class V2PhoneLink {
  readonly phoneFp: string;
  readonly connId: string;
  readonly name: string;
  relayConnId: string;
  readonly openedAt = Date.now();
  handshaken = false;
  broken = false;
  dormant = false;
  viewed: string | null = null;
  onBroken?: () => void;
  private generation = 0;
  private awaitingDirectReady = false;
  private readonly endpoint: V2PairEndpoint;
  private readonly acks = new Map<string, InnerMessageOf<"ack">>();
  constructor(opts: V2PhoneLinkOptions) {
    this.phoneFp = opts.phoneFp;
    this.connId = opts.connId;
    this.relayConnId = opts.connId;
    this.name = opts.name;
    this.endpoint = new V2PairEndpoint({
      role: "computer",
      computerFp: opts.computerFp,
      phoneFp: opts.phoneFp,
      keys: {
        staticPrivate: opts.identity.x25519.priv,
        remoteStatic: opts.remoteStatic,
        pairKey: opts.kPair,
      },
      sendRelay: opts.send,
      commitFloor: opts.commitFloor,
      prepareReady: opts.prepareReady,
      native: opts.native ?? createDirectPeer,
      allowDirect: true,
      terminal: (bytes, frameBytes) => {
        const inner = parseInner(decodeCbor(bytes));
        if (this.awaitingDirectReady) {
          this.awaitingDirectReady = false;
          this.handshaken = true;
          opts.ready(this);
        }
        if ("reqId" in inner) {
          const ack = this.acks.get(inner.reqId);
          if (ack) {
            this.send(ack);
            return;
          }
        }
        opts.terminal(this, inner, frameBytes);
      },
      routeChanged: (route) => {
        this.awaitingDirectReady = route === "direct";
        this.handshaken = route !== null && !this.awaitingDirectReady;
        this.dormant = false;
        this.viewed = null;
        this.acks.clear();
        this.generation += 1;
        opts.log.info("v2 terminal route changed", { route, phone: opts.phoneFp.slice(0, 8) });
        opts.ready(this);
      },
      failure: (stage) => {
        opts.log.warn("v2 transport failed", { stage, phone: opts.phoneFp.slice(0, 8) });
      },
    });
  }
  get transportDiagnostics() {
    return this.endpoint.diagnostics;
  }

  get activeRoute(): "relay" | "direct" | null {
    return this.endpoint.activeRoute;
  }
  get handshakeGeneration(): number {
    return this.generation;
  }
  get streamMode(): "bounded" {
    return "bounded";
  }
  helloOverdue(now = Date.now()): boolean {
    return !this.handshaken && !this.dormant && now - this.openedAt >= 15_000;
  }
  handleEnvelope(envelope: RoutableEnvelope): Promise<void> {
    return this.endpoint.receiveRelay(envelope);
  }
  send(msg: InnerMessage): boolean {
    return !this.broken && this.endpoint.sendTerminal(encodeCbor(msg));
  }
  sendBounded(msg: InnerMessage): boolean {
    return this.send(msg);
  }
  sendLegacyBulk(_msg: InnerMessageOf<"screen.snapshot" | "screen.diff" | "history">): boolean {
    return false;
  }
  rememberAck(reqId: string, msg: InnerMessageOf<"ack">): void {
    this.acks.set(reqId, msg);
    if (this.acks.size > 256) this.acks.delete(this.acks.keys().next().value!);
  }
  relayLost(): void {
    this.endpoint.relayLost();
  }
  close(): void {
    this.broken = true;
    this.handshaken = false;
    this.endpoint.close();
    this.acks.clear();
  }
}
