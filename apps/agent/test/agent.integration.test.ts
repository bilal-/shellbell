import { mkdtempSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { create } from "@bufbuild/protobuf";
import {
  applyDiff,
  applySnapshot,
  authMessage,
  type CtrlMessage,
  createPairRevocationV2,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  type InnerMessage,
  open,
  pairingAd,
  parseCtrl,
  parseQr,
  type ScreenDiff,
  type ScreenSnapshot,
  type ScreenState,
  seal,
  sign,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { Agent } from "../src/agent.js";
import { startHerdrBackend } from "../src/backends/herdr/start.js";
import { ITerm2Backend } from "../src/backends/iterm2/backend.js";
import {
  ListSessionsResponseSchema,
  NotificationSchema,
  ScreenUpdateNotificationSchema,
  type ServerOriginatedMessage,
  ServerOriginatedMessageSchema,
} from "../src/backends/iterm2/gen/iterm2_pb.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionGone } from "../src/backends/types.js";
import * as configModule from "../src/config.js";
import { loadConfig, loadPairings, type Paths, paths } from "../src/config.js";
import { ControlLineDecoder, ControlServer } from "../src/control.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import type { Logger } from "../src/log.js";
import { createLogger } from "../src/log.js";
import { RelayClient } from "../src/relay-client.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakeHerdr } from "./fakes/fake-herdr.js";
import { FakeClient } from "./fakes/fake-iterm2.js";
import { FakePhone } from "./fakes/fake-phone.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });

it("refreshes capabilities for unchanged backend names without losing hello metadata", async () => {
  const phone = await pairAndConnect();
  try {
    await waitFor(() => typeof Reflect.get(agent, "backendsKey") === "string");
    const hellos = () => phone.inner.filter((message) => message.type === "hello");
    const initial = hellos().at(-1)!;
    const before = hellos().length;
    backend.capabilities = { ...backend.capabilities, mouseClick: true };
    backend.emit({ type: "layout-changed" });
    await waitFor(() => hellos().length > before);
    expect(hellos().at(-1)).toMatchObject({
      features: initial.features,
      launchableBackends: initial.launchableBackends,
      backends: [{ name: "iterm2", capabilities: { mouseClick: true } }],
    });
    const stable = hellos().length;
    const sessions = phone.inner.filter((message) => message.type === "sessions").length;
    backend.capabilities = Object.fromEntries(
      Object.entries(backend.capabilities).reverse(),
    ) as typeof backend.capabilities;
    backend.emit({ type: "layout-changed" });
    await waitFor(
      () => phone.inner.filter((message) => message.type === "sessions").length > sessions,
    );
    expect(hellos()).toHaveLength(stable);
  } finally {
    phone.ws.close();
  }
});

it("retains full hello metadata when connected backend membership changes", async () => {
  const phone = await pairAndConnect();
  try {
    await waitFor(() => typeof Reflect.get(agent, "backendsKey") === "string");
    const hellos = () => phone.inner.filter((message) => message.type === "hello");
    const initial = hellos().at(-1)!;
    const before = hellos().length;
    backend.isConnected = false;
    backend.emit({ type: "layout-changed" });
    await waitFor(() => hellos().length > before);
    expect(hellos().at(-1)).toMatchObject({
      features: initial.features,
      launchableBackends: [],
      backends: [],
    });
  } finally {
    phone.ws.close();
  }
});

it("routes one encrypted ring through the real agent after capability and enrollment", async () => {
  const phone = await pairAndConnect();
  // This is the wiring success case. The separate dispatch deadline test proves
  // generic fallback at 250 ms; unrelated suite CPU load must not choose that path here.
  const budgetClock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    Object.assign(backend, {
      notificationFacts: async (sessionId: string) => ({
        sessionId,
        revision: "1",
        locality: "unknown" as const,
        title: "Private work",
        sessionLabel: "Pane 1",
      }),
    });
    const generation = "AAAAAAAAAAAAAAAAAAAAAA";
    phone.send(phone.phone.seal({ type: "notification.enroll", generation }));
    await waitFor(() => phone.inner.some((m) => m.type === "notification.enrolled"));
    const authenticated = new Promise((resolve) => agent.relay.once("auth-ok", resolve));
    relay.sendToAgent({
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: "MBP",
      serverTime: Date.now(),
      minFrameMs: 125,
      features: ["notify-context-v1"],
    });
    await authenticated;
    agent.notifier.ring({ sessionId: "iterm2:S1", kind: "blocked", reason: "agent-blocked" });
    await waitFor(() =>
      relay.ctrlFromAgent.some((m) => m.type === "notify-context" || m.type === "notify"),
    );
    const messages = relay.ctrlFromAgent.filter(
      (m) => m.type === "notify-context" || m.type === "notify",
    );
    expect(messages).toHaveLength(1);
    const message = messages[0];
    if (message?.type !== "notify-context") throw new Error("missing private notification");
    const box = message.boxes[0]!;
    const pairing = loadPairings(agentPaths).find((p) => p.phoneFp === phone.fp)!;
    const { deriveNotificationKey, openNotification } = await import("@shellbell/protocol");
    expect(
      openNotification(deriveNotificationKey(fromBase64Url(pairing.kPair), box), box),
    ).toMatchObject({
      reason: "agent-blocked",
      context: { title: "Private work", sessionLabel: "Pane 1" },
    });
    expect(JSON.stringify(messages)).not.toContain("Private work");
  } finally {
    budgetClock.mockRestore();
    phone.ws.close();
  }
});

it("acknowledges notification enrollment only after durable installation", async () => {
  const phone = await pairAndConnect();
  const generation = "AAAAAAAAAAAAAAAAAAAAAA";
  phone.send(phone.phone.seal({ type: "notification.enroll", generation }));
  await waitFor(() => phone.inner.some((m) => m.type === "notification.enrolled"));
  expect(phone.inner.find((m) => m.type === "notification.enrolled")).toEqual({
    type: "notification.enrolled",
    generation,
  });
  const { NotificationState } = await import("../src/notification-state.js");
  expect(new NotificationState(agentPaths).reserve(phone.fp)).toMatchObject({
    generation,
    sequence: "1",
  });
  expect(agent.unpairExact(phone.fp)).toBe(true);
  expect(new NotificationState(agentPaths).reserve(phone.fp)).toBeUndefined();
  phone.ws.close();
});
let startupConfig: configModule.AgentConfig;

/** A `Logger` that records every call instead of writing anywhere, for white-box assertions. */
function capturingLogger(): {
  log: Logger;
  calls: { level: string; msg: string; fields?: Record<string, unknown> }[];
} {
  const calls: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const mk = (): Logger => ({
    debug: (msg, fields) => calls.push({ level: "debug", msg, fields }),
    info: (msg, fields) => calls.push({ level: "info", msg, fields }),
    warn: (msg, fields) => calls.push({ level: "warn", msg, fields }),
    error: (msg, fields) => calls.push({ level: "error", msg, fields }),
    child: () => mk(),
  });
  return { log: mk(), calls };
}

/** A phone-side WebSocket client speaking the relay protocol. */
class PhoneSocket {
  ws!: WebSocket;
  ctrl: CtrlMessage[] = [];
  e2e: Envelope[] = [];
  inner: InnerMessage[] = [];
  phone: FakePhone | null = null;
  constructor(readonly identity = generateIdentity()) {}
  get fp() {
    return fingerprint(this.identity.ed25519.pub);
  }
  connect(
    url: string,
    computerFp: string,
    role: "phone" | "pairing",
    gate?: Uint8Array,
  ): Promise<void> {
    this.ws = new WebSocket(`${url}/ws/${computerFp}`);
    return new Promise((resolve) => {
      this.ws.on("message", (data, isBinary) => {
        if (!isBinary) return;
        const env = decodeEnvelope(new Uint8Array(data as Buffer));
        if (env.t === "e2e") {
          this.e2e.push(env);
          if (this.phone) {
            if (env.seq === 0) this.phone.acceptHello(env);
            else if (this.phone.handshaken) this.inner.push(this.phone.open(env));
          }
          return;
        }
        const m = parseCtrl(env.body);
        this.ctrl.push(m);
        if (m.type === "challenge") {
          const sig = sign(
            this.identity.ed25519.priv,
            authMessage(m.connId, role, this.fp, m.nonce),
          );
          this.sendCtrl({
            type: "auth",
            role,
            fp: this.fp,
            ed25519Pub: this.identity.ed25519.pub,
            sig,
            name: "iPhone",
            appVersion: "t",
            gate,
          });
        }
        if (m.type === "auth-ok") resolve();
      });
    });
  }
  sendCtrl(body: CtrlMessage) {
    this.ws.send(encodeEnvelope({ v: 1, t: "ctrl", from: this.fp, seq: 0, body }), {
      binary: true,
    });
  }
  send(env: Envelope) {
    this.ws.send(encodeEnvelope(env), { binary: true });
  }
}

let relay: FakeRelay;
let backend: FakeBackend;
let agent: Agent;
let computerFp: string;
let agentPaths: Paths;

/** A PhoneSocket that has completed conn.hello, so `phone` is non-null. */
type ConnectedPhone = PhoneSocket & { phone: FakePhone };

interface PairTarget {
  agent: Agent;
  relay: FakeRelay;
  computerFp: string;
}

/**
 * Runs the whole pairing dance for one phone and returns a connected, handshaken phone socket.
 * Used by every test below so the flow is written exactly once. Defaults to the shared
 * `agent`/`relay`/`computerFp` from `beforeEach`; a test that stands up its own second agent
 * (e.g. the `superseded` and fire-and-forget-guard tests) passes its own instead.
 */
async function pairAndConnect(
  target: PairTarget = { agent, relay, computerFp },
  /** When given, pair against this already-opened window instead of calling `openPairing()`
   * again -- lets a test prove that a window opened earlier (e.g. before auth, or before a
   * reconnect) is the one a phone actually pairs against. */
  preOpened?: { qrText: string },
  features?: string[],
): Promise<ConnectedPhone> {
  const { qrText } = preOpened ?? target.agent.openPairing();
  const qr = parseQr(qrText, { allowInsecure: true });
  const pairSock = new PhoneSocket();
  await pairSock.connect(target.relay.url, target.computerFp, "pairing", fromBase64Url(qr.g));
  const code = fromBase64Url(qr.p);
  const kPsk = derivePskKey(code, target.computerFp);
  const box = seal(
    kPsk,
    encodeCbor({
      ed25519Pub: pairSock.identity.ed25519.pub,
      x25519Pub: pairSock.identity.x25519.pub,
      name: "iPhone",
      platform: "ios",
    }),
    pairingAd("request", target.computerFp, pairSock.fp),
  );
  pairSock.sendCtrl({ type: "pairing-request", phoneFp: pairSock.fp, box });
  await waitFor(() => pairSock.ctrl.some((m) => m.type === "pairing-response"));
  const resp = pairSock.ctrl.find((m) => m.type === "pairing-response");
  if (resp?.type !== "pairing-response") throw new Error("no pairing-response");
  const inner = decodeCbor(
    open(kPsk, resp.box, pairingAd("response", target.computerFp, pairSock.fp)),
  ) as { x25519Pub: Uint8Array };
  const kPair = derivePairKey(
    pairSock.identity.x25519.priv,
    inner.x25519Pub,
    code,
    target.computerFp,
    pairSock.fp,
  );
  pairSock.ws.close();

  const ph = new PhoneSocket(pairSock.identity);
  ph.phone = new FakePhone(pairSock.identity, target.computerFp, kPair);
  await ph.connect(target.relay.url, target.computerFp, "phone");
  ph.send(ph.phone.hello(features));
  await waitFor(() => ph.inner.some((m) => m.type === "sessions"));
  return ph as ConnectedPhone;
}

beforeEach(async () => {
  const p = paths(mkdtempSync(join(tmpdir(), "sb-agent-")));
  agentPaths = p;
  const { identity, fp } = loadOrCreateIdentity(p);
  computerFp = fp;
  relay = new FakeRelay(fp);
  await relay.start();
  backend = new FakeBackend();
  backend.addSession("S1", { rows: 3, lines: ["one", "two", "three"], scrollbackTotal: 5 });
  const registry = new BackendRegistry(log);
  registry.add(backend);
  // NB: config.relayUrl is deliberately left at its default (a wss:// URL) rather than set to
  // FakeRelay's ws://127.0.0.1 address: PairingManager round-trips the QR text through parseQr(),
  // which requires wss:// (spec-correct: a real phone must never be told to dial plaintext ws://).
  // relayUrlOverride below redirects only the agent's own relay *socket* to the fake server;
  // pairAndConnect() likewise dials `relay.url` directly rather than the (unreachable) `qr.r`.
  const config = { ...loadConfig(p), computerName: "MBP" };
  startupConfig = config;
  agent = new Agent({
    paths: p,
    config,
    identity,
    fp,
    registry,
    log,
    confirm: async () => true,
    appVersion: "0.0.1-test",
    relayUrlOverride: relay.url,
  });
  agent.start();
  await waitFor(() => agent.relayOnline);
});
afterEach(async () => {
  agent.stop();
  await relay.stop();
});

it("keeps the applied digest and encrypted hello on an owned startup snapshot", async () => {
  const revision = agent.configurationRevision;
  startupConfig.computerName = "Caller changed";
  startupConfig.accent = "rose";
  configModule.saveConfig(paths(agent.localStatus.process.stateDir), {
    ...startupConfig,
    relayUrl: "wss://saved.invalid",
  });
  const phone = await pairAndConnect();
  try {
    expect(phone.inner.find((m) => m.type === "hello")).toMatchObject({
      hostPlatform: process.platform,
      computerName: "MBP",
      accent: "emerald",
    });
    expect(agent.configurationRevision).toBe(revision);
  } finally {
    phone.ws.close();
  }
});

describe("Agent end to end (fake relay, fake backend)", () => {
  it("delivers exact xterm input and host-native paste through encryption without duplicate submission", async () => {
    const input = vi.fn(async (_id: string, _data: string) => {});
    const paste = vi.fn(async (_id: string, _text: string, _submit: boolean) => {});
    Object.assign(backend, { sendInput: input, paste });
    backend.capabilities = { ...backend.capabilities, terminalInput: true, terminalPaste: true };
    const phone = await pairAndConnect();
    try {
      expect(phone.inner.find((message) => message.type === "hello")).toMatchObject({
        backends: [{ capabilities: { terminalInput: true, terminalPaste: true } }],
      });
      const data = "\x1b[1;2D\x03é\0\r\n";
      phone.send(
        phone.phone.seal({
          type: "input.terminal",
          reqId: "xterm-exact",
          sessionId: "iterm2:S1",
          data,
        }),
      );
      await waitFor(() =>
        phone.inner.some((message) => message.type === "ack" && message.reqId === "xterm-exact"),
      );
      expect(input).toHaveBeenCalledExactlyOnceWith("S1", data);
      const message = {
        type: "input.paste" as const,
        reqId: "xterm-paste",
        sessionId: "iterm2:S1",
        text: "first\nsecond",
        submit: true,
      };
      phone.send(phone.phone.seal(message));
      phone.send(phone.phone.seal(message));
      await waitFor(
        () =>
          phone.inner.filter((value) => value.type === "ack" && value.reqId === message.reqId)
            .length === 2,
      );
      expect(paste).toHaveBeenCalledExactlyOnceWith("S1", message.text, true);
      expect(backend.sentText).toEqual([]);
    } finally {
      phone.ws.close();
    }
  });

  it("rejects xterm input for a backend that has not advertised support", async () => {
    const input = vi.fn(async () => {});
    Object.assign(backend, { sendInput: input });
    const phone = await pairAndConnect();
    try {
      phone.send(
        phone.phone.seal({
          type: "input.terminal",
          reqId: "old-backend",
          sessionId: "iterm2:S1",
          data: "x",
        }),
      );
      await waitFor(() =>
        phone.inner.some((message) => message.type === "ack" && message.reqId === "old-backend"),
      );
      expect(
        phone.inner.find((message) => message.type === "ack" && message.reqId === "old-backend"),
      ).toMatchObject({ ok: false, error: "unsupported" });
      expect(input).not.toHaveBeenCalled();
    } finally {
      phone.ws.close();
    }
  });
  it("reports only the view accepted by the active service lease", async () => {
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
    try {
      const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
      expect(agent.connectedPhones[0]?.viewed).toBeNull();
      ph.send(ph.phone.seal({ type: "stream.subscribe", subscriptionId, sessionId: "iterm2:S1" }));
      await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S1");
      ph.send(ph.phone.seal({ type: "stream.cancel", subscriptionId }));
      await waitFor(() => agent.connectedPhones[0]?.viewed === null);

      ph.send(ph.phone.seal({ type: "stream.subscribe", subscriptionId, sessionId: "iterm2:S1" }));
      await waitFor(() => agent.connectedPhones[0]?.viewed === "iterm2:S1");
      await waitFor(() => ph.inner.some((message) => message.type === "stream.chunk"));
      const oldFrame = ph.e2e.at(-1);
      if (!oldFrame || oldFrame.seq === 0) throw new Error("missing old stream frame");
      const priorHellos = ph.e2e.filter((envelope) => envelope.seq === 0).length;
      ph.send(ph.phone.hello(["bounded-stream-v1"]));
      expect(() =>
        ph.ws.emit("message", Buffer.from(encodeEnvelope(oldFrame)), true),
      ).not.toThrow();
      await waitFor(() => agent.connectedPhones[0]?.viewed === null);
      await waitFor(() => ph.e2e.filter((envelope) => envelope.seq === 0).length > priorHellos);
      expect(ph.phone.handshaken).toBe(true);
      ph.send(
        ph.phone.seal({
          type: "input.text",
          reqId: "input-after-rehello",
          sessionId: "iterm2:S1",
          text: "still-connected",
        }),
      );
      await waitFor(() =>
        ph.inner.some(
          (message) => message.type === "ack" && message.reqId === "input-after-rehello",
        ),
      );
      expect(backend.sentText.at(-1)?.text).toBe("still-connected");
    } finally {
      ph.ws.close();
    }
  });

  it("does not upgrade an unknown capability or let unnegotiated stream traffic block input", async () => {
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v2"]);
    try {
      expect(agent.linkForPhone(ph.fp)?.streamMode).toBe("legacy");
      ph.send(
        ph.phone.seal({
          type: "stream.subscribe",
          subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA",
          sessionId: "iterm2:S1",
        }),
      );
      expect(agent.connectedPhones[0]?.viewed).toBeNull();
      ph.send(
        ph.phone.seal({
          type: "input.text",
          reqId: "input-after-unknown",
          sessionId: "iterm2:S1",
          text: "ok",
        }),
      );
      await waitFor(() =>
        ph.inner.some((m) => m.type === "ack" && m.reqId === "input-after-unknown"),
      );
      expect(
        ph.inner.find((m) => m.type === "ack" && m.reqId === "input-after-unknown"),
      ).toMatchObject({ ok: true });
      expect(backend.sentText.at(-1)?.text).toBe("ok");
      expect(agent.connectedPhones[0]?.viewed).toBeNull();
    } finally {
      ph.ws.close();
    }
  });

  it("routes a negotiated view through bounded chunks and releases backend demand on cancel", async () => {
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
    const link = agent.linkForPhone(ph.fp);
    expect(link?.streamMode).toBe("bounded");
    const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
    ph.send(ph.phone.seal({ type: "stream.subscribe", subscriptionId, sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "stream.chunk"));
    expect(ph.inner.some((m) => m.type === "screen.snapshot" || m.type === "history")).toBe(false);
    expect(backend.watched.at(-1)).toContain("S1");
    ph.send(ph.phone.seal({ type: "stream.cancel", subscriptionId }));
    await waitFor(() => !backend.watched.at(-1)?.includes("S1"));
    ph.ws.close();
  });

  it("holds bounded native history until a snapshot is ACKed and history is requested", async () => {
    const capture = Object.freeze({ native: "S1" });
    const getScreen = backend.getScreen.bind(backend);
    vi.spyOn(backend, "getScreen").mockImplementation(async (id) => ({
      ...(await getScreen(id)),
      historyCapture: capture,
    }));
    const read = vi.fn(async () => ({
      status: "page" as const,
      from: 4,
      to: 5,
      oldestAvailable: 0,
      lines: [{ r: [{ t: "older" }] }],
    }));
    Object.assign(backend, { getHistoryPage: read });
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
    try {
      const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
      ph.send(ph.phone.seal({ type: "stream.subscribe", subscriptionId, sessionId: "iterm2:S1" }));
      await waitFor(() => ph.inner.some((m) => m.type === "stream.chunk"));
      expect(read).not.toHaveBeenCalled();
      const snapshot = ph.inner.find((m) => m.type === "stream.chunk");
      if (snapshot?.type !== "stream.chunk") throw new Error("missing snapshot");
      expect(snapshot.meta.kind).toBe("snapshot");
      ph.send(ph.phone.seal({ type: "stream.ack", subscriptionId, through: snapshot.sequence }));
      ph.send(
        ph.phone.seal({
          type: "stream.history.get",
          subscriptionId,
          requestId: "BBBBBBBBBBBBBBBBBBBBBB",
          before: 5,
          count: 1,
        }),
      );
      await waitFor(() => read.mock.calls.length === 1);
      await waitFor(() =>
        ph.inner.some((m) => m.type === "stream.chunk" && m.meta.kind === "history"),
      );
      expect(read.mock.calls).toHaveLength(1);
    } finally {
      ph.ws.close();
    }
  });

  it("routes bounded refresh to a new viewport capture", async () => {
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
    try {
      const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
      ph.send(ph.phone.seal({ type: "stream.subscribe", subscriptionId, sessionId: "iterm2:S1" }));
      await waitFor(() => ph.inner.some((m) => m.type === "stream.chunk"));
      const first = ph.inner.find((m) => m.type === "stream.chunk");
      if (first?.type !== "stream.chunk") throw new Error("missing first viewport");
      ph.send(ph.phone.seal({ type: "stream.ack", subscriptionId, through: first.sequence }));
      const captures = backend.getScreenCalls;
      ph.send(ph.phone.seal({ type: "stream.refresh", subscriptionId }));
      await waitFor(() => backend.getScreenCalls > captures);
      await waitFor(() => ph.inner.filter((m) => m.type === "stream.chunk").length > 1);
    } finally {
      ph.ws.close();
    }
  });

  it("passes the original encrypted envelope size into the bounded lease", async () => {
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
    try {
      const link = agent.linkForPhone(ph.fp);
      if (!link) throw new Error("missing link");
      const leases = Reflect.get(agent, "viewLeases") as Map<
        typeof link,
        { lease: { receive(message: InnerMessage, envelopeBytes: number): void } }
      >;
      const lease = leases.get(link)?.lease;
      if (!lease) throw new Error("missing lease");
      const receive = vi.spyOn(lease, "receive");
      const message = { type: "stream.cancel" as const, subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA" };
      const raw = encodeCbor({ ...ph.phone.seal(message), ignoredPadding: "wire-padding" });
      ph.ws.send(raw, { binary: true });
      await waitFor(() => receive.mock.calls.length === 1);
      expect(receive.mock.calls[0]?.[1]).toBe(raw.byteLength);
    } finally {
      ph.ws.close();
    }
  });

  it("retires a bounded view before a held native capture settles after re-handshake", async () => {
    let release!: () => void;
    backend.getScreenGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
    try {
      ph.send(
        ph.phone.seal({
          type: "stream.subscribe",
          subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA",
          sessionId: "iterm2:S1",
        }),
      );
      await waitFor(() => backend.getScreenCalls > 0);
      const before = ph.inner.length;
      const helloCount = ph.e2e.filter((env) => env.seq === 0).length;
      ph.send(ph.phone.hello(["bounded-stream-v1"]));
      await waitFor(() => ph.e2e.filter((env) => env.seq === 0).length > helloCount);
      expect(agent.linkForPhone(ph.fp)?.streamMode).toBe("bounded");
      await waitFor(() => backend.watched.at(-1)?.includes("S1") !== true);
      release();
      await new Promise<void>((done) => setImmediate(done));
      expect(ph.inner.slice(before).some((m) => m.type === "stream.chunk")).toBe(false);
    } finally {
      release();
      ph.ws.close();
    }
  });

  it.each(["disconnect", "replacement", "relay down", "unpair", "stop"] as const)(
    "does not publish held bounded capture after %s",
    async (teardown) => {
      let release!: () => void;
      backend.getScreenGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ph = await pairAndConnect(undefined, undefined, ["bounded-stream-v1"]);
      try {
        ph.send(
          ph.phone.seal({
            type: "stream.subscribe",
            subscriptionId: "AAAAAAAAAAAAAAAAAAAAAA",
            sessionId: "iterm2:S1",
          }),
        );
        await waitFor(() => backend.getScreenCalls > 0);
        const oldLink = agent.linkForPhone(ph.fp);
        if (!oldLink) throw new Error("missing owned link");
        if (teardown === "disconnect") {
          ph.ws.close();
          await waitFor(() => agent.linkForPhone(ph.fp) !== oldLink);
        } else if (teardown === "replacement") {
          relay.sendToAgent({
            type: "phone-connected",
            phoneFp: ph.fp,
            connId: "replacement",
            name: "iPhone",
          });
          await waitFor(() => agent.linkForPhone(ph.fp) !== oldLink);
        } else if (teardown === "relay down") {
          relay.dropAgent();
          await waitFor(() => agent.linkForPhone(ph.fp) === undefined);
        } else if (teardown === "unpair") {
          expect(agent.unpairExact(ph.fp)).toBe(true);
        } else {
          agent.stop();
        }
        await waitFor(() => backend.watched.at(-1)?.includes("S1") !== true);
        const sentBefore = relay.received.filter(
          (r) => r.from.role === "agent" && r.env.t === "e2e" && r.env.seq > 0,
        ).length;
        release();
        await new Promise<void>((done) => setImmediate(done));
        expect(
          relay.received.filter(
            (r) => r.from.role === "agent" && r.env.t === "e2e" && r.env.seq > 0,
          ),
        ).toHaveLength(sentBefore);
      } finally {
        release();
        ph.ws.close();
      }
    },
  );
  it("unpairExact ignores a colliding friendly name and publishes nothing when persistence fails", async () => {
    const first = await pairAndConnect();
    const second = await pairAndConnect();
    await waitFor(() => agent.pairingList.length === 2);
    (agent as unknown as { pairings: { phoneFp: string; name: string }[] }).pairings[0]!.name =
      second.fp;
    const savedBefore = loadPairings(agentPaths);
    const firstLink = agent.linkForPhone(first.fp);
    const secondLink = agent.linkForPhone(second.fp);
    const lastSeen = (agent as unknown as { lastSeenSavedAt: Map<string, number> }).lastSeenSavedAt;
    const lastSeenBefore = new Map(lastSeen);
    expect(firstLink).toBeDefined();
    expect(secondLink).toBeDefined();
    expect(lastSeenBefore.has(first.fp)).toBe(true);
    expect(lastSeenBefore.has(second.fp)).toBe(true);
    const outbound = vi.spyOn(agent.relay, "sendCtrl");
    const server = new ControlServer(join(agentPaths.dir, "agent.sock"), agent, log);
    await server.start();
    const socket = createConnection(join(agentPaths.dir, "agent.sock"));
    const frames: unknown[] = [];
    const decoder = new ControlLineDecoder({
      onLine: (line) => frames.push(JSON.parse(line)),
      onError: () => {
        throw new Error("invalid control frame");
      },
    });
    socket.on("data", (chunk: Buffer) => decoder.push(chunk));
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(`${JSON.stringify({ v: 2, id: 1, cmd: "hello" })}\n`);
    await waitFor(() => frames.length === 1);
    const revoke = (id: number) =>
      socket.write(
        `${JSON.stringify({ v: 2, id, cmd: "devices.revoke", expect: agent.localStatus.process, args: { phoneFp: second.fp } })}\n`,
      );
    relay.ctrlFromAgent.length = 0;
    const spy = vi.spyOn(configModule, "savePairings").mockImplementationOnce(() => {
      throw new Error("disk full");
    });
    try {
      revoke(2);
      await waitFor(() => frames.length === 2);
      expect(frames[1]).toEqual({ v: 2, id: 2, ok: false, error: { code: "operation-failed" } });
      expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([first.fp, second.fp]);
      expect(loadPairings(agentPaths)).toEqual(savedBefore);
      expect(agent.linkForPhone(first.fp)).toBe(firstLink);
      expect(agent.linkForPhone(second.fp)).toBe(secondLink);
      expect(lastSeen).toEqual(lastSeenBefore);
      expect(outbound.mock.calls.some(([message]) => message.type === "unpair")).toBe(false);
      expect(relay.ctrlFromAgent.some((m) => m.type === "unpair")).toBe(false);
      expect(agent.connectedPhones.map((p) => p.phoneFp)).toContain(second.fp);
      spy.mockRestore();
      revoke(3);
      await waitFor(() => frames.length === 3);
      expect(frames[2]).toMatchObject({ ok: true, data: { removed: true } });
      expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([first.fp]);
      expect(loadPairings(agentPaths).map((p) => p.phoneFp)).toEqual([first.fp]);
      expect(agent.linkForPhone(first.fp)).toBe(firstLink);
      expect(agent.linkForPhone(second.fp)).toBeUndefined();
      expect(lastSeen.has(second.fp)).toBe(false);
      expect(lastSeen.get(first.fp)).toBe(lastSeenBefore.get(first.fp));
      await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "unpair"));
      expect(relay.ctrlFromAgent.filter((m) => m.type === "unpair")).toEqual([
        { type: "unpair", phoneFp: second.fp },
      ]);
    } finally {
      spy.mockRestore();
      socket.destroy();
      await server.stop();
      outbound.mockRestore();
      first.ws.close();
      second.ws.close();
    }
  });
  it.each(["resolve", "reject"] as const)(
    "iTerm2 disconnect removes phone health, idle work and viewers; reused IDs survive obsolete capture %s",
    async (settle) => {
      const p = paths(mkdtempSync(join(tmpdir(), "sb-iterm-disconnect-")));
      const { identity, fp } = loadOrCreateIdentity(p);
      const localRelay = new FakeRelay(fp);
      const client = new FakeClient();
      const iterm = new ITerm2Backend(client as never, log, { minMs: 60_000 });
      const other = new FakeBackend("tmux");
      other.addSession("other", { lines: ["other screen"] });
      const registry = new BackendRegistry(log);
      registry.add(iterm);
      registry.add(other);
      let localAgent: Agent | undefined;
      let ph: ConnectedPhone | undefined;
      let otherPhone: ConnectedPhone | undefined;
      let release: (() => void) | undefined;
      try {
        await localRelay.start();
        await iterm.connect();
        const a = new Agent({
          paths: p,
          config: { ...loadConfig(p), notifyMinCommandMs: 1, idleQuietMs: 20, idleMinActiveMs: 10 },
          identity,
          fp,
          registry,
          log,
          confirm: async () => true,
          appVersion: "test",
          relayUrlOverride: localRelay.url,
        });
        localAgent = a;
        a.start();
        await waitFor(() => a.relayOnline);
        const target = { agent: a, relay: localRelay, computerFp: fp };
        const phone = await pairAndConnect(target);
        ph = phone;
        otherPhone = await pairAndConnect(target);
        const initialHello = phone.inner.find((m) => m.type === "hello");
        expect(initialHello?.type === "hello" && initialHello.backends.map((b) => b.name)).toEqual([
          "iterm2",
          "tmux",
        ]);
        phone.send(phone.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
        otherPhone.send(otherPhone.phone.seal({ type: "subscribe", sessionId: "tmux:other" }));
        await waitFor(() => phone.inner.some((m) => m.type === "screen.snapshot"));
        await waitFor(() => other.watched.at(-1)?.includes("other") === true);

        const now = Date.now();
        const at = (time: number, fn: () => void) => {
          const clock = vi.spyOn(Date, "now").mockReturnValue(time);
          try {
            fn();
          } finally {
            clock.mockRestore();
          }
        };
        const rings: { sessionId: string; kind: string }[] = [];
        a.events.on("ring", (ring) => rings.push(ring));
        at(now - 10, () => {
          a.events.onBackendEvent({
            type: "command-start",
            sessionId: "iterm2:S1",
            command: "old",
            at: now - 10,
          });
        });
        at(now, () => {
          a.events.onBackendEvent({
            type: "command-end",
            sessionId: "iterm2:S1",
            exitCode: 0,
            at: now,
          });
        });
        await waitFor(
          () => localRelay.ctrlFromAgent.filter((m) => m.type === "notify").length === 1,
        );
        expect(a.notifier.size).toBe(1);

        let captured = false;
        let reject!: (error: Error) => void;
        let resolve!: (reply: ServerOriginatedMessage) => void;
        const held = new Promise<ServerOriginatedMessage>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        const request = client.request.bind(client);
        let oldReply!: ServerOriginatedMessage;
        vi.spyOn(client, "request").mockImplementation(async (sub) => {
          const reply = await request(sub);
          if (sub.case !== "getBufferRequest" || sub.value.session !== "S1") return reply;
          if (!captured) {
            oldReply = reply;
            if (reply.submessage.case === "getBufferResponse")
              reply.submessage.value.contents[0]!.text = "obsolete capture";
            captured = true;
            return held;
          }
          if (reply.submessage.case === "getBufferResponse")
            reply.submessage.value.contents[0]!.text = "fresh capture";
          return reply;
        });
        release = () => resolve(oldReply);
        client.emit(
          "notification",
          create(NotificationSchema, {
            screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }),
          }),
        );
        await waitFor(() => captured);
        at(now + 1, () => {
          a.events.onBackendEvent({ type: "screen-changed", sessionId: "iterm2:S1" });
          // S2 has no recent prompt ring: its idle ring would not be hidden by deduplication.
          a.events.onBackendEvent({ type: "screen-changed", sessionId: "iterm2:S2" });
          other.emit({ type: "command-start", sessionId: "other", command: "running", at: now });
          other.emit({ type: "screen-changed", sessionId: "other" });
        });
        at(now + 11, () => {
          a.events.onBackendEvent({ type: "screen-changed", sessionId: "iterm2:S1" });
          a.events.onBackendEvent({ type: "screen-changed", sessionId: "iterm2:S2" });
          other.emit({ type: "screen-changed", sessionId: "other" });
          client.connected = false;
          client.emit("close");
        });
        expect(a.events.stateOf("iterm2:S1")).toBe("unknown");
        expect(a.events.stateOf("tmux:other")).toBe("running");
        expect(a.notifier.size).toBe(0);
        expect(other.watched.at(-1)).toContain("other");
        at(now + 40, () => a.events.tick());
        expect(rings.map((r) => [r.sessionId, r.kind])).toEqual([
          ["iterm2:S1", "prompt"],
          ["tmux:other", "idle"],
        ]);
        await waitFor(() =>
          phone.inner.some(
            (m) => m.type === "hello" && m.backends.length === 1 && m.backends[0]?.name === "tmux",
          ),
        );
        await waitFor(() =>
          phone.inner.some(
            (m) => m.type === "sessions" && m.list.length === 1 && m.list[0]?.id === "tmux:other",
          ),
        );
        await waitFor(
          () => localRelay.ctrlFromAgent.filter((m) => m.type === "notify").length === 2,
        );

        client.titles.S1 = "fresh title";
        client.paths.S1 = "/fresh/path";
        client.jobNames.S1 = "fresh-job";
        await iterm.connect();
        await waitFor(() =>
          phone.inner.some(
            (m) =>
              m.type === "sessions" &&
              m.list.some(
                (s) => s.id === "iterm2:S1" && s.title === "fresh title" && s.cwd === "/fresh/path",
              ),
          ),
        );
        expect(iterm.hostJob("S1")).toBe("fresh-job");
        expect(rings).toHaveLength(2);
        phone.send(phone.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
        await waitFor(() =>
          phone.inner.some(
            (m) => m.type === "screen.snapshot" && m.lines[0]?.r[0]?.t === "fresh capture",
          ),
        );
        if (settle === "reject") reject(new SessionGone("S1"));
        else release();
        await new Promise<void>((done) => setImmediate(done));
        expect(
          phone.inner.some(
            (m) => m.type === "screen.snapshot" && m.lines[0]?.r[0]?.t === "fresh capture",
          ),
        ).toBe(true);
        // A subsequent capture plus an acknowledged input is a phone-observed barrier.
        client.emit(
          "notification",
          create(NotificationSchema, {
            screenUpdateNotification: create(ScreenUpdateNotificationSchema, { session: "S1" }),
          }),
        );
        phone.send(
          phone.phone.seal({
            type: "input.line",
            reqId: "after-reconnect",
            sessionId: "iterm2:S1",
            text: "echo ok",
          }),
        );
        await waitFor(() =>
          phone.inner.some((m) => m.type === "ack" && m.reqId === "after-reconnect"),
        );
        for (const message of phone.inner) {
          const lines =
            message.type === "screen.snapshot"
              ? message.lines
              : message.type === "screen.diff"
                ? message.changed.map((change) => change.line)
                : [];
          expect(lines.some((line) => line.r.some((run) => run.t === "obsolete capture"))).toBe(
            false,
          );
        }
        at(now + 40, () => {
          a.events.onBackendEvent({
            type: "command-start",
            sessionId: "iterm2:S1",
            command: "new",
            at: now + 40,
          });
        });
        at(now + 50, () => {
          a.events.onBackendEvent({
            type: "command-end",
            sessionId: "iterm2:S1",
            exitCode: 0,
            at: now + 50,
          });
        });
        await waitFor(
          () => localRelay.ctrlFromAgent.filter((m) => m.type === "notify").length === 3,
        );
        expect(rings.map((r) => [r.sessionId, r.kind])).toEqual([
          ["iterm2:S1", "prompt"],
          ["tmux:other", "idle"],
          ["iterm2:S1", "prompt"],
        ]);
        // A healthy reconnect must be advertised even when iTerm2 has no terminal panes.
        const helloCount = () => phone.inner.filter((m) => m.type === "hello").length;
        const beforeDrop = helloCount();
        client.connected = false;
        client.emit("close");
        await waitFor(() => helloCount() > beforeDrop);
        const beforeEmptyReconnect = helloCount();
        vi.mocked(client.request).mockImplementation(async (sub) =>
          sub.case === "listSessionsRequest"
            ? create(ServerOriginatedMessageSchema, {
                submessage: {
                  case: "listSessionsResponse",
                  value: create(ListSessionsResponseSchema, {}),
                },
              })
            : request(sub),
        );
        await iterm.connect();
        await waitFor(() => helloCount() > beforeEmptyReconnect);
        const lastHello = phone.inner.filter((m) => m.type === "hello").at(-1);
        expect(lastHello?.hostPlatform).toBe(process.platform);
        expect(lastHello?.backends.map((b) => b.name)).toEqual(["iterm2", "tmux"]);
        const lastSessions = phone.inner.filter((m) => m.type === "sessions").at(-1);
        expect(lastSessions?.list.map((s) => s.id)).toEqual(["tmux:other"]);
        expect(rings).toHaveLength(3);
      } finally {
        release?.();
        ph?.ws.close();
        otherPhone?.ws.close();
        localAgent?.stop();
        await iterm.close();
        await localRelay.stop();
      }
    },
  );
  it("pairs, handshakes, receives hello+sessions, views a session, types with ack, gets diffs and events", async () => {
    // --- pair, reconnect as a phone, run conn.hello (the dance lives in pairAndConnect) ---
    const ph = await pairAndConnect();
    expect(agent.pairingList).toHaveLength(1);
    expect(ph.inner[0]).toMatchObject({
      type: "hello",
      computerName: "MBP",
      backends: [{ name: "iterm2" }],
    });
    const sessions = ph.inner.find((m) => m.type === "sessions");
    if (sessions?.type !== "sessions") throw new Error();
    expect(sessions.list.map((s) => s.id)).toEqual(["iterm2:S1"]);

    // --- view + snapshot ---
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "screen.snapshot"));
    const snap = ph.inner.find((m) => m.type === "screen.snapshot");
    if (snap?.type !== "screen.snapshot") throw new Error();
    expect(snap.lines.map((l) => l.r[0]?.t)).toEqual(["one", "two", "three"]);

    // --- input with ack, duplicate reqId not re-executed ---
    ph.send(ph.phone.seal({ type: "input.line", reqId: "r1", sessionId: "iterm2:S1", text: "y" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack"));
    expect(backend.sentText).toEqual([{ id: "S1", text: "y\r" }]);
    ph.send(ph.phone.seal({ type: "input.line", reqId: "r1", sessionId: "iterm2:S1", text: "y" }));
    await waitFor(() => ph.inner.filter((m) => m.type === "ack").length === 2);
    expect(backend.sentText).toHaveLength(1);

    // --- output → diff; command-end → event to the phone; ring to the relay ---
    backend.appendLine("S1", "four");
    await waitFor(() => ph.inner.some((m) => m.type === "screen.diff"));

    // Reconstruct the phone's local screen state through the *shipped* applySnapshot/applyDiff,
    // exactly as a real client would, rather than merely asserting a diff frame arrived: this is
    // the end-to-end proof that the diff actually reconstructs what the backend now shows.
    let screenState: ScreenState | undefined;
    for (const m of ph.inner) {
      if (m.type === "screen.snapshot")
        screenState = applySnapshot(screenState, m as ScreenSnapshot);
      else if (m.type === "screen.diff") {
        if (!screenState) throw new Error("diff arrived before any snapshot");
        const applied = applyDiff(screenState, m as ScreenDiff);
        if (applied.gap) throw new Error("unexpected gap reconstructing screen state");
        screenState = applied.state;
      }
    }
    expect(screenState?.lines.map((l) => l.r[0]?.t)).toEqual(["two", "three", "four"]);

    backend.emit({
      type: "command-start",
      sessionId: "S1",
      command: "make",
      at: Date.now() - 20_000,
    });
    backend.emit({ type: "command-end", sessionId: "S1", exitCode: 0, at: Date.now() });
    await waitFor(() => ph.inner.some((m) => m.type === "event"));
    expect(ph.inner.find((m) => m.type === "event")).toMatchObject({
      kind: "prompt",
      sessionId: "iterm2:S1",
      exitCode: 0,
    });
    // durationMs is 0 here because command-start was only just observed; ring requires ≥10 s → none expected
    expect(relay.ctrlFromAgent.filter((m) => m.type === "notify")).toHaveLength(0);

    // --- unsupported focus is acked with an error ---
    backend.capabilities = { ...backend.capabilities, focus: false };
    ph.send(ph.phone.seal({ type: "session.focus", reqId: "r2", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "r2"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "r2")).toMatchObject({
      ok: false,
      error: "unsupported",
    });

    // --- a mismatched windowId is acked bad-window, not "failed" ---
    ph.send(
      ph.phone.seal({
        type: "session.create",
        reqId: "r3",
        in: { kind: "tab", backend: "tmux", windowId: "iterm2:w1" },
      }),
    );
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "r3"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "r3")).toMatchObject({
      ok: false,
      error: "bad-window",
    });
    ph.ws.close();
  });

  it("refreshes session state after command lifecycle events", async () => {
    const ph = await pairAndConnect();
    try {
      const transitions = [
        {
          event: {
            type: "command-start" as const,
            sessionId: "S1",
            command: "fake",
            at: Date.now(),
          },
          state: "running",
        },
        {
          event: { type: "command-end" as const, sessionId: "S1", exitCode: 0, at: Date.now() },
          state: "finished",
        },
        { event: { type: "prompt" as const, sessionId: "S1", at: Date.now() }, state: "editing" },
      ];
      for (const { event, state } of transitions) {
        const before = ph.inner.length;
        backend.emit(event);
        await waitFor(() =>
          ph.inner
            .slice(before)
            .some(
              (m) =>
                m.type === "sessions" &&
                m.list.some((session) => session.id === "iterm2:S1" && session.state === state),
            ),
        );
        expect(agent.sessionList.find((session) => session.id === "iterm2:S1")?.state).toBe(state);
      }
    } finally {
      ph.ws.close();
    }
  });

  it("applies the relay's minFrameMs to the flush interval", async () => {
    // FakeRelay advertises minFrameMs 125 in auth-ok; the agent must have applied it.
    const spy = vi.spyOn(
      Reflect.get(agent, "views") as { setIntervalMs(ms: number): void },
      "setIntervalMs",
    );
    agent.relay.emit("auth-ok", {
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: "FakeMac",
      serverTime: Date.now(),
      minFrameMs: 400,
    });
    expect(spy).toHaveBeenCalledWith(400);
    agent.relay.emit("auth-ok", {
      type: "auth-ok",
      role: "agent",
      agentOnline: true,
      computerName: "FakeMac",
      serverTime: Date.now(),
      minFrameMs: 50,
    });
    expect(spy).toHaveBeenLastCalledWith(125); // never below the 125 ms floor
    spy.mockRestore();
  });

  it("applies unpaired tombstones BEFORE sending pairings-sync (Plan 02 parked item)", async () => {
    // The relay clears every tombstone when it handles pairings-sync, so a sync that still lists a
    // tombstoned phone would resurrect it. Order is the whole contract.
    const ph = await pairAndConnect();
    const removedFp = ph.fp;
    expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([removedFp]);
    ph.ws.close();

    relay.ctrlFromAgent.length = 0;
    relay.sendToAgent({ type: "unpaired", phoneFps: [removedFp] });
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "pairings-sync"));
    const sync = relay.ctrlFromAgent.find((m) => m.type === "pairings-sync");
    if (sync?.type !== "pairings-sync") throw new Error("no pairings-sync");
    // The tombstone was applied first: the sync must NOT re-register the removed phone.
    expect(sync.phones.map((p) => p.phoneFp)).not.toContain(removedFp);
    expect(agent.pairingList).toHaveLength(0);
    // And it is written through to disk, not just held in memory.
    expect(loadPairings(agentPaths)).toHaveLength(0);
  });

  it("keeps a v2 local pairing when relay sends unsigned unpair notices", async () => {
    const ph = await pairAndConnect();
    const pairKey = fromBase64Url(agent.pairingList[0]!.kPair);
    expect(() => agent.raisePairProtocolFloor(ph.fp, new Uint8Array(32))).toThrow();
    expect(agent.pairingList[0]?.minProtocolVersion).toBeUndefined();
    agent.raisePairProtocolFloor(ph.fp, pairKey);
    expect(agent.pairingList[0]?.minProtocolVersion).toBe(2);
    expect(loadPairings(agentPaths)[0]?.minProtocolVersion).toBe(2);

    relay.ctrlFromAgent.length = 0;
    relay.sendToAgent({ type: "unpair", phoneFp: ph.fp });
    relay.sendToAgent({ type: "unpaired", phoneFps: [ph.fp] });
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "pairings-sync"));
    expect(agent.pairingList[0]?.phoneFp).toBe(ph.fp);
    expect(loadPairings(agentPaths)[0]?.minProtocolVersion).toBe(2);
    expect(agent.unpairExact(ph.fp)).toBe(true);
    expect(loadPairings(agentPaths)).toHaveLength(0);
    ph.ws.close();
  });

  it("accepts only the current phone-signed proof to delete a v2 local pair", async () => {
    const ph = await pairAndConnect();
    const pairKey = fromBase64Url(agent.pairingList[0]!.kPair);
    agent.raisePairProtocolFloor(ph.fp, pairKey);
    const proof = createPairRevocationV2({
      computerFp,
      phoneFp: ph.fp,
      kPair: pairKey,
      phoneEd25519Priv: ph.identity.ed25519.priv,
      phoneEd25519Pub: ph.identity.ed25519.pub,
    });
    relay.sendToAgent({ type: "unpair", phoneFp: ph.fp, proof });
    await waitFor(() => agent.pairingList.length === 0);
    expect(loadPairings(agentPaths)).toHaveLength(0);
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "revocation-ack"));
    expect(relay.ctrlFromAgent.find((m) => m.type === "revocation-ack")).toMatchObject({
      phoneFp: ph.fp,
      pairId: proof.pairId,
    });
    ph.ws.close();
  });

  it("checks a retained signed proof before applying an offline v2 tombstone", async () => {
    const ph = await pairAndConnect();
    const pairKey = fromBase64Url(agent.pairingList[0]!.kPair);
    agent.raisePairProtocolFloor(ph.fp, pairKey);
    const proof = createPairRevocationV2({
      computerFp,
      phoneFp: ph.fp,
      kPair: pairKey,
      phoneEd25519Priv: ph.identity.ed25519.priv,
      phoneEd25519Pub: ph.identity.ed25519.pub,
    });
    relay.ctrlFromAgent.length = 0;
    relay.sendToAgent({
      type: "unpaired",
      phoneFps: [ph.fp],
      proofs: [{ ...proof, pairId: new Uint8Array(32) }],
    });
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "pairings-sync"));
    expect(agent.pairingList).toHaveLength(1);
    expect(relay.ctrlFromAgent.some((m) => m.type === "revocation-ack")).toBe(false);
    relay.sendToAgent({ type: "unpaired", phoneFps: [ph.fp], proofs: [proof] });
    await waitFor(() => agent.pairingList.length === 0);
    expect(loadPairings(agentPaths)).toHaveLength(0);
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "revocation-ack"));
    ph.ws.close();
  });

  it("unpair removes the pairing, persists it, drops the link and tells the relay", async () => {
    const ph = await pairAndConnect();
    const fp = ph.fp;
    expect(agent.pairingList.map((p) => p.phoneFp)).toEqual([fp]);
    await waitFor(() => agent.connectedPhones.length === 1);
    relay.ctrlFromAgent.length = 0;

    expect(agent.unpair("nobody")).toBe(false);
    expect(agent.unpair("")).toBe(false); // guard: `"".startsWith("")` must not match the first pairing
    expect(agent.unpair(fp.slice(0, 6))).toBe(true); // fp prefix, per spec 8.1

    expect(agent.pairingList).toHaveLength(0);
    expect(loadPairings(agentPaths)).toHaveLength(0); // persisted
    expect(agent.connectedPhones).toHaveLength(0); // link dropped
    await waitFor(() => relay.ctrlFromAgent.some((m) => m.type === "unpair"));
    expect(relay.ctrlFromAgent.find((m) => m.type === "unpair")).toMatchObject({
      type: "unpair",
      phoneFp: fp,
    });
    ph.ws.close();
  });

  it("sends `event` to every handshaken phone, not just the viewer (spec 4.4, 7.4)", async () => {
    const a = await pairAndConnect();
    const b = await pairAndConnect();
    expect(agent.pairingList).toHaveLength(2);
    // Only `a` is viewing anything.
    a.send(a.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => a.inner.some((m) => m.type === "screen.snapshot"));

    backend.emit({ type: "command-start", sessionId: "S1", command: "make", at: Date.now() });
    backend.emit({ type: "command-end", sessionId: "S1", exitCode: 3, at: Date.now() });
    await waitFor(
      () => a.inner.some((m) => m.type === "event") && b.inner.some((m) => m.type === "event"),
    );
    for (const p of [a, b]) {
      expect(p.inner.find((m) => m.type === "event")).toMatchObject({
        kind: "prompt",
        sessionId: "iterm2:S1",
        exitCode: 3,
      });
    }
    // `b` never subscribed, so it got no screen frames at all.
    expect(
      b.inner.filter((m) => m.type === "screen.snapshot" || m.type === "screen.diff"),
    ).toHaveLength(0);
    a.ws.close();
    b.ws.close();
  });

  it("session.focus on an unknown/unregistered-backend session id acks session-gone, not unsupported (spec 7.4)", async () => {
    const ph = await pairAndConnect();
    // The registry in this suite only ever has an "iterm2" backend added -- "tmux:nope" names a
    // backend that isn't registered, so `capabilitiesOf()` returns null.
    ph.send(ph.phone.seal({ type: "session.focus", reqId: "rfocus", sessionId: "tmux:nope" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rfocus"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "rfocus")).toMatchObject({
      ok: false,
      error: "session-gone",
    });
    ph.ws.close();
  });

  it("input to a session on an unregistered backend acks session-gone", async () => {
    const ph = await pairAndConnect();
    ph.send(ph.phone.seal({ type: "input.line", reqId: "rin", sessionId: "tmux:nope", text: "x" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rin"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "rin")).toMatchObject({
      ok: false,
      error: "session-gone",
    });
    ph.ws.close();
  });

  it("snapshot.get for a session the phone is not viewing acks an error, not ok", async () => {
    const ph = await pairAndConnect();
    // No `subscribe` was sent, so `link.viewed` is still null -- this must not silently ack ok.
    ph.send(ph.phone.seal({ type: "snapshot.get", reqId: "rsnap", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rsnap"));
    expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "rsnap")).toMatchObject({
      ok: false,
      error: "not-viewing",
    });
    ph.ws.close();
  });

  it("session.create broadcasts `sessions` exactly once", async () => {
    const ph = await pairAndConnect();
    const before = ph.inner.filter((m) => m.type === "sessions").length;
    ph.send(
      ph.phone.seal({
        type: "session.create",
        reqId: "rcreate",
        in: { kind: "tab", backend: "iterm2" },
      }),
    );
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "rcreate"));
    // The `sessions` refresh is debounced 100 ms; give it (generously) time to land, then make
    // sure it landed exactly once rather than counting an absence as success.
    await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length > before, 1000);
    await new Promise((r) => setTimeout(r, 150));
    expect(ph.inner.filter((m) => m.type === "sessions").length - before).toBe(1);
    ph.ws.close();
  });

  it("exactly-once: a duplicate reqId arriving while the first is still executing is not re-executed (spec 7.4)", async () => {
    const ph = await pairAndConnect();
    const currentHello = ph.phone.hello();
    ph.send(currentHello);
    await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length === 2);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realSendText = backend.sendText.bind(backend);
    backend.sendText = async (id: string, text: string) => {
      await gate;
      return realSendText(id, text);
    };
    let firstEntered!: () => void;
    const first = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let bothEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      bothEntered = resolve;
    });
    const originalOnInner = Reflect.get(agent, "onInner") as (...args: unknown[]) => Promise<void>;
    const handlers: Promise<void>[] = [];
    Reflect.set(agent, "onInner", (...args: unknown[]) => {
      const handler = Reflect.apply(originalOnInner, agent, args) as Promise<void>;
      handlers.push(handler);
      if (handlers.length === 1) firstEntered();
      if (handlers.length === 2) bothEntered();
      return handler;
    });
    try {
      // Both frames are sent before either has any chance to finish executing.
      ph.send(
        ph.phone.seal({ type: "input.line", reqId: "dup1", sessionId: "iterm2:S1", text: "z" }),
      );
      await first;
      const body = currentHello.body as { n: Uint8Array; c: Uint8Array };
      const corrupted = new Uint8Array(body.c);
      corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
      ph.send(currentHello); // rejected duplicate must not replace the pending request map
      ph.send({ ...currentHello, body: { n: body.n, c: corrupted } });
      ph.send(
        ph.phone.seal({ type: "input.line", reqId: "dup1", sessionId: "iterm2:S1", text: "z" }),
      );
      // Both handlers have entered while the first backend operation remains gated.
      await entered;
      expect(agent.linkForPhone(ph.fp)?.handshakeGeneration).toBe(2);
      release();
      await waitFor(
        () => ph.inner.filter((m) => m.type === "ack" && m.reqId === "dup1").length === 2,
      );
      expect(backend.sentText.filter((t) => t.text === "z\r")).toHaveLength(1);
      for (const ack of ph.inner.filter((m) => m.type === "ack" && m.reqId === "dup1")) {
        expect(ack).toMatchObject({ ok: true });
      }
    } finally {
      release();
      await Promise.allSettled(handlers);
      Reflect.set(agent, "onInner", originalOnInner);
      backend.sendText = realSendText;
      ph.ws.close();
    }
  });

  it("retains input outcomes across a fresh hello after an acknowledgement is lost", async () => {
    const ph = await pairAndConnect();
    const request = {
      type: "input.line" as const,
      reqId: "lost-input-ack",
      sessionId: "iterm2:S1",
      text: "once",
    };
    ph.send(ph.phone.seal(request));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === request.reqId));
    // Resubmit the same ID under a fresh key, treating the first ack as lost.
    ph.send(ph.phone.hello());
    await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length === 2);
    ph.send(ph.phone.seal(request));
    await waitFor(
      () => ph.inner.filter((m) => m.type === "ack" && m.reqId === request.reqId).length === 2,
    );
    expect(backend.sentText.filter((t) => t.text === "once\r")).toHaveLength(1);
    ph.ws.close();
  });

  it("joins an in-flight input from a replacement relay connection without executing twice", async () => {
    const ph = await pairAndConnect();
    const originalSendText = backend.sendText.bind(backend);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let calls = 0;
    backend.sendText = async (id, text) => {
      calls += 1;
      entered();
      await gate;
      return originalSendText(id, text);
    };
    const replacement = new PhoneSocket(ph.identity);
    replacement.phone = ph.phone;
    const request = {
      type: "input.text" as const,
      reqId: "pending-replacement-input",
      sessionId: "iterm2:S1",
      text: "once",
    };
    try {
      ph.send(ph.phone.seal(request));
      await started;
      const oldLink = agent.linkForPhone(ph.fp);
      await replacement.connect(relay.url, computerFp, "phone");
      replacement.send(replacement.phone.hello());
      await waitFor(() => replacement.inner.some((m) => m.type === "sessions"));
      expect(agent.linkForPhone(ph.fp)).not.toBe(oldLink);
      replacement.send(replacement.phone.seal(request));
      // This independent request is an ordered barrier while input is held.
      replacement.send(
        replacement.phone.seal({ type: "snapshot.get", reqId: "barrier", sessionId: "iterm2:S1" }),
      );
      await waitFor(() => replacement.inner.some((m) => m.type === "ack" && m.reqId === "barrier"));
      expect(calls).toBe(1);
      release();
      await waitFor(() =>
        replacement.inner.some((m) => m.type === "ack" && m.reqId === request.reqId),
      );
      expect(backend.sentText.filter((t) => t.text === "once")).toHaveLength(1);
      expect(ph.inner.some((m) => m.type === "ack" && m.reqId === request.reqId)).toBe(false);
    } finally {
      release();
      backend.sendText = originalSendText;
      ph.ws.close();
      replacement.ws.close();
    }
  });

  it("preserves outcomes through failed unpair persistence and resets them for a new pairing key", async () => {
    const ph = await pairAndConnect();
    const request = {
      type: "input.text" as const,
      reqId: "pair-lifetime",
      sessionId: "iterm2:S1",
      text: "once",
    };
    ph.send(ph.phone.seal(request));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === request.reqId));
    const persistence = vi.spyOn(configModule, "savePairings").mockImplementationOnce(() => {
      throw new Error("disk unavailable");
    });
    try {
      expect(() => agent.unpairExact(ph.fp)).toThrow("disk unavailable");
    } finally {
      persistence.mockRestore();
    }
    ph.send(ph.phone.hello());
    await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length === 2);
    ph.send(ph.phone.seal(request));
    await waitFor(
      () => ph.inner.filter((m) => m.type === "ack" && m.reqId === request.reqId).length === 2,
    );
    expect(backend.sentText.filter((t) => t.text === "once")).toHaveLength(1);

    const previous = agent.pairingList.find((p) => p.phoneFp === ph.fp)!;
    const nextKey = fromBase64Url(previous.kPair).slice();
    nextKey[0] = nextKey[0]! ^ 1;
    const addPairing = Reflect.get(agent, "addPairing");
    Reflect.apply(addPairing, agent, [
      { ...previous, kPair: Buffer.from(nextKey).toString("base64url") },
    ]);
    expect(agent.linkForPhone(ph.fp)).toBeUndefined();
    const replacement = new PhoneSocket(ph.identity);
    replacement.phone = new FakePhone(ph.identity, computerFp, nextKey);
    try {
      await replacement.connect(relay.url, computerFp, "phone");
      replacement.send(replacement.phone.hello());
      await waitFor(() => replacement.inner.some((m) => m.type === "sessions"));
      replacement.send(replacement.phone.seal(request));
      await waitFor(() =>
        replacement.inner.some((m) => m.type === "ack" && m.reqId === request.reqId),
      );
      expect(backend.sentText.filter((t) => t.text === "once")).toHaveLength(2);
    } finally {
      ph.ws.close();
      replacement.ws.close();
    }
  });

  it("retains create-session outcomes when the relay connection goes down", async () => {
    const ph = await pairAndConnect();
    const request = {
      type: "session.create" as const,
      reqId: "create-once",
      in: { kind: "tab" as const, backend: "iterm2" as const },
    };
    ph.send(ph.phone.seal(request));
    await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === request.reqId));
    const first = ph.inner.find((m) => m.type === "ack" && m.reqId === request.reqId);
    const oldLink = agent.linkForPhone(ph.fp)!;
    agent.relay.emit("down");
    expect(agent.linkForPhone(ph.fp)).toBeUndefined();
    relay.sendToAgent({
      type: "phone-connected",
      phoneFp: ph.fp,
      connId: oldLink.connId,
      name: "iPhone",
    });
    await waitFor(() => agent.linkForPhone(ph.fp) !== undefined);
    const helloCount = ph.inner.filter((m) => m.type === "hello").length;
    ph.send(ph.phone.hello());
    await waitFor(() => ph.inner.filter((m) => m.type === "hello").length > helloCount);
    ph.send(ph.phone.seal(request));
    await waitFor(
      () => ph.inner.filter((m) => m.type === "ack" && m.reqId === request.reqId).length === 2,
    );
    expect(ph.inner.filter((m) => m.type === "ack" && m.reqId === request.reqId)).toEqual([
      first,
      first,
    ]);
    expect(await backend.listSessions()).toHaveLength(2);
    ph.ws.close();
  });

  it("keeps input request IDs independent between paired phones", async () => {
    const a = await pairAndConnect();
    const b = await pairAndConnect();
    for (const ph of [a, b]) {
      ph.send(
        ph.phone.seal({
          type: "input.key",
          reqId: "shared-id",
          sessionId: "iterm2:S1",
          key: "enter",
        }),
      );
      await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "shared-id"));
    }
    expect(backend.sentText.filter((t) => t.text === "\r")).toHaveLength(2);
    a.ws.close();
    b.ws.close();
  });

  it("fresh hello drops the old view, bootstraps, and discards old history completion", async () => {
    const ph = await pairAndConnect();
    const connId = agent.linkForPhone(ph.fp)?.connId;
    expect(connId).toBeDefined();
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => backend.watched.at(-1)?.includes("S1") === true);

    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getHistory = backend.getHistory.bind(backend);
    let historyCalls = 0;
    backend.getHistory = async (id, before, count) => {
      historyCalls += 1;
      started();
      await gate;
      return getHistory(id, before, count);
    };
    let markHandled!: () => void;
    const handled = new Promise<void>((resolve) => {
      markHandled = resolve;
    });
    const originalOnInner = Reflect.get(agent, "onInner") as (...args: unknown[]) => Promise<void>;
    Reflect.set(agent, "onInner", async (...args: unknown[]) => {
      try {
        await Reflect.apply(originalOnInner, agent, args);
      } finally {
        markHandled();
      }
    });
    try {
      ph.send(
        ph.phone.seal({
          type: "history.get",
          reqId: "old-history",
          sessionId: "iterm2:S1",
          before: 5,
          count: 2,
        }),
      );
      await entered;
      const before = ph.inner.length;
      const helloReplies = ph.e2e.filter((env) => env.seq === 0).length;
      ph.send(ph.phone.hello());
      await waitFor(() => ph.e2e.filter((env) => env.seq === 0).length === helloReplies + 1);

      await waitFor(() => backend.watched.at(-1)?.includes("S1") !== true);
      await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length === 2);
      const newHandshakeMessages = () => ph.inner.slice(before);
      expect(newHandshakeMessages().filter((m) => m.type === "hello")).toHaveLength(1);
      expect(newHandshakeMessages().filter((m) => m.type === "sessions")).toHaveLength(1);

      release();
      await handled;
      // A reply to this new-key request is a transport ordering barrier for any stale sends.
      ph.send(
        ph.phone.seal({
          type: "snapshot.get",
          reqId: "new-snapshot",
          sessionId: "iterm2:S1",
        }),
      );
      await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "new-snapshot"));
      expect(
        newHandshakeMessages().find((m) => m.type === "ack" && m.reqId === "new-snapshot"),
      ).toMatchObject({ ok: false, error: "not-viewing" });
      expect(newHandshakeMessages().some((m) => m.type === "history")).toBe(false);
      expect(
        newHandshakeMessages().some((m) => m.type === "ack" && m.reqId === "old-history"),
      ).toBe(false);

      // The old acknowledgement was not inserted into the new handshake's cache.
      ph.send(
        ph.phone.seal({
          type: "history.get",
          reqId: "old-history",
          sessionId: "iterm2:S1",
          before: 5,
          count: 2,
        }),
      );
      await waitFor(() =>
        ph.inner.slice(before).some((m) => m.type === "ack" && m.reqId === "old-history"),
      );
      expect(historyCalls).toBe(2);
      expect(ph.inner.slice(before).filter((m) => m.type === "history")).toHaveLength(1);

      const snapshots = ph.inner.filter((m) => m.type === "screen.snapshot").length;
      ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
      await waitFor(() => backend.watched.at(-1)?.includes("S1") === true);
      await waitFor(() => ph.inner.filter((m) => m.type === "screen.snapshot").length > snapshots);
      ph.send(
        ph.phone.seal({
          type: "snapshot.get",
          reqId: "resubscribed",
          sessionId: "iterm2:S1",
        }),
      );
      await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "resubscribed"));
      expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "resubscribed")).toMatchObject({
        ok: true,
      });
    } finally {
      release();
      await handled;
      Reflect.set(agent, "onInner", originalOnInner);
      backend.getHistory = getHistory;
      ph.ws.close();
    }
  });

  it("retires old-generation waiters while the new generation joins their same-ID outcome", async () => {
    const ph = await pairAndConnect();
    const originalSendText = backend.sendText.bind(backend);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls: string[] = [];
    const originalOnInner = Reflect.get(agent, "onInner") as (...args: unknown[]) => Promise<void>;
    const handlers: Promise<void>[] = [];
    try {
      backend.sendText = async (id, value) => {
        calls.push(value);
        started();
        await gate;
        return originalSendText(id, value);
      };
      Reflect.set(agent, "onInner", (...args: unknown[]) => {
        const handler = Reflect.apply(originalOnInner, agent, args) as Promise<void>;
        handlers.push(handler);
        return handler;
      });
      const request = {
        type: "input.line" as const,
        reqId: "reused",
        sessionId: "iterm2:S1",
        text: "old",
      };
      ph.send(ph.phone.seal(request));
      await entered;
      ph.send(ph.phone.seal(request));
      await waitFor(() => handlers.length === 2);
      const before = ph.inner.length;
      ph.send(ph.phone.hello());
      await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length === 2);
      // Changing the payload under an existing ID cannot create another operation.
      ph.send(ph.phone.seal({ ...request, text: "new" }));
      await waitFor(() => handlers.length === 3);
      expect(calls).toEqual(["old\r"]);
      release();
      await Promise.all(handlers);
      await waitFor(() =>
        ph.inner.slice(before).some((m) => m.type === "ack" && m.reqId === request.reqId),
      );
      expect(
        ph.inner.slice(before).filter((m) => m.type === "ack" && m.reqId === request.reqId),
      ).toHaveLength(1);
      ph.send(ph.phone.seal({ ...request, text: "new" }));
      await waitFor(
        () =>
          ph.inner.slice(before).filter((m) => m.type === "ack" && m.reqId === request.reqId)
            .length === 2,
      );
      expect(
        ph.inner.slice(before).filter((m) => m.type === "ack" && m.reqId === request.reqId),
      ).toEqual([expect.objectContaining({ ok: true }), expect.objectContaining({ ok: true })]);
      expect(calls).toEqual(["old\r"]);
      expect(backend.sentText.filter((sent) => sent.text === "old\r")).toHaveLength(1);
    } finally {
      release();
      await Promise.allSettled(handlers);
      Reflect.set(agent, "onInner", originalOnInner);
      backend.sendText = originalSendText;
      ph.ws.close();
    }
  });

  it("duplicate and invalid hellos preserve the current view and bootstrap", async () => {
    const ph = await pairAndConnect();
    const connId = agent.linkForPhone(ph.fp)?.connId;
    expect(connId).toBeDefined();
    const accepted = ph.phone.hello();
    ph.send(accepted);
    await waitFor(() => ph.inner.filter((m) => m.type === "sessions").length === 2);
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => backend.watched.at(-1)?.includes("S1") === true);
    const generation = agent.linkForPhone(ph.fp)?.handshakeGeneration;
    const bootstraps = ph.inner.filter((m) => m.type === "sessions").length;
    const body = accepted.body as { n: Uint8Array; c: Uint8Array };
    const corrupted = new Uint8Array(body.c);
    corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
    try {
      ph.send(accepted);
      ph.send({ ...accepted, body: { n: body.n, c: corrupted } });
      ph.send(
        ph.phone.seal({
          type: "snapshot.get",
          reqId: "still-viewing",
          sessionId: "iterm2:S1",
        }),
      );
      await waitFor(() => ph.inner.some((m) => m.type === "ack" && m.reqId === "still-viewing"));
      expect(ph.inner.find((m) => m.type === "ack" && m.reqId === "still-viewing")).toMatchObject({
        ok: true,
      });
      expect(backend.watched.at(-1)).toContain("S1");
      expect(agent.linkForPhone(ph.fp)?.handshakeGeneration).toBe(generation);
      expect(ph.inner.filter((m) => m.type === "sessions")).toHaveLength(bootstraps);
    } finally {
      ph.ws.close();
    }
  });

  it.each(["disconnect", "replacement", "relay down", "stop", "broken link"] as const)(
    "detaches a pending input acknowledgement on %s",
    async (teardown) => {
      const ph = await pairAndConnect();
      const oldLink = agent.linkForPhone(ph.fp);
      if (!oldLink) throw new Error("missing paired link");
      const oldSend = vi.spyOn(oldLink, "send");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let markStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const originalSendText = backend.sendText.bind(backend);
      backend.sendText = async (id, value) => {
        markStarted();
        await gate;
        return originalSendText(id, value);
      };
      let markHandled!: () => void;
      const handled = new Promise<void>((resolve) => {
        markHandled = resolve;
      });
      const originalOnInner = Reflect.get(agent, "onInner") as (
        ...args: unknown[]
      ) => Promise<void>;
      Reflect.set(agent, "onInner", async (...args: unknown[]) => {
        try {
          await Reflect.apply(originalOnInner, agent, args);
        } finally {
          markHandled();
        }
      });
      let entered = false;
      try {
        ph.send(
          ph.phone.seal({
            type: "input.line",
            reqId: "detached",
            sessionId: "iterm2:S1",
            text: "once",
          }),
        );
        await started;
        entered = true;
        if (teardown === "disconnect") {
          ph.ws.close();
          await waitFor(() => agent.linkForPhone(ph.fp) !== oldLink);
        } else if (teardown === "replacement") {
          relay.sendToAgent({
            type: "phone-connected",
            phoneFp: ph.fp,
            connId: "replacement",
            name: "iPhone",
          });
          await waitFor(() => agent.linkForPhone(ph.fp) !== oldLink);
        } else if (teardown === "relay down") {
          relay.dropAgent();
          await waitFor(() => agent.linkForPhone(ph.fp) !== oldLink);
        } else if (teardown === "broken link") {
          for (let i = 0; i < 20; i++) {
            const frame = ph.phone.seal({ type: "subscribe", sessionId: null });
            const body = frame.body as { n: Uint8Array; c: Uint8Array };
            const corrupted = new Uint8Array(body.c);
            corrupted[corrupted.length - 1] = (corrupted[corrupted.length - 1] as number) ^ 0xff;
            ph.send({ ...frame, body: { n: body.n, c: corrupted } });
          }
          await waitFor(() => oldLink.broken && agent.linkForPhone(ph.fp) !== oldLink);
        } else {
          agent.stop();
          expect(agent.linkForPhone(ph.fp)).toBeUndefined();
        }
        release();
        await handled;
        expect(backend.sentText.filter((sent) => sent.text === "once\r")).toHaveLength(1);
        expect(
          oldSend.mock.calls.some(([msg]) => msg.type === "ack" && msg.reqId === "detached"),
        ).toBe(false);
      } finally {
        release();
        if (entered) await handled;
        Reflect.set(agent, "onInner", originalOnInner);
        backend.sendText = originalSendText;
        oldSend.mockRestore();
        ph.ws.close();
      }
    },
  );

  it("stop() closes any open pairing window and releases every phone view (Important)", async () => {
    const ph = await pairAndConnect();
    ph.send(ph.phone.seal({ type: "subscribe", sessionId: "iterm2:S1" }));
    await waitFor(() => ph.inner.some((m) => m.type === "screen.snapshot"));
    expect(agent.connectedPhones).toHaveLength(1);

    agent.openPairing(); // leave a pairing window open across stop()
    const closeWindowSpy = vi.spyOn(agent.pairing, "closeWindow");

    agent.stop();

    expect(closeWindowSpy).toHaveBeenCalled();
    expect(backend.watched.at(-1)).not.toContain("S1");
    expect(agent.connectedPhones).toHaveLength(0);
    ph.ws.close();
  });

  it("superseded (relay closes with 4005): stops the agent and calls onSuperseded (spec §12, Important)", async () => {
    const p3 = paths(mkdtempSync(join(tmpdir(), "sb-agent-superseded-")));
    const { identity: id3, fp: fp3 } = loadOrCreateIdentity(p3);
    const relay3 = new FakeRelay(fp3);
    await relay3.start();
    const registry3 = new BackendRegistry(log);
    registry3.add(new FakeBackend());
    const config3 = { ...loadConfig(p3), computerName: "MBP3" };
    let supersededCalls = 0;
    const agent3 = new Agent({
      paths: p3,
      config: config3,
      identity: id3,
      fp: fp3,
      registry: registry3,
      log,
      confirm: async () => true,
      appVersion: "0.0.1-test",
      relayUrlOverride: relay3.url,
      onSuperseded: () => {
        supersededCalls += 1;
      },
    });
    agent3.start();
    try {
      await waitFor(() => agent3.relayOnline);
      const stopSpy = vi.spyOn(agent3, "stop");

      // A second "agent" socket authenticating with the *same* fp supersedes the first, closing
      // its socket with 4005 ("Duplicate agent process: New wins; old exits").
      const impostor = new RelayClient({
        relayUrl: relay3.url,
        fp: fp3,
        identity: id3,
        name: "impostor",
        appVersion: "0.0.1-test",
        log,
      });
      impostor.start();
      try {
        await waitFor(() => supersededCalls === 1);
        expect(stopSpy).toHaveBeenCalledTimes(1);
        expect(agent3.relayOnline).toBe(false);
        expect(agent3.connectedPhones).toHaveLength(0);
      } finally {
        impostor.stop();
      }
    } finally {
      agent3.stop();
      await relay3.stop();
    }
  });

  it("guards a fire-and-forget ctrl handler: a savePairings failure during `unpaired` is logged, not thrown (Critical)", async () => {
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);

    const { log: log2, calls } = capturingLogger();
    const p2 = paths(mkdtempSync(join(tmpdir(), "sb-agent-guard-")));
    const { identity: id2, fp: fp2 } = loadOrCreateIdentity(p2);
    const relay2 = new FakeRelay(fp2);
    await relay2.start();
    const registry2 = new BackendRegistry(log2);
    registry2.add(new FakeBackend());
    const config2 = { ...loadConfig(p2), computerName: "MBP2" };
    const agent2 = new Agent({
      paths: p2,
      config: config2,
      identity: id2,
      fp: fp2,
      registry: registry2,
      log: log2,
      confirm: async () => true,
      appVersion: "0.0.1-test",
      relayUrlOverride: relay2.url,
    });
    agent2.start();
    try {
      await waitFor(() => agent2.relayOnline);
      const ph2 = await pairAndConnect({ agent: agent2, relay: relay2, computerFp: fp2 });
      expect(agent2.pairingList).toHaveLength(1);

      const spy = vi.spyOn(configModule, "savePairings").mockImplementationOnce(() => {
        throw new Error("disk full");
      });
      try {
        relay2.sendToAgent({ type: "unpaired", phoneFps: [ph2.fp] });
        await waitFor(() => calls.some((c) => c.level === "error" && c.msg === "handler failed"));
      } finally {
        spy.mockRestore();
      }

      expect(calls.find((c) => c.level === "error" && c.msg === "handler failed")).toMatchObject({
        fields: { where: "ctrl" },
      });
      // The agent survived the failure: the relay connection is still up.
      expect(agent2.relayOnline).toBe(true);
      await new Promise((r) => setTimeout(r, 30)); // let any unhandled rejection surface
      expect(rejections).toHaveLength(0);

      ph2.ws.close();
    } finally {
      process.removeListener("unhandledRejection", onRejection);
      agent2.stop();
      await relay2.stop();
    }
  });

  it(
    "C1: a window opened before the relay authenticates is silently dropped, then re-advertised " +
      "by readvertise() on auth-ok -- a phone can still pair against it",
    async () => {
      const p2 = paths(mkdtempSync(join(tmpdir(), "sb-agent-c1-")));
      const { identity: id2, fp: fp2 } = loadOrCreateIdentity(p2);
      const relay2 = new FakeRelay(fp2);
      await relay2.start();
      const registry2 = new BackendRegistry(log);
      registry2.add(new FakeBackend());
      const config2 = { ...loadConfig(p2), computerName: "MBP2" };
      const agent2 = new Agent({
        paths: p2,
        config: config2,
        identity: id2,
        fp: fp2,
        registry: registry2,
        log,
        confirm: async () => true,
        appVersion: "0.0.1-test",
        relayUrlOverride: relay2.url,
      });
      try {
        // The exact race C1 fixes: `start()` kicks off a not-yet-authenticated relay connection,
        // and `openPairing()` runs synchronously in the same tick -- its own `pairing-open` send
        // is dropped (RelayClient.sendCtrl returns false pre-auth).
        agent2.start();
        const { qrText } = agent2.openPairing();
        expect(relay2.window).toBeNull(); // proves the race: nothing has reached the relay yet

        await waitFor(() => agent2.relayOnline);
        // Agent's auth-ok handler calls pairing.readvertise(); the relay should see the window
        // without anyone calling openPairing() a second time.
        await waitFor(() => relay2.window !== null);

        const ph = await pairAndConnect(
          { agent: agent2, relay: relay2, computerFp: fp2 },
          { qrText },
        );
        expect(agent2.pairingList.map((p) => p.phoneFp)).toContain(ph.fp);
        ph.ws.close();
      } finally {
        agent2.stop();
        await relay2.stop();
      }
    },
  );

  it(
    "I1: the relay drops the agent mid-window; on reconnect the window is re-advertised and " +
      "pairing still succeeds against the original QR",
    async () => {
      const { qrText } = agent.openPairing();
      await waitFor(() => relay.window !== null);

      relay.dropAgent();
      await waitFor(() => !agent.relayOnline);
      // FakeRelay mirrors the shipped relay: an agent disconnect closes the window row.
      await waitFor(() => relay.window === null);

      // RelayClient reconnects on its own backoff (default ~1s + jitter).
      await waitFor(() => agent.relayOnline, 8000);
      await waitFor(() => relay.window !== null, 8000);

      const ph = await pairAndConnect(undefined, { qrText });
      expect(agent.pairingList.map((p) => p.phoneFp)).toContain(ph.fp);
      ph.ws.close();
    },
  );

  it("throttles the lastSeenAt-only savePairings write across a fast phone reconnect loop (minor)", async () => {
    const ph = await pairAndConnect();
    const spy = vi.spyOn(configModule, "savePairings");
    spy.mockClear();
    // Simulate a phone stuck reconnecting: the relay announces the same phoneFp connecting again
    // under a fresh connId, twice in immediate succession -- well within the throttle window that
    // the just-completed real connect above already started.
    relay.sendToAgent({
      type: "phone-connected",
      phoneFp: ph.fp,
      connId: "retry-1",
      name: "iPhone",
    });
    relay.sendToAgent({
      type: "phone-connected",
      phoneFp: ph.fp,
      connId: "retry-2",
      name: "iPhone",
    });
    await waitFor(() => agent.linkForPhone(ph.fp)?.connId === "retry-2");
    expect(spy).not.toHaveBeenCalled();
    ph.ws.close();
  });

  it(
    "spec 8.12 (ruling 3): a handshaken phone gets a fresh hello when herdr connects or " +
      "disconnects -- even with zero panes -- and no hello when nothing changed",
    async () => {
      const p4 = paths(mkdtempSync(join(tmpdir(), "sb-agent-herdr-hello-")));
      const { identity: id4, fp: fp4 } = loadOrCreateIdentity(p4);
      const relay4 = new FakeRelay(fp4);
      await relay4.start();
      const registry4 = new BackendRegistry(log);
      registry4.add(new FakeBackend());
      const config4 = { ...loadConfig(p4), computerName: "MBP4" };
      const agent4 = new Agent({
        paths: p4,
        config: config4,
        identity: id4,
        fp: fp4,
        registry: registry4,
        log,
        confirm: async () => true,
        appVersion: "0.0.1-test",
        relayUrlOverride: relay4.url,
      });
      agent4.start();
      // Not started yet -- just reserves a socket path, so herdr is initially "not there".
      const herdrServer = new FakeHerdr();
      let handle: { stop(): void } | null = null;
      try {
        await waitFor(() => agent4.relayOnline);
        const ph = await pairAndConnect({ agent: agent4, relay: relay4, computerFp: fp4 });
        const hellos = () => ph.inner.filter((m) => m.type === "hello");
        expect(hellos()).toHaveLength(1);
        expect(hellos()[0]).toMatchObject({ backends: [{ name: "iterm2" }] });

        // Registered before herdr is reachable: connecting fails and retries.
        handle = startHerdrBackend({
          registry: registry4,
          log,
          socketPath: herdrServer.path,
          retryMs: 20,
          backendOptions: { reconnectMs: 60_000, syncDebounceMs: 20 },
        });
        // Give the retry loop a few rounds to prove absence alone sends no hello.
        await new Promise((r) => setTimeout(r, 100));
        expect(hellos()).toHaveLength(1);

        // Herdr appears -- with a ZERO-pane snapshot, so the only signal is HerdrBackend's own
        // `layout-changed` on connect, not a `session-added`/`session-removed` side effect.
        herdrServer.reply("session.snapshot", () => ({
          type: "session_snapshot",
          snapshot: {
            version: "0.8.2",
            protocol: 22,
            workspaces: [],
            tabs: [],
            panes: [],
            layouts: [],
            agents: [],
          },
        }));
        await herdrServer.start();
        await waitFor(() => hellos().length === 2, 3000);
        expect(hellos().at(-1)).toMatchObject({
          backends: [{ name: "iterm2" }, { name: "herdr" }],
        });

        // Quiet again: no further hello while nothing changes.
        await new Promise((r) => setTimeout(r, 100));
        expect(hellos()).toHaveLength(2);

        // Herdr's socket dies -- again zero panes, so only `layout-changed` on disconnect explains
        // the phone finding out.
        await herdrServer.stop();
        await waitFor(() => hellos().length === 3, 3000);
        expect(hellos().at(-1)).toMatchObject({ backends: [{ name: "iterm2" }] });

        ph.ws.close();
      } finally {
        handle?.stop();
        await herdrServer.stop().catch(() => {});
        agent4.stop();
        await relay4.stop();
      }
    },
  );

  it(
    "M-2: the hello re-broadcast still runs on a refresh where registry.listSessions() itself " +
      "rejects, as long as the connected backend set changed",
    async () => {
      // `registry.listSessions()` already isolates every MEMBER's own failure (`safeListSessions`
      // in registry.ts), so this needs the registry FACADE itself to throw -- unlikely, but the
      // fix must not depend on it never happening: `broadcastHelloIfBackendsChanged()` must run
      // regardless, not only on the `try`'s happy path.
      const p5 = paths(mkdtempSync(join(tmpdir(), "sb-agent-m2-")));
      const { identity: id5, fp: fp5 } = loadOrCreateIdentity(p5);
      const relay5 = new FakeRelay(fp5);
      await relay5.start();
      const registry5 = new BackendRegistry(log);
      const iterm5 = new FakeBackend();
      registry5.add(iterm5);
      const config5 = { ...loadConfig(p5), computerName: "MBP5" };
      const agent5 = new Agent({
        paths: p5,
        config: config5,
        identity: id5,
        fp: fp5,
        registry: registry5,
        log,
        confirm: async () => true,
        appVersion: "0.0.1-test",
        relayUrlOverride: relay5.url,
      });
      agent5.start();
      try {
        await waitFor(() => agent5.relayOnline);
        const ph = await pairAndConnect({ agent: agent5, relay: relay5, computerFp: fp5 });
        const hellos = () => ph.inner.filter((m) => m.type === "hello");
        expect(hellos()).toHaveLength(1);

        // Make the registry facade itself reject exactly once, then adding a second backend
        // changes the connected set on that SAME refresh.
        const realListSessions = registry5.listSessions.bind(registry5);
        let thrown = false;
        registry5.listSessions = async () => {
          if (!thrown) {
            thrown = true;
            throw new Error("registry facade exploded");
          }
          return realListSessions();
        };
        const tmux5 = new FakeBackend("tmux");
        registry5.add(tmux5);

        // Despite the rejection, the phone still gets the fresh hello for the new backend set.
        await waitFor(() => hellos().length === 2, 3000);
        expect(hellos().at(-1)).toMatchObject({
          backends: [{ name: "iterm2" }, { name: "tmux" }],
        });

        ph.ws.close();
      } finally {
        agent5.stop();
        await relay5.stop();
      }
    },
  );
});
