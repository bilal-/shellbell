import { CONVERSATION_FEATURE, encodeCbor } from "@shellbell/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagerDeps } from "../src/net/manager";
import type { MobileStreamSnapshot } from "../src/net/mobile-screen-stream";
import type { NetworkSource } from "../src/net/network-monitor";

/**
 * `manager.ts` pulls in `react-native` (`AppState`) and, via `store/computers.ts`,
 * `expo-sqlite/kv-store` — neither runs under vitest/node. These mocks are the seam: `AppState`
 * exposes a controllable `currentState` plus a real listener list (via `__setAppState`, a
 * test-only escape hatch) so `connectAll`'s generation guard can be driven deterministically
 * without a real device or a real timer race.
 */
vi.mock("react-native", () => {
  let currentState: string = "active";
  const listeners: Array<(s: string) => void> = [];
  return {
    AppState: {
      get currentState() {
        return currentState;
      },
      addEventListener: (_event: string, cb: (s: string) => void) => {
        listeners.push(cb);
        return {
          remove: () => {
            const i = listeners.indexOf(cb);
            if (i >= 0) listeners.splice(i, 1);
          },
        };
      },
    },
    __setAppState: (s: string) => {
      currentState = s;
      for (const cb of [...listeners]) cb(s);
    },
  };
});

vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: () => null,
    setItemSync: () => {},
  },
}));

vi.mock("../src/identity/keys", () => ({
  loadPairSecret: vi.fn(),
}));

interface ConnOpts {
  relayUrl: string;
  kPair: Uint8Array;
  computerFp: string;
  onInner: (m: { type: string; [k: string]: unknown }, envelopeBytes?: number) => void;
  onMalformedConversation?: (subscriptionId: string) => void;
  onStatus: (s: string, extra?: unknown) => void;
  onTransport?: (state: {
    route: "relay" | "direct" | null;
    ready: boolean;
    phase: string;
    retryPending: boolean;
    lastFailure: null;
  }) => void;
  pushToken?: () => Promise<{
    token: string;
    platform: "ios" | "android";
    enabled: boolean;
  } | null>;
}

interface RecordedConnection {
  networkChanged: ReturnType<typeof vi.fn>;
  relayUrl: string;
  opts: ConnOpts;
  handshakeGeneration: number;
  online: boolean;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  send: ReturnType<typeof vi.fn>;
  sendForHandshake: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  newReqId: ReturnType<typeof vi.fn>;
  sendPushToken: ReturnType<typeof vi.fn<(token: unknown) => void>>;
  unpairSelf: ReturnType<typeof vi.fn>;
  pendingReqIds: () => string[];
}

const created: RecordedConnection[] = [];
vi.mock("../src/net/connection", () => ({
  ComputerConnection: vi.fn().mockImplementation(function (this: unknown, opts: ConnOpts) {
    const inst: RecordedConnection = {
      networkChanged: vi.fn(),
      relayUrl: opts.relayUrl as string,
      opts,
      handshakeGeneration: 0,
      online: true,
      connect: vi.fn(),
      close: vi.fn(),
      send: vi.fn(() => true),
      sendForHandshake: vi.fn(() => true),
      request: vi.fn(() => new Promise(() => {})),
      newReqId: vi.fn(() => "req1"),
      sendPushToken: vi.fn(),
      unpairSelf: vi.fn(),
      pendingReqIds: () => [],
    };
    created.push(inst);
    return inst;
  }),
}));

const setAppState = async (s: "active" | "background" | "inactive") => {
  const rn = (await import("react-native")) as unknown as { __setAppState: (s: string) => void };
  rn.__setAppState(s);
};

const computer = {
  fp: "f1",
  name: "MBP",
  accent: "emerald",
  relayUrl: "ws://relay.invalid",
  pairedAt: new Date().toISOString(),
  lastSeenAt: null,
  pushEnabled: false,
};

describe("ConnectionManager", () => {
  beforeEach(async () => {
    vi.resetModules();
    created.length = 0;
    await setAppState("active");
    const { useComputersStore } = await import("../src/store/computers");
    useComputersStore.setState({ computers: [computer] });
  });

  async function readyManager(
    pushToken: ManagerDeps["pushToken"] = async () => null,
    network?: NetworkSource,
  ) {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager, LOST_INPUT_TOAST } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    connectionManager.start({
      network,
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken,
    });
    await vi.waitFor(() => expect(created).toHaveLength(1));
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");
    return { connectionManager, conn, useConnectionsStore, LOST_INPUT_TOAST };
  }

  it("refreshes the existing paired connection immediately on Wi-Fi/cellular handoff", async () => {
    const { networkSource, useNetworkStore } = await import("../src/store/network");
    const { networkSnapshot } = await import("../src/net/network-monitor");
    useNetworkStore.getState().update(networkSnapshot({ type: "WIFI", isInternetReachable: true }));
    const { connectionManager, conn } = await readyManager(undefined, networkSource);
    try {
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "CELLULAR", isInternetReachable: true }));
      expect(conn.networkChanged).toHaveBeenCalledExactlyOnceWith(true);
      expect(created).toHaveLength(1);
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "CELLULAR", isInternetReachable: true }));
      expect(conn.networkChanged).toHaveBeenCalledOnce();
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "WIFI", isInternetReachable: true }));
      expect(conn.networkChanged).toHaveBeenCalledTimes(2);
    } finally {
      connectionManager.stop();
    }
  });

  it("pauses an absent network and immediately resumes on restoration", async () => {
    const { networkSource, useNetworkStore } = await import("../src/store/network");
    const { networkSnapshot } = await import("../src/net/network-monitor");
    const { connectionManager, conn } = await readyManager(undefined, networkSource);
    try {
      useNetworkStore.getState().update(networkSnapshot({ type: "NONE" }));
      expect(conn.networkChanged).toHaveBeenLastCalledWith(false);
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "WIFI", isInternetReachable: true }));
      expect(conn.networkChanged).toHaveBeenLastCalledWith(true);
      expect(created).toHaveLength(1);
      // A private LAN can remain useful even when Android cannot validate Internet access.
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "WIFI", isInternetReachable: false }));
      expect(conn.networkChanged).toHaveBeenCalledTimes(2);
      connectionManager.stop();
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "CELLULAR", isInternetReachable: true }));
      expect(conn.networkChanged).toHaveBeenCalledTimes(2);
    } finally {
      connectionManager.stop();
    }
  });

  it("does not dial an absent network on cold start and connects when it returns", async () => {
    const { networkSource, useNetworkStore } = await import("../src/store/network");
    const { networkSnapshot } = await import("../src/net/network-monitor");
    useNetworkStore.getState().update(networkSnapshot({ type: "NONE" }));
    const { loadPairSecret } = await import("../src/identity/keys");
    vi.mocked(loadPairSecret).mockResolvedValue({ kPair: new Uint8Array(32) } as never);
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      network: networkSource,
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "phone",
      appVersion: "test",
      pushToken: async () => null,
    });
    try {
      expect(created).toHaveLength(0);
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "CELLULAR", isInternetReachable: true }));
      await vi.waitFor(() => expect(created).toHaveLength(1));
    } finally {
      connectionManager.stop();
    }
  });

  it("fences a pending pair-secret read when the network disappears", async () => {
    const { networkSource, useNetworkStore } = await import("../src/store/network");
    const { networkSnapshot } = await import("../src/net/network-monitor");
    const { connectionManager } = await readyManager(undefined, networkSource);
    const { loadPairSecret } = await import("../src/identity/keys");
    const { useComputersStore } = await import("../src/store/computers");
    const secret = { kPair: new Uint8Array(32) } as never;
    let resolve!: (value: typeof secret) => void;
    vi.mocked(loadPairSecret).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    try {
      useComputersStore.getState().add({ ...computer, fp: "f2" });
      await vi.waitFor(() => expect(loadPairSecret).toHaveBeenCalledWith("f2"));
      useNetworkStore.getState().update(networkSnapshot({ type: "NONE" }));
      resolve(secret);
      await Promise.resolve();
      expect(created).toHaveLength(1);
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "CELLULAR", isInternetReachable: true }));
      await vi.waitFor(() => expect(created).toHaveLength(2));
      expect(created[1]?.opts.computerFp).toBe("f2");
    } finally {
      connectionManager.stop();
    }
  });

  it("reconnects only the edited computer to its saved relay without replacing its pair", async () => {
    const { connectionManager, conn } = await readyManager();
    const { useComputersStore } = await import("../src/store/computers");
    try {
      useComputersStore.getState().update(computer.fp, { relayUrl: "wss://new.example.com" });
      await vi.waitFor(() => expect(created).toHaveLength(2));
      expect(conn.close).toHaveBeenCalledWith("user");
      expect(created[1]!.opts.relayUrl).toBe("wss://new.example.com");
      expect(created[1]!.opts.kPair).toEqual(conn.opts.kPair);
      expect(useComputersStore.getState().computers[0]!.pairedAt).toBe(computer.pairedAt);
      conn.opts.onStatus("online");
      expect(connectionManager.get(computer.fp)).toBe(created[1]);
    } finally {
      connectionManager.stop();
    }
  });

  const conversationHello = (enabled = true, features = [CONVERSATION_FEATURE]) => ({
    type: "hello",
    agentVersion: "test",
    computerName: "Computer",
    accent: "emerald",
    features,
    conversationEnabled: enabled,
  });
  const wireId = (value: string) => value.padStart(22, "0");
  const conversationBatch = (subscriptionId: string) => ({
    type: "conversation.batch",
    subscriptionId,
    generation: wireId("generation"),
    batchId: wireId("batch"),
    baseRevision: 0,
    revision: 1,
    operation: "reset",
    entries: [{ id: wireId("entry"), kind: "assistant", text: "Growing reply" }],
    olderCursor: wireId("cursor"),
    history: "unloaded",
  });
  const conversationSubscriptions = (conn: RecordedConnection) =>
    conn.sendForHandshake.mock.calls
      .map(([, message]) => message)
      .filter((message) => message.type === "conversation.subscribe");

  async function readyConversation() {
    const f = await readyManager();
    f.conn.handshakeGeneration = 1;
    f.conn.opts.onStatus("online");
    f.conn.opts.onInner(conversationHello());
    const lease = f.connectionManager.claimView("f1", "herdr:a");
    const subscription = conversationSubscriptions(f.conn).at(-1);
    if (!subscription) throw new Error("missing conversation subscription");
    const batch = conversationBatch(subscription.subscriptionId);
    f.conn.opts.onInner(batch, encodeCbor(batch).byteLength);
    return { ...f, lease, batch };
  }

  it("subscribes only after current-handshake feature negotiation and owner opt-in", async () => {
    const { connectionManager, conn } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "herdr:a");
      expect(conversationSubscriptions(conn)).toHaveLength(0);
      conn.opts.onInner(conversationHello(false));
      expect(conversationSubscriptions(conn)).toHaveLength(0);
      conn.opts.onInner(conversationHello(true, []));
      expect(conversationSubscriptions(conn)).toHaveLength(0);
      conn.opts.onInner(conversationHello());
      expect(conversationSubscriptions(conn)).toHaveLength(1);
      conn.handshakeGeneration = 2;
      conn.opts.onStatus("online");
      expect(conversationSubscriptions(conn)).toHaveLength(1);
      conn.opts.onInner(conversationHello());
      expect(conversationSubscriptions(conn)).toHaveLength(2);
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("keeps Conversation independent of raw terminal refresh and fences UI callbacks", async () => {
    const { connectionManager, conn, lease, useConnectionsStore } = await readyConversation();
    try {
      const revision = lease.conversationRevision();
      const entries = useConnectionsStore.getState().read("f1").conversationView?.snapshot.entries;
      expect(entries).toHaveLength(1);
      lease.setRawStream(false);
      lease.setRawStream(true);
      lease.refreshHistory();
      expect(lease.conversationRevision()).toBe(revision);
      expect(conversationSubscriptions(conn)).toHaveLength(1);
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot.entries).toBe(
        entries,
      );
      lease.setConversation(false);
      expect(useConnectionsStore.getState().read("f1").conversationView).toBeUndefined();
      lease.setConversation(true);
      expect(conversationSubscriptions(conn)).toHaveLength(2);
      expect(lease.requestOlderConversation(revision)).toBe(false);
      expect(lease.refreshConversation(revision)).toBe(false);
    } finally {
      connectionManager.stop();
    }
  });

  it("clears on owner opt-out, rejects late data, and still acknowledges clear", async () => {
    const { connectionManager, conn, lease, batch, useConnectionsStore } =
      await readyConversation();
    try {
      const revision = lease.conversationRevision();
      conn.opts.onInner(conversationHello(false));
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot).toMatchObject({
        state: "disabled",
        entries: [],
      });
      conn.opts.onInner(batch, encodeCbor(batch).byteLength);
      const clear = {
        type: "conversation.clear",
        subscriptionId: batch.subscriptionId,
        clearId: wireId("clear"),
        reason: "changed",
      };
      conn.opts.onInner(clear, encodeCbor(clear).byteLength);
      expect(conn.sendForHandshake).toHaveBeenCalledWith(1, {
        type: "conversation.cleared",
        subscriptionId: batch.subscriptionId,
        clearId: clear.clearId,
      });
      expect(lease.conversationRevision()).toBe(revision);
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot).toMatchObject({
        state: "disabled",
        entries: [],
      });
      expect(lease.requestOlderConversation(revision)).toBe(false);
      expect(
        conn.sendForHandshake.mock.calls.some(([, m]) => m.type === "conversation.refresh"),
      ).toBe(false);
    } finally {
      connectionManager.stop();
    }
  });

  it.each(["background", "route", "revoke", "leave", "session"])(
    "discards Conversation on %s",
    async (action) => {
      const { connectionManager, conn, lease, batch, useConnectionsStore } =
        await readyConversation();
      try {
        if (action === "background") await setAppState("background");
        if (action === "route")
          conn.opts.onTransport?.({
            route: "direct",
            ready: false,
            phase: "paused",
            retryPending: true,
            lastFailure: null,
          });
        if (action === "revoke") conn.opts.onStatus("offline", { error: "unpaired" });
        if (action === "leave") lease.release();
        if (action === "session") conn.opts.onInner({ type: "sessions", list: [] });
        conn.opts.onInner(batch, encodeCbor(batch).byteLength);
        expect(useConnectionsStore.getState().read("f1").conversationView).toBeUndefined();
        expect(lease.conversationRevision()).toBeNull();
      } finally {
        connectionManager.stop();
      }
    },
  );

  it("rejects old Conversation frames after reconnect and waits for a fresh hello", async () => {
    const { connectionManager, conn, lease, batch, useConnectionsStore } =
      await readyConversation();
    try {
      const revision = lease.conversationRevision();
      conn.handshakeGeneration = 2;
      conn.opts.onStatus("online");
      conn.opts.onInner(batch, encodeCbor(batch).byteLength);
      expect(useConnectionsStore.getState().read("f1").conversationView).toBeUndefined();
      conn.opts.onInner(conversationHello());
      expect(conversationSubscriptions(conn)).toHaveLength(2);
      conn.opts.onInner(batch, encodeCbor(batch).byteLength);
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot.entries).toEqual(
        [],
      );
      expect(lease.refreshConversation(revision)).toBe(false);
    } finally {
      connectionManager.stop();
    }
  });

  it("starts a fresh empty Conversation when the owner opts back in", async () => {
    const { connectionManager, conn, lease, batch, useConnectionsStore } =
      await readyConversation();
    try {
      const prior = lease.conversationRevision();
      conn.opts.onInner(conversationHello(false));
      conn.opts.onInner(conversationHello());
      const current = conversationSubscriptions(conn).at(-1)!;
      expect(current.subscriptionId).not.toBe(batch.subscriptionId);
      expect(lease.conversationRevision()).not.toBe(prior);
      conn.opts.onInner(batch, encodeCbor(batch).byteLength);
      expect(
        useConnectionsStore.getState().read("f1").conversationView?.snapshot.entries,
      ).toHaveLength(0);
      const next = conversationBatch(current.subscriptionId);
      conn.opts.onInner(next, encodeCbor(next).byteLength);
      expect(
        useConnectionsStore.getState().read("f1").conversationView?.snapshot.entries,
      ).toHaveLength(1);
    } finally {
      connectionManager.stop();
    }
  });

  it("does not resubscribe on session updates after source-disabled status precedes hello", async () => {
    const { connectionManager, conn, batch } = await readyConversation();
    try {
      const disabled = {
        type: "conversation.status",
        subscriptionId: batch.subscriptionId,
        state: "disabled",
      };
      conn.opts.onInner(disabled, encodeCbor(disabled).byteLength);
      for (let i = 0; i < 3; i++)
        conn.opts.onInner({
          type: "sessions",
          list: [{ id: "herdr:a", backend: "herdr", title: "Session", state: "working" }],
        });
      expect(conversationSubscriptions(conn)).toHaveLength(1);
    } finally {
      connectionManager.stop();
    }
  });

  it("recovers only the current consented owner after an authenticated malformed message", async () => {
    const { connectionManager, conn, batch, useConnectionsStore } = await readyConversation();
    try {
      conn.opts.onMalformedConversation?.(wireId("stale"));
      expect(
        useConnectionsStore.getState().read("f1").conversationView?.snapshot.entries,
      ).toHaveLength(1);
      conn.opts.onMalformedConversation?.(batch.subscriptionId);
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot).toMatchObject({
        entries: [],
        state: "unavailable",
      });
      expect(conn.sendForHandshake).toHaveBeenCalledWith(1, {
        type: "conversation.refresh",
        subscriptionId: batch.subscriptionId,
      });
      const count = conn.sendForHandshake.mock.calls.length;
      conn.opts.onInner(conversationHello(false));
      conn.opts.onMalformedConversation?.(batch.subscriptionId);
      expect(conn.sendForHandshake).toHaveBeenCalledTimes(count);
    } finally {
      connectionManager.stop();
    }
  });

  it("retries a refused Conversation subscribe without coupling terminal progress", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    vi.useFakeTimers();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      conn.opts.onInner(conversationHello());
      conn.sendForHandshake.mockImplementation(
        (_generation, message) => message.type !== "conversation.subscribe",
      );
      connectionManager.claimView("f1", "herdr:a");
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot.state).toBe(
        "unavailable",
      );
      expect(conversationSubscriptions(conn)).toHaveLength(1);
      conn.sendForHandshake.mockReturnValue(true);
      await vi.advanceTimersByTimeAsync(1000);
      expect(conversationSubscriptions(conn)).toHaveLength(2);
      expect(useConnectionsStore.getState().read("f1").conversationView?.snapshot.state).toBe(
        "checking",
      );
    } finally {
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("does not republish an old Conversation after a reentrant focus change", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    conn.handshakeGeneration = 1;
    conn.opts.onStatus("online");
    conn.opts.onInner(conversationHello());
    let switched = false;
    const unsubscribe = useConnectionsStore.subscribe((state) => {
      if (!switched && state.byComputer.f1?.conversationView?.sessionId === "herdr:a") {
        switched = true;
        connectionManager.claimView("f1", "herdr:b");
      }
    });
    try {
      const old = connectionManager.claimView("f1", "herdr:a");
      expect(useConnectionsStore.getState().read("f1").conversationView?.sessionId).toBe("herdr:b");
      old.release();
      expect(useConnectionsStore.getState().read("f1").conversationView?.sessionId).toBe("herdr:b");
      expect(conversationSubscriptions(conn).at(-1)?.sessionId).toBe("herdr:b");
    } finally {
      unsubscribe();
      connectionManager.stop();
    }
  });

  it("owns only the latest focused route and ignores an older route release", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const a = connectionManager.claimView("f1", "tmux:a");
      const b = connectionManager.claimView("f1", "tmux:b");
      const before = conn.sendForHandshake.mock.calls.length;
      a.release();
      expect(a.requestOlder()).toBe(false);
      expect(conn.sendForHandshake).toHaveBeenCalledTimes(before);
      expect(conn.sendForHandshake.mock.calls.at(-1)?.[1]).toMatchObject({
        type: "stream.subscribe",
        sessionId: "tmux:b",
      });
      expect(useConnectionsStore.getState().read("f1").boundedView?.sessionId).toBe("tmux:b");
      b.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("applies a Reading view switch made while the app was briefly inactive", async () => {
    const { connectionManager, conn } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const subscribes = () =>
        conn.sendForHandshake.mock.calls
          .map(([, m]) => m)
          .filter((m) => m.type === "stream.subscribe");
      expect(subscribes().at(-1)).toMatchObject({ mode: "vt" });
      await setAppState("inactive");
      lease.setRawStream(false);
      await setAppState("active");
      expect(subscribes().at(-1)).not.toHaveProperty("mode");
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("sends an owned cancellation when focus leaves a bounded subscription", async () => {
    const { connectionManager, conn } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const subscribe = conn.sendForHandshake.mock.calls.find(
        ([, m]) => m.type === "stream.subscribe",
      )?.[1];
      lease.release();
      expect(conn.sendForHandshake).toHaveBeenCalledWith(1, {
        type: "stream.cancel",
        subscriptionId: subscribe.subscriptionId,
      });
    } finally {
      connectionManager.stop();
    }
  });

  it("retires an accepted key epoch even when status remains online", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      const lease = connectionManager.claimView("f1", "tmux:a");
      conn.opts.onStatus("online");
      const first = conn.sendForHandshake.mock.calls[0]?.[1] as { subscriptionId: string };
      conn.handshakeGeneration = 2;
      conn.opts.onStatus("online");
      const second = conn.sendForHandshake.mock.calls.find(
        ([generation, message]) => generation === 2 && message.type === "stream.subscribe",
      )?.[1] as { subscriptionId: string };
      expect(second.subscriptionId).not.toBe(first.subscriptionId);
      const before = useConnectionsStore.getState().read("f1").boundedView;
      conn.opts.onInner(
        { type: "stream.error", subscriptionId: first.subscriptionId, reason: "unavailable" },
        100,
      );
      expect(useConnectionsStore.getState().read("f1").boundedView).toBe(before);
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("does not let a reentrant focus claim get overwritten by the old publisher", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    const schedule = vi.spyOn(globalThis, "setTimeout");
    conn.handshakeGeneration = 1;
    conn.opts.onStatus("online");
    let next: ReturnType<typeof connectionManager.claimView> | undefined;
    const unsubscribe = useConnectionsStore.subscribe((state) => {
      if (state.byComputer.f1?.boundedView?.sessionId === "tmux:a" && !next) {
        next = connectionManager.claimView("f1", "tmux:b");
      }
    });
    try {
      const first = connectionManager.claimView("f1", "tmux:a");
      expect(useConnectionsStore.getState().read("f1").boundedView?.sessionId).toBe("tmux:b");
      expect(conn.sendForHandshake.mock.calls.at(-1)?.[1]).toMatchObject({
        type: "stream.subscribe",
        sessionId: "tmux:b",
      });
      expect(schedule).toHaveBeenCalledTimes(1);
      const count = conn.sendForHandshake.mock.calls.length;
      first.release();
      expect(conn.sendForHandshake).toHaveBeenCalledTimes(count);
    } finally {
      unsubscribe();
      schedule.mockRestore();
      next?.release();
      connectionManager.stop();
    }
  });

  it("keeps C's view when claim B reentrantly becomes claim C during A cancellation", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    let c: ReturnType<typeof connectionManager.claimView> | undefined;
    try {
      vi.useFakeTimers();
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const a = connectionManager.claimView("f1", "tmux:a");
      conn.sendForHandshake.mockImplementation((_generation, message) => {
        if (message.type === "stream.cancel" && !c) c = connectionManager.claimView("f1", "tmux:c");
        return true;
      });
      const b = connectionManager.claimView("f1", "tmux:b");
      expect(useConnectionsStore.getState().read("f1").boundedView?.sessionId).toBe("tmux:c");
      expect(conn.sendForHandshake.mock.calls.at(-1)?.[1]).toMatchObject({
        type: "stream.subscribe",
        sessionId: "tmux:c",
      });
      expect(c?.requestOlder()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
      a.release();
      b.release();
      expect(useConnectionsStore.getState().read("f1").boundedView?.sessionId).toBe("tmux:c");
    } finally {
      c?.release();
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("keeps C's view when release A reentrantly claims C during cancellation", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    let c: ReturnType<typeof connectionManager.claimView> | undefined;
    try {
      vi.useFakeTimers();
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const a = connectionManager.claimView("f1", "tmux:a");
      conn.sendForHandshake.mockImplementation((_generation, message) => {
        if (message.type === "stream.cancel" && !c) c = connectionManager.claimView("f1", "tmux:c");
        return true;
      });
      a.release();
      expect(useConnectionsStore.getState().read("f1").boundedView?.sessionId).toBe("tmux:c");
      expect(c?.requestOlder()).toBe(true);
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      c?.release();
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("keeps connections through a background shorter than the grace period", async () => {
    const { BACKGROUND_GRACE_MS } = await import("../src/net/manager");
    expect(BACKGROUND_GRACE_MS).toBe(5000);
    const { connectionManager, conn } = await readyManager();
    try {
      vi.useFakeTimers();
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const subscribes = () =>
        conn.sendForHandshake.mock.calls.filter(([, m]) => m.type === "stream.subscribe").length;
      expect(subscribes()).toBe(1);
      await setAppState("background");
      // Nothing new starts during the grace window.
      conn.opts.onStatus("online");
      expect(subscribes()).toBe(1);
      vi.advanceTimersByTime(BACKGROUND_GRACE_MS - 1);
      expect(conn.close).not.toHaveBeenCalled();
      await setAppState("active");
      // Keep the connection, but revalidate the terminal source after the pause.
      expect(conn.sendForHandshake.mock.calls.some(([, m]) => m.type === "stream.cancel")).toBe(
        true,
      );
      expect(subscribes()).toBe(2);
      vi.advanceTimersByTime(BACKGROUND_GRACE_MS * 2);
      expect(conn.close).not.toHaveBeenCalled();
      expect(created).toHaveLength(1);
      lease.release();
    } finally {
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("resubscribes a view whose output arrived during the grace window", async () => {
    const { connectionManager, conn } = await readyManager();
    try {
      vi.useFakeTimers();
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const first = conn.sendForHandshake.mock.calls.find(
        ([, m]) => m.type === "stream.subscribe",
      )?.[1] as { subscriptionId: string };
      await setAppState("background");
      conn.opts.onInner(
        { type: "stream.error", subscriptionId: first.subscriptionId, reason: "unavailable" },
        100,
      );
      await setAppState("active");
      const subscribes = conn.sendForHandshake.mock.calls.filter(
        ([, m]) => m.type === "stream.subscribe",
      );
      expect(subscribes).toHaveLength(2);
      lease.release();
    } finally {
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("closes every connection once the grace period passes in the background", async () => {
    const { BACKGROUND_GRACE_MS, connectionManager, conn } = await (async () => {
      const ready = await readyManager();
      const { BACKGROUND_GRACE_MS } = await import("../src/net/manager");
      return { ...ready, BACKGROUND_GRACE_MS };
    })();
    try {
      vi.useFakeTimers();
      await setAppState("background");
      await setAppState("inactive");
      vi.advanceTimersByTime(BACKGROUND_GRACE_MS - 1);
      expect(conn.close).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(conn.close).toHaveBeenCalledExactlyOnceWith("background");
      await setAppState("active");
      await vi.waitFor(() => expect(created).toHaveLength(2));
    } finally {
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("closes at once when the network changes during the grace window", async () => {
    const { networkSource, useNetworkStore } = await import("../src/store/network");
    const { networkSnapshot } = await import("../src/net/network-monitor");
    useNetworkStore.getState().update(networkSnapshot({ type: "WIFI", isInternetReachable: true }));
    const { connectionManager, conn } = await readyManager(undefined, networkSource);
    try {
      vi.useFakeTimers();
      await setAppState("background");
      useNetworkStore
        .getState()
        .update(networkSnapshot({ type: "CELLULAR", isInternetReachable: true }));
      expect(conn.close).toHaveBeenCalledExactlyOnceWith("background");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("keeps route demand across background and fences an old connection instance", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const oldSubscription = conn.sendForHandshake.mock.calls.find(
        ([, message]) => message.type === "stream.subscribe",
      )?.[1] as { subscriptionId: string };
      vi.useFakeTimers();
      await setAppState("background");
      const { BACKGROUND_GRACE_MS } = await import("../src/net/manager");
      vi.advanceTimersByTime(BACKGROUND_GRACE_MS);
      vi.useRealTimers();
      await setAppState("active");
      await vi.waitFor(() => expect(created).toHaveLength(2));
      const replacement = created[1];
      if (!replacement) throw new Error("missing replacement");
      replacement.handshakeGeneration = 2;
      replacement.opts.onStatus("online");
      expect(
        replacement.sendForHandshake.mock.calls.filter(([, m]) => m.type === "stream.subscribe"),
      ).toHaveLength(1);
      const current = useConnectionsStore.getState().read("f1").boundedView;
      conn.opts.onStatus("offline");
      conn.opts.onInner(
        {
          type: "stream.error",
          subscriptionId: oldSubscription.subscriptionId,
          reason: "unavailable",
        },
        100,
      );
      expect(useConnectionsStore.getState().read("f1").boundedView).toBe(current);
      expect(useConnectionsStore.getState().read("f1").status).toBe("online");
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("publishes a real bounded receiver snapshot for the focused session", async () => {
    const { prepareStreamSnapshot, STREAM_LIMITS, StreamSender } = await import(
      "@shellbell/protocol"
    );
    const { projectStreamRows } = await import("../src/screen/stream-presentation");
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      conn.handshakeGeneration = 3;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const subscriptionId = conn.sendForHandshake.mock.calls.find(
        ([, m]) => m.type === "stream.subscribe",
      )?.[1].subscriptionId as string;
      const chunks: Array<{ type: string; [key: string]: unknown }> = [];
      const sender = new StreamSender({
        subscriptionId,
        sessionId: "tmux:a",
        now: () => Date.now(),
        newTransferId: () => "T".repeat(22),
        send: (chunk) => {
          chunks.push(chunk);
          return true;
        },
      });
      const prepared = prepareStreamSnapshot({
        cols: 40,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [{ r: [{ t: "visible" }] }],
        scrollbackTotal: 5,
        gen: 1,
      });
      if (!prepared.ok) throw new Error("fixture rejected");
      expect(sender.offer({ kind: "snapshot", generation: 1 }, prepared.bytes).accepted).toBe(true);
      sender.pump();
      for (const chunk of chunks) conn.opts.onInner(chunk, 200);
      const stream = useConnectionsStore.getState().read("f1").boundedView?.snapshot;
      expect(stream?.status).toBe("live");
      expect(projectStreamRows(stream!).at(-1)).toMatchObject({ kind: "line", liveRowIndex: 0 });
      conn.opts.onInner(chunks[0]!, STREAM_LIMITS.envelopeBytes + 1);
      expect(useConnectionsStore.getState().read("f1").boundedView?.snapshot).toMatchObject({
        status: "closed",
        error: "invalid-transfer",
      });
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("retains a complete same-session viewport for presentation until replacement output arrives", async () => {
    const { prepareStreamSnapshot, STREAM_LIMITS, StreamSender } = await import(
      "@shellbell/protocol"
    );
    const { projectStreamRows } = await import("../src/screen/stream-presentation");
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      vi.useFakeTimers();
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const firstId = conn.sendForHandshake.mock.calls.find(
        ([, message]) => message.type === "stream.subscribe",
      )?.[1].subscriptionId;
      const chunks: Array<{ type: string; [key: string]: unknown }> = [];
      const sender = new StreamSender({
        subscriptionId: firstId,
        sessionId: "tmux:a",
        now: () => Date.now(),
        newTransferId: () => "T".repeat(22),
        send: (chunk) => {
          chunks.push(chunk);
          return true;
        },
      });
      const prepared = prepareStreamSnapshot({
        cols: 40,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [{ r: [{ t: "last complete" }] }],
        scrollbackTotal: 5,
        gen: 7,
      });
      if (!prepared.ok) throw new Error("fixture rejected");
      sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes);
      sender.pump();
      for (const chunk of chunks) conn.opts.onInner(chunk, 200);
      conn.handshakeGeneration = 2;
      conn.opts.onStatus("online");
      const replacement = useConnectionsStore.getState().read("f1").boundedView;
      expect(replacement?.snapshot.screen).toBeUndefined();
      expect(replacement?.fallbackScreen?.lines[0]?.r[0]?.t).toBe("last complete");
      expect(
        projectStreamRows(replacement!.snapshot, replacement!.fallbackScreen).at(-1),
      ).toMatchObject({
        kind: "line",
        liveRowIndex: 0,
      });
      expect(lease.refreshHistory()).toBe(true);
      expect(
        useConnectionsStore.getState().read("f1").boundedView?.fallbackScreen?.lines[0]?.r[0]?.t,
      ).toBe("last complete");
      vi.advanceTimersByTime(STREAM_LIMITS.progressMs + 1);
      expect(useConnectionsStore.getState().read("f1").boundedView).toMatchObject({
        snapshot: { status: "closed", error: "stalled" },
        fallbackScreen: { lines: [{ r: [{ t: "last complete" }] }] },
      });
      // A new handshake resubscribes and keeps showing the last complete viewport meanwhile.
      conn.handshakeGeneration = 3;
      conn.opts.onStatus("online");
      expect(useConnectionsStore.getState().read("f1").boundedView).toMatchObject({
        snapshot: { status: "loading" },
        fallbackScreen: { lines: [{ r: [{ t: "last complete" }] }] },
      });
      expect(
        conn.sendForHandshake.mock.calls.some(
          ([generation, message]) => generation === 3 && message.type === "stream.subscribe",
        ),
      ).toBe(true);
      lease.release();
    } finally {
      connectionManager.stop();
      vi.useRealTimers();
    }
  });

  it("drops terminal history on the old computer while keeping its nonterminal state", async () => {
    const { connectionManager, useConnectionsStore } = await readyManager();
    try {
      const a = connectionManager.claimView("f1", "tmux:a");
      useConnectionsStore.getState().patch("f1", () => ({
        boundedView: {
          sessionId: "tmux:a",
          snapshot: { status: "live" } as MobileStreamSnapshot,
        },
        history: ["command"],
        pendingInputs: { input: { at: 1, sessionId: "tmux:a" } },
      }));
      const b = connectionManager.claimView("f2", "tmux:b");
      const old = useConnectionsStore.getState().read("f1");
      expect(old.boundedView).toBeUndefined();
      expect(old.history).toEqual(["command"]);
      expect(old.pendingInputs.input?.sessionId).toBe("tmux:a");
      a.release();
      b.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("keeps a focused session that an incomplete list leaves out", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const subscribes = () =>
        conn.sendForHandshake.mock.calls.filter(([, m]) => m.type === "stream.cancel").length;
      const before = subscribes();
      // The computer had more sessions than one message holds: the focused one may still exist.
      conn.opts.onInner({ type: "sessions", list: [], complete: false });
      expect(useConnectionsStore.getState().read("f1").sessionsComplete).toBe(false);
      expect(subscribes()).toBe(before);
      // A complete list that leaves it out ends it.
      conn.opts.onInner({ type: "sessions", list: [], complete: true });
      expect(subscribes()).toBeGreaterThan(before);
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("recreates a focused subscription if its session reappears", async () => {
    const { connectionManager, conn } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      conn.opts.onInner({ type: "sessions", list: [] });
      const previousCount = conn.sendForHandshake.mock.calls.filter(
        ([, m]) => m.type === "stream.subscribe",
      ).length;
      conn.opts.onInner({
        type: "sessions",
        list: [{ id: "tmux:a", title: "A", backend: "tmux", state: "running" }],
      });
      expect(
        conn.sendForHandshake.mock.calls.filter(([, m]) => m.type === "stream.subscribe"),
      ).toHaveLength(previousCount + 1);
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it("rejects old rendered actions after key replacement while current owner can recover", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    const { MobileScreenStream } = await import("../src/net/mobile-screen-stream");
    const skip = vi.spyOn(MobileScreenStream.prototype, "skipOversized");
    const protect = vi.spyOn(MobileScreenStream.prototype, "protectHistory");
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      const oldRevision = lease.revision();
      expect(oldRevision).not.toBeNull();
      conn.handshakeGeneration = 2;
      conn.opts.onStatus("online");
      const newRevision = lease.revision();
      expect(newRevision).not.toBeNull();
      expect(newRevision).not.toBe(oldRevision);
      const count = conn.sendForHandshake.mock.calls.length;
      expect(lease.skipOversized(oldRevision)).toBe(false);
      expect(lease.protectHistory("h:1", oldRevision)).toBe(false);
      expect(lease.refreshHistory(oldRevision)).toBe(false);
      expect(lease.retryOutput(oldRevision)).toBe(false);
      expect(lease.refreshHistory(null)).toBe(false);
      expect(conn.sendForHandshake.mock.calls).toHaveLength(count);
      expect(skip).not.toHaveBeenCalled();
      expect(protect).not.toHaveBeenCalled();
      lease.skipOversized(newRevision);
      lease.protectHistory("h:1", newRevision);
      expect(skip).toHaveBeenCalledOnce();
      expect(protect).toHaveBeenCalledOnce();
      expect(lease.retryOutput(newRevision)).toBe(true);
      const retrySubscribe = conn.sendForHandshake.mock.calls.filter(
        ([generation, message]) => generation === 2 && message.type === "stream.subscribe",
      );
      expect(retrySubscribe).toHaveLength(2);
      const { prepareStreamSnapshot, StreamSender } = await import("@shellbell/protocol");
      const retryMessage = retrySubscribe.at(-1)?.[1] as { subscriptionId: string } | undefined;
      if (!retryMessage) throw new Error("missing retry subscription");
      const retryId = retryMessage.subscriptionId;
      const chunks: Array<{ type: string; [key: string]: unknown }> = [];
      const sender = new StreamSender({
        subscriptionId: retryId,
        sessionId: "tmux:a",
        now: () => Date.now(),
        newTransferId: () => "T".repeat(22),
        send: (chunk) => {
          chunks.push(chunk);
          return true;
        },
      });
      const screen = prepareStreamSnapshot({
        cols: 40,
        rows: 1,
        cursor: { x: 0, y: 0 },
        lines: [{ r: [{ t: "recovered" }] }],
        scrollbackTotal: 0,
        gen: 1,
      });
      if (!screen.ok) throw new Error("screen fixture rejected");
      sender.offer({ kind: "snapshot", generation: 1 }, screen.bytes);
      sender.pump();
      for (const chunk of chunks) conn.opts.onInner(chunk, 200);
      expect(
        useConnectionsStore.getState().read("f1").boundedView?.snapshot.screen?.lines[0]?.r[0]?.t,
      ).toBe("recovered");
      expect(
        conn.sendForHandshake.mock.calls.filter(
          ([, message]) =>
            message.type === "stream.history.get" && message.subscriptionId === retryId,
        ),
      ).toHaveLength(0);
      expect(lease.refreshHistory(newRevision)).toBe(false);
      expect(lease.refreshHistory(lease.revision())).toBe(true);
      lease.release();
    } finally {
      skip.mockRestore();
      protect.mockRestore();
      connectionManager.stop();
    }
  });

  it("does not overwrite a replacement owner installed during refresh cancellation", async () => {
    const { connectionManager, conn } = await readyManager();
    try {
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      const lease = connectionManager.claimView("f1", "tmux:a");
      conn.sendForHandshake.mockImplementation((_generation, message) => {
        if (message.type === "stream.cancel" && conn.handshakeGeneration === 1) {
          conn.handshakeGeneration = 2;
          conn.opts.onStatus("online");
        }
        return true;
      });
      lease.refreshHistory();
      expect(
        conn.sendForHandshake.mock.calls.filter(
          ([generation, message]) => generation === 2 && message.type === "stream.subscribe",
        ),
      ).toHaveLength(1);
      lease.release();
    } finally {
      connectionManager.stop();
    }
  });

  it.each(["online status", "manager close"] as const)(
    "does not warn about lost input for history-only IDs on %s",
    async (path) => {
      const { connectionManager, conn, useConnectionsStore, LOST_INPUT_TOAST } =
        await readyManager();
      try {
        useConnectionsStore.getState().patch("f1", () => ({
          pendingInputs: { input: { at: 1, sessionId: "iterm2:s" } },
          toast: "Prior notice",
        }));
        if (path === "online status") {
          conn.opts.onStatus("online", { agentOnline: true, lostReqIds: ["history"] });
        } else {
          conn.pendingReqIds = () => ["history"];
          connectionManager.stop();
        }
        const state = useConnectionsStore.getState().read("f1");
        expect(state.pendingInputs).toEqual({ input: { at: 1, sessionId: "iterm2:s" } });
        expect(state.toast).toBe("Prior notice");
        expect(state.toast).not.toBe(LOST_INPUT_TOAST);
      } finally {
        connectionManager.stop();
      }
    },
  );

  it.each(["online status", "manager close"] as const)(
    "warns only for real pending input among mixed lost IDs on %s",
    async (path) => {
      const { connectionManager, conn, useConnectionsStore, LOST_INPUT_TOAST } =
        await readyManager();
      try {
        useConnectionsStore.getState().patch("f1", () => ({
          pendingInputs: {
            lostInput: { at: 1, sessionId: "iterm2:s" },
            stillPending: { at: 2, sessionId: "iterm2:s" },
          },
          toast: "Prior notice",
        }));
        const lostReqIds = ["history", "already-acked", "lostInput"];
        if (path === "online status") {
          conn.opts.onStatus("online", { agentOnline: true, lostReqIds });
        } else {
          conn.pendingReqIds = () => lostReqIds;
          connectionManager.stop();
        }
        const state = useConnectionsStore.getState().read("f1");
        expect(state.pendingInputs).toEqual({ stillPending: { at: 2, sessionId: "iterm2:s" } });
        expect(state.toast).toBe(LOST_INPUT_TOAST);
      } finally {
        connectionManager.stop();
      }
    },
  );

  it("does not turn an already-acknowledged input ID into a loss warning", async () => {
    const { connectionManager, conn, useConnectionsStore } = await readyManager();
    try {
      useConnectionsStore.getState().patch("f1", () => ({
        pendingInputs: { acked: { at: 1, sessionId: "iterm2:s" } },
        toast: "Prior notice",
      }));
      conn.opts.onInner({ type: "ack", reqId: "acked", ok: true });
      expect(useConnectionsStore.getState().read("f1").pendingInputs).toEqual({});
      conn.opts.onStatus("online", { agentOnline: true, lostReqIds: ["acked"] });
      expect(useConnectionsStore.getState().read("f1").toast).toBe("Prior notice");
    } finally {
      connectionManager.stop();
    }
  });

  it("isolates a corrupt pairing so other computers still connect", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    vi.mocked(loadPairSecret).mockImplementation(async (fp) => {
      if (fp === "f1") throw new Error("invalid stored minimum protocol version");
      return {
        kPair: new Uint8Array(32),
        computerEd25519Pub: new Uint8Array(32),
        computerX25519Pub: new Uint8Array(32),
      };
    });
    const { useComputersStore } = await import("../src/store/computers");
    useComputersStore.setState({ computers: [computer, { ...computer, fp: "f2" }] });
    const { useConnectionsStore } = await import("../src/store/connections");
    const { connectionManager } = await import("../src/net/manager");
    try {
      connectionManager.start({
        identity: {} as never,
        phoneFp: "p1",
        phoneName: "iPhone",
        appVersion: "t",
        pushToken: async () => null,
      });
      await vi.waitFor(() => expect(created).toHaveLength(1));
      expect(useConnectionsStore.getState().read("f1")).toMatchObject({
        status: "error",
        error: "storage",
      });
      expect(created[0]?.opts.computerFp).toBe("f2");
    } finally {
      connectionManager.stop();
    }
  });

  it("connects when the app is foreground throughout", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(1);
    expect(created[0]?.connect).toHaveBeenCalledTimes(1);
    connectionManager.stop();
  });

  it("uses the latest relay when settings change while pair keys are loading", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    let resolveSecret!: (v: unknown) => void;
    const secret = {
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    };
    (loadPairSecret as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecret = resolve;
          }),
      )
      .mockResolvedValue(secret);
    const { connectionManager } = await import("../src/net/manager");
    const { useComputersStore } = await import("../src/store/computers");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "Phone",
      appVersion: "t",
      pushToken: async () => null,
    });
    try {
      useComputersStore.getState().update(computer.fp, { relayUrl: "wss://latest.example.com" });
      resolveSecret(secret);
      await vi.waitFor(() => expect(created).toHaveLength(1));
      expect(created[0]!.opts.relayUrl).toBe("wss://latest.example.com");
    } finally {
      connectionManager.stop();
    }
  });

  it("backgrounded mid-await bails: no connection is ever created", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    let resolveSecret!: (v: unknown) => void;
    (loadPairSecret as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((r) => {
          resolveSecret = r;
        }),
    );
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    // `connectAll` is now suspended awaiting `loadPairSecret`; background before it resumes.
    await setAppState("background");
    resolveSecret({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(0);
    connectionManager.stop();
  });

  it("does not reconnect a removing computer when an older secret read finishes", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    let resolveSecret!: (v: unknown) => void;
    (loadPairSecret as ReturnType<typeof vi.fn>).mockImplementation(
      () =>
        new Promise((r) => {
          resolveSecret = r;
        }),
    );
    const { connectionManager } = await import("../src/net/manager");
    const { useComputersStore } = await import("../src/store/computers");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    const computer = useComputersStore.getState().computers[0]!;
    useComputersStore.getState().update(computer.fp, { removing: true });
    resolveSecret({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    // Drain the awaited secret continuation, not a timing-dependent sleep.
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(0);
    connectionManager.stop();
  });

  it("notification navigation requires a fresh session list from the current handshake", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({ kPair: new Uint8Array(32) });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    try {
      await vi.waitFor(() => expect(created).toHaveLength(1));
      const conn = created[0]!;
      conn.handshakeGeneration = 1;
      conn.opts.onStatus("online");
      expect(connectionManager.isSessionCurrent("f1", "tmux:a")).toBe(false);
      conn.opts.onInner({
        type: "sessions",
        list: [{ id: "tmux:a", title: "A", backend: "tmux", state: "running" }],
      } as never);
      expect(connectionManager.isSessionCurrent("f1", "tmux:a")).toBe(true);
      conn.handshakeGeneration = 2;
      conn.opts.onStatus("online");
      expect(connectionManager.isSessionCurrent("f1", "tmux:a")).toBe(false);
      conn.opts.onInner({ type: "sessions", list: [] });
      expect(connectionManager.isSessionCurrent("f1", "tmux:a")).toBe(false);
    } finally {
      connectionManager.stop();
    }
  });

  it("R57: a background/foreground flap during loadPairSecret self-heals to exactly one connection", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    const secret = {
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    };
    let resolveSecret!: (v: unknown) => void;
    // The first call (call A, from `start()`) hangs until we resolve it below; any call made by
    // a self-healing rerun resolves immediately, as a real SecureStore retry would.
    (loadPairSecret as ReturnType<typeof vi.fn>)
      .mockImplementationOnce(
        () =>
          new Promise((r) => {
            resolveSecret = r;
          }),
      )
      .mockResolvedValue(secret);
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    // `connectAll` (call A) is now suspended awaiting the first `loadPairSecret`.
    await setAppState("background"); // bumps the generation; nothing to close yet
    await setAppState("active"); // the re-triggered connectAll (call B) finds f1 still "starting"
    // Give the self-healing machinery a few ticks *without* resolving call A yet, proving it
    // does not busy-loop or connect early while the original call is genuinely still in flight.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(0);
    // Now let the original await resolve: it bails on the stale generation and flags a rerun,
    // which re-scans against the (by-then active) current state and connects for real.
    resolveSecret(secret);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(created).toHaveLength(1);
    expect(created[0]?.connect).toHaveBeenCalledTimes(1);
    connectionManager.stop();
  });

  it("onInner: a sessions message persists titles via the injected titleStorage (spec 2026-09-20 §5)", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    const { lookupSessionTitle } = await import("../src/notifications/sessionTitles");
    const titles = new Map<string, string>();
    const titleStorage = {
      getItemSync: (k: string) => titles.get(k) ?? null,
      setItemSync: (k: string, v: string) => void titles.set(k, v),
    };
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
      titleStorage,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    // Drives the real `case "sessions":` branch through the manager's message loop -- not a
    // direct call to `onSessionsMessage` -- so this guards the wiring itself (the call site and
    // the `this.deps?.titleStorage` plumbing), not just the exported function's own logic.
    conn.opts.onInner({
      type: "sessions",
      list: [{ id: "s1", title: "claude-code", backend: "herdr" }],
    });

    expect(lookupSessionTitle("f1", "s1", titleStorage)?.title).toBe("claude-code");
    connectionManager.stop();
  });

  it("rotation supersedes an authenticated token acquisition already in flight", async () => {
    let resolveToken!: (token: Awaited<ReturnType<ManagerDeps["pushToken"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<ManagerDeps["pushToken"]>>>((resolve) => {
      resolveToken = resolve;
    });
    const { connectionManager, conn } = await readyManager(() => pending);
    try {
      const acquiring = conn.opts.pushToken!().then((token) => {
        if (token) conn.sendPushToken(token);
      });
      connectionManager.registerNativePushToken({
        token: "B",
        platform: "android",
        provider: "fcm",
      });
      resolveToken({ token: "A", platform: "android", provider: "fcm", enabled: false });
      await acquiring;
      expect(conn.sendPushToken.mock.calls.map(([token]) => token)).toEqual([
        { token: "B", platform: "android", provider: "fcm", enabled: false },
      ]);
    } finally {
      connectionManager.stop();
    }
  });

  it("toggle fallback uses the rotated destination when a fresh acquisition fails", async () => {
    let fail = false;
    const { connectionManager, conn } = await readyManager(async () =>
      fail
        ? null
        : {
            token: "A",
            platform: "ios",
            provider: "apns",
            environment: "development",
            enabled: true,
          },
    );
    try {
      await conn.opts.pushToken!();
      connectionManager.registerNativePushToken({
        token: "B",
        platform: "ios",
        provider: "apns",
        environment: "production",
      });
      fail = true;
      connectionManager.notifyPushToggle("f1", false);
      await vi.waitFor(() => expect(conn.sendPushToken).toHaveBeenCalledTimes(2));
      await vi.waitFor(() =>
        expect(conn.sendPushToken.mock.calls.at(-1)?.[0]).toEqual({
          token: "B",
          platform: "ios",
          provider: "apns",
          environment: "production",
          enabled: false,
        }),
      );
    } finally {
      connectionManager.stop();
    }
  });

  it("notifyPushToggle sends push-token when a token exists, and is a no-op otherwise", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async (fp: string) => ({ token: `tok-${fp}`, platform: "ios", enabled: false }),
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    connectionManager.notifyPushToggle("f1", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).toHaveBeenCalledWith({
      token: "tok-f1",
      platform: "ios",
      enabled: true,
    });

    // An unknown fp (no live connection) must not throw.
    expect(() => connectionManager.notifyPushToggle("unknown", true)).not.toThrow();
    connectionManager.stop();
  });

  it("M1: toggling push off falls back to the last known token when a fresh fetch resolves null", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    let resolveToken = true;
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      // Resolves a real token on connect (so the manager caches it), then null afterwards --
      // e.g. permission revoked or a transient Expo failure on the toggle's own fetch.
      pushToken: async (fp: string) =>
        resolveToken ? { token: `tok-${fp}`, platform: "ios", enabled: false } : null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    // First toggle succeeds with a real token -- this is what populates the cache (the mocked
    // `ComputerConnection.connect()` is a no-op, so it never calls `opts.pushToken` itself).
    connectionManager.notifyPushToggle("f1", true);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).toHaveBeenCalledWith({
      token: "tok-f1",
      platform: "ios",
      enabled: true,
    });

    // Now a fresh fetch fails (permission revoked, transient Expo error, ...): the "off" toggle
    // must still reach the relay using the token cached from the successful fetch above, since
    // the protocol's `push-token.token` is required non-empty (packages/protocol/src/ctrl.ts).
    resolveToken = false;
    connectionManager.notifyPushToggle("f1", false);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).toHaveBeenCalledWith({
      token: "tok-f1",
      platform: "ios",
      enabled: false,
    });
    connectionManager.stop();
  });

  it("M1: toggling push with no token ever cached is a silent no-op", async () => {
    const { loadPairSecret } = await import("../src/identity/keys");
    (loadPairSecret as ReturnType<typeof vi.fn>).mockResolvedValue({
      kPair: new Uint8Array(32),
      computerEd25519Pub: new Uint8Array(32),
      computerX25519Pub: new Uint8Array(32),
    });
    const { connectionManager } = await import("../src/net/manager");
    connectionManager.start({
      identity: {} as never,
      phoneFp: "p1",
      phoneName: "iPhone",
      appVersion: "t",
      pushToken: async () => null,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const conn = created[0];
    if (!conn) throw new Error("test setup: no connection created");

    connectionManager.notifyPushToggle("f1", false);
    await Promise.resolve();
    await Promise.resolve();
    expect(conn.sendPushToken).not.toHaveBeenCalled();
    connectionManager.stop();
  });

  it("a slow notifications-on toggle cannot re-enable push after a later off toggle", async () => {
    type Pending = (token: { token: string; platform: "android"; provider: "fcm" }) => void;
    const pending: Pending[] = [];
    const { connectionManager, conn } = await readyManager(
      () => new Promise((resolve) => pending.push((t) => resolve({ ...t, enabled: false }))),
    );
    const { useComputersStore } = await import("../src/store/computers");
    try {
      useComputersStore.getState().update("f1", { pushEnabled: true });
      connectionManager.notifyPushToggle("f1", true);
      useComputersStore.getState().update("f1", { pushEnabled: false });
      connectionManager.notifyPushToggle("f1", false);
      expect(pending).toHaveLength(2);
      // The off request's token arrives first, then the older on request's token.
      pending[1]!({ token: "A", platform: "android", provider: "fcm" });
      await vi.waitFor(() => expect(conn.sendPushToken).toHaveBeenCalledTimes(1));
      pending[0]!({ token: "A", platform: "android", provider: "fcm" });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(conn.sendPushToken.mock.calls).toEqual([
        [{ token: "A", platform: "android", provider: "fcm", enabled: false }],
      ]);
    } finally {
      connectionManager.stop();
    }
  });

  describe("automatic output recovery", () => {
    async function boundedView() {
      const ready = await readyManager();
      vi.useFakeTimers();
      ready.conn.handshakeGeneration = 1;
      ready.conn.opts.onStatus("online");
      const lease = ready.connectionManager.claimView("f1", "tmux:a");
      const subscriptions = () =>
        ready.conn.sendForHandshake.mock.calls
          .filter(([, message]) => message.type === "stream.subscribe")
          .map(([, message]) => message.subscriptionId as string);
      const view = () => ready.useConnectionsStore.getState().read("f1").boundedView;
      return { ...ready, lease, subscriptions, view };
    }

    async function agentFor(subscriptionId: string) {
      const { prepareStreamSnapshot, StreamSender } = await import("@shellbell/protocol");
      const chunks: Array<{ type: string; [key: string]: unknown }> = [];
      let transfers = 0;
      const sender = new StreamSender({
        subscriptionId,
        sessionId: "tmux:a",
        now: () => Date.now(),
        newTransferId: () => (++transfers).toString(36).padStart(22, "T"),
        send: (chunk) => {
          chunks.push(chunk);
          return true;
        },
      });
      return {
        /** The chunks of one full screen snapshot, ACKed at the sender so the lane frees. */
        snapshot(gen: number, text: string) {
          const prepared = prepareStreamSnapshot({
            cols: 40,
            rows: 1,
            cursor: { x: 0, y: 0 },
            lines: [{ r: [{ t: text }] }],
            scrollbackTotal: 0,
            gen,
          });
          if (!prepared.ok) throw new Error("fixture rejected");
          expect(sender.offer({ kind: "snapshot", generation: gen }, prepared.bytes).accepted).toBe(
            true,
          );
          const start = chunks.length;
          sender.pump();
          const sent = chunks.slice(start);
          const last = sent.at(-1)?.sequence as number;
          sender.acknowledge(subscriptionId, last);
          return sent;
        },
      };
    }

    it("recovers a first screen that missed its deadline without a tap", async () => {
      const { STREAM_LIMITS } = await import("@shellbell/protocol");
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        expect(subscriptions()).toHaveLength(1);
        vi.advanceTimersByTime(STREAM_LIMITS.progressMs + 1);
        expect(view()).toMatchObject({
          snapshot: { status: "closed", error: "stalled" },
          retrying: true,
        });
        vi.advanceTimersByTime(250);
        expect(subscriptions()).toHaveLength(2);
        const agent = await agentFor(subscriptions()[1]!);
        for (const chunk of agent.snapshot(1, "recovered")) conn.opts.onInner(chunk, 200);
        expect(view()?.snapshot.status).toBe("live");
        expect(view()?.snapshot.screen?.lines[0]?.r[0]?.t).toBe("recovered");
        expect(view()?.retrying).toBeUndefined();
        vi.advanceTimersByTime(60_000);
        expect(subscriptions()).toHaveLength(2);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("revalidates the source after a chunk dropped during a transport pause", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await agentFor(subscriptions()[0]!);
        for (const chunk of agent.snapshot(1, "first")) conn.opts.onInner(chunk, 200);
        expect(view()?.snapshot.status).toBe("live");
        conn.online = false;
        for (const chunk of agent.snapshot(2, "dropped")) conn.opts.onInner(chunk, 200);
        conn.online = true;
        for (const chunk of agent.snapshot(3, "after gap")) conn.opts.onInner(chunk, 200);
        expect(view()).toMatchObject({
          snapshot: { status: "loading" },
        });
        expect(subscriptions()).toHaveLength(2);
        const fresh = await agentFor(subscriptions()[1]!);
        for (const chunk of fresh.snapshot(3, "after gap")) conn.opts.onInner(chunk, 200);
        expect(view()?.snapshot.status).toBe("live");
        expect(view()?.snapshot.screen?.lines[0]?.r[0]?.t).toBe("after gap");
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("keeps snapshot fallback through retries and mode changes until the view reopens", async () => {
      const { connectionManager, conn, lease, subscriptions } = await boundedView();
      const lastSubscribe = () =>
        conn.sendForHandshake.mock.calls
          .filter(([, m]) => m.type === "stream.subscribe")
          .at(-1)?.[1];
      try {
        conn.opts.onInner(
          { type: "stream.error", subscriptionId: subscriptions()[0]!, code: "unsupported" },
          200,
        );
        vi.advanceTimersByTime(0);
        expect(lastSubscribe()).not.toHaveProperty("mode");
        expect(lease.retryOutput(lease.revision())).toBe(true);
        expect(lastSubscribe()).not.toHaveProperty("mode");
        lease.setRawStream(false);
        lease.setRawStream(true);
        expect(lastSubscribe()).not.toHaveProperty("mode");
        lease.release();
        const reopened = connectionManager.claimView("f1", "tmux:a");
        expect(lastSubscribe()).toMatchObject({ mode: "vt", retained: false });
        reopened.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("clears snapshot fallback as well as history when the computer ends the stream", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await agentFor(subscriptions()[0]!);
        for (const chunk of agent.snapshot(1, "private old screen")) conn.opts.onInner(chunk, 200);
        expect(view()?.snapshot.screen).toBeDefined();
        conn.opts.onInner(
          { type: "stream.error", subscriptionId: subscriptions()[0]!, code: "session-gone" },
          200,
        );
        expect(view()?.snapshot.output?.state).toBe("ended");
        expect(view()?.snapshot.screen).toBeUndefined();
        expect(view()?.snapshot.history).toBeUndefined();
        expect(view()?.fallbackScreen).toBeUndefined();
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    async function nativeFor(subscriptionId: string, conn: RecordedConnection) {
      const { CONTINUATION_EXTENSIONS, StreamSender } = await import("@shellbell/protocol");
      const chunks: Array<{ type: string; [key: string]: unknown }> = [];
      let serial = 0;
      const sender = new StreamSender({
        subscriptionId,
        sessionId: "tmux:a",
        now: () => Date.now(),
        newTransferId: () => String(++serial).padStart(22, "T"),
        send: (chunk) => {
          chunks.push(chunk);
          return true;
        },
      });
      conn.opts.onInner(
        { type: "stream.accepted", subscriptionId, extensions: [...CONTINUATION_EXTENSIONS] },
        200,
      );
      return {
        offer(meta: import("@shellbell/protocol").StreamTransferMeta, text: string) {
          expect(sender.offer(meta, new TextEncoder().encode(text)).accepted).toBe(true);
          sender.pump();
          let through = 0;
          while (chunks.length) {
            const chunk = chunks.shift()!;
            through = chunk.sequence as number;
            conn.opts.onInner(chunk, 200);
          }
          sender.acknowledge(subscriptionId, through);
        },
        seed: {
          kind: "vt-seed",
          generation: 1,
          cols: 40,
          rows: 4,
          capture: "C".repeat(22),
          disposition: "initial",
          reason: "start",
          cursor: "real",
          alternate: "real",
        } as const,
      };
    }

    it("waits for native materialization before retrying a resize storm", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await nativeFor(subscriptions()[0]!, conn);
        agent.offer(agent.seed, "earlier history");
        const log = view()!.snapshot.vt!.log as import("../src/terminal/vt-replay-log").VtReplayLog;
        agent.offer(
          { ...agent.seed, generation: 2, disposition: "discontinuity", reason: "resize" },
          "resize",
        );
        expect(view()?.snapshot.error).toBe("stalled");
        vi.advanceTimersByTime(250);
        expect(subscriptions()).toHaveLength(1);
        expect(log.isDisposed).toBe(false);
        log.apply(0);
        expect(subscriptions()).toHaveLength(2);
        expect(
          conn.sendForHandshake.mock.calls
            .filter(([, m]) => m.type === "stream.subscribe")
            .at(-1)?.[1],
        ).toMatchObject({ retained: true });
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("preserves renderer failure and its checkpoint while no subscription is active", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await nativeFor(subscriptions()[0]!, conn);
        agent.offer(agent.seed, "earlier history");
        const log = view()!.snapshot.vt!.log as import("../src/terminal/vt-replay-log").VtReplayLog;
        log.apply(0);
        conn.opts.onStatus("offline");
        lease.rendererError(log, "renderer", null);
        conn.handshakeGeneration++;
        conn.opts.onStatus("online");
        const next = await nativeFor(subscriptions()[1]!, conn);
        next.offer(
          { ...next.seed, disposition: "discontinuity", reason: "reconnect" },
          "new screen",
        );
        expect(view()?.snapshot.output).toMatchObject({ state: "paused", reason: "renderer" });
        vi.advanceTimersByTime(60_000);
        expect(subscriptions()).toHaveLength(2);
        expect(log.isDisposed).toBe(false);
        lease.rendererReady(log, null);
        vi.advanceTimersByTime(250);
        expect(subscriptions()).toHaveLength(3);
        conn.opts.onStatus("offline");
        connectionManager.stop();
        expect(log.bytes).toBe(0);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("wakes applied reports from renderer callbacks and retains only the current focused source", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await nativeFor(subscriptions()[0]!, conn);
        agent.offer(agent.seed, "saved screen");
        const log = view()!.snapshot.vt!.log as import("../src/terminal/vt-replay-log").VtReplayLog;
        expect(view()!.snapshot.output?.state).toBe("catching-up");
        expect(conn.sendForHandshake.mock.calls.some(([, m]) => m.type === "stream.applied")).toBe(
          false,
        );
        log.apply(0);
        expect(view()!.snapshot.output?.state).toBe("live");
        vi.advanceTimersByTime(50);
        expect(
          conn.sendForHandshake.mock.calls
            .filter(([, m]) => m.type === "stream.applied")
            .map(([, m]) => m.offset),
        ).toEqual([0]);
        await setAppState("background");
        expect(view()!.snapshot.output?.state).toBe("paused");
        vi.advanceTimersByTime(1000);
        await setAppState("active");
        expect(subscriptions()).toHaveLength(2);
        expect(
          conn.sendForHandshake.mock.calls
            .filter(([, m]) => m.type === "stream.subscribe")
            .at(-1)?.[1],
        ).toMatchObject({ retained: true });
        expect(view()!.snapshot.vt!.log).toBe(log);
        expect(log.isDisposed).toBe(false);
        const newer = connectionManager.claimView("f1", "tmux:b");
        expect(log.isDisposed).toBe(true);
        expect(lease.retryOutput()).toBe(false);
        newer.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("clears a lost checkpoint before requesting a full seed and releases memory on unpair", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await nativeFor(subscriptions()[0]!, conn);
        agent.offer(agent.seed, "saved screen");
        const log = view()!.snapshot.vt!.log as import("../src/terminal/vt-replay-log").VtReplayLog;
        log.apply(0);
        lease.rendererError(log, "checkpoint-missing", lease.revision());
        expect(log.bytes).toBe(0);
        expect(subscriptions()).toHaveLength(2);
        expect(
          conn.sendForHandshake.mock.calls
            .filter(([, m]) => m.type === "stream.subscribe")
            .at(-1)?.[1],
        ).toMatchObject({ retained: false });
        const next = await nativeFor(subscriptions()[1]!, conn);
        next.offer(next.seed, "fresh screen");
        const fresh = view()!.snapshot.vt!
          .log as import("../src/terminal/vt-replay-log").VtReplayLog;
        fresh.apply(0);
        conn.opts.onStatus("offline", { error: "unpaired" });
        expect(fresh.bytes).toBe(0);
        expect(view()?.snapshot.output?.state).toBe("ended");
        expect(view()?.snapshot.vt).toBeUndefined();
        conn.opts.onStatus("online");
        vi.advanceTimersByTime(120_000);
        expect(subscriptions()).toHaveLength(2);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("keeps malformed transfers paused across route and handshake changes until explicit retry", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const agent = await nativeFor(subscriptions()[0]!, conn);
        agent.offer(agent.seed, "screen");
        agent.offer({ kind: "vt", generation: 1, offset: 2 }, "gap");
        expect(view()?.snapshot.error).toBe("invalid-transfer");
        const transport = {
          route: "direct" as const,
          phase: "direct",
          retryPending: false,
          lastFailure: null,
        };
        conn.opts.onTransport?.({ ...transport, ready: false });
        conn.opts.onTransport?.({ ...transport, ready: true });
        conn.opts.onStatus("offline");
        conn.handshakeGeneration++;
        conn.opts.onStatus("online");
        vi.advanceTimersByTime(120_000);
        expect(subscriptions()).toHaveLength(1);
        expect(lease.revision()).not.toBeNull();
        expect(lease.retryOutput(lease.revision())).toBe(true);
        expect(subscriptions()).toHaveLength(2);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("retries an oversized screen after changed geometry even following a disconnected handshake", async () => {
      const { connectionManager, conn, lease, subscriptions } = await boundedView();
      try {
        const sessions = (cols: number) =>
          conn.opts.onInner({
            type: "sessions",
            list: [{ id: "tmux:a", title: "A", backend: "tmux", state: "running", cols, rows: 24 }],
          });
        sessions(300);
        conn.opts.onInner(
          { type: "stream.error", subscriptionId: subscriptions()[0]!, code: "screen-too-large" },
          200,
        );
        conn.opts.onStatus("offline");
        conn.handshakeGeneration++;
        conn.opts.onStatus("online");
        sessions(300);
        expect(subscriptions()).toHaveLength(1);
        sessions(80);
        expect(subscriptions()).toHaveLength(2);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("keeps retrying at a bounded delay without announcements bypassing backoff", async () => {
      const { STREAM_LIMITS } = await import("@shellbell/protocol");
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        for (const delay of [250, 1000, 2000, 5000, 10000, 20000, 30000, 30000]) {
          const before = subscriptions().length;
          vi.advanceTimersByTime(STREAM_LIMITS.progressMs);
          expect(view()).toMatchObject({ snapshot: { status: "closed" }, retrying: true });
          conn.opts.onStatus("online");
          conn.opts.onInner({
            type: "sessions",
            list: [{ id: "tmux:a", title: "A", backend: "tmux", state: "running" }],
          });
          expect(subscriptions()).toHaveLength(before);
          vi.advanceTimersByTime(delay - 1);
          expect(subscriptions()).toHaveLength(before);
          vi.advanceTimersByTime(1);
          expect(subscriptions()).toHaveLength(before + 1);
        }
        expect(lease.retryOutput(lease.revision())).toBe(true);
        const afterManual = subscriptions().length;
        vi.advanceTimersByTime(STREAM_LIMITS.progressMs + 250);
        expect(subscriptions()).toHaveLength(afterManual + 1);
        lease.release();
        vi.advanceTimersByTime(120_000);
        expect(subscriptions()).toHaveLength(afterManual + 1);
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("treats a transiently closed stream as stale when the same handshake reports online", async () => {
      const { STREAM_LIMITS } = await import("@shellbell/protocol");
      const { connectionManager, conn, lease, subscriptions } = await boundedView();
      try {
        vi.advanceTimersByTime(STREAM_LIMITS.progressMs);
        expect(subscriptions()).toHaveLength(1);
        conn.opts.onStatus("online");
        expect(subscriptions()).toHaveLength(1);
        vi.advanceTimersByTime(250);
        expect(subscriptions()).toHaveLength(2);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("does not retry a session that has gone", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        conn.opts.onInner(
          { type: "stream.error", subscriptionId: subscriptions()[0]!, code: "session-gone" },
          100,
        );
        expect(view()?.snapshot).toMatchObject({ status: "closed", error: "session-gone" });
        expect(view()?.retrying).toBeUndefined();
        conn.opts.onInner({
          type: "sessions",
          list: [{ id: "tmux:a", title: "A", backend: "tmux", state: "running" }],
        });
        vi.advanceTimersByTime(60_000);
        expect(subscriptions()).toHaveLength(1);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });

    it("resubscribes when the transport becomes ready again on the same handshake", async () => {
      const { connectionManager, conn, lease, subscriptions, view } = await boundedView();
      try {
        const transport = (ready: boolean) =>
          conn.opts.onTransport?.({
            route: ready ? "direct" : null,
            ready,
            phase: "none",
            retryPending: false,
            lastFailure: null,
          });
        conn.online = false;
        transport(false);
        const missed = await agentFor(subscriptions()[0]!);
        for (const chunk of missed.snapshot(1, "missed")) conn.opts.onInner(chunk, 200);
        vi.advanceTimersByTime(1000);
        conn.online = true;
        transport(true);
        expect(subscriptions()).toHaveLength(2);
        const fresh = await agentFor(subscriptions()[1]!);
        for (const chunk of fresh.snapshot(1, "resumed")) conn.opts.onInner(chunk, 200);
        expect(view()?.snapshot.screen?.lines[0]?.r[0]?.t).toBe("resumed");
        // An ACK refused as a pause begins closes the stream; the pause swallows the timed
        // retry, so resuming must heal it.
        conn.sendForHandshake.mockImplementationOnce(() => false);
        for (const chunk of fresh.snapshot(2, "refused ack")) conn.opts.onInner(chunk, 200);
        expect(view()?.snapshot).toMatchObject({ status: "closed", error: "stalled" });
        conn.online = false;
        transport(false);
        vi.advanceTimersByTime(60_000);
        expect(subscriptions()).toHaveLength(2);
        conn.online = true;
        transport(true);
        expect(subscriptions()).toHaveLength(3);
        lease.release();
      } finally {
        connectionManager.stop();
        vi.useRealTimers();
      }
    });
  });
});
