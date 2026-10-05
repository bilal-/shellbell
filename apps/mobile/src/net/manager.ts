import {
  type Identity,
  type InnerMessageLoose,
  randomBytes,
  type StreamMessage,
  toBase64Url,
} from "@shellbell/protocol";
import { AppState, type AppStateStatus } from "react-native";
import { loadPairSecret, upgradePairProtocolFloor } from "../identity/keys";
import type { PushToken } from "../notifications/native-token";
import {
  type SessionLike,
  saveSessionTitles,
  type TitleStorage,
} from "../notifications/sessionTitles";
import type { BoundedHistoryWindow } from "../store/bounded-history";
import { useComputersStore } from "../store/computers";
import type { Status } from "../store/connections";
import { useConnectionsStore } from "../store/connections";
import { applyDiffKeyed, applySnapshotKeyed, prependHistoryKeyed } from "../store/screen";
import { shouldLoadOlder } from "../util/session-state";
import type { ConnectionOptions, StatusExtra } from "./connection";
import { ComputerConnection, type PushTokenInfo } from "./connection";
import { MobileScreenStream } from "./mobile-screen-stream";
import {
  type NetworkSnapshot,
  type NetworkSource,
  networkPathChanged,
  UNKNOWN_NETWORK,
} from "./network-monitor";
import { LOST_INPUT_TOAST } from "./toasts";

export { LOST_INPUT_TOAST };

export interface ManagerDeps {
  /** Explicit legacy conformance override; normal clients always attempt direct transport. */
  direct?: boolean;
  directFactory?: ConnectionOptions["directFactory"];
  network?: NetworkSource;
  notificationNative?: ConnectionOptions["notificationNative"];
  identity: Identity;
  phoneFp: string;
  phoneName: string;
  appVersion: string;
  pushToken: (computerFp: string) => Promise<PushTokenInfo | null>;
  /** Spec 10.8 foreground path. Injected by `_layout.tsx` so this module stays native-free:
   *  importing `src/notifications` here would pull `expo-notifications` into `manager.test.ts`. */
  onForegroundEvent?: (computerFp: string, sessionTitle: string, kind: string) => void;
  /** Spec 2026-09-20 §5: the on-device title store (`kvTitleStorage`), injected by `_layout.tsx`
   *  for the same reason as `onForegroundEvent` above — `sessionTitles.ts` itself stays free of
   *  Expo imports so node tests can import it, and its real backend lives in `src/notifications`,
   *  which this module must not import at module scope. */
  titleStorage?: TitleStorage;
}

export interface FocusedViewLease {
  release(): void;
  /** Opaque active subscription/handshake identity for a rendered callback. */
  revision(): object | null;
  requestOlder(expectedRevision?: object | null): boolean;
  skipOversized(expectedRevision?: object | null): boolean;
  refreshHistory(expectedRevision?: object | null): boolean;
  retryOutput(expectedRevision?: object | null): boolean;
  protectHistory(key: string | null, expectedRevision?: object | null): boolean;
}

interface DesiredView {
  token: object;
  fp: string;
  sessionId: string;
}
interface ActiveView {
  desired: DesiredView;
  connection: ComputerConnection;
  generation: number;
  mode: "legacy" | "bounded";
  subscriptionId?: string;
  stream?: MobileScreenStream;
  timer?: ReturnType<typeof setTimeout>;
  legacyHistoryPending?: boolean;
}

/**
 * Spec 2026-09-20 §5: titles must outlive the in-memory store, or a backgrounded app cannot name
 * the session a ring came from. Exported for tests; `storage` is injectable for the same reason.
 * A missing storage (no deps configured yet, or a test that doesn't care) is a silent no-op
 * rather than a throw — titles are a notification nicety, never load-bearing for the socket.
 */
export function onSessionsMessage(
  fp: string,
  list: readonly SessionLike[],
  storage?: TitleStorage,
): void {
  if (storage === undefined) return;
  saveSessionTitles(fp, list, storage);
}

class Manager {
  private sessionGenerations = new WeakMap<ComputerConnection, number>();
  private conns = new Map<string, ComputerConnection>();
  private starting = new Set<string>();
  private deps: ManagerDeps | null = null;
  /** Bumped by `closeAll`; a `connectAll` in flight when it changes must not resume as if
   *  still foregrounded (spec 11.3: a backgrounded phone must not hold a connection open). */
  private generation = 0;
  /** Set (R57) when a computer was skipped/bailed this round and might need a retry once the
   *  app is confirmed active again; consumed only where a `starting` lock actually releases (see
   *  `connectAll`), never eagerly, so a still-in-flight lock is never busy-polled. */
  private rerun = false;
  private sub: { remove: () => void } | null = null;
  private unsubscribeComputers: (() => void) | null = null;
  private unsubscribeNetwork: (() => void) | null = null;
  private network: NetworkSnapshot = UNKNOWN_NETWORK;
  /** Last push token the relay is known to have per computer (M1): the protocol's `push-token`
   *  requires a non-empty `token` (packages/protocol/src/ctrl.ts), so an "off" toggle after a
   *  fresh fetch fails (permission revoked, transient Expo error) has nothing valid to send
   *  unless it falls back to a token we previously registered successfully. */
  private lastToken = new Map<string, PushTokenInfo>();
  private pushTokenRevision = 0;
  private desired: DesiredView | null = null;
  private active: ActiveView | null = null;
  private retained: { token: object; window: BoundedHistoryWindow } | null = null;

  claimView(fp: string, sessionId: string): FocusedViewLease {
    const desired = { token: {}, fp, sessionId };
    this.desired = desired;
    this.retireActive();
    if (this.desired === desired) {
      this.retained = null;
      this.clearOtherViews(desired);
      if (this.desired === desired) this.reconcileView();
    }
    const isCurrent = () => this.desired === desired;
    return {
      release: () => {
        if (!isCurrent()) return;
        this.desired = null;
        this.retireActive();
        if (this.desired !== null) return;
        this.retained = null;
        this.clearOtherViews(null);
      },
      revision: () => {
        const owner = this.active;
        return isCurrent() && owner?.desired === desired && this.current(owner) ? owner : null;
      },
      requestOlder: (expectedRevision) => isCurrent() && this.requestOlder(expectedRevision),
      skipOversized: (expectedRevision) =>
        isCurrent() &&
        this.matchesRevision(expectedRevision) &&
        this.runOwnedAction((s) => s.skipOversized()),
      refreshHistory: (expectedRevision) =>
        isCurrent() && this.matchesRevision(expectedRevision) && this.refreshView(true),
      retryOutput: (expectedRevision) =>
        isCurrent() && this.matchesRevision(expectedRevision) && this.refreshView(false),
      protectHistory: (key, expectedRevision) =>
        isCurrent() &&
        this.matchesRevision(expectedRevision) &&
        this.runOwnedAction((s) => s.protectHistory(key)),
    };
  }

  private matchesRevision(expectedRevision?: object | null): boolean {
    if (expectedRevision === undefined) return true;
    const owner = this.active;
    return (
      owner !== null &&
      expectedRevision !== null &&
      expectedRevision === owner &&
      this.current(owner)
    );
  }

  private requestOlder(expectedRevision?: object | null): boolean {
    const owner = this.active;
    if (
      !owner ||
      !this.current(owner) ||
      (expectedRevision !== undefined && expectedRevision !== owner)
    )
      return false;
    if (owner.mode === "bounded") {
      return this.runOwnedAction(
        (stream) => stream.snapshot.historyStatus !== "loading" && stream.requestOlder(),
      );
    }
    if (owner.legacyHistoryPending) return false;
    const state = useConnectionsStore.getState().read(owner.desired.fp);
    const view = state.view;
    if (
      view?.sessionId !== owner.desired.sessionId ||
      !shouldLoadOlder(view.view.state.historyFrom, state.oldestAvailable[owner.desired.sessionId])
    )
      return false;
    const reqId = owner.connection.newReqId();
    owner.legacyHistoryPending = true;
    try {
      void owner.connection
        .request({
          type: "history.get",
          reqId,
          sessionId: owner.desired.sessionId,
          before: view.view.state.historyFrom,
          count: 200,
        })
        .catch(() => undefined)
        .finally(() => {
          owner.legacyHistoryPending = false;
        });
    } catch {
      owner.legacyHistoryPending = false;
      return false;
    }
    return true;
  }

  private clearOtherViews(desired: DesiredView | null): void {
    const store = useConnectionsStore.getState();
    for (const [fp, connection] of Object.entries(store.byComputer)) {
      const keep = desired?.fp === fp;
      const keepLegacy = keep && connection.view?.sessionId === desired.sessionId;
      const keepBounded = keep && connection.boundedView?.sessionId === desired.sessionId;
      if ((!connection.view || keepLegacy) && (!connection.boundedView || keepBounded)) continue;
      store.patch(fp, () => ({
        view: keepLegacy ? connection.view : undefined,
        boundedView: keepBounded ? connection.boundedView : undefined,
      }));
      if (desired && this.desired !== desired) return;
    }
  }

  private current(owner: ActiveView): boolean {
    return (
      this.active === owner &&
      this.desired === owner.desired &&
      this.conns.get(owner.desired.fp) === owner.connection &&
      owner.connection.handshakeGeneration === owner.generation &&
      owner.connection.streamMode === owner.mode &&
      owner.connection.online &&
      AppState.currentState === "active"
    );
  }

  private retireActive(retain = false): void {
    const old = this.active;
    this.active = null;
    if (!old) return;
    if (old.timer) clearTimeout(old.timer);
    if (old.stream) {
      old.stream.cancel();
      if (
        old.subscriptionId &&
        this.conns.get(old.desired.fp) === old.connection &&
        old.connection.online &&
        old.connection.handshakeGeneration === old.generation &&
        old.connection.streamMode === "bounded"
      ) {
        old.connection.sendForHandshake(old.generation, {
          type: "stream.cancel",
          subscriptionId: old.subscriptionId,
        });
      }
      if (retain && this.desired === old.desired && old.stream.historyWindow) {
        this.retained = { token: old.desired.token, window: old.stream.historyWindow };
      }
    } else if (this.conns.get(old.desired.fp) === old.connection && old.connection.online) {
      old.connection.subscribe(null);
    }
  }

  private runOwnedAction(action: (stream: MobileScreenStream) => boolean): boolean {
    const owner = this.active;
    if (!owner?.stream || !this.current(owner)) return false;
    let result = false;
    try {
      result = action(owner.stream);
    } finally {
      this.publishOwner(owner);
    }
    return result;
  }

  private publishOwner(owner: ActiveView): void {
    if (!owner.stream || !this.current(owner)) return;
    const snapshot = owner.stream.snapshot;
    useConnectionsStore.getState().patch(owner.desired.fp, (connection) => {
      const prior =
        connection.boundedView?.sessionId === owner.desired.sessionId
          ? connection.boundedView
          : undefined;
      const fallbackScreen = snapshot.screen
        ? undefined
        : (prior?.snapshot.screen ?? prior?.fallbackScreen);
      return {
        view: undefined,
        boundedView: { sessionId: owner.desired.sessionId, snapshot, fallbackScreen },
      };
    });
    if (!this.current(owner)) return;
    if (owner.timer) clearTimeout(owner.timer);
    const deadline = owner.stream.nextDeadline();
    if (deadline === null) {
      owner.timer = undefined;
      return;
    }
    owner.timer = setTimeout(
      () => {
        owner.timer = undefined;
        if (this.current(owner))
          this.runOwnedAction((stream) => {
            stream.tick();
            return true;
          });
      },
      Math.max(0, deadline - Date.now()),
    );
  }

  private reconcileView(): void {
    const desired = this.desired;
    if (!desired || AppState.currentState !== "active") return;
    const connection = this.conns.get(desired.fp);
    if (!connection?.online) return;
    const generation = connection.handshakeGeneration;
    const mode = connection.streamMode;
    if (this.active && this.current(this.active)) return;
    this.retireActive(true);
    if (
      this.active ||
      this.desired !== desired ||
      this.conns.get(desired.fp) !== connection ||
      !connection.online
    )
      return;
    if (connection.handshakeGeneration !== generation || connection.streamMode !== mode) {
      this.reconcileView();
      return;
    }
    const owner: ActiveView = { desired, connection, generation, mode };
    this.active = owner;
    if (mode === "legacy") {
      useConnectionsStore.getState().patch(desired.fp, () => ({ boundedView: undefined }));
      if (this.current(owner)) connection.subscribe(desired.sessionId);
      return;
    }
    const retainedHistory =
      this.retained?.token === desired.token ? this.retained.window : undefined;
    this.retained = null;
    useConnectionsStore.getState().patch(desired.fp, () => ({ view: undefined }));
    if (!this.current(owner)) return;
    const subscriptionId = toBase64Url(randomBytes(16));
    owner.subscriptionId = subscriptionId;
    const stream = new MobileScreenStream({
      subscriptionId,
      sessionId: desired.sessionId,
      now: () => Date.now(),
      retainedHistory,
      sendControl: (message: StreamMessage) =>
        this.current(owner) && connection.sendForHandshake(generation, message),
    });
    owner.stream = stream;
    try {
      stream.start();
    } finally {
      this.publishOwner(owner);
    }
  }

  private refreshView(refreshHistory: boolean): boolean {
    const old = this.active;
    if (!old?.stream || !this.current(old)) return false;
    const desired = old.desired;
    const retainedHistory = old.stream.historyWindow;
    this.retireActive();
    if (
      this.active ||
      this.desired !== desired ||
      this.conns.get(desired.fp) !== old.connection ||
      !old.connection.online ||
      old.connection.handshakeGeneration !== old.generation ||
      old.connection.streamMode !== "bounded"
    )
      return false;
    const connection = old.connection;
    const generation = connection.handshakeGeneration;
    const owner: ActiveView = { desired, connection, generation, mode: "bounded" };
    this.active = owner;
    const subscriptionId = toBase64Url(randomBytes(16));
    owner.subscriptionId = subscriptionId;
    const stream = new MobileScreenStream({
      subscriptionId,
      sessionId: desired.sessionId,
      now: () => Date.now(),
      retainedHistory,
      refreshHistory,
      sendControl: (message: StreamMessage) =>
        this.current(owner) && connection.sendForHandshake(generation, message),
    });
    owner.stream = stream;
    try {
      stream.start();
    } finally {
      this.publishOwner(owner);
    }
    return this.current(owner);
  }

  start(deps: ManagerDeps): void {
    this.deps = deps;
    this.network = deps.network?.current() ?? UNKNOWN_NETWORK;
    this.unsubscribeNetwork =
      deps.network?.subscribe((snapshot) => this.onNetwork(snapshot)) ?? null;
    this.sub = AppState.addEventListener("change", (s) => this.onAppState(s));
    this.unsubscribeComputers = useComputersStore.subscribe((s, prev) => {
      if (s.computers !== prev.computers && AppState.currentState === "active") {
        void this.connectAll();
      }
    });
    if (AppState.currentState === "active") void this.connectAll();
  }

  stop(): void {
    this.sub?.remove();
    this.unsubscribeComputers?.();
    this.unsubscribeNetwork?.();
    this.sub = null;
    this.unsubscribeComputers = null;
    this.unsubscribeNetwork = null;
    this.desired = null;
    this.retireActive();
    this.retained = null;
    this.clearOtherViews(null);
    this.closeAll("user");
    this.deps = null;
  }

  get(fp: string): ComputerConnection | undefined {
    return this.conns.get(fp);
  }

  isSessionCurrent(fp: string, sessionId: string): boolean {
    if (!useComputersStore.getState().computers.some((c) => c.fp === fp && !c.removing))
      return false;
    const conn = this.conns.get(fp);
    const state = useConnectionsStore.getState().byComputer[fp];
    return (
      !!conn &&
      state?.status === "online" &&
      this.sessionGenerations.get(conn) === conn.handshakeGeneration &&
      state.sessions.some((session) => session.id === sessionId)
    );
  }

  /** Supersede older acquisitions and cache rotation before forwarding to paired computers. */
  registerNativePushToken(token: PushToken): void {
    this.pushTokenRevision += 1;
    for (const computer of useComputersStore.getState().computers) {
      if (computer.removing) continue;
      const info = { ...token, enabled: computer.pushEnabled };
      this.lastToken.set(computer.fp, info);
      this.conns.get(computer.fp)?.sendPushToken(info);
    }
  }

  /** Forward a notifications-toggle change, falling back to the most recent destination. */
  notifyPushToggle(fp: string, enabled: boolean): void {
    const conn = this.conns.get(fp);
    const deps = this.deps;
    if (!conn || !deps) return;
    this.fetchToken(fp)
      .then((t) => {
        if (t) {
          conn.sendPushToken({ ...t, enabled });
          return;
        }
        // M1: a fresh fetch failing must not silently strand `enabled: false` -- the protocol requires a
        // non-empty token, so re-send the last token we know the relay already has with the
        // new `enabled` value. If we have never registered a token for this computer there is
        // genuinely nothing valid to send; this is a documented no-op, not a bug (the relay was
        // never told push was on in the first place, so "off" needs no message).
        const cached = this.lastToken.get(fp);
        if (cached) conn.sendPushToken({ ...cached, enabled });
      })
      .catch(() => undefined);
  }

  /** Wraps `deps.pushToken` to remember the last non-null result per computer (M1), so a later
   *  failed fetch (e.g. toggling push off) can still fall back to a token the relay already has. */
  private fetchToken(fp: string): Promise<PushTokenInfo | null> {
    const deps = this.deps;
    if (!deps) return Promise.resolve(null);
    const revision = this.pushTokenRevision;
    return deps.pushToken(fp).then((t) => {
      if (revision !== this.pushTokenRevision) return null;
      if (t) this.lastToken.set(fp, t);
      return t;
    });
  }

  private onAppState(s: AppStateStatus): void {
    if (s === "active") void this.connectAll();
    else this.closeAll("background");
  }

  private onNetwork(snapshot: NetworkSnapshot): void {
    const previous = this.network;
    this.network = snapshot;
    if (AppState.currentState !== "active") return;
    if (snapshot.disconnected !== previous.disconnected || networkPathChanged(previous, snapshot)) {
      // Fence in-flight secure-storage reads as well as obsolete transport callbacks.
      this.generation += 1;
      this.retireActive(true);
      for (const connection of this.conns.values())
        connection.networkChanged(!snapshot.disconnected);
    }
    if (!snapshot.disconnected) void this.connectAll();
  }

  private async connectAll(): Promise<void> {
    const deps = this.deps;
    if (!deps || AppState.currentState !== "active" || this.network.disconnected) return;
    const gen = this.generation;
    for (const [fp, conn] of this.conns) {
      const current = useComputersStore.getState().computers.find((c) => c.fp === fp);
      if (!current || current.removing || current.relayUrl !== conn.relayUrl) {
        if (this.active?.connection === conn) this.retireActive();
        const lost = conn.pendingReqIds();
        conn.close("user");
        this.conns.delete(fp);
        this.noteLostInputs(fp, lost);
        this.clearOtherViews(this.desired);
      }
    }
    for (const c of useComputersStore.getState().computers) {
      if (c.removing) continue;
      if (this.conns.has(c.fp)) continue;
      if (this.starting.has(c.fp)) {
        // Another connectAll is already handling this fp (mid-`loadPairSecret`); that call may
        // bail below without ever creating a connection if a background/foreground flap changed
        // the generation out from under it (R57). Flag a rerun -- it is only ever consumed once
        // *some* call's own lock below actually releases, never eagerly here: this path never
        // awaits, so eagerly retrying here would busy-loop against a lock that hasn't had a
        // chance to clear yet.
        this.rerun = true;
        continue;
      }
      this.starting.add(c.fp);
      try {
        let secret: Awaited<ReturnType<typeof loadPairSecret>>;
        try {
          secret = await loadPairSecret(c.fp);
        } catch {
          // Corrupt or temporarily unavailable secure storage is local to this
          // computer. Never interpret it as a legacy pair or strand other pairs.
          if (this.generation === gen && AppState.currentState === "active") {
            useConnectionsStore.getState().patch(c.fp, () => ({
              status: "error",
              agentOnline: false,
              error: "storage",
            }));
          }
          continue;
        }
        // Never create a socket for a stale generation -- but the app may be active again by the
        // time this settles, so flag a rerun rather than stranding this computer until the next
        // AppState/store trigger (R57).
        if (this.generation !== gen || AppState.currentState !== "active") {
          this.rerun = true;
          continue;
        }
        if (!secret) continue;
        const current = useComputersStore.getState().computers.find((item) => item.fp === c.fp);
        if (current?.relayUrl !== c.relayUrl) {
          this.rerun = true;
          continue;
        }
        if (
          !useComputersStore
            .getState()
            .computers.some((current) => current.fp === c.fp && !current.removing)
        )
          continue;
        if (this.conns.has(c.fp)) continue;
        const conn = new ComputerConnection({
          computerFp: c.fp,
          relayUrl: c.relayUrl,
          identity: deps.identity,
          phoneFp: deps.phoneFp,
          phoneName: deps.phoneName,
          appVersion: deps.appVersion,
          kPair: secret.kPair,
          minProtocolVersion: secret.minProtocolVersion,
          direct: deps.direct ?? true,
          directFactory: deps.directFactory,
          allowRelayTerminal: deps.direct === false,
          remoteStatic: secret.computerX25519Pub,
          commitFloor: () => upgradePairProtocolFloor(c.fp, secret.kPair),
          boundedStream: true,
          notificationNative: deps.notificationNative,
          pushToken: () => this.fetchToken(c.fp),
          onStatus: (status, extra) => this.onStatus(c.fp, conn, status, extra),
          onTransport: (transport) => {
            if (this.conns.get(c.fp) === conn)
              useConnectionsStore.getState().patch(c.fp, () => ({ transport }));
          },
          onInner: (m, envelopeBytes) => this.onInner(c.fp, conn, m, envelopeBytes),
        });
        this.conns.set(c.fp, conn);
        conn.connect();
      } finally {
        this.starting.delete(c.fp);
        // Self-healing (R57): a lock just released, which guarantees real async progress was
        // made (this path only runs after an `await`) -- if anything was flagged as missed while
        // this or another call was in flight, re-scan once. Loop-safe: clear before recursing so
        // a rerun that itself needs another rerun isn't silently swallowed by this call clearing
        // it afterwards.
        if (this.rerun && AppState.currentState === "active") {
          this.rerun = false;
          void this.connectAll();
        }
      }
    }
    if (this.generation !== gen) return;
    for (const [fp, conn] of this.conns) {
      if (!useComputersStore.getState().computers.some((c) => c.fp === fp && !c.removing)) {
        if (this.active?.connection === conn) this.retireActive();
        conn.close("user");
        this.conns.delete(fp);
        this.clearOtherViews(this.desired);
      }
    }
  }

  private closeAll(reason: "background" | "user"): void {
    this.generation++;
    this.retireActive(reason === "background");
    for (const [fp, conn] of this.conns) {
      const lost = conn.pendingReqIds();
      conn.close(reason);
      if (lost.length > 0) this.noteLostInputs(fp, lost);
    }
    this.conns.clear();
  }

  /** Spec 12: any close with un-acked input raises the toast — not only a deliberate background. */
  private noteLostInputs(fp: string, lost: string[]): void {
    if (lost.length === 0) return;
    useConnectionsStore.getState().patch(fp, (c) => {
      const rest = { ...c.pendingInputs };
      let lostInput = false;
      for (const id of lost) {
        if (!Object.hasOwn(rest, id)) continue;
        delete rest[id];
        lostInput = true;
      }
      return lostInput ? { pendingInputs: rest, toast: LOST_INPUT_TOAST } : {};
    });
  }

  private onStatus(
    fp: string,
    conn: ComputerConnection,
    status: Status,
    extra?: StatusExtra,
  ): void {
    if (this.conns.get(fp) !== conn) return;
    if (
      this.active?.connection === conn &&
      (status !== "online" ||
        this.active.generation !== conn.handshakeGeneration ||
        this.active.mode !== conn.streamMode)
    )
      this.retireActive(
        status === "online" || status === "waiting-direct" || status === "handshake",
      );
    useConnectionsStore.getState().patch(fp, () => ({
      status,
      agentOnline: extra?.agentOnline ?? status === "online",
      offlineReason: extra?.offlineReason,
      error: extra?.error,
      transport: extra?.transport,
    }));
    // Spec 12: any close with un-acked input raises the toast, not only a deliberate background.
    if (extra?.lostReqIds?.length) this.noteLostInputs(fp, extra.lostReqIds);
    if (status === "online") this.reconcileView();
  }

  private acceptLegacy(fp: string, conn: ComputerConnection, sessionId: string): boolean {
    const owner = this.active;
    return (
      owner?.mode === "legacy" &&
      owner.connection === conn &&
      owner.desired.fp === fp &&
      owner.desired.sessionId === sessionId &&
      this.current(owner)
    );
  }

  private onInner(
    fp: string,
    conn: ComputerConnection,
    m: InnerMessageLoose,
    envelopeBytes: number,
  ): void {
    if (this.conns.get(fp) !== conn) return;
    const store = useConnectionsStore.getState();
    if (m.type.startsWith("stream.")) {
      const owner = this.active;
      if (
        owner?.connection === conn &&
        owner.stream &&
        this.current(owner) &&
        "subscriptionId" in m &&
        m.subscriptionId === owner.subscriptionId
      ) {
        try {
          owner.stream.receive(m as StreamMessage, envelopeBytes);
        } finally {
          this.publishOwner(owner);
        }
      }
      return;
    }
    switch (m.type) {
      case "hello":
        store.patch(fp, () => ({ hello: m }));
        useComputersStore.getState().update(fp, {
          name: m.computerName,
          accent: m.accent,
          lastSeenAt: new Date().toISOString(),
        });
        return;
      case "sessions":
        this.sessionGenerations.set(conn, conn.handshakeGeneration);
        store.patch(fp, () => ({ sessions: m.list }));
        onSessionsMessage(fp, m.list, this.deps?.titleStorage);
        if (this.desired?.fp === fp && !m.list.some((s) => s.id === this.desired?.sessionId)) {
          this.retireActive();
        } else if (this.desired?.fp === fp) {
          this.reconcileView();
        }
        return;
      case "screen.snapshot":
        if (!this.acceptLegacy(fp, conn, m.sessionId)) return;
        store.patch(fp, (c) => ({
          view: {
            sessionId: m.sessionId,
            view: applySnapshotKeyed(
              c.view?.sessionId === m.sessionId ? c.view.view : undefined,
              m,
            ),
          },
        }));
        return;
      case "screen.diff": {
        if (!this.acceptLegacy(fp, conn, m.sessionId)) return;
        // Compute first, patch second, send third: no side effects inside the reducer.
        const cur = store.read(fp);
        if (cur.view?.sessionId !== m.sessionId) return;
        const { view, gap } = applyDiffKeyed(cur.view.view, m);
        if (gap) {
          const conn = this.conns.get(fp);
          if (conn) {
            conn.send({
              type: "snapshot.get",
              reqId: conn.newReqId(),
              sessionId: m.sessionId,
            });
          }
          return;
        }
        store.patch(fp, () => ({ view: { sessionId: m.sessionId, view } }));
        return;
      }
      case "history":
        if (!this.acceptLegacy(fp, conn, m.sessionId)) return;
        store.patch(fp, (c) => ({
          oldestAvailable: { ...c.oldestAvailable, [m.sessionId]: m.oldestAvailable },
          view:
            c.view?.sessionId === m.sessionId
              ? {
                  sessionId: m.sessionId,
                  view: prependHistoryKeyed(c.view.view, m.lines, m.before),
                }
              : c.view,
        }));
        return;
      case "event": {
        const title = store.read(fp).sessions.find((s) => s.id === m.sessionId)?.title ?? "Session";
        store.patch(fp, (c) => ({
          events: {
            ...c.events,
            [m.sessionId]: [...(c.events[m.sessionId] ?? []).slice(-19), m],
          },
          unread: { ...c.unread, [m.sessionId]: (c.unread[m.sessionId] ?? 0) + 1 },
        }));
        this.deps?.onForegroundEvent?.(fp, title, m.kind);
        return;
      }
      case "ack":
        store.patch(fp, (c) => {
          const rest = { ...c.pendingInputs };
          delete rest[m.reqId];
          return { pendingInputs: rest };
        });
        return;
      default:
        return;
    }
  }
}

export const connectionManager = new Manager();
