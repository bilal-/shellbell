import { decodeCbor } from "./codec.js";
import { helloAd, open, randomBytes } from "./crypto.js";
import { E2EBodySchema, type Envelope, type RoutableEnvelope } from "./envelope.js";
import { parseInner } from "./inner.js";
import { encodeNoiseSequence } from "./noise-kkpsk2.js";
import {
  decodeV2Frame,
  encodeV2Frame,
  type V2PairKeys,
  type V2Role,
  type V2SecureSession,
} from "./session-v2.js";
import { type NativeDirectFactory, V2DirectAttempt } from "./session-v2-direct-attempt.js";

export type {
  NativeDirectEvents,
  NativeDirectFactory,
  NativeDirectPeer,
} from "./session-v2-direct-attempt.js";

import { V2PairedCarrier } from "./session-v2-paired-carrier.js";
import { V2_ROUTE_LIMITS } from "./session-v2-route-wire.js";
import { V2RouteCoordinator } from "./session-v2-routes.js";
import {
  type DirectSignal,
  decodeDirectSignal,
  encodeDirectSignal,
  V2_FEATURE,
} from "./session-v2-signaling.js";

export interface V2TransportState {
  route: "relay" | "direct" | null;
  ready: boolean;
  phase:
    | "none"
    | "native"
    | "offer"
    | "connecting"
    | "open"
    | "certificate"
    | "noise"
    | "cutover"
    | "direct";
  retryPending: boolean;
  lastFailure: string | null;
}

export interface V2EndpointOptions {
  role: V2Role;
  computerFp: string;
  phoneFp: string;
  keys: V2PairKeys;
  sendRelay(envelope: RoutableEnvelope): boolean;
  commitFloor(): Promise<void>;
  prepareReady(): boolean;
  terminal(bytes: Uint8Array, frameBytes: number): void;
  routeChanged(route: "relay" | "direct" | null, revision: number): void;
  failure(stage: "bootstrap" | "direct" | "recovery"): void;
  stateChanged?(state: V2TransportState): void;
  native?: NativeDirectFactory;
  allowDirect?: boolean;
  now?: () => number;
}
export function isV2Hello(
  envelope: Envelope,
  pairKey: Uint8Array,
  computerFp: string,
  phoneFp: string,
): boolean {
  if (envelope.seq !== 0 || envelope.from !== phoneFp || envelope.to !== computerFp) return false;
  try {
    const body = E2EBodySchema.parse(envelope.body);
    const inner = parseInner(decodeCbor(open(pairKey, body, helloAd(phoneFp, computerFp))));
    return inner.type === "conn.hello" && inner.features?.includes(V2_FEATURE) === true;
  } catch {
    return false;
  }
}

/** Shared endpoint orchestration; native ICE and application dispatch stay in their apps. */
export class V2PairEndpoint {
  private carrier: V2PairedCarrier | null = null;
  private owner: V2RouteCoordinator | null = null;
  private relaySession: V2SecureSession | null = null;
  private direct: V2DirectAttempt | null = null;
  private generation = 1n;
  private lastFailure: string | null = null;
  private retryAt: number | null = null;
  private retryFailures = 0;
  private nativeAttempts = 0;
  private retriesExhausted = false;
  private readonly traffic = { relaySent: 0, relayReceived: 0, directSent: 0, directReceived: 0 };
  private bootstrapRevision = 0;
  private reportedRevision = -1;
  private reportedRoute: "relay" | "direct" | null = null;
  private reportedState = "";
  private recoveryNotified = false;
  private closed = false;
  private incoming = Promise.resolve();
  private queued = 0;
  private readonly clock: () => number;
  private readonly interval: ReturnType<typeof setInterval>;

  constructor(private readonly options: V2EndpointOptions) {
    this.clock = options.now ?? (() => performance.now());
    this.interval = setInterval(() => this.poll(), 100);
  }
  get activeRoute(): "relay" | "direct" | null {
    return this.owner?.activeRoute?.route ?? null;
  }
  get ready(): boolean {
    return this.activeRoute !== null && this.owner?.paused === false;
  }
  get routeRevision(): number {
    return this.owner?.routeRevision ?? 0;
  }

  get diagnostics() {
    const attempt = this.direct;
    const phase: V2TransportState["phase"] =
      this.activeRoute === "direct" ? "direct" : (attempt?.phase ?? "none");
    return {
      route: this.activeRoute,
      ready: this.ready,
      phase,
      lastFailure: this.lastFailure,
      ...this.traffic,
    };
  }

  get state(): V2TransportState {
    const { route, ready, phase, lastFailure } = this.diagnostics;
    return { route, ready, phase, lastFailure, retryPending: this.retryAt !== null };
  }

  private sendRelay(envelope: RoutableEnvelope): boolean {
    const admitted = this.options.sendRelay(envelope);
    if (admitted && envelope.v === 2) this.traffic.relaySent += envelope.body.length;
    return admitted;
  }
  begin(): void {
    if (this.closed || this.options.role !== "phone") return;
    this.carrier?.close();
    this.carrier = this.newCarrier();
    this.bootstrapRevision += 1;
    if (!this.sendRelay(this.carrier.start())) this.bootstrapFailed();
  }
  receiveRelay(envelope: RoutableEnvelope): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (++this.queued > 32) {
      this.queued -= 1;
      this.bootstrapFailed();
      return Promise.resolve();
    }
    const task = this.incoming.then(() => this.relay(envelope));
    this.incoming = task
      .catch(() => this.bootstrapFailed())
      .finally(() => {
        this.queued -= 1;
      });
    return this.incoming;
  }
  sendTerminal(bytes: Uint8Array): boolean {
    return this.owner?.sendTerminal(bytes) ?? false;
  }
  relayLost(): void {
    this.owner?.relayLost();
    this.carrier?.close();
    this.carrier = null;
    this.changed();
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.interval);
    this.carrier?.close();
    this.carrier = null;
    this.owner?.close();
    this.owner = null;
    this.closeDirect();
  }
  /** A local, explicit fault injection / relay-only choice; never sends terminal input. */
  dropDirect(): void {
    this.options.allowDirect = false;
    if (this.direct?.session) this.owner?.routeLost(this.direct.session);
    this.closeDirect();
    this.poll();
  }
  /** Owner fault injection: follow the normal loss/retry path rather than opting out. */
  interruptDirect(): void {
    this.directFailed("interrupted");
  }

  private newCarrier(): V2PairedCarrier {
    return new V2PairedCarrier({
      role: this.options.role,
      computerFp: this.options.computerFp,
      phoneFp: this.options.phoneFp,
      keys: this.options.keys,
      now: this.clock,
      newId: () => randomBytes(16),
    });
  }
  private async relay(envelope: RoutableEnvelope): Promise<void> {
    if (this.closed) return;
    if (
      envelope.from !==
        (this.options.role === "phone" ? this.options.computerFp : this.options.phoneFp) ||
      envelope.to !==
        (this.options.role === "phone" ? this.options.phoneFp : this.options.computerFp)
    )
      return;
    if (envelope.v === 2) {
      this.traffic.relayReceived += envelope.body.length;
      if (!this.owner || !this.relaySession) return;
      const result = this.owner.receive(this.relaySession, decodeV2Frame(envelope.body));
      if (result?.kind === "terminal") this.options.terminal(result.bytes, envelope.body.length);
      else if (result?.kind === "signal") {
        const attempt = this.direct;
        try {
          await this.signal(result.bytes);
        } catch {
          if (this.direct === attempt && !attempt?.session?.ready)
            this.directFailed("remote-signal", attempt ?? undefined);
        }
      }
      this.poll();
      return;
    }
    if (envelope.t !== "e2e") return;
    if (this.options.role === "computer" && envelope.seq === 0) {
      if (
        !isV2Hello(
          envelope,
          this.options.keys.pairKey,
          this.options.computerFp,
          this.options.phoneFp,
        )
      )
        return;
      this.carrier?.close();
      this.carrier = this.newCarrier();
      this.bootstrapRevision += 1;
    }
    const carrier = this.carrier;
    if (!carrier) return;
    const revision = this.bootstrapRevision;
    const answer = carrier.receive(envelope);
    if (answer && !this.sendRelay(answer)) throw new Error("bootstrap queue refused");
    if (!carrier.ready) return;
    const session = carrier.takeReadySession();
    this.carrier = null;
    try {
      await this.options.commitFloor();
    } catch (error) {
      session.close();
      throw error;
    }
    if (this.closed || revision !== this.bootstrapRevision) {
      session.close();
      return;
    }
    this.closeDirect();
    this.relaySession = session;
    this.generation = 1n;
    this.nativeAttempts = 0;
    this.retriesExhausted = false;
    this.retryAt = null;
    const transport = {
      session,
      send: (frame: Parameters<typeof encodeV2Frame>[0]) =>
        this.sendRelay({
          v: 2,
          t: "e2e",
          from: this.options.role === "phone" ? this.options.phoneFp : this.options.computerFp,
          to: this.options.role === "phone" ? this.options.computerFp : this.options.phoneFp,
          body: encodeV2Frame(frame),
        }),
    };
    if (this.owner) this.owner.recover(transport);
    else
      this.owner = new V2RouteCoordinator({
        role: this.options.role,
        computerFp: this.options.computerFp,
        phoneFp: this.options.phoneFp,
        relay: transport,
        now: this.clock,
        newId: () => randomBytes(16),
        prepareReady: this.options.prepareReady,
      });
    if (this.options.role === "phone") this.owner.begin();
    this.recoveryNotified = false;
    this.poll();
  }
  private poll(): void {
    if (this.closed || !this.owner) return;
    try {
      this.owner.sweep();
      if (this.owner.preparationPending) this.owner.approve();
      if (
        this.options.role === "phone" &&
        (this.owner.status === "uncommitted" ||
          (this.owner.status === "relay" && this.direct?.session && this.direct.session.ready))
      )
        this.owner.begin();
      this.changed();
      this.retryDirect();
      if (this.owner.status === "recovering" && !this.carrier && !this.recoveryNotified) {
        this.recoveryNotified = true;
        this.closeDirect();
        this.options.failure("recovery");
      }
    } catch {
      this.options.failure("recovery");
    }
    const state = this.state;
    const signature = JSON.stringify(state);
    if (signature !== this.reportedState) {
      this.reportedState = signature;
      this.options.stateChanged?.(state);
    }
  }
  private changed(): void {
    const route = this.activeRoute;
    const revision = this.routeRevision;
    if (this.reportedRevision === revision && this.reportedRoute === route) return;
    this.reportedRevision = revision;
    this.reportedRoute = route;
    this.options.routeChanged(route, revision);
    if (route === "direct" && this.direct) {
      this.direct.cancelDeadline();
      this.retryFailures = 0;
      this.retryAt = null;
      this.lastFailure = null;
    }
  }
  private retryDirect(): void {
    if (
      this.options.role !== "phone" ||
      !this.options.allowDirect ||
      !this.options.native ||
      this.retriesExhausted ||
      this.direct ||
      this.carrier ||
      !this.ready ||
      this.activeRoute !== "relay" ||
      !this.options.prepareReady()
    )
      return;
    if (this.retryAt !== null && this.clock() < this.retryAt) return;
    // Refresh the encrypted connection before exhausting the coordinator's bounded ID sets.
    if (this.nativeAttempts >= V2_ROUTE_LIMITS.directAttempts) {
      this.retriesExhausted = true;
      this.bootstrapFailed();
      return;
    }
    this.nativeAttempts += 1;
    this.retryAt = null;
    void this.startDirect();
  }
  private bootstrapFailed(): void {
    this.carrier?.close();
    this.carrier = null;
    this.options.failure("bootstrap");
  }

  private async startDirect(
    offer?: Extract<DirectSignal, { type: "direct.offer" }>,
  ): Promise<void> {
    if (this.closed || this.direct || !this.ready || !this.relaySession || !this.options.native)
      return;
    this.generation = offer
      ? new DataView(offer.generation.buffer, offer.generation.byteOffset, 8).getBigUint64(0, true)
      : this.generation + 1n;
    const attempt: V2DirectAttempt = new V2DirectAttempt({
      role: this.options.role,
      keys: this.options.keys,
      computerFp: this.options.computerFp,
      phoneFp: this.options.phoneFp,
      relay: this.relaySession.description,
      generation: offer?.generation ?? encodeNoiseSequence(this.generation),
      offer,
      native: this.options.native,
      current: () => !this.closed && this.direct === attempt,
      committed: () => this.activeRoute === "direct",
      sendSignal: (signal) => this.sendSignal(signal),
      sent: (length) => {
        this.traffic.directSent += length;
      },
      received: (length) => {
        this.traffic.directReceived += length;
      },
      ready: (session) => {
        this.owner?.stageDirect({ session, send: (frame) => attempt.send(encodeV2Frame(frame)) });
        if (this.options.role === "phone") this.owner?.begin();
      },
      frame: (session, bytes) => {
        const result = this.owner?.receive(session, decodeV2Frame(bytes));
        if (result?.kind === "terminal") this.options.terminal(result.bytes, bytes.length);
        this.poll();
      },
      failed: (reason) => this.directFailed(reason, attempt),
    });
    this.direct = attempt;
    await attempt.start();
  }
  private async signal(bytes: Uint8Array): Promise<void> {
    if (!this.relaySession || !this.owner) return;
    const attempt = this.direct;
    if (this.activeRoute === "direct" && attempt?.session?.ready) return;
    const signal = decodeDirectSignal(bytes, {
      sender: this.options.role === "phone" ? "computer" : "phone",
      sessionId: this.relaySession.description.sessionId,
      committedGeneration: this.relaySession.description.generation,
      ...(attempt && { pending: { offerId: attempt.offerId, generation: attempt.generation } }),
    });
    if (signal.type === "direct.offer") {
      if (!this.options.native || this.options.role !== "computer") return;
      await this.startDirect(signal);
      return;
    }
    await attempt?.signal(signal);
  }
  private sendSignal(signal: DirectSignal): boolean {
    return this.owner?.sendSignal(encodeDirectSignal(signal)) ?? false;
  }
  private directFailed(code = "closed", expected?: V2DirectAttempt): void {
    if (expected && this.direct !== expected) return;
    const attempt = this.direct;
    if (!attempt) return;
    const base = Math.min(60_000, 5_000 * 2 ** this.retryFailures);
    this.retryFailures = Math.min(this.retryFailures + 1, 4);
    this.retryAt = this.clock() + Math.min(60_000, base * (0.8 + (0.4 * randomBytes(1)[0]!) / 255));
    this.lastFailure = code;
    if (!attempt.session?.ready) {
      try {
        this.sendSignal({
          type: "direct.abort",
          ...attempt.signalContext(),
          reason:
            code === "timeout" ? "timeout" : code === "certificate" ? "dtls-failed" : "ice-failed",
        });
      } catch {
        // Signaling failure must not escape native callbacks or prevent relay fallback.
      }
    }
    const session = attempt?.session;
    if (session) this.owner?.routeLost(session);
    this.closeDirect();
    this.options.failure("direct");
    this.poll();
  }
  private closeDirect(): void {
    const attempt = this.direct;
    this.direct = null;
    if (!attempt) return;
    attempt.close();
  }
}
