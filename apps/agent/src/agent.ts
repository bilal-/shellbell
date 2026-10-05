import { timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  bytesForKey,
  type CtrlMessage,
  fromBase64Url,
  type Identity,
  type InnerMessage,
  type InnerMessageOf,
  isV2Hello,
  MAX_PAIRINGS,
  type NativeDirectFactory,
  NOTIFICATION_FEATURE,
  type PairRevocationV2,
  pairRevocationIdV2,
  type RoutableEnvelope,
  randomBytes,
  type SessionInfo,
  toBase64Url,
  verifyPairRevocationV2,
} from "@shellbell/protocol";
import type { BackendRegistry } from "./backends/registry.js";
import { type BackendEvent, BadWindow, SessionGone, Unsupported } from "./backends/types.js";
import {
  type AgentConfig,
  AgentConfigSchema,
  loadPairings,
  type Pairing,
  type Paths,
  savePairings,
} from "./config.js";
import { configRevision } from "./config-values.js";
import { EventEngine } from "./events.js";
import { hostPlatform } from "./host-platform.js";
import { LOCAL_CONTROL_VERSION, type LocalRuntime, type LocalStatus } from "./local-status.js";
import { type Logger, safeErrorName } from "./log.js";
import { createGitContextReader } from "./notification-context.js";
import { NotificationDispatcher } from "./notification-dispatch.js";
import { NotificationState } from "./notification-state.js";
import { Notifier } from "./notifier.js";
import { isPairedRequest, PairedRequestLedger } from "./paired-requests.js";
import { PairingManager } from "./pairing.js";
import { PhoneLink } from "./phone-link.js";
import { V2PhoneLink } from "./v2-phone-link.js";

type ConnectedPhoneLink = PhoneLink | V2PhoneLink;

import { RelayClient } from "./relay-client.js";
import { ServiceViewCoordinator, type ServiceViewLease } from "./service-view-coordinator.js";
import { preservePairProtocolFloor } from "./state-schema.js";

/** Minimum interval between `pairings.json` writes triggered purely by `lastSeenAt` churn. */
const LAST_SEEN_SAVE_THROTTLE_MS = 60_000;

export interface AgentOptions {
  paths: Paths;
  config: AgentConfig;
  identity: Identity;
  fp: string;
  registry: BackendRegistry;
  log: Logger;
  confirm: (phoneFp: string, name: string) => Promise<boolean>;
  appVersion: string;
  serviceInstance?: string | null;
  relay?: RelayClient;
  directFactory?: NativeDirectFactory;
  relayUrlOverride?: string;
  /** "old exits with a message" when a newer agent process supersedes this one. */
  onSuperseded?: () => void;
  /** Fires whenever the pairing window closes (expiry, explicit close, a completed pairing, or
   * too many bad codes) -- lets a control-socket client watching `pair-open` learn the window is
   * gone instead of idling out its own timer. */
  onPairingClosed?: () => void;
}

export class Agent {
  readonly relay: RelayClient;
  private readonly views: ServiceViewCoordinator;
  private readonly viewLeases = new Map<
    ConnectedPhoneLink,
    { generation: number; lease: ServiceViewLease }
  >();
  readonly events: EventEngine;
  readonly notifier: Notifier;
  private readonly notificationState: NotificationState;
  private notificationRelayCapable = false;
  readonly pairing: PairingManager;
  /** Keyed by relay connId: a stale socket can never be confused with the live one. */
  private links = new Map<string, ConnectedPhoneLink>();
  /** phoneFp -> connId of that phone's live socket; e2e envelopes only carry the fp. */
  private connByFp = new Map<string, string>();
  private pairings: Pairing[];
  private readonly pairRequests = new Map<string, PairedRequestLedger>();
  private sessions: SessionInfo[] = [];
  private tick: NodeJS.Timeout | null = null;
  private sessionsDebounce: NodeJS.Timeout | null = null;
  /** View-bound requests are retired with their handshake. Input/create/focus
   * outcomes instead belong to the pairing's transport-independent ledger. */
  private readonly pendingAcks = new Map<
    ConnectedPhoneLink,
    Map<string, Promise<InnerMessageOf<"ack"> | null>>
  >();
  /** Last time each phone's `lastSeenAt` was actually persisted (ms epoch); throttles the
   * `savePairings` disk write in `attach()` so a phone stuck in a reconnect loop cannot rewrite
   * `pairings.json` on every attempt. */
  private readonly lastSeenSavedAt = new Map<string, number>();
  private readonly log: Logger;
  private readonly localProcess: LocalRuntime;
  get configurationRevision(): string {
    return configRevision(this.o.config);
  }
  /** Last `hello.backends` fingerprint sent, so a backend appearing or dying re-announces itself. */
  private backendsKey: string | null = null;

  constructor(private readonly o: AgentOptions) {
    // Own a startup snapshot: caller changes must not change behavior or the applied digest.
    o = { ...o, config: Object.freeze(AgentConfigSchema.parse(o.config)) };
    this.o = o;
    this.log = o.log.child({ unit: "agent" });
    this.pairings = loadPairings(o.paths);
    this.localProcess = {
      pid: process.pid,
      agentVersion: o.appVersion,
      computerFp: o.fp,
      stateDir: realpathSync(o.paths.dir),
      serviceInstance: o.serviceInstance ?? null,
    };
    // `relayUrlOverride` (test-only) redirects where the agent's own socket connects, without
    // changing the relay URL the pairing QR advertises to phones -- PairingManager always uses
    // `o.config.relayUrl` below, since that is the address a real phone will actually dial.
    const socketUrl = o.relayUrlOverride ?? o.config.relayUrl;
    this.relay =
      o.relay ??
      new RelayClient({
        relayUrl: socketUrl,
        fp: o.fp,
        identity: o.identity,
        name: o.config.computerName,
        appVersion: o.appVersion,
        log: o.log,
      });
    this.views = new ServiceViewCoordinator({
      backend: o.registry,
      log: o.log,
      now: () => Date.now(),
      newTransferId: () => toBase64Url(randomBytes(16)),
      onSessionGone: () => this.scheduleSessions(),
    });
    this.events = new EventEngine({
      notifyMinCommandMs: o.config.notifyMinCommandMs,
      idleQuietMs: o.config.idleQuietMs,
      idleMinActiveMs: o.config.idleMinActiveMs,
    });
    this.notificationState = new NotificationState(o.paths);
    const notifications = new NotificationDispatcher({
      state: this.notificationState,
      computerFp: o.fp,
      computerName: () => o.config.computerName,
      capable: () => this.notificationRelayCapable,
      pairings: () => this.pairings,
      facts: (id) => o.registry.notificationFacts(id),
      git: createGitContextReader(),
    });
    this.notifier = new Notifier(
      (m) => this.relay.sendCtrl(m),
      o.log,
      Date.now,
      (r) => notifications.prepare(r),
    );
    this.pairing = new PairingManager({
      identity: o.identity,
      fp: o.fp,
      computerName: o.config.computerName,
      accent: o.config.accent,
      relayUrl: o.config.relayUrl,
      sendCtrl: (m) => this.relay.sendCtrl(m),
      savePairing: (p) => this.addPairing(p),
      confirm: o.confirm,
      pairingCount: () => this.pairings.length,
      log: o.log,
      onClose: () => this.o.onPairingClosed?.(),
    });
    this.relay.on("auth-ok", (m) => {
      this.notificationRelayCapable = m.features?.includes(NOTIFICATION_FEATURE) ?? false;
      this.safe("auth-ok", () => {
        // the relay advertises its minimum frame interval; the flush loop must
        // honour it.
        this.views.setIntervalMs(Math.max(125, m.minFrameMs));
        // C1/I1: the relay's own pairing-window row does not survive a fresh connection (first
        // run: this socket was never authenticated when `openPairing()` first sent it) or a
        // reconnect mid-window (the relay drops the row when the agent socket closes). Re-send it
        // every time we (re-)authenticate so the printed QR never silently goes stale.
        this.pairing.readvertise();
      });
    });
    this.relay.on("ctrl", (m) => this.safe("ctrl", () => this.onCtrl(m)));
    this.relay.on("e2e", (env, envelopeBytes) =>
      this.safe("e2e", () => this.onE2E(env, envelopeBytes)),
    );
    this.relay.on("down", () => {
      this.notificationRelayCapable = false;
      this.safe("down", () => {
        for (const link of [...this.links.values()]) {
          if (link instanceof V2PhoneLink) {
            link.relayLost();
            if (link.activeRoute === "direct") continue;
          }
          this.dropLinkFor(link.phoneFp);
        }
      });
    });
    // "Duplicate agent process: New wins; old exits with a message." The relay closed us
    // with 4005 (superseded by a newer agent) -- there is no reconnect coming (RelayClient itself
    // stops retrying), so shut everything down and let the CLI print the message
    // and exit. `down` above already tore down the phone links.
    this.relay.on("superseded", () => {
      this.safe("superseded", () => {
        this.log.warn("relay connection superseded by a newer agent instance; stopping");
        this.stop();
        this.o.onSuperseded?.();
      });
    });
    o.registry.on((e) => this.safe("backend-event", () => this.onBackendEvent(e)));
    this.events.on("event", (ev) => this.safe("events-event", () => this.broadcast(ev)));
    this.events.on("ring", (r) =>
      this.safe("events-ring", () => {
        this.notifier.ring(r);
      }),
    );
  }

  /**
   * Runs a fire-and-forget event handler (sync or async) so neither a synchronous throw nor a
   * rejected promise ever escapes uncaught -- a disk write failing mid-handler (e.g. `savePairings`
   * during `unpaired`) must be logged and leave the agent running, never crash the process or
   * surface as an unhandled rejection.
   */
  private safe(where: string, fn: () => void | Promise<void>): void {
    try {
      const result = fn();
      if (result && typeof result.then === "function") {
        result.catch((err: unknown) => this.logHandlerFailure(where, err));
      }
    } catch (err) {
      this.logHandlerFailure(where, err);
    }
  }

  private logHandlerFailure(where: string, err: unknown): void {
    this.log.error("handler failed", { where, error: safeErrorName(err) });
  }

  // ---- lifecycle ----

  start(): void {
    this.views.start();
    this.relay.start();
    this.tick = setInterval(() => {
      this.safe("tick", () => {
        this.events.tick();
        this.pairing.tick();
        this.sweepHandshakes();
      });
    }, 1000);
    this.safe("refresh-sessions", () => this.refreshSessions());
  }

  stop(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
    if (this.sessionsDebounce) clearTimeout(this.sessionsDebounce);
    this.sessionsDebounce = null;
    this.pairing.closeWindow();
    for (const link of this.links.values()) {
      this.closeLease(link);
      if (link instanceof V2PhoneLink) link.close();
    }
    this.links.clear();
    this.connByFp.clear();
    this.pendingAcks.clear();
    this.views.stop();
    this.pairRequests.clear();
    this.relay.stop();
  }

  /**
   * a phone must send conn.hello within 10 s of connecting. We do not close the socket
   * (the relay owns it) — we log once and leave the link dormant until a hello actually arrives.
   */
  private sweepHandshakes(): void {
    const now = Date.now();
    for (const link of this.links.values()) {
      if (!link.helloOverdue(now)) continue;
      link.dormant = true;
      this.log.warn("no conn.hello within 10s; ignoring this link until one arrives", {
        phone: link.phoneFp.slice(0, 8),
        conn: link.connId.slice(0, 6),
      });
    }
  }

  get relayOnline(): boolean {
    return this.relay.online;
  }
  get localStatus(): Pick<
    LocalStatus,
    "controlVersion" | "process" | "backends" | "terminalReady"
  > {
    const backends = this.o.registry.status();
    return {
      controlVersion: LOCAL_CONTROL_VERSION,
      process: this.localProcess,
      backends,
      terminalReady: backends.some((backend) => backend.connected),
    };
  }
  get pairingList(): Pairing[] {
    return this.pairings;
  }
  get sessionList(): SessionInfo[] {
    return this.sessions;
  }
  get connectedPhones(): LocalStatus["connected"] {
    return [...this.links.values()].map((l) => ({
      phoneFp: l.phoneFp,
      name: l.name,
      viewed: this.viewLeases.get(l)?.lease.viewedSessionId ?? null,
      ...(l instanceof V2PhoneLink && { transport: l.transportDiagnostics }),
    }));
  }

  /** Test seam: the live link for a phone fp, or undefined. */
  linkForPhone(phoneFp: string): ConnectedPhoneLink | undefined {
    const connId = this.connByFp.get(phoneFp);
    return connId ? this.links.get(connId) : undefined;
  }

  openPairing(): { qrText: string; expiresAt: number } {
    return this.pairing.openWindow();
  }
  closePairing(): void {
    this.pairing.closeWindow();
  }

  get pairingOpen(): boolean {
    this.pairing.tick();
    return this.pairing.isOpen;
  }

  unpair(fpOrName: string): boolean {
    if (!fpOrName) return false; // guard: `startsWith("")` would otherwise match the first pairing
    const p = this.pairings.find((x) => x.phoneFp.startsWith(fpOrName) || x.name === fpOrName);
    return p ? this.removePairing(p) : false;
  }

  /** Removes one pairing only when its complete fingerprint matches. */
  unpairExact(phoneFp: string): boolean {
    const p = this.pairings.find((x) => x.phoneFp === phoneFp);
    return p ? this.removePairing(p) : false;
  }

  /** Called only after this exact pair has completed an authenticated v2 session. */
  raisePairProtocolFloor(phoneFp: string, expectedKPair: Uint8Array, preserve?: V2PhoneLink): void {
    const pairing = this.pairings.find((p) => p.phoneFp === phoneFp);
    const stored = loadPairings(this.o.paths).find((p) => p.phoneFp === phoneFp);
    if (!pairing || !stored || expectedKPair.length !== 32) {
      throw new Error("shellbell: pairing changed before protocol upgrade");
    }
    const actual = fromBase64Url(stored.kPair);
    if (
      actual.length !== 32 ||
      pairing.kPair !== stored.kPair ||
      pairing.ed25519Pub !== stored.ed25519Pub ||
      pairing.x25519Pub !== stored.x25519Pub ||
      !timingSafeEqual(Buffer.from(actual), Buffer.from(expectedKPair))
    ) {
      throw new Error("shellbell: pairing changed before protocol upgrade");
    }
    const next = this.pairings.map((p) =>
      p.phoneFp === phoneFp ? { ...p, minProtocolVersion: 2 as const } : p,
    );
    this.pairings = savePairings(this.o.paths, next);
    if (preserve !== this.linkForPhone(phoneFp)) this.dropLinkFor(phoneFp);
  }

  /** Saves replacement state before publishing revocation side effects. */
  private removePairing(p: Pairing): boolean {
    const next = this.pairings.filter((x) => x !== p);
    this.pairings = savePairings(this.o.paths, next);
    this.notificationState.forget(p.phoneFp);
    this.relay.sendCtrl({ type: "unpair", phoneFp: p.phoneFp });
    this.pairRequests.delete(p.phoneFp);
    this.dropLinkFor(p.phoneFp);
    this.lastSeenSavedAt.delete(p.phoneFp);
    return true;
  }

  private dropLinkFor(phoneFp: string): void {
    const connId = this.connByFp.get(phoneFp);
    if (connId === undefined) return;
    const link = this.links.get(connId);
    if (link) {
      this.closeLease(link);
      if (link instanceof V2PhoneLink) link.close();
      this.pendingAcks.delete(link);
    }
    this.links.delete(connId);
    this.connByFp.delete(phoneFp);
  }

  private addPairing(p: Pairing): void {
    this.notificationState.forget(p.phoneFp);
    const previous = this.pairings.find((x) => x.phoneFp === p.phoneFp);
    const next = preservePairProtocolFloor(previous, p);
    const replacements = [...this.pairings.filter((x) => x.phoneFp !== p.phoneFp), next];
    this.pairings = savePairings(this.o.paths, replacements);
    if (
      previous?.kPair !== p.kPair ||
      previous?.ed25519Pub !== p.ed25519Pub ||
      previous?.x25519Pub !== p.x25519Pub
    ) {
      this.pairRequests.delete(p.phoneFp);
      this.dropLinkFor(p.phoneFp);
    }
  }

  /** Local-only removal, for an `unpair` the relay has already applied. */
  private acceptsRelayUnpair(pairing: Pairing, proof?: PairRevocationV2): boolean {
    if (pairing.minProtocolVersion !== 2) return true;
    if (!proof) return false;
    try {
      return verifyPairRevocationV2(proof, {
        computerFp: this.o.fp,
        phoneFp: pairing.phoneFp,
        kPair: fromBase64Url(pairing.kPair),
        phoneEd25519Pub: fromBase64Url(pairing.ed25519Pub),
      });
    } catch {
      return false;
    }
  }

  private forgetPairing(phoneFp: string, proof?: PairRevocationV2): boolean {
    const pairing = this.pairings.find((p) => p.phoneFp === phoneFp);
    if (pairing && !this.acceptsRelayUnpair(pairing, proof)) {
      this.log.warn("ignored unsigned or invalid relay unpair for upgraded pairing", {
        phone: phoneFp.slice(0, 8),
      });
      return false;
    }
    this.notificationState.forget(phoneFp);
    const before = this.pairings.length;
    const remaining = this.pairings.filter((x) => x.phoneFp !== phoneFp);
    if (remaining.length !== before) this.pairings = savePairings(this.o.paths, remaining);
    this.pairRequests.delete(phoneFp);
    this.dropLinkFor(phoneFp);
    this.lastSeenSavedAt.delete(phoneFp);
    return true;
  }

  // ---- relay ctrl ----

  private async onCtrl(m: CtrlMessage): Promise<void> {
    switch (m.type) {
      case "unpaired": {
        if (m.phoneFps.length) {
          const proofs = new Map(m.proofs?.map((proof) => [proof.phoneFp, proof]));
          const acknowledgements = (m.proofs ?? []).filter((proof) => {
            if (!m.phoneFps.includes(proof.phoneFp)) return false;
            const pairing = this.pairings.find((p) => p.phoneFp === proof.phoneFp);
            return !pairing || this.acceptsRelayUnpair(pairing, proof);
          });
          const removable = m.phoneFps.filter((fp) =>
            this.pairings.some(
              (p) => p.phoneFp === fp && this.acceptsRelayUnpair(p, proofs.get(fp)),
            ),
          );
          if (removable.length) {
            const remaining = this.pairings.filter((p) => !removable.includes(p.phoneFp));
            this.pairings = savePairings(this.o.paths, remaining);
            for (const fp of removable) {
              this.pairRequests.delete(fp);
              this.dropLinkFor(fp);
            }
            this.log.info("applied verified or legacy unpair tombstones", {
              count: removable.length,
            });
          }
          for (const proof of acknowledgements) {
            this.relay.sendCtrl({
              type: "revocation-ack",
              phoneFp: proof.phoneFp,
              pairId: proof.pairId,
            });
          }
        }
        // Sync acknowledges legacy tombstones; signed proofs require the pair-ID
        // acknowledgement above after local persistence succeeds.
        this.relay.sendCtrl({
          type: "pairings-sync",
          phones: this.pairings.slice(0, MAX_PAIRINGS).map((p) => ({
            phoneFp: p.phoneFp,
            ed25519Pub: fromBase64Url(p.ed25519Pub),
            name: p.name,
            pairId: pairRevocationIdV2(fromBase64Url(p.kPair)),
          })),
        });
        return;
      }
      case "phones":
        for (const p of m.connected) this.attach(p.phoneFp, p.connId, p.name);
        return;
      case "phone-connected":
        this.attach(m.phoneFp, m.connId, m.name);
        return;
      case "phone-disconnected": {
        // Remove by connId: a superseded socket's disconnect must not evict the live one.
        const link = [...this.links.values()].find(
          (l) => (l instanceof V2PhoneLink ? l.relayConnId : l.connId) === m.connId,
        );
        if (!link) return;
        if (link instanceof V2PhoneLink) {
          link.relayLost();
          if (link.activeRoute === "direct") return;
          link.close();
        }
        this.closeLease(link);
        this.pendingAcks.delete(link);
        this.links.delete(link.connId);
        if (this.connByFp.get(link.phoneFp) === link.connId) this.connByFp.delete(link.phoneFp);
        return;
      }
      case "pairing-request":
        await this.pairing.handleRequest(m);
        return;
      case "unpair":
        // The relay already removed its row before forwarding this; just drop our local state.
        // Do NOT call unpair(), which would echo a redundant `unpair` back to the relay.
        if (this.forgetPairing(m.phoneFp, m.proof) && m.proof) {
          this.relay.sendCtrl({
            type: "revocation-ack",
            phoneFp: m.phoneFp,
            pairId: m.proof.pairId,
          });
        }
        return;
      case "error":
        this.log.warn("relay error", {
          code: m.code === "too-many-pairings" ? m.code : "unknown",
        });
        return;
      default:
        return;
    }
  }

  private attach(phoneFp: string, connId: string, name: string): void {
    const pairing = this.pairings.find((p) => p.phoneFp === phoneFp);
    if (!pairing) {
      this.log.warn("relay announced an unknown phone; ignoring", { phone: phoneFp.slice(0, 8) });
      return;
    }
    const existing = this.linkForPhone(phoneFp);
    if (existing instanceof V2PhoneLink && !existing.broken) {
      existing.relayConnId = connId;
      return;
    }
    this.dropLinkFor(phoneFp);
    const link =
      pairing.minProtocolVersion === 2
        ? this.newV2Link(pairing, connId, name)
        : new PhoneLink({
            phoneFp,
            connId,
            name,
            kPair: fromBase64Url(pairing.kPair),
            computerFp: this.o.fp,
            boundedStream: true,
            minProtocolVersion: pairing.minProtocolVersion,
            send: (env) => this.relay.sendEnvelope(env),
            sendBounded: (env) => this.relay.sendScheduledBulkEnvelope(env, "bounded"),
            sendLegacyBulk: (env) => this.relay.sendScheduledBulkEnvelope(env, "legacy"),
            log: this.o.log,
          });
    link.onBroken = () => {
      this.closeLease(link);
      this.pendingAcks.delete(link);
      if (this.links.get(connId) === link) {
        this.links.delete(connId);
        if (this.connByFp.get(phoneFp) === connId) this.connByFp.delete(phoneFp);
      }
    };
    this.links.set(connId, link);
    this.connByFp.set(phoneFp, connId);
    pairing.lastSeenAt = new Date().toISOString();
    // Minor: a phone stuck reconnecting would otherwise rewrite pairings.json on every attempt.
    // `lastSeenAt` is best-effort telemetry, not correctness-critical, so throttling its persist
    // is safe -- the in-memory value above is always fresh even when the write is skipped.
    const now = Date.now();
    const lastSaved = this.lastSeenSavedAt.get(phoneFp) ?? 0;
    if (now - lastSaved >= LAST_SEEN_SAVE_THROTTLE_MS) {
      this.lastSeenSavedAt.set(phoneFp, now);
      this.pairings = savePairings(this.o.paths, this.pairings);
    }
  }

  private newV2Link(pairing: Pairing, connId: string, name: string): V2PhoneLink {
    const key = fromBase64Url(pairing.kPair);
    let link: V2PhoneLink;
    link = new V2PhoneLink({
      phoneFp: pairing.phoneFp,
      connId,
      name,
      computerFp: this.o.fp,
      identity: this.o.identity,
      native: this.o.directFactory,
      kPair: key,
      remoteStatic: fromBase64Url(pairing.x25519Pub),
      send: (env) => this.relay.sendBoundedEnvelope(env),
      commitFloor: async () => this.raisePairProtocolFloor(pairing.phoneFp, key, link),
      prepareReady: () =>
        this.pairRequests.get(pairing.phoneFp)?.idle !== false &&
        (this.pendingAcks.get(link)?.size ?? 0) === 0,
      terminal: (source, msg, bytes) =>
        this.safe("v2-terminal", () => this.onInner(source, msg, bytes)),
      ready: (source) => this.onLinkReady(source),
      log: this.o.log,
    });
    return link;
  }

  private onLinkReady(link: ConnectedPhoneLink): void {
    this.closeLease(link);
    this.pendingAcks.set(link, new Map());
    if (!this.ownsHandshake(link, link.handshakeGeneration)) return;
    this.installLease(link, link.handshakeGeneration);
    if (!this.ownsHandshake(link, link.handshakeGeneration)) return;
    link.send({
      type: "hello",
      features: [NOTIFICATION_FEATURE],
      agentVersion: this.o.appVersion,
      hostPlatform: hostPlatform(process.platform),
      backends: this.o.registry.connected(),
      launchableBackends: this.o.registry.launchable(),
      computerName: this.o.config.computerName,
      accent: this.o.config.accent,
    });
    if (this.ownsHandshake(link, link.handshakeGeneration))
      link.send({ type: "sessions", list: this.sessions });
  }

  // ---- e2e ----

  private onE2E(env: RoutableEnvelope, envelopeBytes: number): void | Promise<void> {
    // Envelopes carry the phone's fp, so resolve the live connId through the side index.
    const connId = this.connByFp.get(env.from);
    let link = connId === undefined ? undefined : this.links.get(connId);
    if (!link) return;
    if (!(link instanceof V2PhoneLink) && env.v === 1 && env.t === "e2e") {
      const pairing = this.pairings.find((p) => p.phoneFp === env.from);
      if (pairing && isV2Hello(env, fromBase64Url(pairing.kPair), this.o.fp, pairing.phoneFp)) {
        this.closeLease(link);
        this.pendingAcks.delete(link);
        link = this.newV2Link(pairing, link.connId, link.name);
        this.links.set(link.connId, link);
      }
    }
    if (link instanceof V2PhoneLink) return link.handleEnvelope(env);
    if (env.v !== 1) return;
    const generation = link.handshakeGeneration;
    const msg = link.handleEnvelope(env);
    if (link.handshakeGeneration !== generation) this.onLinkReady(link);
    // Returned (not fire-and-forgotten) so the caller's `safe()` wrapper catches a rejection.
    return msg ? this.onInner(link, msg, envelopeBytes) : undefined;
  }

  private closeLease(link: ConnectedPhoneLink): void {
    const owned = this.viewLeases.get(link);
    if (!owned) return;
    this.viewLeases.delete(link);
    owned.lease.close();
  }

  private installLease(link: ConnectedPhoneLink, generation: number): void {
    let lease: ServiceViewLease | null = null;
    const owns = () =>
      this.ownsHandshake(link, generation) && this.viewLeases.get(link)?.lease === lease;
    lease = this.views.attach(link.connId, {
      mode: link.streamMode,
      sendLegacy: (message) => owns() && link.sendLegacyBulk(message),
      sendChunk: (message) => owns() && link.sendBounded(message),
      sendControl: (message) => owns() && link.send(message),
    });
    if (!this.ownsHandshake(link, generation)) {
      lease.close();
      return;
    }
    this.viewLeases.set(link, { generation, lease });
  }

  private ownsHandshake(link: ConnectedPhoneLink, generation: number): boolean {
    return (
      this.links.get(link.connId) === link &&
      link.handshaken &&
      !link.broken &&
      link.handshakeGeneration === generation
    );
  }

  /** Reserve IDs before execution. Pair-scoped side effects survive link
   * replacement; view-bound work is retired with its owning handshake. */
  private async onInner(
    link: ConnectedPhoneLink,
    msg: InnerMessage,
    envelopeBytes: number,
  ): Promise<void> {
    const generation = link.handshakeGeneration;
    if (!this.ownsHandshake(link, generation)) return;
    if (msg.type === "notification.enroll") {
      if (
        this.notificationState.enroll(link.phoneFp, msg.generation) &&
        this.ownsHandshake(link, generation)
      )
        link.send({ type: "notification.enrolled", generation: msg.generation });
      return;
    }
    if (
      msg.type === "stream.subscribe" ||
      msg.type === "stream.ack" ||
      msg.type === "stream.history.get" ||
      msg.type === "stream.cancel" ||
      msg.type === "stream.refresh" ||
      msg.type === "stream.chunk" ||
      msg.type === "stream.error"
    ) {
      const owned = this.viewLeases.get(link);
      if (link.streamMode === "bounded" && owned?.generation === generation)
        owned.lease.receive(msg, envelopeBytes);
      return;
    }
    if (!("reqId" in msg)) {
      await this.execute(link, msg, generation);
      return;
    }
    if (isPairedRequest(msg)) {
      let requests = this.pairRequests.get(link.phoneFp);
      if (!requests) {
        requests = new PairedRequestLedger();
        this.pairRequests.set(link.phoneFp, requests);
      }
      const ack = await requests.run(msg.reqId, async () => {
        const result = await this.execute(link, msg, generation);
        if (!result) throw new Error("paired request produced no outcome");
        return result;
      });
      // Only a caller on the current route receives the outcome; replacement
      // callers join the same operation even if its original handler has retired.
      if (this.ownsHandshake(link, generation)) link.send(ack);
      return;
    }
    const requests = this.pendingAcks.get(link);
    if (!requests) return;
    const inflight = requests.get(msg.reqId);
    if (inflight) {
      const ack = await inflight;
      if (ack && this.ownsHandshake(link, generation)) link.send(ack);
      return;
    }
    const p = this.execute(link, msg, generation);
    requests.set(msg.reqId, p);
    try {
      const ack = await p;
      if (ack && this.ownsHandshake(link, generation)) {
        link.rememberAck(msg.reqId, ack);
        link.send(ack);
      }
    } finally {
      if (requests.get(msg.reqId) === p) requests.delete(msg.reqId);
    }
  }

  /** Runs one inner message's side effect and returns the ack to send, or null (e.g. `subscribe`). */
  private async execute(
    link: ConnectedPhoneLink,
    msg: InnerMessage,
    generation: number,
  ): Promise<InnerMessageOf<"ack"> | null> {
    const reg = this.o.registry;
    const okAck = (reqId: string, extra: { sessionId?: string } = {}): InnerMessageOf<"ack"> => ({
      type: "ack",
      reqId,
      ok: true,
      ...extra,
    });
    const errAck = (reqId: string, error: string): InnerMessageOf<"ack"> => ({
      type: "ack",
      reqId,
      ok: false,
      error,
    });
    try {
      switch (msg.type) {
        case "subscribe":
          if (!this.ownsHandshake(link, generation)) return null;
          if (link.streamMode !== "legacy") return null;
          if (this.viewLeases.get(link)?.lease.setLegacyView(msg.sessionId))
            link.viewed = msg.sessionId;
          return null;
        case "input.line":
          this.log.info("input", { kind: "line", len: msg.text.length });
          await reg.sendText(msg.sessionId, `${msg.text}\r`);
          return okAck(msg.reqId);
        case "input.text":
          this.log.info("input", { kind: "text", len: msg.text.length });
          await reg.sendText(msg.sessionId, msg.text);
          return okAck(msg.reqId);
        case "input.key":
          await reg.sendText(msg.sessionId, bytesForKey(msg.key));
          return okAck(msg.reqId);
        case "history.get": {
          if (link.streamMode !== "legacy") return errAck(msg.reqId, "unsupported");
          return (
            (await this.viewLeases.get(link)?.lease.requestLegacyHistory(msg)) ??
            errAck(msg.reqId, "cancelled")
          );
        }
        case "session.create": {
          const id = await reg.createSession(msg.in);
          // Debounced, not an immediate `refreshSessions()`: a real backend (iTerm2) already emits
          // `session-added` for this same creation, so an unconditional immediate refresh here would
          // broadcast `sessions` twice. `scheduleSessions()` coalesces with that event if it lands in
          // the same 100 ms window, and still fires exactly once if the backend never emits one.
          this.scheduleSessions();
          return okAck(msg.reqId, { sessionId: id });
        }
        case "session.focus": {
          const caps = reg.capabilitiesOf(msg.sessionId);
          // an unknown/gone session id is `session-gone`; `unsupported` is reserved for a
          // real session on a backend that just doesn't implement focus (e.g. tmux).
          if (caps === null) throw new SessionGone(msg.sessionId);
          if (!caps.focus) return errAck(msg.reqId, "unsupported");
          await reg.focus(msg.sessionId);
          return okAck(msg.reqId);
        }
        case "snapshot.get":
          if (link.streamMode !== "legacy") return errAck(msg.reqId, "unsupported");
          if (link.viewed !== msg.sessionId) return errAck(msg.reqId, "not-viewing");
          this.viewLeases.get(link)?.lease.forceLegacySnapshot(msg.sessionId);
          return okAck(msg.reqId);
        default:
          return null;
      }
    } catch (err) {
      // a mismatched windowId must reach the phone as error:"bad-window", not "failed".
      const error =
        err instanceof SessionGone
          ? "session-gone"
          : err instanceof Unsupported
            ? "unsupported"
            : err instanceof BadWindow
              ? "bad-window"
              : "failed";
      this.log.warn("inner message failed", {
        type: msg.type,
        error,
        err: safeErrorName(err),
      });
      return "reqId" in msg ? errAck(msg.reqId, error) : null;
    }
  }

  private broadcast(msg: InnerMessage): void {
    for (const l of this.links.values()) l.send(msg);
  }

  // ---- backend ----

  private onBackendEvent(e: BackendEvent): void {
    this.events.onBackendEvent(e);
    // NB: the ScreenTracker subscribes to the registry itself and owns `markDirty` /
    // `sessionRemoved`. Do not mirror those calls here.
    switch (e.type) {
      case "screen-changed":
        return;
      case "session-removed":
        // The notifier's rate-limit state and the event engine's per-session prompt state must not
        // leak forever once a session is gone (events.onBackendEvent already dropped its own state
        // above for "session-removed", but forget() is idempotent -- call it explicitly here too so
        // the contract holds even if that internal handling ever changes).
        this.notifier.forget(e.sessionId);
        this.events.forget(e.sessionId);
        this.scheduleSessions();
        return;
      case "layout-changed":
      case "session-added":
      case "focus-changed":
      case "title-changed":
      // `SessionInfo.state` comes from `EventEngine.stateOf`; state and structural
      // events changed by `this.events.onBackendEvent(e)` need a fresh list on phones.
      case "command-start":
      case "command-end":
      case "prompt":
      case "agent-state":
        this.scheduleSessions();
        return;
      default:
        return;
    }
  }

  private scheduleSessions(): void {
    if (this.sessionsDebounce) return;
    this.sessionsDebounce = setTimeout(() => {
      this.sessionsDebounce = null;
      void this.refreshSessions();
    }, 100);
  }

  /**
   * `hello.backends` lists the CONNECTED backends, and a change to that set must reach
   * every phone. Herdr makes the set genuinely dynamic (it appears when the user starts herdr and
   * disappears when the socket dies), so this runs on every debounced refresh.
   */
  private broadcastHelloIfBackendsChanged(): void {
    const backends = this.o.registry.connected();
    const key = backends
      .map((b) => b.name)
      .sort()
      .join(",");
    if (key === this.backendsKey) return;
    const first = this.backendsKey === null;
    this.backendsKey = key;
    if (first) return; // the per-phone `hello` sent at handshake already carries this set
    for (const l of this.links.values())
      l.send({
        type: "hello",
        agentVersion: this.o.appVersion,
        hostPlatform: hostPlatform(process.platform),
        backends,
        computerName: this.o.config.computerName,
        accent: this.o.config.accent,
      });
  }

  private async refreshSessions(): Promise<void> {
    // M-2: this used to sit inside the `try` below, after `listSessions()`. `registry.listSessions`
    // already isolates every member's own failure (`registry.ts` `safeListSessions`), so this needs
    // the registry facade itself to throw -- unlikely, but if it ever does on exactly the refresh
    // where Herdr appeared or died, skipping the hello here silently defers it to "whenever
    // something else happens to schedule another refresh", which may be never. Running it in a
    // `finally` means a failing member can never suppress the one signal that actually matters.
    try {
      const list = await this.o.registry.listSessions();
      // a backend can know a session's state before any event has been processed
      // (herdr's first snapshot reports `blocked` outright). The EventEngine is authoritative once
      // it has an opinion; `"unknown"` is not an opinion.
      this.sessions = list.map((s) => {
        const known = this.events.stateOf(s.id);
        return known === "unknown" ? s : { ...s, state: known };
      });
      this.broadcast({ type: "sessions", list: this.sessions });
    } catch (err) {
      // Retain only fixed error categories: messages and custom names may contain
      // session titles, command lines or credentials.
      this.log.warn("listSessions failed", { err: safeErrorName(err) });
    } finally {
      this.broadcastHelloIfBackendsChanged();
    }
  }
}
