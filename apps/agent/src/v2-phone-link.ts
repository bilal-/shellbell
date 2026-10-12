import {
  type DirectIceServer,
  decodeCbor,
  directIceServers,
  encodeCbor,
  type Identity,
  type InnerMessage,
  type InnerMessageOf,
  type NativeDirectFactory,
  parseInner,
  type RoutableEnvelope,
  V2PairEndpoint,
} from "@shellbell/protocol";
import { directPeerFactory } from "./direct-peer.js";
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
  /** Current STUN/TURN servers; read for each new direct attempt. */
  iceServers?: () => DirectIceServer[];
}
/** How long a secure-v2 phone has to complete its first handshake before it is reported. */
export const V2_HELLO_TIMEOUT_MS = 15_000;

/** Pair lifetime is independent of the relay's socket presence. */
export class V2PhoneLink {
  readonly helloTimeoutMs = V2_HELLO_TIMEOUT_MS;
  readonly phoneFp: string;
  readonly connId: string;
  readonly name: string;
  relayConnId: string;
  readonly openedAt = Date.now();
  handshaken = false;
  /** The first encrypted handshake committed a route; direct readiness may still lag behind. */
  private routed = false;
  broken = false;
  dormant = false;
  viewed: string | null = null;
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
      native: opts.native ?? directPeerFactory(opts.iceServers ?? (() => directIceServers())),
      allowDirect: true,
      terminal: (bytes, frameBytes) => {
        let inner: InnerMessage;
        try {
          inner = parseInner(decodeCbor(bytes));
        } catch {
          // One unreadable message, such as from a newer phone, must not fail the route.
          return;
        }
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
        // The relay route carries no terminal data, so only a direct route can become ready.
        this.awaitingDirectReady = route === "direct";
        this.handshaken = false;
        if (route) this.routed = true;
        this.dormant = false;
        this.viewed = null;
        this.acks.clear();
        this.generation += 1;
        opts.log.info("v2 terminal route changed", { route, phone: opts.phoneFp.slice(0, 8) });
        opts.ready(this);
      },
      // `detail` is a reason code and phase only; candidates and addresses never reach logs.
      failure: (stage, detail) => {
        opts.log.warn("v2 transport failed", {
          stage,
          ...(detail ? { code: detail.code, phase: detail.phase } : {}),
          phone: opts.phoneFp.slice(0, 8),
        });
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
  helloOverdue(now = Date.now()): boolean {
    // After the handshake, a slow direct route is reported as a direct failure instead.
    return (
      !this.handshaken &&
      !this.routed &&
      !this.dormant &&
      now - this.openedAt >= this.helloTimeoutMs
    );
  }
  handleEnvelope(envelope: RoutableEnvelope): Promise<void> {
    return this.endpoint.receiveRelay(envelope);
  }
  send(msg: InnerMessage): boolean {
    return !this.broken && this.endpoint.sendTerminal(encodeCbor(msg));
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
