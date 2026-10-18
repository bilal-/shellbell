import {
  type CtrlMessageLoose,
  decodeEnvelope,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  type Identity,
  type InnerMessage,
  type InnerMessageLoose,
  isV2Hello,
  randomBytes,
  verifyPairRevocationV2,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../../agent/src/log.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { V2PhoneLink } from "../../agent/src/v2-phone-link.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { fakeNativeDirectHub } from "../../agent/test/fakes/native-direct-hub.js";
import {
  ComputerConnection,
  type ConnectionOptions,
  DeliveryUnknownError,
  type StatusExtra,
} from "../src/net/connection.js";
import { setControlLocked } from "../src/security/control-lock.js";
import type { Status } from "../src/store/connections.js";

const waitFor = (fn: () => boolean, ms = 3000) =>
  new Promise<void>((resolve, reject) => {
    const t0 = Date.now();
    const tick = () => {
      if (fn()) return resolve();
      if (Date.now() - t0 > ms) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });

/**
 * A fully scripted `WsLike` double for tests that need deterministic control over exactly which
 * ctrl frame arrives when (e.g. a `presence` mid-handshake) without racing a real relay/agent.
 */
class FakeSocket {
  binaryType = "";
  readyState = 0;
  closed = false;
  closeCode: number | undefined;
  closeReason: string | undefined;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(_data: ArrayBuffer | Uint8Array | string): void {
    // Outgoing frames are not inspected by the tests that use this double.
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.onclose?.({ code: code ?? 1000, reason: reason ?? "" });
  }

  triggerOpen(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  triggerEnvelope(env: Envelope): void {
    this.onmessage?.({ data: encodeEnvelope(env) });
  }

  triggerCtrl(body: CtrlMessageLoose): void {
    this.triggerEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body } as Envelope);
  }
}

type AgentLink = { link: V2PhoneLink; received: InnerMessage[] };

/** Minimal secure-v2 "agent" on the fake relay: negotiates the direct route, sends hello once
 *  it is ready, and by default acks every reqId. `current` is the link for the phone's latest
 *  handshake; a reconnect replaces it. */
async function fakeAgent(
  relay: FakeRelay,
  mac: Identity,
  kPair: Uint8Array,
  phoneFp: string,
  respond: (message: InnerMessage, link: V2PhoneLink) => void = (message, link) => {
    if ("reqId" in message) link.send({ type: "ack", reqId: message.reqId, ok: true });
  },
  /** False leaves the app-level hello to the test. */
  hello = true,
) {
  const fp = fingerprint(mac.ed25519.pub);
  const log = createLogger({ stdout: false });
  const rc = new RelayClient({
    relayUrl: relay.url,
    fp,
    identity: mac,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
  });
  let current: AgentLink | null = null;
  const received: InnerMessageLoose[] = [];
  const attach = (connId: string, name: string) => {
    if (current && !current.link.broken && current.link.activeRoute === "direct") {
      current.link.relayConnId = connId;
      return;
    }
    current?.link.close();
    const own: InnerMessage[] = [];
    const link = new V2PhoneLink({
      phoneFp,
      connId,
      name,
      computerFp: fp,
      identity: mac,
      kPair,
      remoteStatic: phone.x25519.pub,
      native: native.computer,
      send: (env) => rc.sendBoundedEnvelope(env),
      commitFloor: async () => {},
      prepareReady: () => true,
      terminal: (source, msg) => {
        // The phone's bootstrap `subscribe` only starts the direct route; it is not a request.
        if (msg.type === "subscribe" && msg.sessionId === null && own.length === 0) return;
        own.push(msg);
        received.push(msg as InnerMessageLoose);
        respond(msg, source);
      },
      ready: (source) => {
        if (!hello || !source.handshaken) return;
        source.send({
          type: "hello",
          agentVersion: "t",
          backends: [],
          computerName: "MBP",
          accent: "emerald",
        });
      },
      log,
    });
    current = { link, received: own };
  };
  rc.on("ctrl", (m) => {
    if (m.type === "phone-connected") attach(m.connId, m.name);
    else if (m.type === "phones") for (const p of m.connected) attach(p.connId, p.name);
  });
  rc.on("e2e", (env) => void current?.link.handleEnvelope(env));
  rc.start();
  await waitFor(() => rc.online);
  return {
    rc,
    received,
    send: (message: InnerMessage) => current?.link.send(message),
    get current() {
      return current;
    },
  };
}

let relay: FakeRelay;
let native: ReturnType<typeof fakeNativeDirectHub>;
const mac = generateIdentity();
const phone = generateIdentity();
const macFp = fingerprint(mac.ed25519.pub);
const phoneFp = fingerprint(phone.ed25519.pub);
const kPair = randomBytes(32);

function makeConn(over: Partial<ConnectionOptions> = {}) {
  const inner: InnerMessageLoose[] = [];
  const statuses: Status[] = [];
  const c = new ComputerConnection({
    computerFp: macFp,
    relayUrl: relay.url,
    identity: phone,
    phoneFp,
    phoneName: "iPhone",
    appVersion: "t",
    kPair,
    remoteStatic: mac.x25519.pub,
    commitFloor: async () => {},
    directFactory: native.phone,
    onInner: (m) => inner.push(m),
    onStatus: (s) => statuses.push(s),
    WebSocketImpl: WebSocket as never,
    backoffMinMs: 50,
    backoffMaxMs: 100,
    ...over,
  });
  return { c, inner, statuses };
}

const leases = () => relay.ctrlFromPhones.filter((r) => r.fp === phoneFp && r.msg.type === "lease");

function capturedTransport() {
  const sockets: WebSocket[] = [];
  class CapturedSocket extends WebSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return { sockets, WebSocketImpl: CapturedSocket as never };
}

/** A connected secure-v2 pair whose computer only answers through `onRequest` and leaves the
 *  app-level hello to the test. */
async function scriptedPair(
  onRequest: (message: InnerMessage, agent: V2PhoneLink) => void = () => {},
  onStatusEvent?: (status: Status, extra?: StatusExtra) => void,
  options: Partial<ConnectionOptions> = {},
) {
  const agent = await fakeAgent(relay, mac, kPair, phoneFp, onRequest, false);
  const statusEvents: Array<{ status: Status; extra?: StatusExtra }> = [];
  const { c, inner } = makeConn({
    ...options,
    onStatus: (status, extra) => {
      statusEvents.push({ status, extra });
      onStatusEvent?.(status, extra);
    },
  });
  c.connect();
  await waitFor(() => c.online);
  const first = agent.current!;
  /** Waits for the phone's next completed handshake and returns the computer's new link. */
  const reconnect = async (): Promise<{ agent: AgentLink }> => {
    const before = c.handshakeGeneration;
    await waitFor(() => c.handshakeGeneration > before && c.online);
    return { agent: agent.current! };
  };
  return {
    c,
    first,
    inner,
    statusEvents,
    get controlFrames(): CtrlMessageLoose[] {
      return relay.ctrlFromPhones.filter((r) => r.fp === phoneFp).map((r) => r.msg);
    },
    reconnect,
    /** A fresh handshake on a new network path, as after a network change. */
    async rekey(): Promise<AgentLink> {
      const next = reconnect();
      c.networkChanged(true);
      return (await next).agent;
    },
    stop: () => agent.rc.stop(),
  };
}

describe("authenticated stream capability", () => {
  it("does not overwrite a rotated registration with a pending authenticated acquisition", async () => {
    let resolveToken!: (token: {
      token: string;
      platform: "android";
      provider: "fcm";
      enabled: boolean;
    }) => void;
    const pending = new Promise<{
      token: string;
      platform: "android";
      provider: "fcm";
      enabled: boolean;
    }>((resolve) => {
      resolveToken = resolve;
    });
    const pair = await scriptedPair(undefined, undefined, { pushToken: () => pending });
    try {
      pair.c.sendPushToken({ token: "B", platform: "android", provider: "fcm", enabled: true });
      resolveToken({ token: "A", platform: "android", provider: "fcm", enabled: true });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(
        pair.controlFrames
          .filter((frame) => frame.type === "push-token")
          .map((frame) => frame.token),
      ).toEqual(["B"]);
    } finally {
      pair.c.close("user");
    }
  });
  it("registers the current native destination after authenticated reconnect", async () => {
    let token = "first-native-token";
    const pair = await scriptedPair(undefined, undefined, {
      pushToken: async () => ({
        token,
        platform: "ios",
        provider: "apns",
        environment: "development",
        enabled: true,
      }),
    });
    try {
      await vi.waitFor(() =>
        expect(pair.controlFrames).toContainEqual(
          expect.objectContaining({
            type: "push-token",
            token,
            provider: "apns",
            environment: "development",
          }),
        ),
      );
      token = "replacement-native-token";
      pair.c.close();
      pair.c.connect();
      await pair.reconnect();
      await vi.waitFor(() =>
        expect(
          pair.controlFrames.filter((frame) => frame.type === "push-token").at(-1),
        ).toMatchObject({
          type: "push-token",
          token,
          platform: "ios",
          provider: "apns",
          environment: "development",
        }),
      );
    } finally {
      pair.c.close("user");
    }
  });
  it("advertises private pushes only after durable enrollment and its matching encrypted ACK", async () => {
    const native = {
      notificationReadiness: async () => ({ crypto: true, receiver: true, storage: true }),
      installNotificationKey: vi.fn().mockResolvedValue(undefined),
    };
    const token = { token: "private-test", platform: "android" as const, enabled: true };
    // Private pushes need a relay that advertises them.
    await relay.stop();
    relay = new FakeRelay(macFp, { features: ["notify-context-v1"] });
    await relay.start();
    const pair = await scriptedPair(undefined, undefined, {
      notificationNative: native,
      pushToken: async () => token,
    });
    try {
      const registrations = () => pair.controlFrames.filter((m) => m.type === "push-token");
      await vi.waitFor(() => expect(registrations().length).toBeGreaterThan(0));
      expect(registrations().at(-1)?.features ?? []).not.toContain("notify-context-v1");
      pair.first.link.send({
        type: "hello",
        agentVersion: "test",
        computerName: "Test Mac",
        accent: "green",
        backends: [],
        features: ["notify-context-v1"],
      });
      await vi.waitFor(() =>
        expect(pair.inner).toContainEqual(
          expect.objectContaining({ type: "hello", features: ["notify-context-v1"] }),
        ),
      );
      await vi.waitFor(() => expect(native.installNotificationKey).toHaveBeenCalledOnce());
      await vi.waitFor(() =>
        expect(pair.first.received).toContainEqual({
          type: "notification.enroll",
          generation: expect.any(String),
        }),
      );
      const request = pair.first.received.find((m) => m.type === "notification.enroll");
      if (request?.type !== "notification.enroll") throw new Error("missing enrollment");
      expect(native.installNotificationKey).toHaveBeenCalledOnce();
      expect(registrations().at(-1)?.features ?? []).not.toContain("notify-context-v1");
      pair.first.link.send({ type: "notification.enrolled", generation: request.generation });
      await vi.waitFor(() =>
        expect(registrations().at(-1)?.features).toContain("notify-context-v1"),
      );
      // After a fresh handshake, the old generation's acknowledgement no longer counts.
      const next = await pair.rekey();
      next.link.send({ type: "notification.enrolled", generation: request.generation });
      pair.c.sendPushToken(token);
      expect(registrations().at(-1)?.features ?? []).not.toContain("notify-context-v1");
    } finally {
      pair.c.close("user");
    }
  });
});

beforeEach(async () => {
  native = fakeNativeDirectHub();
  relay = new FakeRelay(macFp);
  await relay.start();
});
afterEach(async () => {
  await relay.stop();
});

describe("ComputerConnection", () => {
  it("replaces a network path immediately and ignores callbacks from the retired socket", () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket });
    try {
      c.connect();
      const old = sockets[0]!;
      c.networkChanged(true);
      expect(old.closed).toBe(true);
      expect(sockets).toHaveLength(2);
      old.triggerOpen();
      old.onclose?.({ code: 4004, reason: "obsolete path" });
      expect(c.status).toBe("connecting");
      expect(sockets).toHaveLength(2);
    } finally {
      c.close();
    }
  });

  it("pauses network retries and resumes immediately without waiting for backoff", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket });
    try {
      c.connect();
      sockets[0]!.onclose?.({ code: 1006, reason: "lost path" });
      c.networkChanged(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sockets).toHaveLength(1);
      expect(c.status).toBe("offline");
      c.networkChanged(true);
      expect(sockets).toHaveLength(2);
      expect(c.status).toBe("connecting");
    } finally {
      c.close();
      vi.useRealTimers();
    }
  });

  it.each([4413, 4429])("network handoff respects the relay cooldown after %s", async (code) => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket, backoffMaxMs: 30_000 });
    try {
      c.connect();
      sockets[0]!.onclose?.({ code, reason: "slow down" });
      c.networkChanged(false);
      c.networkChanged(true);
      await vi.advanceTimersByTimeAsync(29_999);
      expect(sockets).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(sockets).toHaveLength(2);
    } finally {
      c.close();
      vi.useRealTimers();
    }
  });

  it("rejects uncertain input on handoff and never sends it again", async () => {
    const pair = await scriptedPair();
    try {
      const pending = pair.c.request({
        type: "input.line",
        reqId: "handoff-input",
        sessionId: "fixture",
        text: "fixture only",
      });
      const rejection = expect(pending).rejects.toBeInstanceOf(DeliveryUnknownError);
      pair.c.networkChanged(true);
      await rejection;
      const fresh = await pair.reconnect();
      expect(pair.c.pendingReqIds()).toEqual([]);
      expect(
        fresh.agent.received.filter(
          (message) => "reqId" in message && message.reqId === "handoff-input",
        ),
      ).toEqual([]);
    } finally {
      pair.c.close();
    }
  });

  it.each([4004, 4005, 4403])("network restoration cannot bypass permanent close %s", (code) => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket });
    try {
      c.connect();
      sockets[0]!.onclose?.({ code, reason: "permanent" });
      c.networkChanged(false);
      c.networkChanged(true);
      expect(sockets).toHaveLength(1);
      expect(c.status).toBe("error");
    } finally {
      c.close();
    }
  });

  it("network restoration cannot retry a pairing that requires an upgrade", () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c } = makeConn({
      WebSocketImpl: RecordingSocket,
      minProtocolVersion: 2,
      remoteStatic: undefined,
    });
    try {
      c.connect();
      sockets[0]!.triggerOpen();
      sockets[0]!.triggerCtrl({
        type: "auth-ok",
        role: "phone",
        agentOnline: true,
        computerName: null,
        serverTime: Date.now(),
        minFrameMs: 125,
      });
      expect(c.status).toBe("error");
      c.networkChanged(false);
      c.networkChanged(true);
      expect(sockets).toHaveLength(1);
      expect(c.status).toBe("error");
    } finally {
      c.close();
    }
  });

  it("uses secure v2 for a pair without the floor and never sends a legacy hello", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    try {
      c.connect();
      const hellos = () =>
        relay.received.filter(
          (r) => r.env.from === phoneFp && r.env.v === 1 && r.env.t === "e2e" && r.env.seq === 0,
        );
      await waitFor(() => hellos().length > 0);
      for (const { env } of hellos()) expect(isV2Hello(env, kPair, macFp, phoneFp)).toBe(true);
      await waitFor(() => c.online && inner.some((m) => m.type === "hello"));
      expect(c.activeRoute).toBe("direct");
      for (const { env } of hellos()) expect(isV2Hello(env, kPair, macFp, phoneFp)).toBe(true);
    } finally {
      c.close("user");
      agent.rc.stop();
    }
  });

  it("stops instead of sending a legacy hello when the secure-v2 keys are missing", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const onStatus = vi.fn();
    const { c } = makeConn({ minProtocolVersion: 2, remoteStatic: undefined, onStatus });
    try {
      c.connect();
      await waitFor(() => c.status === "error");
      expect(relay.received.filter((r) => r.env.from === phoneFp)).toHaveLength(0);
      expect(onStatus).toHaveBeenCalledWith(
        "error",
        expect.objectContaining({ error: "upgrade-required" }),
      );
      c.unpairSelf();
      await waitFor(() => relay.ctrlFromPhones.some((r) => r.msg.type === "unpair"));
      const unpair = relay.ctrlFromPhones.find((r) => r.msg.type === "unpair")?.msg;
      expect(unpair?.type).toBe("unpair");
      if (unpair?.type !== "unpair") throw new Error("missing unpair");
      expect(unpair.proof).toBeDefined();
      expect(
        verifyPairRevocationV2(unpair.proof, {
          computerFp: macFp,
          phoneFp,
          kPair,
          phoneEd25519Pub: phone.ed25519.pub,
        }),
      ).toBe(true);
    } finally {
      c.close();
      agent.rc.stop();
    }
  });

  it("contains a throwing keepalive write and continues renewing its relay lease", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const transport = capturedTransport();
    const { c } = makeConn({ WebSocketImpl: transport.WebSocketImpl });
    let restoreSend: (() => void) | undefined;
    try {
      c.connect();
      await waitFor(() => c.status === "online");
      // Zero while signing in, then a positive lease once online.
      await waitFor(() => {
        const last = leases().at(-1)?.msg;
        return last?.type === "lease" && last.ttlMs === 60_000;
      });
      const renewed = leases().length + 1;
      const socket = transport.sockets[0];
      if (!socket) throw new Error("missing connected transport");
      const send = socket.send.bind(socket);
      const spy = vi.spyOn(socket, "send").mockImplementation((data) => {
        if (data === "ping") throw new Error("native transport refused keepalive");
        send(data);
      });
      restoreSend = () => spy.mockRestore();
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      await waitFor(() => leases().length === renewed);
      expect(leases().at(-1)?.msg).toMatchObject({ type: "lease", ttlMs: 60_000 });
      expect(c.status).toBe("online");
      const writesBeforeClose = spy.mock.calls.length;
      Object.defineProperty(socket, "readyState", { configurable: true, value: WebSocket.CLOSING });
      try {
        expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
        expect(spy.mock.calls.length).toBe(writesBeforeClose);
      } finally {
        Reflect.deleteProperty(socket, "readyState");
      }
      c.close();
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      expect(c.status).toBe("idle");
    } finally {
      restoreSend?.();
      c.close();
      agent.rc.stop();
      vi.useRealTimers();
    }
  });

  it("refuses terminal control while App Lock is up but keeps the view current", async () => {
    const pair = await scriptedPair((message, agent) => {
      if ("reqId" in message) agent.send({ type: "ack", reqId: message.reqId, ok: true });
    });
    try {
      setControlLocked(true);
      for (const message of [
        { type: "input.line", reqId: "l", sessionId: "iterm2:s", text: "rm -rf ~" },
        { type: "input.key", reqId: "k", sessionId: "iterm2:s", key: "enter" },
        { type: "session.create", reqId: "c", in: { kind: "tab", backend: "iterm2" } },
        { type: "session.focus", reqId: "f", sessionId: "iterm2:s" },
      ] as const)
        await expect(pair.c.request(message)).rejects.toBeInstanceOf(DeliveryUnknownError);
      expect(pair.c.send({ type: "subscribe", sessionId: "iterm2:s" })).toBe(true);
      await waitFor(() => pair.first.received.length === 1);
      expect(pair.first.received.map((m) => m.type)).toEqual(["subscribe"]);

      setControlLocked(false);
      const ack = await pair.c.request({
        type: "input.line",
        reqId: "after",
        sessionId: "iterm2:s",
        text: "ls",
      });
      expect(ack.ok).toBe(true);
    } finally {
      setControlLocked(false);
      pair.c.close();
    }
  });

  it("returns the identical active duplicate promise and sends only its first payload", async () => {
    const pair = await scriptedPair();
    try {
      const first = pair.c.request({
        type: "input.line",
        reqId: "same",
        sessionId: "iterm2:s",
        text: "first",
      });
      const duplicate = pair.c.request({
        type: "input.line",
        reqId: "same",
        sessionId: "iterm2:s",
        text: "ignored",
      });
      expect(duplicate).toBe(first);
      await waitFor(() => pair.first.received.length === 1);
      expect(pair.first.received).toMatchObject([{ type: "input.line", text: "first" }]);
      pair.first.link.send({ type: "ack", reqId: "same", ok: true });
      await expect(first).resolves.toMatchObject({ reqId: "same", ok: true });
      expect(pair.c.pendingReqIds()).toEqual([]);

      const later = pair.c.request({
        type: "input.line",
        reqId: "same",
        sessionId: "iterm2:s",
        text: "later",
      });
      expect(later).not.toBe(first);
      await waitFor(() => pair.first.received.length === 2);
      expect(pair.first.received).toMatchObject([
        { type: "input.line", text: "first" },
        { type: "input.line", text: "later" },
      ]);
      pair.first.link.send({ type: "ack", reqId: "same", ok: true });
      await expect(later).resolves.toMatchObject({ reqId: "same", ok: true });
    } finally {
      pair.c.close();
    }
  });

  it("converts a local request serialization exception to payload-free delivery unknown", async () => {
    const pair = await scriptedPair();
    try {
      const message = {
        type: "input.line" as const,
        reqId: "serialize",
        sessionId: "iterm2:s",
        get text(): string {
          throw new Error("unavailable field");
        },
      };
      const pending = pair.c.request(message);
      await expect(pending).rejects.toBeInstanceOf(DeliveryUnknownError);
      expect(pair.c.pendingReqIds()).toEqual([]);
      expect(pair.first.received).toEqual([]);
    } finally {
      pair.c.close();
    }
  });

  it("authenticates, leases, handshakes, receives hello, sends inputs with acks", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner, statuses } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // Secure v2 negotiates on the relay, then waits for the direct route before going online.
    expect(statuses).toEqual([
      "connecting",
      "auth",
      "handshake",
      "handshake",
      "waiting-direct",
      "online",
    ]);
    // Not attentive until online: a positive lease would cancel this phone's pending pushes.
    await waitFor(() => leases().length >= 2);
    expect(leases().map((r) => r.msg)).toEqual([
      { type: "lease", ttlMs: 0 },
      { type: "lease", ttlMs: 60_000 },
    ]);
    const ack = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "y",
    });
    expect(ack.ok).toBe(true);
    expect(agent.received[0]).toMatchObject({ type: "input.line", text: "y" });
    c.close("user");
    agent.rc.stop();
  });

  it("close('background') sends lease 0 and fails pending requests", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // Stop the agent so nothing can ack; the phone socket stays up.
    agent.rc.stop();
    await waitFor(() => relay.agent === null);
    const before = leases().length;
    const p = c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "x",
    });
    expect(c.pendingReqIds()).toHaveLength(1);
    c.close("background");
    await expect(p).rejects.toThrow(/delivery unknown/i);
    expect(c.pendingReqIds()).toHaveLength(0);
    expect(c.status).toBe("idle");
    await waitFor(() => leases().length > before);
    expect(leases().at(-1)?.msg).toMatchObject({ type: "lease", ttlMs: 0 });
  });

  it("reconnects after the relay drops the socket and keeps its direct route", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    const dropped = relay.phones.get(phoneFp)?.ws;
    dropped?.terminate();
    await waitFor(() => {
      const socket = relay.phones.get(phoneFp)?.ws;
      return socket !== undefined && socket !== dropped;
    }, 5000);
    expect(c.online).toBe(true);
    expect(
      (await c.request({ type: "input.line", reqId: c.newReqId(), sessionId: "s", text: "y" })).ok,
    ).toBe(true);
    c.close("user");
    agent.rc.stop();
  });

  it("stops permanently on 4005 (superseded) instead of racing the winner", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const first = makeConn();
    first.c.connect();
    await waitFor(() => first.inner.some((m) => m.type === "hello"));
    const connections = relay.connections;
    const second = makeConn();
    second.c.connect();
    await waitFor(() => first.c.status === "error");
    expect(first.statuses.at(-1)).toBe("error");
    await new Promise((r) => setTimeout(r, 300));
    // No third socket: the loser must not reconnect.
    expect(relay.connections).toBe(connections + 1);
    second.c.close("user");
    agent.rc.stop();
  });

  it("stops permanently when the relay rejects the identity", async () => {
    const { c, statuses } = makeConn({ identity: generateIdentity() });
    c.connect();
    await waitFor(() => c.status === "error");
    const connections = relay.connections;
    await new Promise((r) => setTimeout(r, 300));
    expect(relay.connections).toBe(connections);
    expect(statuses.at(-1)).toBe("error");
  });

  it("close() then immediate connect() ignores the stale socket's late close event", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    const connectionsBefore = relay.connections;
    c.close();
    c.connect();
    // The reconnect completes a fresh handshake: a second "hello" app message arrives.
    await waitFor(() => inner.filter((m) => m.type === "hello").length === 2, 5000);
    expect(c.status).toBe("online");
    // Give the stale socket's own close event (whatever code it carries — ours, or the relay's
    // 4005 once the reconnect authenticates under the same phone fp) time to arrive and settle.
    await new Promise((r) => setTimeout(r, 300));
    // The socket-identity guard must have ignored it: the live (reconnected) socket is untouched
    // and exactly one extra socket was dialled, never a phantom third one.
    expect(c.status).toBe("online");
    expect(relay.connections).toBe(connectionsBefore + 1);
    c.close("user");
    agent.rc.stop();
  });

  it("close() while still CONNECTING closes the underlying socket instead of leaking it", () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c, statuses } = makeConn({ WebSocketImpl: RecordingSocket });
    c.connect();
    const sock = sockets[0];
    if (!sock) throw new Error("test setup: no socket constructed");
    // Never opened: still CONNECTING when close() is called.
    expect(sock.readyState).toBe(0);
    c.close();
    // The socket itself must be told to close, not merely abandoned (readyState === OPEN is not
    // the only state close() must act on).
    expect(sock.closed).toBe(true);
    expect(c.status).toBe("idle");
    expect(statuses).toEqual(["connecting", "idle"]);
  });

  it("keeps TURN servers from auth-ok and asks the relay to refresh them before they expire", async () => {
    const sent: CtrlMessageLoose[] = [];
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
      override send(data: ArrayBuffer | Uint8Array | string): void {
        if (typeof data === "string") return;
        const env = decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (env.t === "ctrl") sent.push(env.body as CtrlMessageLoose);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket });
    try {
      c.connect();
      const sock = sockets[0];
      if (!sock) throw new Error("test setup: no socket constructed");
      sock.triggerOpen();
      sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
      expect(c.iceServers()).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
      const turn = { urls: ["turn:t.example.test:3478"], username: "u", credential: "c" };
      sock.triggerCtrl({
        type: "auth-ok",
        role: "phone",
        agentOnline: false,
        computerName: null,
        serverTime: Date.now(),
        minFrameMs: 125,
        iceServers: [turn],
        iceExpiresInMs: 60 * 60 * 1000,
      });
      expect(c.iceServers()).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }, turn]);
      expect(sent.filter((m) => m.type === "ice-refresh")).toHaveLength(1);
      expect(c.iceServers()).toHaveLength(2);
      expect(sent.filter((m) => m.type === "ice-refresh")).toHaveLength(1);
      sock.triggerCtrl({
        type: "ice-servers",
        iceServers: [{ ...turn, username: "u2" }],
        iceExpiresInMs: 86_400_000,
      });
      expect(c.iceServers()[1]?.username).toBe("u2");
    } finally {
      c.close();
    }
  });

  it("refreshes TURN servers on its keepalive without waiting for a new peer", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sent: CtrlMessageLoose[] = [];
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
      override send(data: ArrayBuffer | Uint8Array | string): void {
        if (typeof data === "string") return;
        const env = decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (env.t === "ctrl") sent.push(env.body as CtrlMessageLoose);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket });
    try {
      c.connect();
      const sock = sockets[0]!;
      sock.triggerOpen();
      sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
      sock.triggerCtrl({
        type: "auth-ok",
        role: "phone",
        agentOnline: false,
        computerName: null,
        serverTime: Date.now(),
        minFrameMs: 125,
        iceServers: [],
        iceExpiresInMs: 0,
      });
      expect(sent.some((m) => m.type === "ice-refresh")).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(sent.filter((m) => m.type === "ice-refresh")).toHaveLength(1);
    } finally {
      c.close();
      vi.useRealTimers();
    }
  });

  it("never asks a relay without TURN support to refresh", async () => {
    const sent: CtrlMessageLoose[] = [];
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
      override send(data: ArrayBuffer | Uint8Array | string): void {
        if (typeof data === "string") return;
        const env = decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (env.t === "ctrl") sent.push(env.body as CtrlMessageLoose);
      }
    }
    const { c } = makeConn({ WebSocketImpl: RecordingSocket });
    try {
      c.connect();
      const sock = sockets[0]!;
      sock.triggerOpen();
      sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
      sock.triggerCtrl({
        type: "auth-ok",
        role: "phone",
        agentOnline: false,
        computerName: null,
        serverTime: Date.now(),
        minFrameMs: 125,
      });
      expect(c.iceServers()).toEqual([{ urls: ["stun:stun.cloudflare.com:3478"] }]);
      expect(sent.some((m) => m.type === "ice-refresh")).toBe(false);
    } finally {
      c.close();
    }
  });

  it("presence agentOnline:false during handshake goes offline but keeps the socket open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c, statuses } = makeConn({ WebSocketImpl: RecordingSocket });
    c.connect();
    const sock = sockets[0];
    if (!sock) throw new Error("test setup: no socket constructed");
    sock.triggerOpen();
    sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
    sock.triggerCtrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
      computerName: null,
      serverTime: Date.now(),
      minFrameMs: 125,
    });
    try {
      expect(c.status).toBe("handshake");
      sock.triggerCtrl({ type: "presence", agentOnline: false, computerName: null });
      expect(c.status).toBe("offline");
      // Past the secure handshake's 15-second deadline: the abandoned attempt must not close
      // the socket the phone keeps for the computer's return.
      vi.advanceTimersByTime(20_000);
      expect(sock.closed).toBe(false);
      expect(statuses.at(-1)).toBe("offline");
      sock.triggerCtrl({ type: "presence", agentOnline: true, computerName: null });
      expect(c.status).toBe("handshake");
      expect(sock.closed).toBe(false);
    } finally {
      c.close("user");
      vi.useRealTimers();
    }
  });

  it("unpairSelf() sends an unpair ctrl the relay accepts for this phone's own fp (review R60)", async () => {
    const { c } = makeConn();
    c.connect();
    // No agent needed: ctrl auth completes (and the relay attaches `att.fp`) independent of
    // whether an agent is present -- mirrored by the identity-rejection test above, which also
    // reaches a terminal status without ever starting a fake agent.
    await waitFor(
      () => c.status === "offline" || c.status === "handshake" || c.status === "online",
    );
    c.unpairSelf();
    await waitFor(() =>
      relay.ctrlFromPhones.some((r) => r.fp === phoneFp && r.msg.type === "unpair"),
    );
    const sent = relay.ctrlFromPhones.find((r) => r.msg.type === "unpair");
    expect(sent?.msg).toMatchObject({ type: "unpair", phoneFp });
    c.close("user");
  });

  it("holds a push token sent before the relay's challenge, which would close as 'auth required'", async () => {
    const sent: CtrlMessageLoose[] = [];
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
      override send(data: ArrayBuffer | Uint8Array | string): void {
        if (typeof data === "string") return;
        const env = decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data));
        if (env.t === "ctrl") sent.push(env.body as CtrlMessageLoose);
      }
    }
    const token = { token: "fresh", platform: "android" as const, provider: "fcm" as const };
    const { c } = makeConn({
      WebSocketImpl: RecordingSocket,
      // Acquisition fails after sign-in, so only the update held from before it can say "off".
      pushToken: async () => null,
    });
    try {
      c.connect();
      const sock = sockets[0];
      if (!sock) throw new Error("test setup: no socket constructed");
      sock.triggerOpen();
      c.sendPushToken({ ...token, enabled: true });
      c.sendPushToken({ ...token, enabled: false });
      expect(sent.map((m) => m.type)).not.toContain("push-token");
      sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
      expect(sent[0]?.type).toBe("auth");
      sock.triggerCtrl({
        type: "auth-ok",
        role: "phone",
        agentOnline: false,
        computerName: null,
        serverTime: Date.now(),
        minFrameMs: 125,
      });
      await waitFor(() => sent.some((m) => m.type === "push-token"));
      // Only the latest update, once.
      expect(sent.filter((m) => m.type === "push-token")).toEqual([
        expect.objectContaining({ token: "fresh", enabled: false }),
      ]);
    } finally {
      c.close("user");
    }
  });

  it("sendPushToken() forwards token/platform/enabled over ctrl (review R60)", async () => {
    const { c } = makeConn();
    c.connect();
    await waitFor(
      () => c.status === "offline" || c.status === "handshake" || c.status === "online",
    );
    c.sendPushToken({ token: "expo-token-abc", platform: "ios", enabled: false });
    await waitFor(() =>
      relay.ctrlFromPhones.some((r) => r.fp === phoneFp && r.msg.type === "push-token"),
    );
    const sent = relay.ctrlFromPhones.find((r) => r.msg.type === "push-token");
    expect(sent?.msg).toMatchObject({
      type: "push-token",
      token: "expo-token-abc",
      platform: "ios",
      enabled: false,
    });
    c.close("user");
  });
});
