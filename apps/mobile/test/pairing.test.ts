import {
  authMessage,
  type CtrlMessage,
  type CtrlMessageOf,
  decodeCbor,
  decodeEnvelope,
  derivePairKey,
  derivePskKey,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  encodeQr,
  fingerprint,
  fromBase64Url,
  generateIdentity,
  MAX_PAIRINGS,
  open,
  pairingAd,
  parseQr,
  randomBytes,
  seal,
  toBase64Url,
  verify,
} from "@shellbell/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { createLogger } from "../../agent/src/log.js";
import { PairingManager, type PairingManagerOptions } from "../../agent/src/pairing.js";
import { RelayClient } from "../../agent/src/relay-client.js";
import { FakeRelay } from "../../agent/test/fakes/fake-relay.js";
import { PairingError, parsePairingQr, runPairing } from "../src/net/pairing.js";

// ---------------------------------------------------------------------------
// Scripted-socket harness: a fully controlled double so tests can drive
// exactly one ctrl frame at a time without racing a real relay.
// ---------------------------------------------------------------------------

class FakeSocket {
  binaryType = "";
  closed = false;
  closeCode: number | undefined;
  sent: Uint8Array[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.onclose?.({ code, reason });
  }

  triggerEnvelope(env: Envelope): void {
    this.onmessage?.({ data: encodeEnvelope(env) });
  }

  triggerCtrl(body: CtrlMessage): void {
    this.triggerEnvelope({ v: 1, t: "ctrl", from: "relay", seq: 0, body } as Envelope);
  }
}

function socketFactory(): { Ctor: new (url: string) => FakeSocket; sockets: FakeSocket[] } {
  const sockets: FakeSocket[] = [];
  class Wrapped extends FakeSocket {
    constructor(url: string) {
      super(url);
      sockets.push(this);
    }
  }
  return { Ctor: Wrapped, sockets };
}

function sentCtrl(sock: FakeSocket, i: number): CtrlMessage {
  const env = decodeEnvelope(sock.sent[i] as Uint8Array);
  return env.body as CtrlMessage;
}

/** Builds a valid QR (v1) with a fresh computer identity, without touching PairingManager. */
function makeQr(over: { r?: string } = {}) {
  const mac = generateIdentity();
  const macFp = fingerprint(mac.ed25519.pub);
  const code = randomBytes(16);
  const gate = randomBytes(16);
  const qrText = encodeQr({
    v: 1,
    r: over.r ?? "wss://relay.test",
    c: macFp,
    e: toBase64Url(mac.ed25519.pub),
    n: "MBP",
    p: toBase64Url(code),
    g: toBase64Url(gate),
  });
  const { qr } = parsePairingQr(qrText, { allowInsecure: true });
  return { mac, macFp, code, gate, qr };
}

function basePhoneOpts() {
  const identity = generateIdentity();
  const phoneFp = fingerprint(identity.ed25519.pub);
  return { identity, phoneFp, phoneName: "iPhone", platform: "ios" as const, appVersion: "0.1.0" };
}

// ---------------------------------------------------------------------------
// parsePairingQr
// ---------------------------------------------------------------------------

describe("parsePairingQr", () => {
  it("validates before anything is sent and names the computer for the confirmation sheet", () => {
    const mac = generateIdentity();
    const macFp = fingerprint(mac.ed25519.pub);
    const qrText = encodeQr({
      v: 1,
      r: "wss://relay.test",
      c: macFp,
      e: toBase64Url(mac.ed25519.pub),
      n: "Bilal's MacBook",
      p: toBase64Url(randomBytes(16)),
      g: toBase64Url(randomBytes(16)),
    });
    const { qr, displayName, fpPrefix } = parsePairingQr(qrText);
    expect(qr.c).toBe(macFp);
    expect(displayName).toBe("Bilal's MacBook");
    expect(fpPrefix).toBe(`${macFp.slice(0, 4)}-${macFp.slice(4, 8)}`);
  });

  it("throws PairingError('bad-qr') for text that isn't a pairing QR", () => {
    expect(() => parsePairingQr("not json")).toThrow(PairingError);
    try {
      parsePairingQr("not json");
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(PairingError);
      expect((e as PairingError).code).toBe("bad-qr");
    }
  });

  it("throws PairingError('bad-qr') for a ws:// relay without allowInsecure", () => {
    const mac = generateIdentity();
    const macFp = fingerprint(mac.ed25519.pub);
    const qrText = encodeQr({
      v: 1,
      r: "ws://localhost:8787",
      c: macFp,
      e: toBase64Url(mac.ed25519.pub),
      n: "MBP",
      p: toBase64Url(randomBytes(16)),
      g: toBase64Url(randomBytes(16)),
    });
    expect(() => parsePairingQr(qrText)).toThrow(PairingError);
    try {
      parsePairingQr(qrText);
      throw new Error("expected throw");
    } catch (e) {
      expect((e as PairingError).code).toBe("bad-qr");
    }
  });

  it("accepts a ws:// relay when allowInsecure is set (dev override)", () => {
    const mac = generateIdentity();
    const macFp = fingerprint(mac.ed25519.pub);
    const qrText = encodeQr({
      v: 1,
      r: "ws://localhost:8787",
      c: macFp,
      e: toBase64Url(mac.ed25519.pub),
      n: "MBP",
      p: toBase64Url(randomBytes(16)),
      g: toBase64Url(randomBytes(16)),
    });
    const { qr } = parsePairingQr(qrText, { allowInsecure: true });
    expect(qr.r).toBe("ws://localhost:8787");
  });
});

// ---------------------------------------------------------------------------
// runPairing — scripted socket: wire behaviour, guarding, single-settle, timeout
// ---------------------------------------------------------------------------

describe("runPairing (scripted socket)", () => {
  it("answers challenge with role pairing, the phone identity, and the QR's gate", async () => {
    const { macFp, code, gate, qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    const nonce = randomBytes(32);
    sock.triggerCtrl({ type: "challenge", nonce, connId: "c1" });
    expect(sock.sent).toHaveLength(1);
    const body = sentCtrl(sock, 0) as CtrlMessageOf<"auth">;
    expect(body.type).toBe("auth");
    expect(body.role).toBe("pairing");
    expect(body.fp).toBe(phoneFp);
    expect(body.name).toBe(phoneName);
    expect(body.appVersion).toBe(appVersion);
    expect(body.gate).toEqual(gate);
    expect(
      verify(identity.ed25519.pub, authMessage("c1", "pairing", phoneFp, nonce), body.sig),
    ).toBe(true);
    // Settle so no dangling timer survives the test.
    sock.triggerCtrl({ type: "pairing-reject", phoneFp, reason: "declined" });
    await expect(promise).rejects.toMatchObject({ code: "declined" });
    void macFp;
    void code;
  });

  it("on auth-ok, seals a pairing-request under K_psk with the phone's identity/name/platform", async () => {
    const { macFp, code, qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    sock.triggerCtrl({
      type: "auth-ok",
      role: "pairing",
      agentOnline: true,
      computerName: "MBP",
      serverTime: Date.now(),
      minFrameMs: 125,
    });
    expect(sock.sent).toHaveLength(1);
    const body = sentCtrl(sock, 0) as CtrlMessageOf<"pairing-request">;
    expect(body.type).toBe("pairing-request");
    expect(body.phoneFp).toBe(phoneFp);
    const kPsk = derivePskKey(code, macFp);
    const opened = decodeCbor(open(kPsk, body.box, pairingAd("request", macFp, phoneFp))) as {
      ed25519Pub: Uint8Array;
      x25519Pub: Uint8Array;
      name: string;
      platform: string;
    };
    expect(opened.ed25519Pub).toEqual(identity.ed25519.pub);
    expect(opened.x25519Pub).toEqual(identity.x25519.pub);
    expect(opened.name).toBe(phoneName);
    expect(opened.platform).toBe(platform);
    sock.triggerCtrl({ type: "pairing-reject", phoneFp, reason: "declined" });
    await expect(promise).rejects.toMatchObject({ code: "declined" });
  });

  it("resolves with the same K_pair the computer would derive", async () => {
    const { mac, macFp, code, qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    const kPsk = derivePskKey(code, macFp);
    const box = seal(
      kPsk,
      encodeCbor({ x25519Pub: mac.x25519.pub, computerName: "MBP", accent: "emerald" }),
      pairingAd("response", macFp, phoneFp),
    );
    sock.triggerCtrl({ type: "pairing-response", phoneFp, box });
    const result = await promise;
    expect(result.computerFp).toBe(macFp);
    expect(result.computerName).toBe("MBP");
    expect(result.accent).toBe("emerald");
    expect(result.relayUrl).toBe(qr.r);
    const expected = derivePairKey(mac.x25519.priv, identity.x25519.pub, code, macFp, phoneFp);
    expect(result.secret.kPair).toEqual(expected);
    expect(result.secret.computerEd25519Pub).toEqual(mac.ed25519.pub);
    expect(result.secret.computerX25519Pub).toEqual(mac.x25519.pub);
    expect(sock.closed).toBe(true);
  });

  it("an undecryptable pairing-response box rejects bad-code without throwing", async () => {
    const { mac, macFp, qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    const wrongKey = randomBytes(32);
    const box = seal(
      wrongKey,
      encodeCbor({ x25519Pub: mac.x25519.pub, computerName: "MBP", accent: "emerald" }),
      pairingAd("response", macFp, phoneFp),
    );
    expect(() => sock.triggerCtrl({ type: "pairing-response", phoneFp, box })).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: "bad-code" });
  });

  it("a wrong-length x25519Pub in the response rejects bad-code without reaching derivePairKey", async () => {
    const { mac, macFp, code, qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    const kPsk = derivePskKey(code, macFp);
    const box = seal(
      kPsk,
      encodeCbor({
        x25519Pub: mac.x25519.pub.slice(0, 16),
        computerName: "MBP",
        accent: "emerald",
      }),
      pairingAd("response", macFp, phoneFp),
    );
    expect(() => sock.triggerCtrl({ type: "pairing-response", phoneFp, box })).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: "bad-code" });
  });

  it("a malformed frame rejects relay instead of throwing into the socket callback", async () => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    expect(() => sock.onmessage?.({ data: new Uint8Array([1, 2, 3, 4, 5]) })).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: "relay" });
  });

  it("an unrecognised ctrl enum rejects relay, not bad-code", async () => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    // auth-fail.reason stays strict (R54 ruling 1): an enum value a newer relay introduces still
    // fails parseCtrlLoose, and that is a wire fault, not proof the pairing code is wrong.
    expect(() =>
      sock.triggerCtrl({ type: "auth-fail", reason: "a-reason-from-the-future" } as never),
    ).not.toThrow();
    await expect(promise).rejects.toMatchObject({ code: "relay" });
  });

  it("ignores text frames without disrupting the handshake", async () => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    sock.onmessage?.({ data: "ping" });
    expect(sock.sent).toHaveLength(0);
    expect(sock.closed).toBe(false);
    sock.triggerCtrl({ type: "challenge", nonce: randomBytes(32), connId: "c1" });
    expect(sock.sent).toHaveLength(1);
    sock.triggerCtrl({ type: "pairing-reject", phoneFp, reason: "declined" });
    await expect(promise).rejects.toMatchObject({ code: "declined" });
  });

  it.each([
    ["no-window", "no-window"],
    ["no-agent", "no-agent"],
    ["timeout", "timeout"],
    ["bad-sig", "relay"],
    ["not-paired", "relay"],
    ["fp-mismatch", "relay"],
  ] as const)("auth-fail reason %s -> PairingError(%s)", async (reason, code) => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    sock.triggerCtrl({ type: "auth-fail", reason });
    await expect(promise).rejects.toMatchObject({ code });
  });

  it.each([
    ["declined", "declined"],
    ["bad-code", "bad-code"],
    ["no-agent", "no-agent"],
    ["too-many", "too-many"],
    ["window-closed", "no-window"],
  ] as const)("pairing-reject reason %s -> PairingError(%s)", async (reason, code) => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    sock.triggerCtrl({ type: "pairing-reject", phoneFp, reason });
    await expect(promise).rejects.toMatchObject({ code });
  });

  it.each([
    [4001, "no-window"],
    [4003, "declined"],
    [4408, "timeout"],
    [4413, "relay"],
    [4429, "relay"],
    [1000, "relay"],
  ] as const)("close code %i -> PairingError(%s)", async (code, expected) => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    sock.close(code, "");
    await expect(promise).rejects.toMatchObject({ code: expected });
  });

  it("a socket error rejects with PairingError('relay')", async () => {
    const { qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    sock.onerror?.({});
    await expect(promise).rejects.toMatchObject({ code: "relay" });
  });

  it("settles exactly once: a duplicate close after a successful response is a no-op", async () => {
    const { mac, macFp, code, qr } = makeQr();
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const { Ctor, sockets } = socketFactory();
    const promise = runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: Ctor as never,
    });
    const sock = sockets[0];
    if (!sock) throw new Error("no socket created");
    const kPsk = derivePskKey(code, macFp);
    const box = seal(
      kPsk,
      encodeCbor({ x25519Pub: mac.x25519.pub, computerName: "MBP", accent: "emerald" }),
      pairingAd("response", macFp, phoneFp),
    );
    sock.triggerCtrl({ type: "pairing-response", phoneFp, box });
    await expect(promise).resolves.toMatchObject({ computerFp: macFp });
    // finish() already closed the socket once; firing onclose again must not throw or reject.
    expect(() => sock.onclose?.({ code: 4003, reason: "declined" })).not.toThrow();
  });

  it("bounds the whole exchange with a timeout that always fires", async () => {
    vi.useFakeTimers();
    try {
      const { qr } = makeQr();
      const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
      const { Ctor, sockets } = socketFactory();
      const promise = runPairing({
        qr,
        identity,
        phoneFp,
        phoneName,
        platform,
        appVersion,
        WebSocketImpl: Ctor as never,
        timeoutMs: 1000,
      });
      const sock = sockets[0];
      if (!sock) throw new Error("no socket created");
      const assertion = expect(promise).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
      expect(sock.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// runPairing — against the shipped FakeRelay + the agent's real PairingManager
// ---------------------------------------------------------------------------

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

async function startAgentWithPairing(
  confirm: (phoneFp: string, name: string) => Promise<boolean>,
  overrides: Partial<PairingManagerOptions> = {},
) {
  const mac = generateIdentity();
  const macFp = fingerprint(mac.ed25519.pub);
  const relay = new FakeRelay(macFp);
  await relay.start();
  const log = createLogger({ stdout: false });
  const rc = new RelayClient({
    relayUrl: relay.url,
    fp: macFp,
    identity: mac,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
  });
  const saved: Array<{ phoneFp: string; kPair: string }> = [];
  const pm = new PairingManager({
    identity: mac,
    fp: macFp,
    computerName: "MBP",
    accent: "emerald",
    relayUrl: relay.url,
    sendCtrl: (m) => rc.sendCtrl(m),
    savePairing: (p) => saved.push(p as never),
    confirm,
    pairingCount: () => 0,
    log,
    ...overrides,
  });
  rc.on("ctrl", (m) => {
    if (m.type === "pairing-request") void pm.handleRequest(m);
  });
  rc.start();
  await waitFor(() => rc.online);
  return { relay, mac, macFp, rc, pm, saved };
}

async function stopAgent(h: { rc: RelayClient; relay: FakeRelay }) {
  h.rc.stop();
  await h.relay.stop();
}

describe("runPairing (against the shipped FakeRelay + agent PairingManager)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  afterEach(async () => {
    if (cleanup) await cleanup();
    cleanup = null;
  });

  it("pairs end-to-end: the phone derives the same K_pair the agent persisted", async () => {
    const h = await startAgentWithPairing(async () => true);
    cleanup = () => stopAgent(h);
    const { qrText } = h.pm.openWindow();
    const { qr } = parsePairingQr(qrText, { allowInsecure: true });
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    const result = await runPairing({
      qr,
      identity,
      phoneFp,
      phoneName,
      platform,
      appVersion,
      WebSocketImpl: WebSocket as never,
    });
    expect(result.computerFp).toBe(h.macFp);
    expect(result.computerName).toBe("MBP");
    expect(result.accent).toBe("emerald");
    expect(result.relayUrl).toBe(h.relay.url);
    expect(h.saved).toHaveLength(1);
    expect(h.saved[0]?.phoneFp).toBe(phoneFp);
    expect(fromBase64Url(h.saved[0]?.kPair ?? "")).toEqual(result.secret.kPair);
    expect(result.secret.computerEd25519Pub).toEqual(h.mac.ed25519.pub);
  });

  it("declined by the human on the computer -> PairingError('declined')", async () => {
    const h = await startAgentWithPairing(async () => false);
    cleanup = () => stopAgent(h);
    const { qrText } = h.pm.openWindow();
    const { qr } = parsePairingQr(qrText, { allowInsecure: true });
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    await expect(
      runPairing({
        qr,
        identity,
        phoneFp,
        phoneName,
        platform,
        appVersion,
        WebSocketImpl: WebSocket as never,
      }),
    ).rejects.toMatchObject({ code: "declined" });
  });

  it("a tampered code in the QR -> PairingError('bad-code'), mirroring the agent's own test", async () => {
    const h = await startAgentWithPairing(async () => true);
    cleanup = () => stopAgent(h);
    const { qrText } = h.pm.openWindow();
    const good = parseQr(qrText, { allowInsecure: true });
    const badQrText = JSON.stringify({ ...good, p: toBase64Url(new Uint8Array(16).fill(9)) });
    const { qr } = parsePairingQr(badQrText, { allowInsecure: true });
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    await expect(
      runPairing({
        qr,
        identity,
        phoneFp,
        phoneName,
        platform,
        appVersion,
        WebSocketImpl: WebSocket as never,
      }),
    ).rejects.toMatchObject({ code: "bad-code" });
  });

  it("no pairing window open on the computer -> PairingError('no-window')", async () => {
    const h = await startAgentWithPairing(async () => true);
    cleanup = () => stopAgent(h);
    // No openWindow(): the relay's pairing_window row was never populated.
    const qrText = encodeQr({
      v: 1,
      r: h.relay.url,
      c: h.macFp,
      e: toBase64Url(h.mac.ed25519.pub),
      n: "MBP",
      p: toBase64Url(randomBytes(16)),
      g: toBase64Url(randomBytes(16)),
    });
    const { qr } = parsePairingQr(qrText, { allowInsecure: true });
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    await expect(
      runPairing({
        qr,
        identity,
        phoneFp,
        phoneName,
        platform,
        appVersion,
        WebSocketImpl: WebSocket as never,
      }),
    ).rejects.toMatchObject({ code: "no-window" });
  });

  it("the computer already has MAX_PAIRINGS -> PairingError('too-many')", async () => {
    const h = await startAgentWithPairing(async () => true, { pairingCount: () => MAX_PAIRINGS });
    cleanup = () => stopAgent(h);
    const { qrText } = h.pm.openWindow();
    const { qr } = parsePairingQr(qrText, { allowInsecure: true });
    const { identity, phoneFp, phoneName, platform, appVersion } = basePhoneOpts();
    await expect(
      runPairing({
        qr,
        identity,
        phoneFp,
        phoneName,
        platform,
        appVersion,
        WebSocketImpl: WebSocket as never,
      }),
    ).rejects.toMatchObject({ code: "too-many" });
  });
});
