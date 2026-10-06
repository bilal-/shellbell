import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCbor,
  deriveConnKey,
  E2EBodySchema,
  fingerprint,
  frameAd,
  generateIdentity,
  helloAd,
  type Identity,
  type InnerMessageLoose,
  type Line,
  open,
  parseInnerLoose,
  randomBytes,
  STREAM_LIMITS,
  toBase64Url,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { parseInner as oldParseInner } from "../../../packages/protocol/test/fixtures/legacy-protocol-20260921/inner.js";
import { parseInnerLoose as oldParseInnerLoose } from "../../../packages/protocol/test/fixtures/legacy-protocol-20260921/loose.js";
import { fakeNativeDirectPair } from "../../../packages/protocol/test-support/native-direct.js";
import { Agent } from "../../agent/src/agent.js";
import { BackendRegistry } from "../../agent/src/backends/registry.js";
import type { HistoryReadRequest, Screen } from "../../agent/src/backends/types.js";
import { loadConfig, loadPairings, paths, savePairings } from "../../agent/src/config.js";
import { createLogger } from "../../agent/src/log.js";
import { PhoneLink } from "../../agent/src/phone-link.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { V2PhoneLink } from "../../agent/src/v2-phone-link.js";
import { FakeBackend } from "../../agent/test/fakes/fake-backend.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { waitFor } from "../../agent/test/fakes/wait.js";
import { loadPairSecret } from "../src/identity/keys";
import { ComputerConnection } from "../src/net/connection";
import { connectionManager } from "../src/net/manager";
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

function openedAgentMessages(
  relay: FakeRelay,
  pair: Uint8Array,
  computerFp: string,
  phoneFp: string,
): InnerMessageLoose[] {
  const frames = relay.received.map(({ env }) => env);
  const phoneHello = frames.find((env) => env.t === "e2e" && env.from === phoneFp && env.seq === 0);
  const agentHello = frames.find(
    (env) => env.t === "e2e" && env.from === computerFp && env.seq === 0,
  );
  if (!phoneHello || !agentHello) throw new Error("missing encrypted handshake");
  const phoneOpening = parseInnerLoose(
    decodeCbor(open(pair, E2EBodySchema.parse(phoneHello.body), helloAd(phoneFp, computerFp))),
  );
  const agentOpening = parseInnerLoose(
    decodeCbor(open(pair, E2EBodySchema.parse(agentHello.body), helloAd(computerFp, phoneFp))),
  );
  if (phoneOpening.type !== "conn.hello" || agentOpening.type !== "conn.hello") {
    throw new Error("invalid encrypted handshake");
  }
  const { kConn, connTag } = deriveConnKey(
    pair,
    phoneOpening.n,
    agentOpening.n,
    computerFp,
    phoneFp,
  );
  return frames
    .filter(
      (env) => env.t === "e2e" && env.from === computerFp && env.to === phoneFp && env.seq > 0,
    )
    .map((env) =>
      parseInnerLoose(
        decodeCbor(
          open(
            kConn,
            E2EBodySchema.parse(env.body),
            frameAd(computerFp, phoneFp, connTag, env.seq),
          ),
        ),
      ),
    );
}

function openedPhoneMessages(
  relay: FakeRelay,
  pair: Uint8Array,
  computerFp: string,
  phoneFp: string,
  fromIndex = 0,
): InnerMessageLoose[] {
  const frames = relay.received.slice(fromIndex).map(({ env }) => env);
  const phoneHelloIndex = frames.findIndex(
    (env) => env.t === "e2e" && env.from === phoneFp && env.seq === 0,
  );
  const agentHello = frames.find(
    (env) => env.t === "e2e" && env.from === computerFp && env.seq === 0,
  );
  if (phoneHelloIndex < 0 || !agentHello) throw new Error("missing encrypted handshake");
  const phoneHello = frames[phoneHelloIndex];
  if (!phoneHello) throw new Error("missing encrypted phone hello");
  const phoneOpening = parseInnerLoose(
    decodeCbor(open(pair, E2EBodySchema.parse(phoneHello.body), helloAd(phoneFp, computerFp))),
  );
  const agentOpening = parseInnerLoose(
    decodeCbor(open(pair, E2EBodySchema.parse(agentHello.body), helloAd(computerFp, phoneFp))),
  );
  if (phoneOpening.type !== "conn.hello" || agentOpening.type !== "conn.hello") {
    throw new Error("invalid encrypted handshake");
  }
  const { kConn, connTag } = deriveConnKey(
    pair,
    phoneOpening.n,
    agentOpening.n,
    computerFp,
    phoneFp,
  );
  return frames
    .slice(phoneHelloIndex + 1)
    .filter(
      (env) => env.t === "e2e" && env.from === phoneFp && env.to === computerFp && env.seq > 0,
    )
    .map((env) =>
      parseInnerLoose(
        decodeCbor(
          open(
            kConn,
            E2EBodySchema.parse(env.body),
            frameAd(phoneFp, computerFp, connTag, env.seq),
          ),
        ),
      ),
    );
}

async function waitForReal(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = performance.now();
  while (!condition()) {
    if (performance.now() - started > timeoutMs) throw new Error("real-clock condition timeout");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

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
  let stalledPhone: Identity;
  let stalledPhoneFp: string;
  let stalledPair: Uint8Array;
  let cycleStartedAt: number;
  let native: ReturnType<typeof fakeNativeDirectPair>;

  beforeEach(async () => {
    native = fakeNativeDirectPair();
    cycleStartedAt = performance.now();
    vi.stubGlobal("WebSocket", WebSocket);
    stateDir = mkdtempSync(join(tmpdir(), "sb-stream-cycle-"));
    const p = paths(stateDir);
    computer = generateIdentity();
    phone = generateIdentity();
    kPair = randomBytes(32);
    computerFp = fingerprint(computer.ed25519.pub);
    phoneFp = fingerprint(phone.ed25519.pub);
    stalledPhone = generateIdentity();
    stalledPhoneFp = fingerprint(stalledPhone.ed25519.pub);
    stalledPair = randomBytes(32);
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
      {
        phoneFp: stalledPhoneFp,
        name: "Stalled phone",
        platform: "android",
        ed25519Pub: toBase64Url(stalledPhone.ed25519.pub),
        x25519Pub: toBase64Url(stalledPhone.x25519.pub),
        kPair: toBase64Url(stalledPair),
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
      direct: false,
      identity: phone,
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
    rmSync(stateDir, { recursive: true, force: true });
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("pauses screen streaming and input on direct loss until an explicit temporary relay exception", async () => {
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

      expect(conn.allowRelayOnce()).toBe(true);
      await waitFor(() => streamedRoutes.includes("relay"));
      expect(
        (
          await conn.request({
            type: "input.text",
            sessionId: "iterm2:S1",
            text: "explicit-relay-input",
            reqId: conn.newReqId(),
          })
        ).ok,
      ).toBe(true);
      expect(
        backend.sentText.filter((input) => input.text === "explicit-relay-input"),
      ).toHaveLength(1);
      failNative = false;
      await waitFor(() => conn.activeRoute === "direct" && conn.online, 12_000);
      failNative = true;
      conn.testTransport("interrupt-direct");
      await waitFor(() => conn.activeRoute === "relay" && conn.status === "waiting-direct");
      expect(conn.online).toBe(false);
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
      direct: true,
      directFactory: native.phone,
      remoteStatic: computer.x25519.pub,
      commitFloor: async () => {},
      onStatus: () => {},
      onInner: (message) => inner.push(message),
    });
    try {
      conn.connect();
      await waitFor(
        () => conn.activeRoute === "direct" && inner.filter((m) => m.type === "hello").length >= 2,
      );
      expect(inner.filter((m) => m.type === "sessions")).toHaveLength(2);
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
      conn.testTransport("drop-direct");
      await waitFor(
        () => conn.activeRoute === "relay" && inner.filter((m) => m.type === "hello").length >= 3,
      );
      expect((await conn.request(request)).ok).toBe(true);
      expect(backend.sentText.filter((x) => x.text === request.text)).toHaveLength(1);
      expect(
        (await conn.request({ ...request, reqId: conn.newReqId(), text: "fresh-relay-input" })).ok,
      ).toBe(true);
    } finally {
      conn.close("user");
    }
  });

  it("upgrades the actual dispatchers to encrypted v2 relay transport and preserves paired request outcomes", async () => {
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
      expect(conn.activeRoute).toBe("relay");
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
      const chunks = openedAgentMessages(relay, kPair, computerFp, phoneFp).filter(
        (message) => message.type === "stream.chunk",
      );
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

  it("recovers a resized reset viewport when native state changes during a partial transfer", async () => {
    const getScreen = backend.getScreen.bind(backend);
    let viewport: Screen = styledScreen(250, "before");
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => {
      await getScreen(id);
      return viewport;
    });
    const socket = Reflect.get(agent.relay, "ws") as WebSocket;
    let pressure = true;
    let admissions = 0;
    Object.defineProperty(socket, "bufferedAmount", {
      configurable: true,
      get: () => (pressure && admissions++ >= 1 ? 1 : 0),
    });
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          openedAgentMessages(relay, kPair, computerFp, phoneFp).filter(
            (message) => message.type === "stream.chunk",
          ).length === 1,
        10_000,
      );
      expect(useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status).toBe(
        "loading",
      );
      viewport = {
        cols: 80,
        rows: 3,
        cursor: { x: 0, y: 2 },
        lines: [{ r: [{ t: "after reset" }] }, { r: [] }, { r: [] }],
        scrollbackTotal: 0,
      };
      backend.clear("S1");
      pressure = false;
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen?.cols === 80,
        10_000,
      );
      expect(
        useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen?.lines,
      ).toEqual(viewport.lines);
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(STREAM_LIMITS.envelopeBytes);
    } finally {
      pressure = false;
      lease.release();
    }
  });

  it("ignores stale and malformed encrypted stream frames while current input still works", async () => {
    const first = connectionManager.claimView(computerFp, "iterm2:S1");
    await waitFor(
      () => useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
    );
    const oldChunk = openedAgentMessages(relay, kPair, computerFp, phoneFp).find(
      (message) => message.type === "stream.chunk",
    );
    if (oldChunk?.type !== "stream.chunk") throw new Error("missing original chunk");
    const second = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      first.release();
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
      const currentChunk = openedAgentMessages(relay, kPair, computerFp, phoneFp)
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

  it("resumes history in ACK order after held native reads and encrypted relay delivery", async () => {
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => ({
      ...(await getScreen(id)),
      scrollbackTotal: 400,
      historyCapture: Object.freeze({ native: "held-history" }),
    }));
    let releaseRead: () => void = () => {};
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const requests: number[] = [];
    Object.assign(backend, {
      getHistoryPage: async (_id: string, request: { before: number; count: number }) => {
        requests.push(request.before);
        await readGate;
        const from = Math.max(0, request.before - Math.min(request.count, 200));
        return {
          status: "page" as const,
          from,
          to: request.before,
          oldestAvailable: 0,
          lines: Array.from({ length: request.before - from }, (_, i) => ({
            r: [{ t: `held-row-${from + i}` }],
          })),
        };
      },
    });
    const target = relay.agent?.ws;
    if (!target) throw new Error("missing fixture agent socket");
    const send = target.send.bind(target);
    const held: Array<Parameters<typeof target.send>> = [];
    let restoreDelivery: (() => void) | undefined;
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    const snapshot = () => useConnectionsStore.getState().read(computerFp).boundedView?.snapshot;
    try {
      await waitFor(() => snapshot()?.status === "live");
      expect(lease.requestOlder(lease.revision())).toBe(true);
      await waitFor(() => requests.length === 1);
      expect(snapshot()?.historyStatus).toBe("loading");
      expect(lease.requestOlder(lease.revision())).toBe(false);
      const conn = connectionManager.get(computerFp);
      if (!conn) throw new Error("missing fixture connection");
      const input = await conn.request({
        type: "input.text",
        reqId: conn.newReqId(),
        sessionId: "iterm2:S1",
        text: "input-during-history",
      });
      expect(input.ok).toBe(true);
      expect(backend.sentText.at(-1)?.text).toBe("input-during-history");
      const beforeHeld = openedPhoneMessages(relay, kPair, computerFp, phoneFp).length;
      const delivery = vi.spyOn(target, "send").mockImplementation((...args) => {
        held.push(args);
      });
      restoreDelivery = () => delivery.mockRestore();
      releaseRead();
      await waitFor(() => snapshot()?.history?.nextBefore === 200);
      expect(lease.requestOlder(lease.revision())).toBe(true);
      // Wait for real encrypted messages, not a fixed sleep or manual tick.
      await waitFor(() => held.length >= 2);
      const controls = openedPhoneMessages(relay, kPair, computerFp, phoneFp)
        .slice(beforeHeld)
        .filter(
          (message) => message.type === "stream.ack" || message.type === "stream.history.get",
        );
      expect(controls.map((message) => message.type)).toEqual(["stream.ack", "stream.history.get"]);
      expect(requests).toEqual([400]);
      restoreDelivery();
      restoreDelivery = undefined;
      for (const args of held) send(...args);
      await waitFor(() => snapshot()?.history?.nextBefore === 0);
      expect(requests).toEqual([400, 200]);
      expect(snapshot()?.status).toBe("live");
      expect(snapshot()?.history?.rows).toHaveLength(400);
      expect(snapshot()?.history?.rows[0]?.row).toBe(0);
      expect(snapshot()?.history?.rows.at(-1)?.row).toBe(399);
    } finally {
      releaseRead();
      restoreDelivery?.();
      lease.release();
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

  it("keeps a genuine old-parser phone on legacy frames after encrypted handshakes", async () => {
    connectionManager.stop();
    await waitFor(() => agent.connectedPhones.length === 0);
    const beginning = relay.received.length;
    const inner: InnerMessageLoose[] = [];
    const legacy = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: phone,
      phoneFp,
      phoneName: "iPhone",
      appVersion: "legacy-cycle",
      kPair,
      boundedStream: false,
      onInner: (message) => inner.push(message),
      onStatus: () => {},
      WebSocketImpl: WebSocket as never,
    });
    try {
      legacy.connect();
      await waitFor(() => legacy.online);
      expect(legacy.streamMode).toBe("legacy");
      expect(legacy.send({ type: "subscribe", sessionId: "iterm2:S1" })).toBe(true);
      await waitFor(() => inner.some((message) => message.type === "screen.snapshot"));
      const frames = relay.received.slice(beginning).map(({ env }) => env);
      const phoneHello = frames.find(
        (env) => env.t === "e2e" && env.from === phoneFp && env.seq === 0,
      );
      const agentHello = frames.find(
        (env) => env.t === "e2e" && env.from === computerFp && env.seq === 0,
      );
      if (!phoneHello || !agentHello) throw new Error("missing encrypted handshake");
      const phoneOpening = oldParseInner(
        decodeCbor(open(kPair, E2EBodySchema.parse(phoneHello.body), helloAd(phoneFp, computerFp))),
      );
      const agentOpening = oldParseInnerLoose(
        decodeCbor(open(kPair, E2EBodySchema.parse(agentHello.body), helloAd(computerFp, phoneFp))),
      );
      if (phoneOpening.type !== "conn.hello" || agentOpening.type !== "conn.hello") {
        throw new Error("old parser rejected encrypted hello");
      }
      expect(phoneOpening).toEqual({ type: "conn.hello", n: phoneOpening.n });
      expect(agentOpening).toEqual({ type: "conn.hello", n: agentOpening.n });
      const { kConn, connTag } = deriveConnKey(
        kPair,
        phoneOpening.n,
        agentOpening.n,
        computerFp,
        phoneFp,
      );
      const agentMessages = frames
        .filter((env) => env.t === "e2e" && env.from === computerFp && env.seq > 0)
        .map((env) =>
          oldParseInnerLoose(
            decodeCbor(
              open(
                kConn,
                E2EBodySchema.parse(env.body),
                frameAd(computerFp, phoneFp, connTag, env.seq),
              ),
            ),
          ),
        );
      expect(agentMessages.some((message) => message.type === "screen.snapshot")).toBe(true);
      expect(agentMessages.every((message) => !message.type.startsWith("stream."))).toBe(true);
    } finally {
      legacy.close("user");
    }
  });

  it("recovers a quiet final viewport after shared socket pressure with a stalled viewer", async () => {
    const healthy = connectionManager.get(computerFp);
    if (!healthy) throw new Error("missing healthy connection");
    const getScreen = backend.getScreen.bind(backend);
    let marker = "initial";
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => {
      await getScreen(id);
      return styledScreen(250, marker);
    });
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    const stalledFrames: InnerMessageLoose[] = [];
    const stalled = new ComputerConnection({
      computerFp,
      relayUrl: relay.url,
      identity: stalledPhone,
      phoneFp: stalledPhoneFp,
      phoneName: "Stalled phone",
      appVersion: "cycle-test",
      kPair: stalledPair,
      boundedStream: true,
      onInner: (message) => stalledFrames.push(message),
      onStatus: () => {},
      WebSocketImpl: WebSocket as never,
    });
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
        10_000,
      );
      stalled.connect();
      await waitFor(() => stalled.online);
      const subscriptionId = "BBBBBBBBBBBBBBBBBBBBBB";
      expect(
        stalled.send({ type: "stream.subscribe", subscriptionId, sessionId: "iterm2:S1" }),
      ).toBe(true);
      await waitFor(
        () => stalledFrames.filter((message) => message.type === "stream.chunk").length === 4,
        10_000,
      );
      expect(stalledFrames.filter((message) => message.type === "stream.chunk")).toHaveLength(4);
      const socket = Reflect.get(agent.relay, "ws") as WebSocket;
      let pressure = true;
      Object.defineProperty(socket, "bufferedAmount", {
        configurable: true,
        get: () => (pressure ? 1 : 0),
      });
      const before = backend.getScreenCalls;
      marker = "quiet-final";
      backend.appendLine("S1", "quiet final");
      const ack = await healthy.request({
        type: "input.text",
        reqId: healthy.newReqId(),
        sessionId: "iterm2:S1",
        text: "input-under-pressure",
      });
      expect(ack.ok).toBe(true);
      expect(backend.sentText.at(-1)?.text).toBe("input-under-pressure");
      expect(backend.getScreenCalls).toBeLessThanOrEqual(before + 2);
      expect(
        useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen?.lines[249]
          ?.r[0]?.t,
      ).toMatch(/^initial/);
      pressure = false;
      await waitFor(
        () =>
          useConnectionsStore
            .getState()
            .read(computerFp)
            .boundedView?.snapshot.screen?.lines[249]?.r[0]?.t.startsWith("quiet-final") === true,
        10_000,
      );
      expect(stalledFrames.filter((message) => message.type === "stream.chunk")).toHaveLength(4);
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(32 * 1024);
    } finally {
      stalled.close("user");
      lease.release();
    }
  });

  it("exhausts the actual shared wire budget while input works and a quiet final viewport recovers", async () => {
    const getScreen = backend.getScreen.bind(backend);
    let marker = "initial";
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => {
      await getScreen(id);
      return styledScreen(250, marker);
    });
    const coordinator = Reflect.get(agent, "views") as {
      pump(): number;
      scheduler: {
        last: number;
        nextBudgetAt(): number | null;
      };
    };
    const socket = Reflect.get(agent.relay, "ws") as WebSocket;
    Object.defineProperty(socket, "bufferedAmount", { configurable: true, get: () => 0 });
    let now = coordinator.scheduler.last + 50;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitForReal(() =>
        openedAgentMessages(relay, kPair, computerFp, phoneFp).some(
          (message) => message.type === "stream.chunk",
        ),
      );
      const admitted = openedAgentMessages(relay, kPair, computerFp, phoneFp).filter(
        (message) => message.type === "stream.chunk",
      ).length;
      expect(admitted).toBeLessThanOrEqual(2);
      expect(coordinator.scheduler.nextBudgetAt()).not.toBeNull();
      expect(useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status).toBe(
        "loading",
      );
      marker = "budget-final";
      backend.emit({ type: "screen-changed", sessionId: "S1" });
      const conn = connectionManager.get(computerFp);
      if (!conn) throw new Error("missing connection");
      const ack = await conn.request({
        type: "input.text",
        reqId: conn.newReqId(),
        sessionId: "iterm2:S1",
        text: "budget-input",
      });
      expect(ack.ok).toBe(true);
      expect(backend.sentText.at(-1)?.text).toBe("budget-input");
      const mobile = Reflect.get(connectionManager, "active").stream as { tick(): void };
      const receiver = Reflect.get(mobile, "receiver") as { lastSequence: number };
      // Force the delayed-ACK callback to run before the service's refill pump.
      // This real timer ordering used to intermittently strand the final partial
      // ACK batch when the test froze Date.now() for the entire recovery phase.
      await waitForReal(() => receiver.lastSequence === 2);
      now += 2_000;
      mobile.tick();
      const resumedAt = performance.now();
      const resumedClock = now;
      clock.mockImplementation(() => resumedClock + Math.floor(performance.now() - resumedAt));
      coordinator.pump();
      await waitForReal(
        () =>
          useConnectionsStore
            .getState()
            .read(computerFp)
            .boundedView?.snapshot.screen?.lines[249]?.r[0]?.t.startsWith("budget-final") === true,
        10_000,
      ).catch((error) => {
        const snapshot = useConnectionsStore.getState().read(computerFp).boundedView?.snapshot;
        const tracker = Reflect.get(coordinator, "tracker");
        const state = Reflect.get(tracker, "sessions").get("iterm2:S1");
        console.error("wire-budget final viewport diagnostic", {
          receiver: (() => {
            const active = Reflect.get(connectionManager, "active");
            const receiver = active?.stream && Reflect.get(active.stream, "receiver");
            return (
              receiver && {
                pendingCount: receiver.pendingCount,
                ackDeadline: receiver.ackDeadline,
                lastSequence: receiver.lastSequence,
              }
            );
          })(),
          now: Date.now(),
          schedulerLast: coordinator.scheduler.last,
          nextBudgetAt: coordinator.scheduler.nextBudgetAt(),
          captureCalls: backend.getScreenCalls,
          status: snapshot?.status,
          error: snapshot?.error,
          finalMarker: snapshot?.screen?.lines[249]?.r[0]?.t.slice(0, 20),
          tracker: state && { dirty: state.dirty, inflight: state.inflight, gen: state.gen },
          chunks: openedAgentMessages(relay, kPair, computerFp, phoneFp).filter(
            (message) => message.type === "stream.chunk",
          ).length,
        });
        throw error;
      });
      expect(relay.wire.maxE2eBytes).toBeLessThanOrEqual(STREAM_LIMITS.envelopeBytes);
    } finally {
      clock.mockRestore();
      lease.release();
    }
  });

  it("measures original serialized bytes for handshake, ACK, history, reconnect and notification control", async () => {
    const capture = Object.freeze({ native: "S1" });
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => ({
      ...(await getScreen(id)),
      historyCapture: capture,
    }));
    Object.assign(backend, {
      getHistoryPage: async () => ({
        status: "page" as const,
        from: 4,
        to: 5,
        oldestAvailable: 0,
        lines: [{ r: [{ t: "older" }] }],
      }),
    });
    const conn = connectionManager.get(computerFp);
    if (!conn) throw new Error("missing connection");
    const lease = connectionManager.claimView(computerFp, "iterm2:S1");
    try {
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live",
      );
      const firstViewportMs = Math.round(performance.now() - cycleStartedAt);
      const historyStart = performance.now();
      expect(lease.requestOlder(lease.revision())).toBe(true);
      await waitFor(
        () =>
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.history?.rows
            .length === 1,
      );
      const historyMs = Math.round(performance.now() - historyStart);
      await waitFor(() =>
        openedPhoneMessages(relay, kPair, computerFp, phoneFp).some(
          (message) => message.type === "stream.ack" && message.through >= 2,
        ),
      );
      const historyAckMs = Math.round(performance.now() - historyStart);
      expect(
        openedPhoneMessages(relay, kPair, computerFp, phoneFp).some(
          (message) => message.type === "stream.ack" && message.through >= 2,
        ),
      ).toBe(true);
      const inputAck = await conn.request({
        type: "input.text",
        reqId: conn.newReqId(),
        sessionId: "iterm2:S1",
        text: "typed-cycle-input",
      });
      expect(inputAck.ok).toBe(true);
      expect(backend.sentText.at(-1)?.text).toBe("typed-cycle-input");
      expect(agent.notifier.ring({ sessionId: "iterm2:S1", kind: "prompt" })).toBe(true);
      await waitFor(() => relay.ctrlFromAgent.some((message) => message.type === "notify"));
      const generation = conn.handshakeGeneration;
      const previousRevision = lease.revision();
      const reconnectFrameStart = relay.received.length;
      const reconnectStart = performance.now();
      relay.phones.get(phoneFp)?.ws.terminate();
      await waitFor(() => conn.handshakeGeneration > generation && conn.online, 10_000);
      await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S1");
      await waitFor(
        () =>
          lease.revision() !== previousRevision &&
          useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status === "live" &&
          Boolean(useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.screen),
      );
      const reconnectViewportMs = Math.round(performance.now() - reconnectStart);
      expect(lease.revision()).not.toBe(previousRevision);
      expect(useConnectionsStore.getState().read(computerFp).boundedView?.snapshot.status).toBe(
        "live",
      );
      await waitFor(() =>
        openedPhoneMessages(relay, kPair, computerFp, phoneFp, reconnectFrameStart).some(
          (message) => message.type === "stream.ack" && message.through >= 1,
        ),
      );
      const reconnectAckMs = Math.round(performance.now() - reconnectStart);
      expect(
        openedPhoneMessages(relay, kPair, computerFp, phoneFp, reconnectFrameStart).some(
          (message) => message.type === "stream.ack" && message.through >= 1,
        ),
      ).toBe(true);
      expect(backend.sentText.filter(({ text }) => text === "typed-cycle-input")).toHaveLength(1);
      lease.release();
      await waitFor(() => agent.connectedPhones[0]?.viewed === null);
      const metric = {
        shape: {
          viewers: 1,
          viewport: "20x3",
          historyLines: 1,
          typedInputs: 1,
          reconnects: 1,
          syntheticNotify: 1,
        },
        ingressFrames: relay.wire.ingressFrames,
        ingressBytes: relay.wire.ingressBytes,
        egressFrames: relay.wire.egressFrames,
        egressBytes: relay.wire.egressBytes,
        maxE2eBytes: relay.wire.maxE2eBytes,
        firstViewportMs,
        historyMs,
        historyAckMs,
        reconnectViewportMs,
        reconnectAckMs,
        fullCycleMs: Math.round(performance.now() - cycleStartedAt),
      };
      expect(metric.maxE2eBytes).toBeLessThanOrEqual(32 * 1024);
      expect(metric.ingressFrames).toBeGreaterThan(6);
      expect(metric.egressFrames).toBeGreaterThan(6);
      console.log("stream-cycle-aggregate", JSON.stringify(metric));
    } finally {
      lease.release();
    }
  });

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

  it("uses legacy subscribe and viewport when a new Manager meets an old-parser agent", async () => {
    connectionManager.stop();
    agent.stop();
    const oldRelay = new RelayClient({
      relayUrl: relay.url,
      fp: computerFp,
      identity: computer,
      name: "MBP",
      appVersion: "old-agent",
      log,
      backoffMinMs: 50,
      backoffMaxMs: 100,
    });
    let link: PhoneLink | null = null;
    let subscribed = false;
    let cancelled = false;
    let oldHelloSeen = false;
    const oldApplicationTypes: string[] = [];
    let oldPhoneNonce: Uint8Array | null = null;
    let oldConnection: ReturnType<typeof deriveConnKey> | null = null;
    oldRelay.on("ctrl", (message) => {
      if (message.type !== "phone-connected") return;
      link = new PhoneLink({
        phoneFp,
        connId: message.connId,
        name: message.name,
        kPair,
        computerFp,
        boundedStream: false,
        send: (envelope) => {
          if (envelope.t === "e2e" && envelope.seq === 0) {
            const oldAgentOpening = oldParseInner(
              decodeCbor(
                open(kPair, E2EBodySchema.parse(envelope.body), helloAd(computerFp, phoneFp)),
              ),
            );
            if (oldAgentOpening.type !== "conn.hello" || !oldPhoneNonce) {
              throw new Error("old parser rejected connection handshake");
            }
            oldConnection = deriveConnKey(
              kPair,
              oldPhoneNonce,
              oldAgentOpening.n,
              computerFp,
              phoneFp,
            );
          }
          oldRelay.sendEnvelope(envelope);
        },
        log,
      });
    });
    oldRelay.on("e2e", (envelope) => {
      if (envelope.v !== 1) throw new Error("unexpected v2 in legacy test");
      const active = link;
      if (!active) return;
      if (envelope.t === "e2e" && envelope.seq === 0) {
        const legacyOpening = oldParseInner(
          decodeCbor(open(kPair, E2EBodySchema.parse(envelope.body), helloAd(phoneFp, computerFp))),
        );
        if (legacyOpening.type !== "conn.hello") throw new Error("old parser rejected phone hello");
        oldHelloSeen = true;
        oldPhoneNonce = legacyOpening.n;
      } else if (envelope.t === "e2e") {
        if (!oldConnection) throw new Error("missing legacy connection key");
        const parsed = oldParseInner(
          decodeCbor(
            open(
              oldConnection.kConn,
              E2EBodySchema.parse(envelope.body),
              frameAd(phoneFp, computerFp, oldConnection.connTag, envelope.seq),
            ),
          ),
        );
        oldApplicationTypes.push(parsed.type);
      }
      const wasHandshaken = active.handshaken;
      const message = active.handleEnvelope(envelope);
      if (!wasHandshaken && active.handshaken) {
        active.send({
          type: "hello",
          agentVersion: "old-agent",
          backends: [],
          computerName: "MBP",
          accent: "emerald",
        });
      }
      if (message?.type === "subscribe" && message.sessionId === "iterm2:S1") {
        subscribed = true;
        void backend.getScreen("S1").then((screen) => {
          active.send({ type: "screen.snapshot", sessionId: "iterm2:S1", gen: 1, ...screen });
        });
      }
      if (message?.type === "subscribe" && message.sessionId === null) cancelled = true;
    });
    try {
      const beginning = relay.received.length;
      oldRelay.start();
      await waitFor(() => oldRelay.online);
      connectionManager.start({
        identity: phone,
        direct: false,
        phoneFp,
        phoneName: "iPhone",
        appVersion: "cycle-test",
        pushToken: async () => null,
      });
      await waitFor(() => connectionManager.get(computerFp)?.online === true);
      expect(oldHelloSeen).toBe(true);
      expect(connectionManager.get(computerFp)?.streamMode).toBe("legacy");
      const lease = connectionManager.claimView(computerFp, "iterm2:S1");
      try {
        await waitFor(
          () => subscribed && Boolean(useConnectionsStore.getState().read(computerFp).view),
        );
        const phoneHello = relay.received
          .slice(beginning)
          .map(({ env }) => env)
          .find((env) => env.t === "e2e" && env.from === phoneFp && env.seq === 0);
        if (!phoneHello) throw new Error("missing encrypted new-phone hello");
        const parsed = oldParseInner(
          decodeCbor(
            open(kPair, E2EBodySchema.parse(phoneHello.body), helloAd(phoneFp, computerFp)),
          ),
        );
        expect(parsed).toEqual({
          type: "conn.hello",
          n: parsed.type === "conn.hello" ? parsed.n : undefined,
        });
        expect(
          relay.received.slice(beginning).some(({ env }) => env.t === "e2e" && env.seq > 0),
        ).toBe(true);
        lease.release();
        await waitFor(() => cancelled);
        expect(oldApplicationTypes).toEqual(["subscribe", "subscribe"]);
      } finally {
        lease.release();
      }
    } finally {
      connectionManager.stop();
      oldRelay.stop();
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
      await waitFor(() => connectionManager.get(computerFp) === undefined);
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
