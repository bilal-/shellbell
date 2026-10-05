import {
  authMessage,
  BOUNDED_STREAM_FEATURE,
  type CtrlMessageLoose,
  type CtrlMessageOf,
  createPairRevocationV2,
  decodeCbor,
  decodeRoutableEnvelope,
  deriveConnKey,
  E2EBodySchema,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  encodeV2RelayEnvelope,
  frameAd,
  helloAd,
  type Identity,
  type InnerMessage,
  type InnerMessageLoose,
  type InnerMessageLooseOf,
  type NativeDirectFactory,
  NOTIFICATION_FEATURE,
  open,
  parseCtrlLoose,
  parseInnerLoose,
  type RoutableEnvelope,
  randomBytes,
  relayWsUrl,
  seal,
  sign,
  toBase64Url,
  V2PairEndpoint,
  type V2TransportState,
} from "@shellbell/protocol";
import { NotificationEnrollment } from "../notifications/enrollment";
import type { NativeNotifications } from "../notifications/native";
import type { ErrorKind, Status } from "../store/connections";

export class DeliveryUnknownError extends Error {
  constructor() {
    super("delivery unknown: the connection closed before an ack arrived");
    this.name = "DeliveryUnknownError";
  }
}

type WsLike = {
  binaryType: string;
  readyState: number;
  send(data: ArrayBuffer | Uint8Array | string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export interface StatusExtra {
  transport?: V2TransportState;
  agentOnline?: boolean;
  offlineReason?: "computer" | "relay" | "network";
  error?: ErrorKind;
  closeCode?: number;
  /** reqIds retired on connection loss or a freshly accepted agent key (spec 12 toast) */
  lostReqIds?: string[];
}

// Omit from each variant so provider, platform, and environment stay correlated.
type PushTokenFields<T> = T extends unknown ? Omit<T, "type" | "features"> : never;
export type PushTokenInfo = PushTokenFields<CtrlMessageOf<"push-token">>;

export interface ConnectionOptions {
  computerFp: string;
  relayUrl: string;
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  kPair: Uint8Array;
  /** This class is the legacy relay link; an upgraded pair cannot use it. */
  minProtocolVersion?: 2;
  direct?: boolean;
  /** False keeps terminal subscriptions and input paused until a direct route commits. */
  allowRelayTerminal?: boolean;
  remoteStatic?: Uint8Array;
  commitFloor?: () => Promise<void>;
  directFactory?: NativeDirectFactory;
  boundedStream?: boolean;
  pushToken?: () => Promise<PushTokenInfo | null>;
  notificationNative?: Pick<
    NativeNotifications,
    "notificationReadiness" | "installNotificationKey"
  >;
  onCtrl?: (m: CtrlMessageLoose) => void;
  /** Original received CBOR byte length, not a re-encoded or decrypted payload size. */
  onInner: (m: InnerMessageLoose, envelopeBytes: number) => void;
  onStatus: (s: Status, extra?: StatusExtra) => void;
  onTransport?: (state: V2TransportState) => void;
  WebSocketImpl?: new (url: string) => WsLike;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  helloTimeoutMs?: number;
}

const LEASE_MS = 60_000;
const KEEPALIVE_MS = 30_000;
const MAX_DECRYPT_FAILURES = 20;
const MAX_ACCEPTED_AGENT_NONCES = 64;

/** Mirrors apps/agent/src/relay-client.ts: these mean the config will never work. */
const PERMANENT_AUTH_FAIL: Record<string, ErrorKind | undefined> = {
  "bad-sig": "rejected",
  "fp-mismatch": "rejected",
  "not-paired": "unpaired",
};

/** Close codes that must never be retried. */
const PERMANENT_CLOSE: Record<number, ErrorKind> = {
  4004: "unpaired",
  4005: "superseded",
  4400: "relay",
  4403: "relay",
};

/** Transient, but reconnecting fast is what caused them: keep the backoff where it is. */
const KEEP_BACKOFF_CLOSE = new Set([4413, 4429]);

export class ComputerConnection {
  status: Status = "idle";
  private ws: WsLike | null = null;
  private endpoint: V2PairEndpoint | null = null;
  private relayAuthed = false;
  private relayTestPaused = false;
  private failNextDirect = false;
  private relayFallbackOnce = false;
  private stopped = true;
  private networkPaused = false;
  private retryNotBefore = 0;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private keepalive: ReturnType<typeof setInterval> | null = null;
  private helloTimer: ReturnType<typeof setTimeout> | null = null;
  private nPhone: Uint8Array | null = null;
  /** Accepted agent nonces for this phone nonce; never evicted mid-context. */
  private readonly acceptedAgentNonces = new Set<string>();
  private kConn: Uint8Array | null = null;
  private connTag = "";
  private seqOut = 0;
  private seqIn = 0;
  private mode: "legacy" | "bounded" = "legacy";
  private generation = 0;
  private failures = 0;
  private minFrameMs = 125;
  private readonly pending = new Map<
    string,
    {
      promise: Promise<InnerMessageLooseOf<"ack">>;
      resolve: (a: InnerMessageLooseOf<"ack">) => void;
      reject: (e: Error) => void;
    }
  >();

  private readonly notificationEnrollment: NotificationEnrollment;
  private notificationRelayCapable = false;
  private notificationHelloGeneration = -1;

  constructor(private readonly o: ConnectionOptions) {
    this.notificationEnrollment = new NotificationEnrollment({
      computerFp: o.computerFp,
      phoneFp: o.phoneFp,
      kPair: o.kPair,
      native: o.notificationNative,
    });
  }
  get relayUrl(): string {
    return this.o.relayUrl;
  }

  get activeRoute(): "relay" | "direct" | null {
    return this.endpoint?.activeRoute ?? (this.online ? "relay" : null);
  }

  get transportDiagnostics() {
    return (
      this.endpoint?.diagnostics ?? {
        route: this.activeRoute,
        ready: this.online,
        relaySent: 0,
        relayReceived: 0,
        directSent: 0,
        directReceived: 0,
      }
    );
  }

  get transportState(): V2TransportState {
    return (
      this.endpoint?.state ?? {
        route: this.activeRoute,
        ready: this.online,
        phase: "none",
        retryPending: false,
        lastFailure: null,
      }
    );
  }

  /** An explicit exception lasts until direct succeeds or this connection is replaced. */
  allowRelayOnce(): boolean {
    if (
      this.status !== "waiting-direct" ||
      this.endpoint?.activeRoute !== "relay" ||
      !this.endpoint.ready
    )
      return false;
    this.relayFallbackOnce = true;
    this.setStatus("online", { agentOnline: true });
    return true;
  }
  testTransport(
    action:
      | "drop-direct"
      | "interrupt-direct"
      | "fail-next-direct"
      | "pause-relay"
      | "resume-relay",
  ): void {
    if (process.env.EXPO_PUBLIC_SHELLBELL_DIRECT !== "1") return;
    if (action === "drop-direct") this.endpoint?.dropDirect();
    else if (action === "interrupt-direct") this.endpoint?.interruptDirect();
    else if (action === "fail-next-direct") this.failNextDirect = true;
    else if (action === "pause-relay") {
      this.relayTestPaused = true;
      this.ws?.close(4000, "owner relay interruption test");
    } else {
      this.relayTestPaused = false;
      if (!this.ws && !this.stopped) this.open();
    }
  }

  get online(): boolean {
    return this.status === "online" && (!this.endpoint || this.endpoint.ready);
  }

  get streamMode(): "legacy" | "bounded" {
    return this.mode;
  }

  get handshakeGeneration(): number {
    return this.generation;
  }

  /** The relay's advertised minimum frame interval; surfaced for Plan 06 perf work. */
  get frameIntervalMs(): number {
    return this.minFrameMs;
  }

  newReqId(): string {
    return toBase64Url(randomBytes(8));
  }

  pendingReqIds(): string[] {
    return [...this.pending.keys()];
  }

  connect(): void {
    // Mirrors relay-client.ts's `start()`: a no-op while a socket already exists / is dialling.
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.open();
  }

  /** Retire the old path and key epoch; delivery-unknown requests are never replayed. */
  networkChanged(available: boolean): void {
    if (this.stopped || this.status === "error") return;
    this.networkPaused = !available;
    const lostReqIds = this.pendingReqIds();
    this.clearTimers();
    const socket = this.ws;
    this.ws = null;
    this.relayAuthed = false;
    this.endpoint?.close();
    this.endpoint = null;
    this.failPending();
    this.resetSession();
    socket?.close(1000, "network changed");
    this.setStatus("offline", { offlineReason: "network", lostReqIds });
    if (available) {
      if (Date.now() >= this.retryNotBefore) this.attempt = 0;
      this.open();
    }
  }

  close(reason: "background" | "user" = "user"): void {
    this.relayFallbackOnce = false;
    this.stopped = true;
    this.clearTimers();
    if (this.ws) {
      // Spec 10.4/11.3: the relay must treat this phone as push-eligible immediately.
      if (reason === "background" && this.ws.readyState === 1) {
        this.sendCtrl({ type: "lease", ttlMs: 0 });
      }
      // Close regardless of readyState (including CONNECTING) so a still-dialling socket never
      // lingers; the socket-identity guard below stops its late onopen/onclose from acting on us.
      this.ws.close(1000, reason);
    }
    this.ws = null;
    this.endpoint?.close();
    this.endpoint = null;
    this.failPending();
    this.resetSession();
    this.setStatus("idle");
  }

  subscribe(sessionId: string | null): boolean {
    return this.send({ type: "subscribe", sessionId });
  }

  /** Local send admission only; remote delivery still requires an acknowledgement. */
  send(msg: InnerMessageLoose): boolean {
    if (this.endpoint)
      return this.status === "online" && this.endpoint.sendTerminal(encodeCbor(msg));
    if (!this.kConn || this.status !== "online" || !this.ws) return false;
    this.seqOut += 1;
    const ad = frameAd(this.o.phoneFp, this.o.computerFp, this.connTag, this.seqOut);
    const box = seal(this.kConn, encodeCbor(msg), ad);
    return this.sendEnvelope({
      v: 1,
      t: "e2e",
      from: this.o.phoneFp,
      to: this.o.computerFp,
      seq: this.seqOut,
      body: box,
    });
  }

  /** Admit only work owned by the current accepted handshake. */
  sendForHandshake(generation: number, message: InnerMessage): boolean {
    if (this.endpoint) return generation === this.generation && this.send(message);
    if (
      generation !== this.generation ||
      this.status !== "online" ||
      !this.kConn ||
      this.ws?.readyState !== 1
    )
      return false;
    return this.send(message);
  }

  request(msg: InnerMessageLoose & { reqId: string }): Promise<InnerMessageLooseOf<"ack">> {
    const reqId = msg.reqId;
    const existing = this.pending.get(reqId);
    if (existing) return existing.promise;
    let resolve!: (ack: InnerMessageLooseOf<"ack">) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<InnerMessageLooseOf<"ack">>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const record = { promise, resolve, reject };
    this.pending.set(reqId, record);
    let admitted = false;
    try {
      admitted = this.send(msg);
    } catch {
      // Local serialization or socket failure has the same unknown delivery result.
    }
    if (!admitted && this.pending.get(reqId) === record) {
      this.pending.delete(reqId);
      reject(new DeliveryUnknownError());
    }
    return promise;
  }

  /** Best-effort: tells the relay/agent this phone is unpairing itself (spec 10.8 / review R60).
   *  A no-op wire-wise if the socket isn't open -- the caller wipes local state regardless. */
  unpairSelf(): void {
    const proof =
      this.o.minProtocolVersion === 2
        ? createPairRevocationV2({
            computerFp: this.o.computerFp,
            phoneFp: this.o.phoneFp,
            kPair: this.o.kPair,
            phoneEd25519Priv: this.o.identity.ed25519.priv,
            phoneEd25519Pub: this.o.identity.ed25519.pub,
          })
        : undefined;
    this.sendCtrl({ type: "unpair", phoneFp: this.o.phoneFp, ...(proof && { proof }) });
  }

  /** Best-effort push-token update, e.g. on a notifications-toggle change (review R60). Token
   *  acquisition itself is Plan 06; this just forwards whatever the caller already has. */
  sendPushToken(info: PushTokenInfo): void {
    this.pushTokenRevision += 1;
    this.sendCtrl({
      type: "push-token",
      ...info,
      ...(this.notificationRelayCapable && {
        features: this.notificationEnrollment.ready ? [NOTIFICATION_FEATURE] : [],
      }),
    });
  }

  private pushTokenRevision = 0;

  // ---- internals ----
  private refreshPushToken(): void {
    const socket = this.ws;
    const generation = this.generation;
    const revision = this.pushTokenRevision;
    this.o
      .pushToken?.()
      .then((token) => {
        if (
          token &&
          !this.stopped &&
          this.ws === socket &&
          this.generation === generation &&
          revision === this.pushTokenRevision
        )
          this.sendPushToken(token);
      })
      .catch(() => undefined);
  }

  private setStatus(s: Status, extra?: StatusExtra): void {
    this.status = s;
    this.o.onStatus(s, { ...extra, transport: this.transportState });
  }

  private stopWith(error: ErrorKind, closeCode?: number): void {
    this.stopped = true;
    this.clearTimers();
    this.setStatus("error", { error, closeCode, lostReqIds: this.pendingReqIds() });
    this.failPending();
  }

  private open(): void {
    if (this.stopped || this.networkPaused) return;
    this.relayFallbackOnce = false;
    const cooldown = this.retryNotBefore - Date.now();
    if (cooldown > 0) {
      this.reconnectTimer = setTimeout(() => this.open(), cooldown);
      return;
    }
    const Ws =
      this.o.WebSocketImpl ?? (globalThis.WebSocket as unknown as new (url: string) => WsLike);
    const ws = new Ws(relayWsUrl(this.o.relayUrl, this.o.computerFp));
    // Captured so every handler below can tell a stale (superseded/closed) socket's late events
    // apart from the live one — mirrors relay-client.ts's `const sock = ws` + `this.ws !== sock`.
    const sock = ws;
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    if (this.activeRoute !== "direct") this.setStatus("connecting");
    ws.onopen = () => {
      if (this.ws !== sock) return;
      if (this.activeRoute !== "direct") this.setStatus("auth");
    };
    ws.onmessage = (ev) => {
      if (this.ws !== sock) return;
      const data = ev.data;
      if (typeof data === "string") return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      let env: RoutableEnvelope;
      try {
        env = decodeRoutableEnvelope(bytes);
      } catch {
        return;
      }
      if (env.t === "ctrl") {
        let m: CtrlMessageLoose;
        try {
          m = parseCtrlLoose(env.body);
        } catch {
          return;
        }
        this.onCtrl(m);
      } else {
        if (this.endpoint) void this.endpoint.receiveRelay(env);
        else if (env.v === 1) this.onE2E(env, bytes.byteLength);
      }
    };
    ws.onclose = (ev) => {
      if (this.ws !== sock) return;
      this.onDown(ev.code);
    };
    ws.onerror = () => {
      if (this.ws !== sock) return;
      /* onclose always follows */
    };
  }

  private sendEnvelope(env: RoutableEnvelope): boolean {
    const socket = this.ws;
    if (socket?.readyState !== 1) return false;
    const bytes = env.v === 2 ? encodeV2RelayEnvelope(env) : encodeEnvelope(env);
    try {
      socket.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  private sendCtrl(body: CtrlMessageLoose): void {
    this.sendEnvelope({ v: 1, t: "ctrl", from: this.o.phoneFp, seq: 0, body } as Envelope);
  }

  private onCtrl(m: CtrlMessageLoose): void {
    this.o.onCtrl?.(m);
    switch (m.type) {
      case "challenge": {
        const msg = authMessage(m.connId, "phone", this.o.phoneFp, m.nonce);
        this.sendCtrl({
          type: "auth",
          role: "phone",
          fp: this.o.phoneFp,
          ed25519Pub: this.o.identity.ed25519.pub,
          sig: sign(this.o.identity.ed25519.priv, msg),
          name: this.o.phoneName,
          appVersion: this.o.appVersion,
        });
        return;
      }
      case "auth-ok": {
        this.relayAuthed = true;
        this.retryNotBefore = 0;
        this.attempt = 0;
        this.minFrameMs = m.minFrameMs;
        this.notificationRelayCapable = m.features?.includes(NOTIFICATION_FEATURE) ?? false;
        this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        this.refreshPushToken();
        this.keepalive = setInterval(() => {
          const socket = this.ws;
          if (socket?.readyState !== 1) return;
          try {
            socket.send("ping");
          } catch {
            // Best effort, like the lease below; close/error owns reconnect state.
          }
          this.sendCtrl({ type: "lease", ttlMs: LEASE_MS });
        }, KEEPALIVE_MS);
        if (m.agentOnline) this.startHandshake();
        else this.setStatus("offline", { agentOnline: false, offlineReason: "computer" });
        return;
      }
      case "auth-fail": {
        const permanent = PERMANENT_AUTH_FAIL[m.reason];
        if (permanent) {
          this.stopWith(permanent);
          this.ws?.close(1000, m.reason);
        } else {
          this.setStatus("offline", { agentOnline: false, offlineReason: "relay" });
        }
        return;
      }
      case "presence": {
        if (this.activeRoute === "direct") {
          if (!m.agentOnline) this.endpoint?.relayLost();
          return;
        }
        if (m.agentOnline && !this.kConn) {
          this.startHandshake();
          return;
        }
        if (!m.agentOnline) {
          // Spec 10.4: presence.agentOnline=false keeps the socket — only the handshake/session
          // state is torn down, so `resetSession()` (which also disarms `helloTimer`) is right,
          // but the socket itself must stay open for the next presence flip.
          const lost = this.pendingReqIds();
          this.resetSession();
          this.failPending();
          this.setStatus("offline", {
            agentOnline: false,
            offlineReason: "computer",
            lostReqIds: lost,
          });
        }
        return;
      }
      default:
        return;
    }
  }

  private startV2Handshake(): void {
    if (!this.o.remoteStatic || !this.o.commitFloor) {
      this.setStatus("error", { error: "upgrade-required" });
      return;
    }
    if (!this.endpoint)
      this.endpoint = new V2PairEndpoint({
        role: "phone",
        computerFp: this.o.computerFp,
        phoneFp: this.o.phoneFp,
        keys: {
          staticPrivate: this.o.identity.x25519.priv,
          remoteStatic: this.o.remoteStatic,
          pairKey: this.o.kPair,
        },
        sendRelay: (envelope) => this.relayAuthed && this.sendEnvelope(envelope),
        commitFloor: async () => {
          await this.o.commitFloor!();
          this.o.minProtocolVersion = 2;
        },
        prepareReady: () => this.pending.size === 0,
        native: (events) => {
          if (this.failNextDirect) {
            this.failNextDirect = false;
            return Promise.reject(new Error("Owner-injected native negotiation failure"));
          }
          return this.o.directFactory
            ? this.o.directFactory(events)
            : import("./direct/peer").then((m) => m.createDirectPeer(events));
        },
        allowDirect: this.o.direct === true,
        stateChanged: (state) => {
          if (!this.stopped) this.o.onTransport?.(state);
        },
        terminal: (bytes, frameBytes) =>
          this.dispatchInner(parseInnerLoose(decodeCbor(bytes)), frameBytes),
        routeChanged: (route) => {
          if (route !== "relay") this.relayFallbackOnce = false;
          const lost = this.pendingReqIds();
          this.failPending();
          this.resetSession();
          this.generation += 1;
          this.mode = "bounded";
          // Direct can outrun the relay commit acknowledgement. Start the service's
          // fresh application bootstrap only after this phone has committed.
          if (
            route === "direct" &&
            !this.endpoint?.sendTerminal(encodeCbor({ type: "subscribe", sessionId: null }))
          )
            return;
          const terminalAllowed =
            route === "direct" || this.o.allowRelayTerminal !== false || this.relayFallbackOnce;
          this.setStatus(route ? (terminalAllowed ? "online" : "waiting-direct") : "handshake", {
            lostReqIds: lost,
            agentOnline: route !== null,
          });
          console.info("SHELLBELL_ROUTE", route ?? "recovering");
        },
        failure: (stage) => {
          console.info("SHELLBELL_TRANSPORT_FAILURE", stage);
          if (stage === "direct") return;
          const lost = this.pendingReqIds();
          this.failPending();
          this.resetSession();
          this.setStatus("handshake", { lostReqIds: lost });
          if (stage === "recovery" && this.relayAuthed) this.endpoint?.begin();
          else if (stage === "bootstrap") this.ws?.close(4000, "v2 bootstrap failed");
        },
      });
    if (this.activeRoute === "direct") return;
    this.resetSession();
    this.setStatus("handshake");
    this.endpoint.begin();
  }

  private startHandshake(): void {
    if (this.o.direct || this.o.minProtocolVersion === 2) {
      this.startV2Handshake();
      return;
    }
    this.resetSession();
    this.setStatus("handshake");
    this.nPhone = randomBytes(16);
    const box = seal(
      this.o.kPair,
      encodeCbor({
        type: "conn.hello",
        n: this.nPhone,
        ...(this.o.boundedStream && { features: [BOUNDED_STREAM_FEATURE] }),
      }),
      helloAd(this.o.phoneFp, this.o.computerFp),
    );
    this.sendEnvelope({
      v: 1,
      t: "e2e",
      from: this.o.phoneFp,
      to: this.o.computerFp,
      seq: 0,
      body: box,
    });
    this.helloTimer = setTimeout(() => {
      if (!this.kConn) this.ws?.close(4000, "hello timeout");
    }, this.o.helloTimeoutMs ?? 10_000);
  }

  private onE2E(env: Envelope, envelopeBytes: number): void {
    const body = E2EBodySchema.safeParse(env.body);
    if (!body.success) return;
    if (env.seq === 0) {
      if (!this.nPhone) return;
      try {
        const ad = helloAd(this.o.computerFp, this.o.phoneFp);
        const inner = parseInnerLoose(decodeCbor(open(this.o.kPair, body.data, ad)));
        if (inner.type !== "conn.hello") return;
        // Any accepted agent nonce is a replay in this phone-nonce context,
        // including one older than the current generation.
        const agentNonce = toBase64Url(inner.n);
        if (this.acceptedAgentNonces.has(agentNonce)) return;
        const d = deriveConnKey(
          this.o.kPair,
          this.nPhone,
          inner.n,
          this.o.computerFp,
          this.o.phoneFp,
        );
        if (this.acceptedAgentNonces.size >= MAX_ACCEPTED_AGENT_NONCES) {
          this.ws?.close(4000, "agent nonce history exhausted");
          return;
        }
        if (this.generation === Number.MAX_SAFE_INTEGER) {
          this.ws?.close(4000, "handshake generation exhausted");
          return;
        }
        this.acceptedAgentNonces.add(agentNonce);
        const lostReqIds = this.pendingReqIds();
        this.failPending();
        this.kConn = d.kConn;
        this.connTag = d.connTag;
        this.seqOut = 0;
        this.seqIn = 0;
        this.generation += 1;
        this.notificationEnrollment.cancel();
        this.notificationHelloGeneration = -1;
        this.mode =
          this.o.boundedStream && inner.features?.includes(BOUNDED_STREAM_FEATURE)
            ? "bounded"
            : "legacy";
        this.failures = 0;
        if (this.helloTimer) clearTimeout(this.helloTimer);
        this.helloTimer = null;
        this.setStatus("online", {
          agentOnline: true,
          ...(lostReqIds.length > 0 ? { lostReqIds } : {}),
        });
        this.refreshPushToken();
      } catch {
        // Spec 6.7: a single malformed/undecryptable hello is tolerated via the shared failure
        // counter, not an immediate permanent re-pair — only MAX_DECRYPT_FAILURES in a row means
        // K_pair itself no longer matches.
        this.failures += 1;
        if (this.failures >= MAX_DECRYPT_FAILURES) {
          this.stopWith("re-pair");
          this.ws?.close(1000, "kpair mismatch");
        }
      }
      return;
    }
    if (!this.kConn || env.seq <= this.seqIn) return;
    let inner: InnerMessageLoose;
    try {
      const ad = frameAd(this.o.computerFp, this.o.phoneFp, this.connTag, env.seq);
      inner = parseInnerLoose(decodeCbor(open(this.kConn, body.data, ad)));
    } catch {
      this.failures += 1;
      if (this.failures >= MAX_DECRYPT_FAILURES) this.ws?.close(4000, "decrypt failures");
      return;
    }
    this.failures = 0;
    this.seqIn = env.seq;
    this.dispatchInner(inner, envelopeBytes);
  }

  private dispatchInner(inner: InnerMessageLoose, envelopeBytes: number): void {
    if (inner.type === "hello" && this.notificationHelloGeneration !== this.generation) {
      this.notificationHelloGeneration = this.generation;
      const generation = this.generation;
      void this.notificationEnrollment.begin(
        {
          current: () =>
            (this.online || this.status === "waiting-direct") && this.generation === generation,
          // Notification enrollment is coordination, independent of terminal route policy.
          send: (message) =>
            generation === this.generation && this.endpoint?.ready
              ? this.endpoint.sendTerminal(encodeCbor(message))
              : this.sendForHandshake(generation, message),
        },
        inner.features ?? [],
      );
    }
    if (
      inner.type === "notification.enrolled" &&
      this.notificationEnrollment.acknowledge(inner.generation)
    )
      this.refreshPushToken();
    if (inner.type === "ack") {
      const p = this.pending.get(inner.reqId);
      if (p) {
        this.pending.delete(inner.reqId);
        p.resolve(inner);
      }
    }
    this.o.onInner(inner, envelopeBytes);
  }

  private onDown(code: number): void {
    this.clearTimers();
    this.ws = null;
    this.relayAuthed = false;
    this.endpoint?.relayLost();
    const directAlive = this.activeRoute === "direct";
    if (!directAlive) {
      this.endpoint?.close();
      this.endpoint = null;
    }
    const lost = directAlive ? [] : this.pendingReqIds();
    if (!directAlive) this.resetSession();
    const permanent = PERMANENT_CLOSE[code];
    if (permanent) {
      this.endpoint?.close();
      this.endpoint = null;
      this.stopped = true;
      this.setStatus("error", { error: permanent, closeCode: code, lostReqIds: lost });
      this.failPending();
      return;
    }
    if (!directAlive) this.failPending();
    if (this.stopped) return;
    if (!directAlive)
      this.setStatus("offline", { closeCode: code, offlineReason: "relay", lostReqIds: lost });
    if (this.relayTestPaused) return;
    const min = this.o.backoffMinMs ?? 1000;
    const max = this.o.backoffMaxMs ?? 30_000;
    const base = Math.min(max, min * 2 ** this.attempt);
    // 4413/4429 mean we were too loud: advance the attempt counter but never reset it elsewhere.
    if (!KEEP_BACKOFF_CLOSE.has(code) || this.attempt === 0) {
      this.attempt = Math.min(this.attempt + 1, 10);
    }
    const wait = KEEP_BACKOFF_CLOSE.has(code) ? max : base + base * 0.2 * (Math.random() * 2 - 1);
    if (KEEP_BACKOFF_CLOSE.has(code)) this.retryNotBefore = Date.now() + wait;
    this.reconnectTimer = setTimeout(() => this.open(), wait);
  }

  private resetSession(): void {
    this.notificationEnrollment.cancel();
    this.notificationHelloGeneration = -1;
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.helloTimer = null;
    this.kConn = null;
    this.mode = "legacy";
    this.nPhone = null;
    this.acceptedAgentNonces.clear();
    this.connTag = "";
    this.seqOut = 0;
    this.seqIn = 0;
    this.failures = 0;
  }

  private failPending(): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      p.reject(new DeliveryUnknownError());
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.keepalive) clearInterval(this.keepalive);
    if (this.helloTimer) clearTimeout(this.helloTimer);
    this.reconnectTimer = null;
    this.keepalive = null;
    this.helloTimer = null;
  }
}
