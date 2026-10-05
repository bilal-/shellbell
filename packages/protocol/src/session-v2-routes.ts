import { bytesEqual, bytesToHex as toHex } from "./bytes.js";
import { FpSchema } from "./envelope.js";
import { decodeNoiseSequence } from "./noise-kkpsk2.js";
import { type V2Frame, V2IdSchema, type V2Role, V2SecureSession } from "./session-v2.js";
import {
  decodeV2RoutePayload,
  encodeV2RoutePayload,
  V2_ROUTE_LIMITS,
  type V2RouteControl,
  type V2RoutePayload,
  type V2RouteReference,
} from "./session-v2-route-wire.js";

export interface V2RouteTransport {
  session: V2SecureSession;
  /** Synchronous, bounded queue admission. A failure retires the affected keys. */
  send(frame: V2Frame): boolean;
}
interface Route extends V2RouteTransport {
  reference: V2RouteReference;
}
interface Transition {
  id: Uint8Array;
  target: Route;
  phase: "phone:prepared" | "phone:committed" | "computer:preparing" | "computer:commit";
}
export interface V2RouteCoordinatorOptions {
  role: V2Role;
  computerFp: string;
  phoneFp: string;
  relay: V2RouteTransport;
  now(): number;
  newId(): Uint8Array;
  /** Endpoint gate: durable exact-pair protocol floor and drained input outcomes. */
  prepareReady(): boolean;
}

function copyReference(ref: V2RouteReference): V2RouteReference {
  return {
    route: ref.route,
    sessionId: ref.sessionId.slice(),
    attemptId: ref.attemptId.slice(),
    generation: ref.generation.slice(),
  };
}
function sameReference(a: V2RouteReference, b: V2RouteReference): boolean {
  return (
    a.route === b.route &&
    bytesEqual(a.sessionId, b.sessionId) &&
    bytesEqual(a.attemptId, b.attemptId) &&
    bytesEqual(a.generation, b.generation)
  );
}

/** Per-pair route authority. Cryptographic readiness alone never admits terminal data. */
export class V2RouteCoordinator {
  private relay: Route | null = null;
  private active: Route | null = null;
  private staged: Route | null = null;
  private transition: Transition | null = null;
  private readonly wireIds = new Set<string>();
  private readonly attemptIds = new Set<string>();
  private readonly transitionIds = new Set<string>();
  private highGeneration = 1n;
  private directAttempts = 0;
  private lastNow = -1;
  private deadline: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private revoked = false;
  private recovering = false;
  private snapshot = false;
  private revision = 0;

  constructor(private readonly options: V2RouteCoordinatorOptions) {
    FpSchema.parse(options.computerFp);
    FpSchema.parse(options.phoneFp);
    if (options.role !== "phone" && options.role !== "computer")
      throw new Error("invalid route role");
    this.installRelay(options.relay);
  }

  get status(): "uncommitted" | "relay" | "direct" | "cutover" | "recovering" | "closed" {
    if (this.revoked) return "closed";
    if (this.recovering) return "recovering";
    if (this.transition) return "cutover";
    return this.active?.reference.route ?? "uncommitted";
  }
  get activeRoute(): V2RouteReference | null {
    return this.active ? copyReference(this.active.reference) : null;
  }
  get routeRevision(): number {
    return this.revision;
  }
  get needsSnapshot(): boolean {
    return this.snapshot;
  }
  get preparationPending(): boolean {
    return this.transition?.phase === "computer:preparing";
  }
  get paused(): boolean {
    return this.revoked || this.recovering || this.transition !== null || this.active === null;
  }
  snapshotApplied(): void {
    if (!this.paused) this.snapshot = false;
  }

  stageDirect(transport: V2RouteTransport): void {
    this.sweep();
    if (
      this.revoked ||
      this.recovering ||
      !this.active ||
      !this.relay ||
      this.staged ||
      this.transition
    )
      throw new Error("route candidate unavailable");
    let candidate: Route | null = null;
    try {
      candidate = this.validate(transport, "direct");
      if (!bytesEqual(candidate.reference.sessionId, this.relay.reference.sessionId))
        throw new Error("direct wire session mismatch");
      const generation = decodeNoiseSequence(candidate.reference.generation);
      if (generation <= this.highGeneration) throw new Error("direct generation reused");
      const id = toHex(candidate.reference.attemptId);
      if (this.attemptIds.has(id)) throw new Error("direct attempt reused");
      if (this.directAttempts >= V2_ROUTE_LIMITS.directAttempts)
        throw new Error("direct attempt capacity");
      this.highGeneration = generation;
      this.directAttempts += 1;
      this.attemptIds.add(id);
      this.staged = candidate;
      this.arm();
    } catch (error) {
      if (transport.session !== this.active?.session && transport.session !== this.relay?.session)
        transport.session.close();
      throw error;
    }
  }

  begin(): boolean {
    this.sweep();
    if (
      this.options.role !== "phone" ||
      this.revoked ||
      this.recovering ||
      !this.staged ||
      !this.relay ||
      this.transition
    )
      throw new Error("route prepare unavailable");
    if (!this.options.prepareReady()) return false;
    const id = V2IdSchema.parse(this.options.newId()).slice();
    if (this.transitionIds.has(toHex(id))) throw new Error("route transition reused");
    this.transitionIds.add(toHex(id));
    this.transition = { id, target: this.staged, phase: "phone:prepared" };
    return this.sendControl("route.prepare");
  }

  approve(): boolean {
    this.sweep();
    if (!this.preparationPending || !this.transition) return false;
    if (!this.options.prepareReady() || !this.transition.target.session.ready) return false;
    this.transition.phase = "computer:commit";
    return this.sendControl("route.prepared");
  }

  receive(
    session: V2SecureSession,
    frame: V2Frame,
  ): Exclude<V2RoutePayload, { kind: "control" }> | null {
    this.sweep();
    if (this.revoked || this.recovering || !this.registered(session)) return null;
    try {
      const plaintext = session.open(frame);
      let payload: V2RoutePayload;
      try {
        payload = decodeV2RoutePayload(plaintext);
      } finally {
        plaintext.fill(0);
      }
      if (payload.kind === "control") {
        if (session !== this.relay?.session)
          throw new Error("route control requires relay session");
        this.control(payload.control);
        return null;
      }
      if (payload.kind === "signal") {
        if (session !== this.relay?.session)
          throw new Error("direct signaling requires relay session");
        return payload;
      }
      if (this.paused || session !== this.active?.session) {
        payload.bytes.fill(0);
        return null;
      }
      return payload;
    } catch {
      this.routeLost(session);
      return null;
    }
  }

  sendTerminal(bytes: Uint8Array): boolean {
    this.sweep();
    if (this.paused || !this.active) return false;
    return this.sendPayload(this.active, { kind: "terminal", bytes });
  }
  sendSignal(bytes: Uint8Array): boolean {
    this.sweep();
    if (this.revoked || this.recovering || !this.relay) return false;
    return this.sendPayload(this.relay, { kind: "signal", bytes });
  }

  abort(reason: Extract<V2RouteControl, { type: "route.abort" }>["reason"] = "cancelled"): void {
    if (!this.staged && !this.transition) return;
    if (this.transition?.phase === "phone:committed" || !this.active) {
      this.failAll();
      return;
    }
    const pending = this.transition;
    if (pending && this.relay) {
      this.sendPayload(this.relay, {
        kind: "control",
        control: {
          type: "route.abort",
          transitionId: pending.id,
          target: copyReference(pending.target.reference),
          reason,
        },
      });
    }
    this.discardCandidate();
    if (pending) this.snapshot = true;
  }

  relayLost(): void {
    if (this.active?.reference.route === "direct" && !this.transition && !this.staged) {
      this.relay?.session.close();
      this.relay = null;
    } else this.failAll();
  }
  routeLost(session: V2SecureSession): void {
    if (session === this.active?.session) this.failAll();
    else if (session === this.relay?.session) this.relayLost();
    else if (session === this.staged?.session) this.abort("candidate-failed");
  }

  /** Explicit authenticated recovery; never reuses the failed wire session ID. */
  recover(transport: V2RouteTransport): void {
    if (this.revoked) {
      transport.session.close();
      throw new Error("route owner revoked");
    }
    const replacement = this.validate(transport, "relay");
    if (this.wireIds.has(toHex(replacement.reference.sessionId))) {
      replacement.session.close();
      throw new Error("wire session reused");
    }
    this.failAll();
    this.installRelay(replacement);
  }

  sweep(): void {
    if (this.revoked) return;
    const now = this.clock();
    if (this.deadline !== null && now >= this.deadline) this.abort("timeout");
  }
  close(): void {
    this.failAll();
    this.revoked = true;
    this.recovering = false;
  }

  private validate(transport: V2RouteTransport, route: "relay" | "direct"): Route {
    if (
      !(transport.session instanceof V2SecureSession) ||
      !transport.session.ready ||
      transport.session.senderRole !== this.options.role
    )
      throw new Error("route session not ready");
    const ref = transport.session.description;
    if (
      ref.computerFp !== this.options.computerFp ||
      ref.phoneFp !== this.options.phoneFp ||
      ref.route !== route
    )
      throw new Error("route pairing mismatch");
    if (route === "relay" && decodeNoiseSequence(ref.generation) !== 1n)
      throw new Error("relay generation must be one");
    return {
      session: transport.session,
      send: transport.send.bind(transport),
      reference: copyReference(ref),
    };
  }
  private installRelay(transport: V2RouteTransport): void {
    const route = this.validate(transport, "relay");
    const id = toHex(route.reference.sessionId);
    if (this.wireIds.has(id) || this.wireIds.size >= V2_ROUTE_LIMITS.wireSessions) {
      route.session.close();
      throw new Error("wire session reused or capacity reached");
    }
    this.wireIds.add(id);
    this.attemptIds.clear();
    this.transitionIds.clear();
    this.attemptIds.add(toHex(route.reference.attemptId));
    this.highGeneration = 1n;
    this.directAttempts = 0;
    this.relay = route;
    this.staged = route;
    this.recovering = false;
    this.arm();
  }
  private control(message: V2RouteControl): void {
    if (message.type === "route.prepare") {
      if (
        this.options.role !== "computer" ||
        this.transition ||
        !this.staged ||
        !sameReference(message.target, this.staged.reference) ||
        this.transitionIds.has(toHex(message.transitionId))
      )
        throw new Error("invalid route prepare");
      this.transitionIds.add(toHex(message.transitionId));
      this.transition = {
        id: message.transitionId.slice(),
        target: this.staged,
        phase: "computer:preparing",
      };
      return;
    }
    const pending = this.transition;
    if (
      !pending ||
      !sameReference(message.target, pending.target.reference) ||
      !bytesEqual(message.transitionId, pending.id)
    )
      throw new Error("route transition mismatch");
    if (message.type === "route.abort") {
      this.abortWithoutSending();
      return;
    }
    if (message.type === "route.prepared" && pending.phase === "phone:prepared") {
      if (!this.options.prepareReady() || !pending.target.session.ready)
        throw new Error("route prepare gate changed");
      pending.phase = "phone:committed";
      this.sendControl("route.commit");
      return;
    }
    if (message.type === "route.commit" && pending.phase === "computer:commit") {
      if (!this.options.prepareReady() || !pending.target.session.ready)
        throw new Error("route commit gate changed");
      const ack: V2RouteControl = {
        type: "route.committed",
        transitionId: pending.id,
        target: copyReference(pending.target.reference),
      };
      this.activate();
      if (!this.relay || !this.sendPayload(this.relay, { kind: "control", control: ack }))
        this.failAll();
      return;
    }
    if (message.type === "route.committed" && pending.phase === "phone:committed") {
      this.activate();
      return;
    }
    throw new Error("route control order mismatch");
  }
  private sendControl(type: "route.prepare" | "route.prepared" | "route.commit"): boolean {
    if (!this.relay || !this.transition) return false;
    return this.sendPayload(this.relay, {
      kind: "control",
      control: {
        type,
        transitionId: this.transition.id,
        target: copyReference(this.transition.target.reference),
      },
    });
  }
  private sendPayload(route: Route, payload: V2RoutePayload): boolean {
    const plaintext = encodeV2RoutePayload(payload);
    try {
      if (route.send(route.session.seal(plaintext)) === true) return true;
    } catch {
      /* Queue or key failure cannot reuse this nonce or route. */
    } finally {
      plaintext.fill(0);
    }
    if (payload.kind === "control") this.failAll();
    else this.routeLost(route.session);
    return false;
  }
  private activate(): void {
    if (!this.staged) throw new Error("route target missing");
    const previous = this.active;
    this.active = this.staged;
    this.staged = null;
    this.transition = null;
    if (previous && previous !== this.relay && previous !== this.active) previous.session.close();
    this.clearTimer();
    this.snapshot = true;
    this.revision += 1;
  }
  private abortWithoutSending(): void {
    if (this.transition?.phase === "phone:committed" || !this.active) {
      this.failAll();
      return;
    }
    this.discardCandidate();
    this.snapshot = true;
  }
  private discardCandidate(): void {
    if (this.staged && this.staged !== this.active && this.staged !== this.relay)
      this.staged.session.close();
    this.staged = null;
    this.transition = null;
    this.clearTimer();
  }
  private failAll(): void {
    for (const route of new Set([this.active, this.staged, this.relay])) route?.session.close();
    this.active = null;
    this.staged = null;
    this.relay = null;
    this.transition = null;
    this.clearTimer();
    this.recovering = true;
    this.snapshot = true;
    this.revision += 1;
  }
  private registered(session: V2SecureSession): boolean {
    return (
      session === this.relay?.session ||
      session === this.active?.session ||
      session === this.staged?.session
    );
  }
  private clock(): number {
    const now = this.options.now();
    if (!Number.isFinite(now) || now < 0 || now < this.lastNow) {
      this.failAll();
      throw new Error("invalid route clock");
    }
    this.lastNow = now;
    return now;
  }
  private arm(): void {
    this.clearTimer();
    this.deadline = this.clock() + V2_ROUTE_LIMITS.attemptMs;
    this.timer = setTimeout(() => this.abort("timeout"), V2_ROUTE_LIMITS.attemptMs);
  }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.deadline = null;
  }
}
