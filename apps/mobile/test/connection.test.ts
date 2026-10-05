import {
  type CtrlMessageLoose,
  decodeEnvelope,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  helloAd,
  type Identity,
  type InnerMessage,
  type InnerMessageLoose,
  randomBytes,
  StreamReceiver,
  seal,
  verifyPairRevocationV2,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../../agent/src/log.js";
import { PhoneLink } from "../../agent/src/phone-link.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import {
  ComputerConnection,
  type ConnectionOptions,
  DeliveryUnknownError,
  type StatusExtra,
} from "../src/net/connection.js";
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

/** Minimal "agent" on the fake relay: authenticates, answers conn.hello, acks every reqId. */
async function fakeAgent(
  relay: FakeRelay,
  mac: Identity,
  kPair: Uint8Array,
  phoneFp: string,
  transformEnvelope: (env: Envelope) => Envelope = (env) => env,
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
  let link: PhoneLink | null = null;
  const received: InnerMessageLoose[] = [];
  rc.on("ctrl", (m) => {
    if (m.type !== "phone-connected") return;
    link = new PhoneLink({
      phoneFp,
      connId: m.connId,
      name: m.name,
      kPair,
      computerFp: fp,
      send: (e) => {
        rc.sendEnvelope(transformEnvelope(e));
      },
      log,
    });
  });
  rc.on("e2e", (env) => {
    if (env.v !== 1) throw new Error("unexpected v2 in legacy test");
    const current = link;
    if (!current) return;
    const was = current.handshaken;
    const msg = current.handleEnvelope(env);
    if (!was && current.handshaken) {
      current.send({
        type: "hello",
        agentVersion: "t",
        backends: [],
        computerName: "MBP",
        accent: "emerald",
      });
    }
    if (!msg) return;
    received.push(msg as InnerMessageLoose);
    if ("reqId" in msg) current.send({ type: "ack", reqId: msg.reqId, ok: true });
  });
  rc.start();
  await waitFor(() => rc.online);
  return { rc, received, send: (message: InnerMessage) => link?.send(message) };
}

let relay: FakeRelay;
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

async function scriptedPair(
  onRequest?: (message: InnerMessage, agent: PhoneLink) => void,
  onStatusEvent?: (status: Status, extra?: StatusExtra) => void,
  capabilities: { mobile?: boolean; agent?: boolean } = {},
  options: Partial<ConnectionOptions> = {},
) {
  type Agent = { link: PhoneLink; received: InnerMessage[] };
  let current: Agent | null = null;
  let phoneHello: Envelope | null = null;
  const phoneFrames: Envelope[] = [];
  const controlFrames: CtrlMessageLoose[] = [];
  const sockets: FakeSocket[] = [];
  class ScriptedSocket extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }

    override send(data: ArrayBuffer | Uint8Array | string): void {
      if (typeof data === "string") return;
      const env = decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data));
      if (env.t === "ctrl") {
        controlFrames.push(env.body as CtrlMessageLoose);
        return;
      }
      if (env.t !== "e2e") return;
      phoneFrames.push(env);
      if (env.seq === 0) phoneHello = env;
      const active = current;
      if (!active) return;
      const message = active.link.handleEnvelope(env);
      if (message) {
        active.received.push(message);
        onRequest?.(message, active.link);
      }
    }
  }
  const statusEvents: Array<{ status: Status; extra?: StatusExtra }> = [];
  const helloReplies: Envelope[] = [];
  const agentEnvelopes: Envelope[] = [];
  const { c, inner } = makeConn({
    ...options,
    boundedStream: capabilities.mobile,
    WebSocketImpl: ScriptedSocket,
    onStatus: (status, extra) => {
      statusEvents.push({ status, extra });
      onStatusEvent?.(status, extra);
    },
  });
  c.connect();
  const socket = sockets[0];
  if (!socket) throw new Error("test setup: no scripted socket");
  let activeSocket = socket;
  const makeAgent = (synchronousHello = false): Agent => {
    const received: InnerMessage[] = [];
    const link = new PhoneLink({
      phoneFp,
      connId: "scripted",
      name: "iPhone",
      kPair,
      computerFp: macFp,
      boundedStream: capabilities.agent,
      send: (env) => {
        agentEnvelopes.push(env);
        if (env.seq === 0) helloReplies.push(env);
        if (env.seq === 0 && !synchronousHello)
          queueMicrotask(() => activeSocket.triggerEnvelope(env));
        else activeSocket.triggerEnvelope(env);
      },
      log: createLogger({ stdout: false }),
    });
    return { link, received };
  };
  current = makeAgent();
  const first = current;
  const authenticate = (target: FakeSocket) => {
    target.triggerOpen();
    target.triggerCtrl({
      type: "auth-ok",
      role: "phone",
      agentOnline: true,
      computerName: null,
      serverTime: Date.now(),
      minFrameMs: 125,
      features: ["notify-context-v1"],
    });
  };
  authenticate(socket);
  await Promise.resolve();
  expect(c.status).toBe("online");
  return {
    c,
    socket,
    first,
    inner,
    statusEvents,
    helloReplies,
    agentEnvelopes,
    phoneFrames,
    controlFrames,
    rekey(synchronousHello = false): Agent {
      if (!phoneHello) throw new Error("test setup: no phone hello");
      const next = makeAgent(synchronousHello);
      current = next;
      next.link.handleEnvelope(phoneHello);
      return next;
    },
    async reconnect(): Promise<{ socket: FakeSocket; agent: Agent }> {
      await vi.waitFor(() => expect(sockets).toHaveLength(2));
      const nextSocket = sockets[1];
      if (!nextSocket) throw new Error("test setup: no reconnect socket");
      activeSocket = nextSocket;
      const next = makeAgent();
      current = next;
      authenticate(nextSocket);
      await Promise.resolve();
      expect(c.status).toBe("online");
      return { socket: nextSocket, agent: next };
    },
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
    const pair = await scriptedPair(undefined, undefined, {}, { pushToken: () => pending });
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
    const pair = await scriptedPair(
      undefined,
      undefined,
      {},
      {
        pushToken: async () => ({
          token,
          platform: "ios",
          provider: "apns",
          environment: "development",
          enabled: true,
        }),
      },
    );
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
        expect(pair.controlFrames.at(-1)).toMatchObject({
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
    const pair = await scriptedPair(
      undefined,
      undefined,
      {},
      {
        notificationNative: native,
        pushToken: async () => token,
      },
    );
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
      expect(pair.inner).toContainEqual(
        expect.objectContaining({ type: "hello", features: ["notify-context-v1"] }),
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
      const next = pair.rekey(true);
      next.link.send({ type: "notification.enrolled", generation: request.generation });
      pair.c.sendPushToken(token);
      expect(registrations().at(-1)?.features ?? []).not.toContain("notify-context-v1");
    } finally {
      pair.c.close("user");
    }
  });
  it.each([
    { mobile: false, agent: false, expected: "legacy" },
    { mobile: false, agent: true, expected: "legacy" },
    { mobile: true, agent: false, expected: "legacy" },
    { mobile: true, agent: true, expected: "bounded" },
  ])(
    "negotiates $expected when mobile=$mobile agent=$agent",
    async ({ mobile, agent, expected }) => {
      const pair = await scriptedPair(undefined, undefined, { mobile, agent });
      expect(pair.c.streamMode).toBe(expected);
      expect(pair.first.link.streamMode).toBe(expected);
      expect(pair.c.handshakeGeneration).toBe(1);
      const firstReply = pair.helloReplies[0];
      if (!firstReply) throw new Error("missing authenticated hello");
      pair.socket.triggerEnvelope(firstReply);
      expect(pair.c.handshakeGeneration).toBe(1);
      expect(pair.c.streamMode).toBe(expected);
    },
  );

  it("refuses an old generation before sealing and keeps sequence for the accepted key", async () => {
    const pair = await scriptedPair(undefined, undefined, { mobile: true, agent: true });
    const generation = pair.c.handshakeGeneration;
    expect(pair.c.sendForHandshake(generation, { type: "subscribe", sessionId: null })).toBe(true);
    const next = pair.rekey(true);
    expect(pair.c.handshakeGeneration).toBe(generation + 1);
    const frameCount = pair.phoneFrames.length;
    expect(
      pair.c.sendForHandshake(generation, { type: "subscribe", sessionId: "tmux:stale" }),
    ).toBe(false);
    expect(pair.phoneFrames).toHaveLength(frameCount);
    expect(pair.c.sendForHandshake(generation + 1, { type: "subscribe", sessionId: null })).toBe(
      true,
    );
    expect(pair.phoneFrames.at(-1)?.seq).toBe(1);
    expect(next.received).toEqual([{ type: "subscribe", sessionId: null }]);
  });

  it("refuses a closed socket before sealing for the current generation", async () => {
    const pair = await scriptedPair(undefined, undefined, { mobile: true, agent: true });
    const generation = pair.c.handshakeGeneration;
    const frameCount = pair.phoneFrames.length;
    pair.socket.readyState = 3;
    expect(pair.c.sendForHandshake(generation, { type: "subscribe", sessionId: null })).toBe(false);
    expect(pair.phoneFrames).toHaveLength(frameCount);
    pair.socket.readyState = 1;
    expect(pair.c.sendForHandshake(generation, { type: "subscribe", sessionId: null })).toBe(true);
    expect(pair.phoneFrames.at(-1)?.seq).toBe(1);
  });

  it("updates capability ownership on a fresh accepted key while status stays online", async () => {
    const capabilities = { mobile: true, agent: true };
    const pair = await scriptedPair(undefined, undefined, capabilities);
    expect(pair.c.streamMode).toBe("bounded");
    capabilities.agent = false;
    pair.rekey(true);
    expect(pair.c.streamMode).toBe("legacy");
    expect(pair.c.handshakeGeneration).toBe(2);
    expect(pair.statusEvents.filter((event) => event.status === "online")).toHaveLength(2);
  });

  it("keeps legacy mode for an authenticated unknown feature and ignores malformed features", async () => {
    const pair = await scriptedPair(undefined, undefined, { mobile: true, agent: false });
    const agentHello = (features: unknown): Envelope => ({
      v: 1,
      t: "e2e",
      from: macFp,
      to: phoneFp,
      seq: 0,
      body: seal(
        kPair,
        encodeCbor({ type: "conn.hello", n: randomBytes(16), features }),
        helloAd(macFp, phoneFp),
      ),
    });
    pair.socket.triggerEnvelope(agentHello(["future-stream-v2"]));
    expect(pair.c.handshakeGeneration).toBe(2);
    expect(pair.c.streamMode).toBe("legacy");
    pair.socket.triggerEnvelope(agentHello([42]));
    expect(pair.c.handshakeGeneration).toBe(2);
    expect(pair.c.streamMode).toBe("legacy");
  });
});

beforeEach(async () => {
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
    const { c } = makeConn({ WebSocketImpl: RecordingSocket, minProtocolVersion: 2 });
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

  it("never sends a legacy hello for a v2-upgraded pair", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const onStatus = vi.fn();
    const { c } = makeConn({ minProtocolVersion: 2, onStatus });
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

  it.each([
    { paddingBytes: 0, expected: "accepted" },
    { paddingBytes: 32768, expected: "invalid" },
  ])(
    "passes original wire length to assembly with $paddingBytes padding bytes",
    async ({ paddingBytes, expected }) => {
      let sentBytes = 0;
      let parsedBytes = 0;
      const agent = await fakeAgent(relay, mac, kPair, phoneFp, (env) => {
        const padded = { ...env, padding: new Uint8Array(paddingBytes) };
        const bytes = encodeEnvelope(padded);
        sentBytes = bytes.byteLength;
        parsedBytes = encodeEnvelope(decodeEnvelope(bytes)).byteLength;
        return padded;
      });
      const applied: Uint8Array[] = [];
      const receiver = new StreamReceiver({
        subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA",
        sessionId: "tmux:1",
        now: () => 0,
        accept: (_meta, bytes) => applied.push(bytes),
        acknowledge: () => true,
      });
      let receivedBytes: number | undefined;
      let result: string | undefined;
      const { c } = makeConn({
        onInner: (message, envelopeBytes) => {
          if (message.type !== "stream.chunk") return;
          receivedBytes = envelopeBytes;
          result = receiver.receive(message, envelopeBytes);
        },
      });
      try {
        c.connect();
        await waitFor(() => c.status === "online");
        agent.send({
          type: "stream.chunk",
          subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA",
          transferId: "BBBBBBBBBBBBBBBBBBBBBB",
          sessionId: "tmux:1",
          sequence: 1,
          index: 0,
          count: 1,
          totalBytes: 1,
          data: new Uint8Array([42]),
          meta: { kind: "snapshot", generation: 1 },
        });
        await waitFor(() => result !== undefined);
        expect(receivedBytes).toBe(sentBytes);
        expect(parsedBytes).toBeLessThan(32768);
        expect(result).toBe(expected);
        expect(applied).toEqual(paddingBytes === 0 ? [new Uint8Array([42])] : []);
        expect(receiver.retainedBytes).toBe(0);
      } finally {
        c.close();
        agent.rc.stop();
      }
    },
  );

  it("contains a throwing keepalive write and continues renewing its relay lease", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const transport = capturedTransport();
    const { c } = makeConn({ WebSocketImpl: transport.WebSocketImpl });
    let restoreSend: (() => void) | undefined;
    try {
      c.connect();
      await waitFor(() => c.status === "online");
      await waitFor(() => leases().length === 1);
      const socket = transport.sockets[0];
      if (!socket) throw new Error("missing connected transport");
      const send = socket.send.bind(socket);
      const spy = vi.spyOn(socket, "send").mockImplementation((data) => {
        if (data === "ping") throw new Error("native transport refused keepalive");
        send(data);
      });
      restoreSend = () => spy.mockRestore();
      expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
      await waitFor(() => leases().length === 2);
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

  it.each([WebSocket.CLOSING, WebSocket.CLOSED])(
    "refuses a send when transport state is %s before its close callback",
    async (readyState) => {
      const agent = await fakeAgent(relay, mac, kPair, phoneFp);
      const transport = capturedTransport();
      const { c } = makeConn({ WebSocketImpl: transport.WebSocketImpl });
      c.connect();
      await waitFor(() => c.status === "online");
      const socket = transport.sockets[0];
      if (!socket) throw new Error("missing connected transport");
      // The native transport can close before its JS close callback is delivered.
      Object.defineProperty(socket, "readyState", { configurable: true, value: readyState });
      try {
        expect(c.status).toBe("online");
        expect(c.send({ type: "subscribe", sessionId: "tmux:test" })).toBe(false);
        const result = c
          .request({ type: "input.line", reqId: "closed", sessionId: "tmux:test", text: "x" })
          .catch((error: unknown) => error);
        expect(c.pendingReqIds()).toEqual([]);
        expect(await result).toBeInstanceOf(DeliveryUnknownError);
      } finally {
        Reflect.deleteProperty(socket, "readyState");
        c.close();
        agent.rc.stop();
      }
    },
  );

  it("reports a thrown local send as delivery unknown without replaying input or reusing its nonce", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const transport = capturedTransport();
    const { c } = makeConn({ WebSocketImpl: transport.WebSocketImpl });
    c.connect();
    await waitFor(() => c.status === "online");
    const socket = transport.sockets[0];
    if (!socket) throw new Error("missing connected transport");
    const send = vi.spyOn(socket, "send").mockImplementationOnce(() => {
      throw new Error("native transport refused the write");
    });
    try {
      await expect(
        c.request({ type: "input.line", reqId: "lost", sessionId: "tmux:test", text: "first" }),
      ).rejects.toBeInstanceOf(DeliveryUnknownError);
      expect(c.pendingReqIds()).toEqual([]);
      const ack = await c.request({
        type: "input.line",
        reqId: "later",
        sessionId: "tmux:test",
        text: "second",
      });
      expect(ack.ok).toBe(true);
      expect(agent.received).toEqual([
        { type: "input.line", reqId: "later", sessionId: "tmux:test", text: "second" },
      ]);
      expect(send.mock.calls.map(([bytes]) => decodeEnvelope(bytes as Uint8Array).seq)).toEqual([
        1, 2,
      ]);
    } finally {
      send.mockRestore();
      c.close();
      agent.rc.stop();
    }
  });

  it("settles a request when an encrypted ACK arrives inside the socket send callback", async () => {
    const pair = await scriptedPair((message, agent) => {
      if (message.type === "input.line")
        agent.send({ type: "ack", reqId: message.reqId, ok: true });
    });
    try {
      const settled: unknown[] = [];
      const pending = pair.c.request({
        type: "input.line",
        reqId: "immediate",
        sessionId: "iterm2:s",
        text: "one",
      });
      void pending.then(
        (ack) => settled.push(ack),
        (error) => settled.push(error),
      );
      await Promise.resolve();
      expect(settled).toEqual([{ type: "ack", reqId: "immediate", ok: true }]);
      expect(pair.c.pendingReqIds()).toEqual([]);
      expect(pair.first.received).toHaveLength(1);
    } finally {
      pair.c.close();
    }
  });

  it("retires old input and history requests before announcing an accepted fresh agent nonce", async () => {
    const pair = await scriptedPair();
    try {
      const settled: unknown[] = [];
      const input = pair.c.request({
        type: "input.line",
        reqId: "old-input",
        sessionId: "iterm2:s",
        text: "one",
      });
      const history = pair.c.request({
        type: "history.get",
        reqId: "old-history",
        sessionId: "iterm2:s",
        before: 5,
        count: 2,
      });
      void input.then(
        (ack) => settled.push(ack),
        (error) => settled.push(error),
      );
      void history.then(
        (ack) => settled.push(ack),
        (error) => settled.push(error),
      );
      expect(pair.c.pendingReqIds()).toEqual(["old-input", "old-history"]);
      const replacement = pair.rekey(true);
      await Promise.resolve();
      expect(settled).toHaveLength(2);
      expect(settled.every((result) => result instanceof DeliveryUnknownError)).toBe(true);
      expect(pair.c.pendingReqIds()).toEqual([]);
      expect(
        pair.statusEvents.filter(({ status }) => status === "online").at(-1)?.extra?.lostReqIds,
      ).toEqual(["old-input", "old-history"]);
      expect(replacement.received).toEqual([]);
    } finally {
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

  it("keeps a synchronous ACK settled even when the socket send then throws", async () => {
    const pair = await scriptedPair((message, agent) => {
      if (message.type === "input.line")
        agent.send({ type: "ack", reqId: message.reqId, ok: true });
    });
    const original = pair.socket.send.bind(pair.socket);
    const send = vi.spyOn(pair.socket, "send").mockImplementation((data) => {
      original(data);
      if (
        typeof data !== "string" &&
        decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data)).seq > 0
      )
        throw new Error("local write reported failure after callback");
    });
    try {
      const pending = pair.c.request({
        type: "input.line",
        reqId: "acked-first",
        sessionId: "iterm2:s",
        text: "one",
      });
      await expect(pending).resolves.toMatchObject({ reqId: "acked-first", ok: true });
      expect(pair.c.pendingReqIds()).toEqual([]);
    } finally {
      send.mockRestore();
      pair.c.close();
    }
  });

  it("does not erase a same-ID replacement registered after the first synchronous ACK", async () => {
    let pair!: Awaited<ReturnType<typeof scriptedPair>>;
    let replacement: ReturnType<ComputerConnection["request"]> | undefined;
    pair = await scriptedPair((message, agent) => {
      if (message.type !== "input.line" || message.text !== "first") return;
      agent.send({ type: "ack", reqId: message.reqId, ok: true });
      replacement = pair.c.request({
        type: "input.line",
        reqId: "reuse",
        sessionId: "iterm2:s",
        text: "second",
      });
    });
    const original = pair.socket.send.bind(pair.socket);
    const send = vi.spyOn(pair.socket, "send").mockImplementation((data) => {
      original(data);
      if (
        typeof data !== "string" &&
        decodeEnvelope(data instanceof Uint8Array ? data : new Uint8Array(data)).seq === 1
      )
        throw new Error("local write reported failure after replacement");
    });
    try {
      const first = pair.c.request({
        type: "input.line",
        reqId: "reuse",
        sessionId: "iterm2:s",
        text: "first",
      });
      await expect(first).resolves.toMatchObject({ reqId: "reuse", ok: true });
      expect(replacement).toBeDefined();
      expect(replacement).not.toBe(first);
      expect(pair.c.pendingReqIds()).toEqual(["reuse"]);
      expect(pair.first.received).toMatchObject([
        { type: "input.line", text: "first" },
        { type: "input.line", text: "second" },
      ]);
      pair.first.link.send({ type: "ack", reqId: "reuse", ok: true });
      await expect(replacement).resolves.toMatchObject({ reqId: "reuse", ok: true });
    } finally {
      send.mockRestore();
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

  it.each(["fresh nonce", "close"] as const)(
    "retires only the in-flight request when %s reenters its send callback",
    async (transition) => {
      let pair!: Awaited<ReturnType<typeof scriptedPair>>;
      let replacement: ReturnType<typeof pair.rekey> | undefined;
      pair = await scriptedPair((message) => {
        if (message.type !== "input.line") return;
        if (transition === "fresh nonce") replacement = pair.rekey(true);
        else pair.c.close();
      });
      try {
        const pending = pair.c.request({
          type: "input.line",
          reqId: "in-flight",
          sessionId: "iterm2:s",
          text: "once",
        });
        await expect(pending).rejects.toBeInstanceOf(DeliveryUnknownError);
        expect(pair.c.pendingReqIds()).toEqual([]);
        expect(replacement?.received ?? []).toEqual([]);
        if (transition === "fresh nonce") {
          expect(pair.c.status).toBe("online");
          expect(pair.statusEvents.at(-1)?.extra?.lostReqIds).toEqual(["in-flight"]);
        } else expect(pair.c.status).toBe("idle");
      } finally {
        pair.c.close();
      }
    },
  );

  it("preserves pending ownership through same-nonce replay and malformed hello", async () => {
    const pair = await scriptedPair();
    try {
      const pending = pair.c.request({
        type: "input.line",
        reqId: "still-live",
        sessionId: "iterm2:s",
        text: "one",
      });
      const replay = pair.helloReplies[0];
      if (!replay) throw new Error("test setup: no agent hello");
      pair.socket.triggerEnvelope(replay);
      pair.socket.triggerEnvelope({
        v: 1,
        t: "e2e",
        from: macFp,
        to: phoneFp,
        seq: 0,
        body: { n: randomBytes(24), c: randomBytes(32) },
      });
      expect(pair.c.pendingReqIds()).toEqual(["still-live"]);
      expect(pair.statusEvents.filter(({ status }) => status === "online")).toHaveLength(1);
      pair.first.link.send({ type: "ack", reqId: "still-live", ok: true });
      await expect(pending).resolves.toMatchObject({ reqId: "still-live", ok: true });
    } finally {
      pair.c.close();
    }
  });

  it("ignores historical A hello and encrypted data after B owns pending input and history", async () => {
    const pair = await scriptedPair();
    try {
      for (let sequence = 1; sequence <= 3; sequence++)
        pair.first.link.send({ type: "ack", reqId: `old-${sequence}`, ok: true });
      const oldFrame = pair.agentEnvelopes.find((env) => env.seq === 3);
      if (!oldFrame) throw new Error("test setup: no old encrypted frame");
      const current = pair.rekey(true);
      const input = pair.c.request({
        type: "input.line",
        reqId: "B-input",
        sessionId: "iterm2:s",
        text: "current",
      });
      const history = pair.c.request({
        type: "history.get",
        reqId: "B-history",
        sessionId: "iterm2:s",
        before: 5,
        count: 2,
      });
      const settled: unknown[] = [];
      void input.then(
        (ack) => settled.push(ack),
        (error) => settled.push(error),
      );
      void history.then(
        (ack) => settled.push(ack),
        (error) => settled.push(error),
      );
      const replay = pair.helloReplies[0];
      if (!replay) throw new Error("test setup: no A hello");
      const observedBefore = pair.inner.length;
      pair.socket.triggerEnvelope(replay);
      await Promise.resolve();
      expect(pair.c.pendingReqIds()).toEqual(["B-input", "B-history"]);
      expect(settled).toEqual([]);
      expect(pair.statusEvents.filter(({ status }) => status === "online")).toHaveLength(2);
      expect(
        pair.c.request({
          type: "input.line",
          reqId: "B-input",
          sessionId: "iterm2:s",
          text: "ignored duplicate",
        }),
      ).toBe(input);

      pair.socket.triggerEnvelope(oldFrame);
      expect(pair.inner).toHaveLength(observedBefore);
      current.link.send({ type: "ack", reqId: "B-input", ok: true });
      current.link.send({ type: "ack", reqId: "B-history", ok: true });
      await expect(input).resolves.toMatchObject({ reqId: "B-input", ok: true });
      await expect(history).resolves.toMatchObject({ reqId: "B-history", ok: true });
      expect(current.received).toMatchObject([
        { type: "input.line", reqId: "B-input" },
        { type: "history.get", reqId: "B-history" },
      ]);
      expect(pair.first.received).toEqual([]);
    } finally {
      pair.c.close();
    }
  });

  it("keeps all 64 accepted nonces until a retryable overflow creates a fresh phone context", async () => {
    const pair = await scriptedPair();
    try {
      let current = pair.first;
      for (let generation = 2; generation <= 64; generation++) current = pair.rekey(true);
      expect(pair.statusEvents.filter(({ status }) => status === "online")).toHaveLength(64);
      const pending = pair.c.request({
        type: "input.line",
        reqId: "at-capacity",
        sessionId: "iterm2:s",
        text: "one",
      });
      const pendingResult = pending.catch((error: unknown) => error);
      const historical = pair.helloReplies[0];
      const latest = pair.helloReplies.at(-1);
      if (!historical || !latest) throw new Error("test setup: missing accepted hellos");
      pair.socket.triggerEnvelope(historical);
      pair.socket.triggerEnvelope(latest);
      expect(pair.c.pendingReqIds()).toEqual(["at-capacity"]);
      expect(pair.statusEvents.filter(({ status }) => status === "online")).toHaveLength(64);
      expect(pair.socket.closed).toBe(false);
      current.link.send({ type: "ack", reqId: "at-capacity", ok: true });
      expect(await pendingResult).toMatchObject({ reqId: "at-capacity", ok: true });

      const overflowPending = pair.c.request({
        type: "history.get",
        reqId: "overflow-history",
        sessionId: "iterm2:s",
        before: 5,
        count: 2,
      });
      const overflowResult = overflowPending.catch((error: unknown) => error);
      const overflowAgent = pair.rekey(true);
      expect(pair.socket.closed).toBe(true);
      expect(await overflowResult).toBeInstanceOf(DeliveryUnknownError);
      expect(pair.socket.closeCode).toBe(4000);
      expect(pair.socket.closeReason).toBe("agent nonce history exhausted");
      expect(pair.statusEvents.filter(({ status }) => status === "online")).toHaveLength(64);
      expect(pair.statusEvents.at(-1)).toMatchObject({
        status: "offline",
        extra: { closeCode: 4000, lostReqIds: ["overflow-history"] },
      });
      expect(overflowAgent.received).toEqual([]);

      const fresh = await pair.reconnect();
      const newRequest = pair.c.request({
        type: "input.line",
        reqId: "new-context",
        sessionId: "iterm2:s",
        text: "new",
      });
      expect(fresh.agent.received).toMatchObject([{ type: "input.line", reqId: "new-context" }]);
      fresh.agent.link.send({ type: "ack", reqId: "new-context", ok: true });
      await expect(newRequest).resolves.toMatchObject({ reqId: "new-context", ok: true });
      expect(pair.statusEvents.filter(({ status }) => status === "online")).toHaveLength(65);
      expect(fresh.socket.closed).toBe(false);
    } finally {
      pair.c.close();
    }
  });

  it("keeps requests created by a fresh online callback on the new agent key", async () => {
    let pair!: Awaited<ReturnType<typeof scriptedPair>>;
    let online = 0;
    let newRequest: ReturnType<ComputerConnection["request"]> | undefined;
    pair = await scriptedPair(undefined, (status) => {
      if (status !== "online" || ++online !== 2) return;
      newRequest = pair.c.request({
        type: "input.line",
        reqId: "new-key",
        sessionId: "iterm2:s",
        text: "new",
      });
    });
    try {
      const old = pair.c.request({
        type: "input.line",
        reqId: "old-key",
        sessionId: "iterm2:s",
        text: "old",
      });
      const oldResult = old.catch((error: unknown) => error);
      const replacement = pair.rekey(true);
      expect(await oldResult).toBeInstanceOf(DeliveryUnknownError);
      expect(pair.statusEvents.at(-1)?.extra?.lostReqIds).toEqual(["old-key"]);
      expect(pair.c.pendingReqIds()).toEqual(["new-key"]);
      expect(pair.first.received).toMatchObject([{ type: "input.line", text: "old" }]);
      expect(replacement.received).toMatchObject([{ type: "input.line", text: "new" }]);
      replacement.link.send({ type: "ack", reqId: "new-key", ok: true });
      await expect(newRequest).resolves.toMatchObject({ reqId: "new-key", ok: true });
    } finally {
      pair.c.close();
    }
  });

  it("authenticates, leases, handshakes, receives hello, sends inputs with acks", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner, statuses } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    expect(statuses).toEqual(["connecting", "auth", "handshake", "online"]);
    await waitFor(() => leases().length > 0);
    expect(leases()[0]?.msg).toMatchObject({ type: "lease", ttlMs: 60_000 });
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

  it("reconnects after the relay drops the socket", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    relay.phones.get(phoneFp)?.ws.terminate();
    await waitFor(() => inner.filter((m) => m.type === "hello").length === 2, 5000);
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

  it("ignores a replayed agent conn.hello: seq counters untouched, later frames still decrypt", async () => {
    const agent = await fakeAgent(relay, mac, kPair, phoneFp);
    const { c, inner } = makeConn();
    c.connect();
    await waitFor(() => inner.some((m) => m.type === "hello"));
    // The agent's conn.hello reply: the first e2e frame FROM the agent, at envelope seq 0.
    const helloReply = relay.received.find((r) => r.from.role === "agent" && r.env.seq === 0);
    if (!helloReply) throw new Error("test setup: no agent conn.hello reply observed");
    const replayBytes = encodeEnvelope(helloReply.env);

    // Advance the session with one legitimate round trip first (seqIn/seqOut > 0 both sides).
    const ack1 = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "one",
    });
    expect(ack1.ok).toBe(true);

    // Replay the captured hello reply straight at the phone's socket, as a relay bug or an
    // attacker who recorded the wire would.
    relay.phones.get(phoneFp)?.ws.send(replayBytes, { binary: true });
    await new Promise((r) => setTimeout(r, 200));

    // No re-handshake is directly observable; prove the session survived intact instead — a
    // phone that re-derived K_conn and rewound seqOut to 0 would desync from the agent's
    // already-advanced seqIn and this second request would never be acked (it would hang until
    // the test's timeout).
    const ack2 = await c.request({
      type: "input.line",
      reqId: c.newReqId(),
      sessionId: "iterm2:s",
      text: "two",
    });
    expect(ack2.ok).toBe(true);
    expect(agent.received.map((m) => (m as { text?: string }).text)).toEqual(["one", "two"]);
    c.close("user");
    agent.rc.stop();
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

  it("presence agentOnline:false during handshake clears the hello timer but keeps the socket open", async () => {
    const sockets: FakeSocket[] = [];
    class RecordingSocket extends FakeSocket {
      constructor(url: string) {
        super(url);
        sockets.push(this);
      }
    }
    const { c, statuses } = makeConn({
      WebSocketImpl: RecordingSocket,
      helloTimeoutMs: 100,
    });
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
    await waitFor(() => c.status === "handshake");
    sock.triggerCtrl({ type: "presence", agentOnline: false, computerName: null });
    await waitFor(() => c.status === "offline");
    // Long enough for the 100ms hello timer to have fired had it not been disarmed.
    await new Promise((r) => setTimeout(r, 300));
    expect(sock.closed).toBe(false);
    expect(statuses.at(-1)).toBe("offline");
  });

  it("tolerates malformed seq-0 hello frames below the shared failure counter", async () => {
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
    await waitFor(() => c.status === "handshake");
    const garbageHello = (): Envelope => ({
      v: 1,
      t: "e2e",
      from: macFp,
      to: phoneFp,
      seq: 0,
      body: { n: randomBytes(24), c: randomBytes(32) },
    });
    // 19 undecryptable hellos in a row: below the 20-failure breaker (spec 6.7), the handshake
    // must be tolerated, not permanently killed by the first one.
    for (let i = 0; i < 19; i++) sock.triggerEnvelope(garbageHello());
    await new Promise((r) => setTimeout(r, 20));
    expect(c.status).toBe("handshake");
    expect(sock.closed).toBe(false);
    // The 20th tips the shared counter over: only now does it become a permanent re-pair.
    sock.triggerEnvelope(garbageHello());
    await waitFor(() => c.status === "error");
    expect(statuses.at(-1)).toBe("error");
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
