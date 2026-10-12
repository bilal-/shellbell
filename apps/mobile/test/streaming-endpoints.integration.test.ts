import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fingerprint,
  generateIdentity,
  type Identity,
  type InnerMessageLoose,
  type Line,
  randomBytes,
  STREAM_LIMITS,
  toBase64Url,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Agent } from "../../agent/src/agent.js";
import { BackendRegistry } from "../../agent/src/backends/registry.js";
import type { HistoryReadRequest, Screen } from "../../agent/src/backends/types.js";
import { loadConfig, loadPairings, paths, savePairings } from "../../agent/src/config.js";
import { createLogger } from "../../agent/src/log.js";
import { V2PhoneLink } from "../../agent/src/v2-phone-link.js";
import { FakeBackend } from "../../agent/test/fakes/fake-backend.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { fakeNativeDirectHub } from "../../agent/test/fakes/native-direct-hub.js";
import { waitFor } from "../../agent/test/fakes/wait.js";
import { loadPairSecret } from "../src/identity/keys";
import { ComputerConnection } from "../src/net/connection";
import { BACKGROUND_GRACE_MS, connectionManager } from "../src/net/manager";
import { useComputersStore } from "../src/store/computers";
import { useConnectionsStore } from "../src/store/connections";

vi.mock("react-native", () => {
  let currentState = "active";
  const listeners: Array<(state: string) => void> = [];
  return {
    AppState: {
      get currentState() {
        return currentState;
      },
      addEventListener: (_event: string, listener: (state: string) => void) => {
        listeners.push(listener);
        return {
          remove: () => {
            const index = listeners.indexOf(listener);
            if (index >= 0) listeners.splice(index, 1);
          },
        };
      },
    },
    __setAppState: (state: string) => {
      currentState = state;
      for (const listener of [...listeners]) listener(state);
    },
  };
});
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync: () => {} },
}));
vi.mock("../src/identity/keys", () => ({
  loadPairSecret: vi.fn(),
  upgradePairProtocolFloor: vi.fn(async () => {}),
}));

const log = createLogger({ stdout: false });

function styledLine(row: number, marker: string): Line {
  return {
    r: [
      { t: `${marker}${row}:${"界".repeat(150)}`, fg: 2, b: true },
      { t: "é".repeat(120), bg: [1, 2, 3], i: true },
    ],
  };
}

function styledScreen(rows: number, marker: string, capture?: Readonly<object>): Screen {
  return {
    cols: 512,
    rows,
    cursor: { x: 0, y: rows - 1 },
    lines: Array.from({ length: rows }, (_, row) => styledLine(row, marker)),
    scrollbackTotal: 120,
    ...(capture ? { historyCapture: capture } : {}),
  };
}

/** Every terminal message the computer sent, captured where it enters the secure route. */
let agentSent: { phoneFp: string; message: InnerMessageLoose }[] = [];
let sendSpy: { mockRestore(): void } | undefined;
const sentToPhone = (phoneFp: string): InnerMessageLoose[] =>
  agentSent.filter((sent) => sent.phoneFp === phoneFp).map((sent) => sent.message);

describe("encrypted service and focused mobile usage cycles", () => {
  let stateDir: string;
  let relay: FakeRelay;
  let agent: Agent;
  let backend: FakeBackend;
  let computerFp: string;
  let computer: Identity;
  let phone: Identity;
  let phoneFp: string;
  let kPair: Uint8Array;
  let native: ReturnType<typeof fakeNativeDirectHub>;

  beforeEach(async () => {
    native = fakeNativeDirectHub();
    agentSent = [];
    const send = V2PhoneLink.prototype.send;
    sendSpy = vi.spyOn(V2PhoneLink.prototype, "send").mockImplementation(function (
      this: V2PhoneLink,
      message,
    ) {
      const sent = send.call(this, message);
      if (sent) agentSent.push({ phoneFp: this.phoneFp, message: message as InnerMessageLoose });
      return sent;
    });
    vi.stubGlobal("WebSocket", WebSocket);
    stateDir = mkdtempSync(join(tmpdir(), "sb-stream-cycle-"));
    const p = paths(stateDir);
    computer = generateIdentity();
    phone = generateIdentity();
    kPair = randomBytes(32);
    computerFp = fingerprint(computer.ed25519.pub);
    phoneFp = fingerprint(phone.ed25519.pub);
    savePairings(p, [
      {
        phoneFp,
        name: "iPhone",
        platform: "ios",
        ed25519Pub: toBase64Url(phone.ed25519.pub),
        x25519Pub: toBase64Url(phone.x25519.pub),
        kPair: toBase64Url(kPair),
        pairedAt: new Date(0).toISOString(),
        lastSeenAt: null,
      },
    ]);
    vi.mocked(loadPairSecret).mockResolvedValue({
      kPair,
      computerEd25519Pub: computer.ed25519.pub,
      computerX25519Pub: computer.x25519.pub,
    });
    relay = new FakeRelay(computerFp);
    await relay.start();
    backend = new FakeBackend();
    backend.addSession("S1", { rows: 3, lines: ["one", "two", "three"], scrollbackTotal: 5 });
    const registry = new BackendRegistry(log);
    registry.add(backend);
    agent = new Agent({
      paths: p,
      config: { ...loadConfig(p), computerName: "MBP" },
      identity: computer,
      fp: computerFp,
      registry,
      log,
      confirm: async () => true,
      appVersion: "cycle-test",
      relayUrlOverride: relay.url,
      directFactory: native.computer,
    });
    agent.start();
    await waitFor(() => agent.relayOnline);
    useComputersStore.setState({
      computers: [
        {
          fp: computerFp,
          name: "MBP",
          accent: "emerald",
          relayUrl: relay.url,
          pairedAt: new Date(0).toISOString(),
          lastSeenAt: null,
          pushEnabled: false,
        },
      ],
    });
    connectionManager.start({
      identity: phone,
      directFactory: native.phone,
      phoneFp,
      phoneName: "iPhone",
      appVersion: "cycle-test",
      pushToken: async () => null,
    });
    await waitFor(() => connectionManager.get(computerFp)?.online === true);
  });

  afterEach(async () => {
    const native = (await import("react-native")) as unknown as {
      __setAppState: (state: string) => void;
    };
    native.__setAppState("active");
    connectionManager.stop();
    agent.stop();
    await relay.stop();
    sendSpy?.mockRestore();
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("pauses screen streaming and input on direct loss until direct returns", async () => {
    connectionManager.stop();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    const streamedRoutes: Array<"direct" | "relay" | null> = [];
    const originalSend = V2PhoneLink.prototype.sendBounded;
    const sends = vi.spyOn(V2PhoneLink.prototype, "sendBounded").mockImplementation(function (
      this: V2PhoneLink,
      message,
    ) {
      streamedRoutes.push(this.activeRoute);
      return originalSend.call(this, message);
    });
    let failNative = false;
    connectionManager.start({
      identity: phone,
      phoneFp,
      phoneName: "Android",
      appVersion: "direct-policy-test",
      pushToken: async () => null,
      directFactory: (events) =>
        failNative
          ? Promise.reject(new Error("simulated restrictive network"))
          : native.phone(events),
    });
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    const screenReady = () =>
      useConnectionsStore.getState().byComputer[computerFp]?.boundedView?.snapshot.screen !==
      undefined;
    try {
      await waitFor(
        () => connectionManager.get(computerFp)?.activeRoute === "direct" && screenReady(),
      );
      const conn = connectionManager.get(computerFp)!;
      expect(streamedRoutes.length).toBeGreaterThan(0);
      expect(streamedRoutes.every((route) => route === "direct")).toBe(true);
      const screen = useConnectionsStore.getState().byComputer[computerFp]?.boundedView;
      failNative = true;
      conn.testTransport("interrupt-direct");
      await waitFor(
        () =>
          conn.activeRoute === "relay" &&
          conn.status === "waiting-direct" &&
          conn.transportState.retryPending,
      );
      expect(conn.online).toBe(false);
      expect(
        conn.send({
          type: "input.text",
          sessionId: "iterm2:S1",
          text: "must-not-send",
          reqId: conn.newReqId(),
        }),
      ).toBe(false);
      expect(backend.sentText.some((input) => input.text === "must-not-send")).toBe(false);
      expect(useConnectionsStore.getState().byComputer[computerFp]?.boundedView).toBe(screen);
      expect(streamedRoutes.every((route) => route === "direct")).toBe(true);
      expect(useConnectionsStore.getState().byComputer[computerFp]?.transport).toMatchObject({
        route: "relay",
        retryPending: true,
      });

      failNative = false;
      await waitFor(() => conn.activeRoute === "direct" && conn.online, 12_000);
      expect(
        (
          await conn.request({
            type: "input.text",
            sessionId: "iterm2:S1",
            text: "direct-again",
            reqId: conn.newReqId(),
          })
        ).ok,
      ).toBe(true);
      expect(streamedRoutes.every((route) => route === "direct")).toBe(true);
      expect(backend.sentText.some((input) => input.text === "must-not-send")).toBe(false);
    } finally {
      lease.release();
      sends.mockRestore();
    }
  }, 20_000);

  it("bootstraps direct terminal traffic when direct outruns the relay commit acknowledgement", async () => {
    connectionManager.stop();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    relay.v2ToPhoneDelayMs = 20;
    const inner: InnerMessageLoose[] = [];
    const conn = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "S22 test",
      appVersion: "direct-test",
      kPair,
      minProtocolVersion: 2,
      directFactory: native.phone,
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {},
      onStatus: () => {},
      onInner: (message) => inner.push(message),
    });
    try {
      conn.connect();
      await waitFor(
        () => conn.activeRoute === "direct" && inner.filter((m) => m.type === "hello").length >= 1,
      );
      // Nothing reaches the phone over the relay route; the hello waits for direct.
      expect(inner.filter((m) => m.type === "hello")).toHaveLength(1);
      expect(inner.filter((m) => m.type === "sessions")).toHaveLength(1);
      const relayBefore = conn.transportDiagnostics.relaySent;
      const request = {
        type: "input.text" as const,
        sessionId: "iterm2:S1",
        text: "direct-disposable-input",
        reqId: conn.newReqId(),
      };
      expect((await conn.request(request)).ok).toBe(true);
      expect(conn.transportDiagnostics.relaySent).toBe(relayBefore);
      expect(conn.transportDiagnostics.directSent).toBeGreaterThan(0);
      expect(backend.sentText.filter((x) => x.text === request.text)).toHaveLength(1);
      conn.testTransport("pause-relay");
      await waitFor(() => !relay.phones.has(phoneFp));
      expect(conn.online).toBe(true);
      expect(
        (await conn.request({ ...request, reqId: conn.newReqId(), text: "direct-without-relay" }))
          .ok,
      ).toBe(true);
      conn.testTransport("resume-relay");
      await waitFor(() => relay.phones.has(phoneFp));
      conn.testTransport("interrupt-direct");
      await waitFor(() => conn.activeRoute === "relay" && conn.status === "waiting-direct");
      expect(conn.send({ ...request, reqId: conn.newReqId(), text: "must-not-send" })).toBe(false);
      await waitFor(
        () => conn.activeRoute === "direct" && inner.filter((m) => m.type === "hello").length >= 2,
        12_000,
      );
      expect(inner.filter((m) => m.type === "hello")).toHaveLength(2);
      expect((await conn.request(request)).ok).toBe(true);
      expect(backend.sentText.filter((x) => x.text === request.text)).toHaveLength(1);
      expect(
        (await conn.request({ ...request, reqId: conn.newReqId(), text: "fresh-direct-input" })).ok,
      ).toBe(true);
    } finally {
      conn.close("user");
    }
  });

  it("leaves the phone push-eligible while it waits for a direct route", async () => {
    connectionManager.stop();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    let failNative = true;
    const conn = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "S22 test",
      appVersion: "direct-test",
      kPair,
      minProtocolVersion: 2,
      directFactory: (events) =>
        failNative
          ? Promise.reject(new Error("simulated restrictive network"))
          : native.phone(events),
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {},
      onStatus: () => {},
      onInner: () => {},
    });
    // The suite's own manager connection already leased for this phone; once the relay has
    // seen its socket close, every lease it sent has arrived, so count only ours after that.
    await waitFor(() => !relay.phones.has(phoneFp));
    const before = relay.ctrlFromPhones.length;
    const leases = () =>
      relay.ctrlFromPhones
        .slice(before)
        .flatMap((r) => (r.fp === phoneFp && r.msg.type === "lease" ? [r.msg.ttlMs] : []));
    const lastLease = () => leases().at(-1);
    try {
      conn.connect();
      // Foreground notices only travel on the direct route. A positive lease before then would
      // cancel pending pushes and make the relay skip new ones, so the phone would get neither.
      await waitFor(() => conn.status === "waiting-direct");
      await waitFor(() => lastLease() === 0);
      expect(leases().every((ttlMs) => ttlMs === 0)).toBe(true);
      failNative = false;
      await waitFor(() => conn.activeRoute === "direct" && conn.online, 12_000);
      await waitFor(() => (lastLease() ?? 0) > 0);
    } finally {
      conn.close("user");
    }
  }, 20_000);

  it("stays online on a working direct route when the relay comes back before the computer", async () => {
    connectionManager.stop();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    const auths: boolean[] = [];
    const conn = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "S22 test",
      appVersion: "direct-test",
      kPair,
      minProtocolVersion: 2,
      directFactory: native.phone,
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {},
      onStatus: () => {},
      onInner: () => {},
      onCtrl: (m) => {
        if (m.type === "auth-ok") auths.push(m.agentOnline);
      },
    });
    let cursor = 0;
    const leasesSince = () =>
      relay.ctrlFromPhones
        .slice(cursor)
        .flatMap((r) => (r.fp === phoneFp && r.msg.type === "lease" ? [r.msg.ttlMs] : []));
    try {
      conn.connect();
      await waitFor(() => conn.activeRoute === "direct" && conn.online);
      conn.testTransport("pause-relay");
      await waitFor(() => !relay.phones.has(phoneFp));
      // Hold the computer off the relay until the phone has signed in again.
      agent.relay.stop();
      await waitFor(() => relay.agent === null);
      cursor = relay.ctrlFromPhones.length;
      const authsBefore = auths.length;
      conn.testTransport("resume-relay");
      await waitFor(() => auths.length > authsBefore);
      expect(auths.at(-1)).toBe(false);
      await waitFor(() => leasesSince().length > 0);
      expect(conn.activeRoute).toBe("direct");
      expect(conn.status).toBe("online");
      expect(leasesSince()).toEqual([60_000]);
    } finally {
      conn.close("user");
      agent.relay.start();
      await waitFor(() => agent.relayOnline);
    }
  }, 20_000);

  it("keeps the direct route when the computer sends an unreadable terminal message", async () => {
    connectionManager.stop();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    const failures: string[] = [];
    const conn = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "S22 test",
      appVersion: "direct-test",
      kPair,
      minProtocolVersion: 2,
      directFactory: native.phone,
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {},
      onStatus: () => {},
      onInner: () => {},
      onTransport: (state) => {
        if (state.lastFailure) failures.push(state.lastFailure);
      },
    });
    try {
      conn.connect();
      await waitFor(() => conn.activeRoute === "direct" && conn.online);
      const link = agent.linkForPhone(phoneFp)!;
      // A chunk whose payload does not match its declared length, as a newer computer's might.
      link.send({
        type: "stream.chunk",
        subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA",
        transferId: "BBBBBBBBBBBBBBBBBBBBBB",
        sessionId: "iterm2:S1",
        sequence: 1,
        index: 0,
        count: 1,
        totalBytes: 2,
        data: new Uint8Array(1),
        meta: { kind: "snapshot", generation: 1 },
      } as never);
      const ack = await conn.request({
        type: "input.text",
        sessionId: "iterm2:S1",
        text: "after-unreadable",
        reqId: conn.newReqId(),
      });
      expect(ack.ok).toBe(true);
      expect(conn.activeRoute).toBe("direct");
      expect(failures).toEqual([]);
    } finally {
      conn.close("user");
    }
  });

  it("keeps the direct route when handling a terminal message throws", async () => {
    connectionManager.stop();
    vi.stubEnv("EXPO_PUBLIC_SHELLBELL_DIRECT", "1");
    const failures: string[] = [];
    let throwOnSessions = false;
    const conn = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "S22 test",
      appVersion: "direct-test",
      kPair,
      minProtocolVersion: 2,
      directFactory: native.phone,
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {},
      onStatus: () => {},
      // Like a storage failure in the app's session-title cache.
      onInner: (message) => {
        if (throwOnSessions && message.type === "sessions") throw new Error("storage unavailable");
      },
      onTransport: (state) => {
        if (state.lastFailure) failures.push(state.lastFailure);
      },
    });
    try {
      conn.connect();
      await waitFor(() => conn.activeRoute === "direct" && conn.online);
      throwOnSessions = true;
      agent.linkForPhone(phoneFp)!.send({ type: "sessions", list: [] });
      const ack = await conn.request({
        type: "input.text",
        sessionId: "iterm2:S1",
        text: "after-throw",
        reqId: conn.newReqId(),
      });
      expect(ack.ok).toBe(true);
      expect(conn.activeRoute).toBe("direct");
      expect(failures).toEqual([]);
    } finally {
      conn.close("user");
    }
  });

  it("upgrades the actual dispatchers to secure v2 and preserves paired request outcomes", async () => {
    connectionManager.stop();
    let floorWritten = false;
    const inner: InnerMessageLoose[] = [];
    const conn = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "S22 test",
      appVersion: "v2-test",
      kPair,
      minProtocolVersion: 2,
      directFactory: native.phone,
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {
        floorWritten = true;
      },
      onStatus: () => {},
      onInner: (message) => inner.push(message),
    });
    try {
      conn.connect();
      await waitFor(() => conn.online && inner.some((m) => m.type === "hello"));
      expect(conn.activeRoute).toBe("direct");
      expect(floorWritten).toBe(true);
      expect(
        loadPairings(paths(stateDir)).find((p) => p.phoneFp === phoneFp)?.minProtocolVersion,
      ).toBe(2);
      expect(relay.v2Frames).toBeGreaterThan(0);
      const request = {
        type: "input.text" as const,
        sessionId: "iterm2:S1",
        text: "disposable-v2-input",
        reqId: conn.newReqId(),
      };
      expect((await conn.request(request)).ok).toBe(true);
      expect((await conn.request(request)).ok).toBe(true);
      expect(backend.sentText.filter((x) => x.text === request.text)).toHaveLength(1);
    } finally {
      conn.close("user");
    }
  });

  it("negotiates a bounded focused view and publishes encrypted viewport frames", async () => {
    const conn = connectionManager.get(computerFp);
    expect(conn?.streamMode).toBe("bounded");
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
      expect(agent.connectedPhones[0]?.viewed).toBe("iterm2:S1");
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(32 * 1024);
      expect(relay.wire.ingressBytes).toBeGreaterThan(0);
      expect(relay.wire.egressBytes).toBeGreaterThan(0);
    } finally {
      lease.release();
    }
    await waitFor(() => agent.connectedPhones[0]?.viewed === null);
  });

  it("recovers history with a fresh subscription when the initial capture was unavailable", async () => {
    const capture = Object.freeze({ native: "S1" });
    let captureAvailable = false;
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => ({
      ...(await getScreen(id)),
      ...(captureAvailable ? { historyCapture: capture } : {}),
    }));
    const read = vi.fn(async (_sessionId: string, request: HistoryReadRequest) => {
      expect(request.capture).toBe(capture);
      return {
        status: "page" as const,
        from: 3,
        to: 5,
        oldestAvailable: 0,
        lines: [{ r: [{ t: "older one" }] }, { r: [{ t: "older two" }] }],
      };
    });
    Object.assign(backend, { getHistoryPage: read });
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    const snapshot = () => useConnectionsStore.getState().read(computerFp).boundedView?.snapshot;
    try {
      await waitFor(() => snapshot()?.status === "live");
      captureAvailable = true;
      expect(lease.requestOlder(lease.revision())).toBe(true);
      await waitFor(() => ["reset", "unavailable"].includes(snapshot()?.historyStatus ?? ""));
      expect(snapshot()?.historyStatus).toBe("reset");
      expect(read).not.toHaveBeenCalled();
      expect(lease.refreshHistory(lease.revision())).toBe(true);
      await waitFor(() => snapshot()?.history?.rows.length === 2);
      expect(snapshot()?.historyStatus).toBe("ready");
      expect(snapshot()?.history?.nextBefore).toBe(3);
      expect(read).toHaveBeenCalledTimes(1);
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(STREAM_LIMITS.envelopeBytes);
    } finally {
      lease.release();
    }
  });

  it("ACKs a bounded viewport before serving a native short history page", async () => {
    const capture = Object.freeze({ native: "S1" });
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => ({
      ...(await getScreen(id)),
      historyCapture: capture,
    }));
    const read = vi.fn(async () => ({
      status: "page" as const,
      from: 3,
      to: 5,
      oldestAvailable: 0,
      lines: [{ r: [{ t: "older one" }] }, { r: [{ t: "older two" }] }],
    }));
    Object.assign(backend, { getHistoryPage: read });
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
      expect(lease.requestOlder(lease.revision())).toBe(true);
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.history?.rows
            .length === 2,
      );
      expect(read).toHaveBeenCalledTimes(1);
      expect(
        useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.history?.nextBefore,
      ).toBe(3);
      expect(relay.received.some(({ env }) => env.t === "e2e" && env.seq > 0)).toBe(true);
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(32 * 1024);
    } finally {
      lease.release();
    }
  });

  it("reassembles styled multibyte viewport and native history across encrypted chunks", async () => {
    const capture = Object.freeze({ native: "S1" });
    const viewport = styledScreen(100, "v", capture);
    const historyLines = Array.from({ length: 100 }, (_, row) => styledLine(row + 20, "h"));
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => {
      await getScreen(id);
      return viewport;
    });
    Object.assign(backend, {
      getHistoryPage: async () => ({
        status: "page" as const,
        from: 20,
        to: 120,
        oldestAvailable: 0,
        lines: historyLines,
      }),
    });
    const startedAt = performance.now();
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
        10_000,
      ).catch(() => {
        throw new Error(
          `large viewport timed out: ${JSON.stringify({
            status: useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status,
            wireFrames: relay.wire.ingressFrames,
            nativeReads: backend.getScreenCalls,
          })}`,
        );
      });
      const state = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot;
      expect(state?.screen?.lines).toEqual(viewport.lines);
      const firstViewportMs = Math.round(performance.now() - startedAt);
      const historyStartedAt = performance.now();
      expect(lease.requestOlder(lease.revision())).toBe(true);
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.historyStatus ===
          "ready",
        10_000,
      ).catch(() => {
        throw new Error(
          `large history timed out: ${JSON.stringify({
            status: useConnectionsStore.getState().read(computerFp).boundedView?.snapshot
              .historyStatus,
            rows: useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.history
              ?.rows.length,
            wireFrames: relay.wire.ingressFrames,
          })}`,
        );
      });
      const history = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.history;
      const retainedLines = history?.rows.length ?? 0;
      expect(retainedLines).toBeGreaterThan(1);
      expect(retainedLines).toBeLessThanOrEqual(100);
      expect(history?.rows.map(({ line }) => line)).toEqual(
        historyLines.slice(100 - retainedLines),
      );
      expect(history?.nextBefore).toBe(120 - retainedLines);
      const historyMs = Math.round(performance.now() - historyStartedAt);
      expect(history?.rows.length).toBeLessThanOrEqual(STREAM_LIMITS.cacheLines);
      expect(history?.encodedBytes).toBeLessThanOrEqual(STREAM_LIMITS.cacheBytes);
      const chunks = sentToPhone(phoneFp).filter((message) => message.type === "stream.chunk");
      expect(chunks.filter((message) => message.meta.kind === "snapshot").length).toBeGreaterThan(
        1,
      );
      expect(chunks.filter((message) => message.meta.kind === "history").length).toBeGreaterThan(1);
      expect(chunks.every((message) => message.count <= 32)).toBe(true);
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(STREAM_LIMITS.envelopeBytes);
      lease.release();
      await waitFor(() => agent.connectedPhones[0]?.viewed === null);
      console.log(
        "stream-large-aggregate",
        JSON.stringify({
          shape: {
            viewers: 1,
            viewport: "512x100 styled multibyte",
            historyRequestedLines: 100,
            historyDeliveredLines: retainedLines,
            reconnects: 0,
            syntheticNotify: 0,
          },
          ingressFrames: relay.wire.ingressFrames,
          ingressBytes: relay.wire.ingressBytes,
          egressFrames: relay.wire.egressFrames,
          egressBytes: relay.wire.egressBytes,
          maxE2eBytes: relay.wire.maxE2eBytes,
          viewportChunks: chunks.filter((message) => message.meta.kind === "snapshot").length,
          historyChunks: chunks.filter((message) => message.meta.kind === "history").length,
          firstViewportMs,
          historyMs,
          fullCycleMs: Math.round(performance.now() - startedAt),
        }),
      );
    } finally {
      lease.release();
    }
  });

  it("ignores stale and malformed encrypted stream frames while current input still works", async () => {
    const first = connectionManager.claimView(computerFp, "iterm2:S1");
    await waitFor(
      () => useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
    );
    const oldChunk = sentToPhone(phoneFp).find((message) => message.type === "stream.chunk");
    if (oldChunk?.type !== "stream.chunk") throw new Error("missing original chunk");
    const second = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      first.release();
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
      const currentChunk = sentToPhone(phoneFp)
        .filter((message) => message.type === "stream.chunk")
        .find((message) => message.subscriptionId !== oldChunk.subscriptionId);
      if (currentChunk?.type !== "stream.chunk") throw new Error("missing replacement chunk");
      const link = agent.linkForPhone(phoneFp);
      const conn = connectionManager.get(computerFp);
      if (!link || !conn) throw new Error("missing active endpoint");
      expect(link.send(oldChunk)).toBe(true);
      expect(link.send({ ...currentChunk, data: new Uint8Array(1) } as never)).toBe(true);
      expect(
        conn.send({ type: "stream.ack", subscriptionId: oldChunk.subscriptionId, through: 999 }),
      ).toBe(true);
      const ack = await conn.request({
        type: "input.text",
        reqId: conn.newReqId(),
        sessionId: "iterm2:S1",
        text: "still routed",
      });
      expect(ack.ok).toBe(true);
      expect(backend.sentText.at(-1)?.text).toBe("still routed");
      expect(
        useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen?.lines[0]?.r[0]
          ?.t,
      ).toBe("one");
      expect(agent.connectedPhones[0]?.viewed).toBe("iterm2:S1");
    } finally {
      second.release();
    }
  });

  it("does not publish a retired native read into a reused session ID", async () => {
    const getScreen = backend.getScreen.bind(backend);
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let firstRead = true;
    let readsStarted = 0;
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => {
      const captured = await getScreen(id);
      readsStarted++;
      if (firstRead) {
        firstRead = false;
        await oldGate;
      }
      return captured;
    });
    const retired = connectionManager.claimView(computerFp, "iterm2:S1");
    await waitFor(() => readsStarted === 1);
    retired.release();
    backend.emit({ type: "session-removed", sessionId: "S1" });
    backend.addSession("S1", { rows: 3, lines: ["reused", "new", "content"], scrollbackTotal: 0 });
    backend.emit({ type: "session-added", sessionId: "S1" });
    const current = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen?.lines[0]
            ?.r[0]?.t === "reused",
      );
      releaseOld();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen?.lines[0]?.r[0]
          ?.t,
      ).toBe("reused");
      expect(agent.connectedPhones[0]?.viewed).toBe("iterm2:S1");
    } finally {
      releaseOld();
      current.release();
    }
  });

  it("keeps cursor progress and the client-wide history cache bounded over many native pages", async () => {
    const capture = Object.freeze({ native: "S1" });
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => ({
      ...(await getScreen(id)),
      scrollbackTotal: 5_100,
      historyCapture: capture,
    }));
    const requests: number[] = [];
    Object.assign(backend, {
      getHistoryPage: async (_id: string, request: { before: number; count: number }) => {
        requests.push(request.before);
        const from = Math.max(0, request.before - Math.min(request.count, 200));
        return {
          status: "page" as const,
          from,
          to: request.before,
          oldestAvailable: 0,
          lines: Array.from({ length: request.before - from }, (_, i) => ({
            r: [{ t: `row-${from + i}` }],
          })),
        };
      },
    });
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
      let cursor = 5_100;
      for (let page = 0; page < 26; page++) {
        const pageStartedAt = performance.now();
        const pageWallClockAt = Date.now();
        expect(lease.requestOlder(lease.revision())).toBe(true);
        await waitFor(() => {
          const next = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot
            .history?.nextBefore;
          return next !== undefined && next < cursor;
        }, 5_000).catch((cause) => {
          const snapshot = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot;
          const active = Reflect.get(connectionManager, "active");
          const stream = active?.stream;
          const receiver = stream && Reflect.get(stream, "receiver");
          const pending = stream && Reflect.get(stream, "pending");
          // Synthetic fixture metadata only: no history text, keys or ciphertext.
          const diagnostic = {
            elapsedMs: Math.round(performance.now() - pageStartedAt),
            wallElapsedMs: Date.now() - pageWallClockAt,
            now: Date.now(),
            nextDeadline: stream?.nextDeadline(),
            pendingBefore: pending?.before,
            firstDeadline: pending?.firstDeadline,
            completionSequence: pending?.completionSequence,
            receiverSequence: receiver && Reflect.get(receiver, "lastSequence"),
            ackDeadline: receiver && Reflect.get(receiver, "ackDeadline"),
            ackPendingCount: receiver && Reflect.get(receiver, "pendingCount"),
            nativeRequests: requests.slice(-3),
            ingressFrames: relay.wire.ingressFrames,
            egressFrames: relay.wire.egressFrames,
          };
          throw new Error(
            `History page ${page} stalled before ${cursor}; requests=${requests.length}; ` +
              `stream=${snapshot?.status}; history=${snapshot?.historyStatus}; ` +
              `next=${snapshot?.history?.nextBefore}; error=${snapshot?.error}; ` +
              `diagnostic=${JSON.stringify(diagnostic)}`,
            { cause },
          );
        });
        const next = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot
          .history?.nextBefore;
        if (next === undefined) throw new Error("history cursor vanished");
        cursor = next;
      }
      const history = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.history;
      expect(cursor).toBe(0);
      expect(requests).toHaveLength(26);
      expect(
        requests.every((before, index) => index === 0 || before < (requests[index - 1] ?? 0)),
      ).toBe(true);
      expect(history?.rows.length).toBeLessThanOrEqual(STREAM_LIMITS.cacheLines);
      expect(history?.encodedBytes).toBeLessThanOrEqual(STREAM_LIMITS.cacheBytes);
      expect(history?.rows[0]?.row).toBe(0);
      expect(history?.rows.at(-1)?.row).toBe(4_999);
      expect(history?.gaps).toEqual([{ from: 5_000, to: 5_100 }]);
    } finally {
      lease.release();
    }
  }, 40_000);

  it("does no screen capture across simulated hours with no active view", async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const baseline = backend.getScreenCalls;
      const coordinator = Reflect.get(agent, "views") as { pump(): number };
      for (let hour = 0; hour < 8; hour++) {
        now += 60 * 60 * 1000;
        backend.emit({ type: "screen-changed", sessionId: "S1" });
        coordinator.pump();
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(backend.getScreenCalls).toBe(baseline);
      expect(agent.connectedPhones[0]?.viewed).toBeNull();
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps the newer focused route after stale route cleanup", async () => {
    backend.addSession("S2", { rows: 3, lines: ["four", "five", "six"], scrollbackTotal: 0 });
    backend.emit({ type: "session-added", sessionId: "S2" });
    const oldRoute = connectionManager.claimView(computerFp, "iterm2:S1");
    await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S1");
    const newRoute = connectionManager.claimView(computerFp, "iterm2:S2");
    try {
      await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S2");
      oldRoute.release();
      expect(oldRoute.requestOlder()).toBe(false);
      expect(agent.connectedPhones[0]?.viewed).toBe("iterm2:S2");
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.sessionId === "iterm2:S2",
      );
    } finally {
      newRoute.release();
    }
    await waitFor(() => agent.connectedPhones[0]?.viewed === null);
  });

  it("drops foreground demand and restores the desired route after AppState resumes", async () => {
    const native = (await import("react-native")) as unknown as {
      __setAppState: (state: string) => void;
    };
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S1");
      const generation = connectionManager.get(computerFp)?.handshakeGeneration;
      native.__setAppState("background");
      // The connection outlives the grace period's start, then closes when it ends.
      expect(connectionManager.get(computerFp)).toBeDefined();
      await waitFor(
        () => connectionManager.get(computerFp) === undefined,
        BACKGROUND_GRACE_MS + 3000,
      );
      await waitFor(() => agent.connectedPhones.length === 0);
      expect(lease.revision()).toBeNull();
      native.__setAppState("active");
      await waitFor(() => connectionManager.get(computerFp)?.online === true, 10_000);
      await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S1", 10_000);
      expect(connectionManager.get(computerFp)?.handshakeGeneration).toBeGreaterThanOrEqual(
        generation ?? 0,
      );
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
    } finally {
      lease.release();
    }
  });
});
