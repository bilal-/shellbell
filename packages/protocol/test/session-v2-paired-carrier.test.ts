import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor } from "../src/codec.js";
import {
  deriveConnKey,
  fingerprint,
  frameAd,
  generateIdentity,
  helloAd,
  open,
  randomBytes,
  seal,
} from "../src/crypto.js";
import type { Envelope } from "../src/envelope.js";
import { V2PairedCarrier } from "../src/session-v2-paired-carrier.js";
import { V2_FEATURE } from "../src/session-v2-signaling.js";

function peers(clock = { now: 0 }) {
  const phoneIdentity = generateIdentity();
  const computerIdentity = generateIdentity();
  const pairKey = randomBytes(32);
  const computerFp = fingerprint(computerIdentity.ed25519.pub);
  const phoneFp = fingerprint(phoneIdentity.ed25519.pub);
  const common = { computerFp, phoneFp, now: () => clock.now, timeoutMs: 15_000 };
  const phone = new V2PairedCarrier({
    ...common,
    role: "phone",
    keys: {
      staticPrivate: phoneIdentity.x25519.priv,
      remoteStatic: computerIdentity.x25519.pub,
      pairKey,
    },
    newId: () => new Uint8Array(16).fill(1),
  });
  const computer = new V2PairedCarrier({
    ...common,
    role: "computer",
    keys: {
      staticPrivate: computerIdentity.x25519.priv,
      remoteStatic: phoneIdentity.x25519.pub,
      pairKey,
    },
    newId: () => new Uint8Array(16).fill(2),
  });
  return { phone, computer, computerFp, phoneFp, pairKey, clock };
}

function exchange() {
  const p = peers();
  let frame: Envelope | null = p.phone.start();
  for (let i = 0; i < 9 && frame; i++) {
    frame = i % 2 === 0 ? p.computer.receive(frame) : p.phone.receive(frame);
  }
  expect(frame).toBeNull();
  expect(p.phone.ready).toBe(true);
  expect(p.computer.ready).toBe(true);
  return p;
}

describe("paired-v1 carrier restricted to v2 bootstrap", () => {
  it("exchanges mutually confirmed v2 sessions without exposing terminal messages", () => {
    const p = exchange();
    const phoneSession = p.phone.takeReadySession();
    const computerSession = p.computer.takeReadySession();
    const data = phoneSession.seal(encodeCbor({ type: "test" }));
    expect(decodeCbor(computerSession.open(data))).toEqual({ type: "test" });
    phoneSession.close();
    computerSession.close();
  });

  it("requires v2 intent in the phone hello, including for an upgraded pair", () => {
    const p = peers();
    const legacy: Envelope = {
      v: 1,
      t: "e2e",
      from: p.phoneFp,
      to: p.computerFp,
      seq: 0,
      body: seal(
        p.pairKey,
        encodeCbor({ type: "conn.hello", n: randomBytes(16) }),
        helloAd(p.phoneFp, p.computerFp),
      ),
    };
    expect(() => p.computer.receive(legacy)).toThrow();
    expect(p.computer.closed).toBe(true);
  });

  it("requires the computer hello to advertise v2 as well", () => {
    const p = peers();
    p.phone.start();
    const legacyReply: Envelope = {
      v: 1,
      t: "e2e",
      from: p.computerFp,
      to: p.phoneFp,
      seq: 0,
      body: seal(
        p.pairKey,
        encodeCbor({ type: "conn.hello", n: randomBytes(16) }),
        helloAd(p.computerFp, p.phoneFp),
      ),
    };
    expect(() => p.phone.receive(legacyReply)).toThrow();
    expect(p.phone.closed).toBe(true);
  });

  it("rejects a correctly encrypted legacy terminal command before v2 confirmation", () => {
    const p = peers();
    const hello = p.phone.start();
    const response = p.computer.receive(hello);
    expect(response).not.toBeNull();
    const phoneHello = decodeCbor(
      open(
        p.pairKey,
        hello.body as { n: Uint8Array; c: Uint8Array },
        helloAd(p.phoneFp, p.computerFp),
      ),
    ) as { n: Uint8Array };
    const computerHello = decodeCbor(
      open(
        p.pairKey,
        response?.body as { n: Uint8Array; c: Uint8Array },
        helloAd(p.computerFp, p.phoneFp),
      ),
    ) as { n: Uint8Array };
    const { kConn, connTag } = deriveConnKey(
      p.pairKey,
      phoneHello.n,
      computerHello.n,
      p.computerFp,
      p.phoneFp,
    );
    const terminal: Envelope = {
      v: 1,
      t: "e2e",
      from: p.phoneFp,
      to: p.computerFp,
      seq: 1,
      body: seal(
        kConn,
        encodeCbor({ type: "subscribe", sessionId: null }),
        frameAd(p.phoneFp, p.computerFp, connTag, 1),
      ),
    };
    expect(() => p.computer.receive(terminal)).toThrow();
    expect(p.computer.closed).toBe(true);
  });

  it("rejects wrong sender and replayed or gapped carrier frames", () => {
    const p = peers();
    const hello = p.phone.start();
    expect(() => p.computer.receive({ ...hello, from: p.computerFp })).toThrow();
    const q = peers();
    const qHello = q.phone.start();
    q.computer.receive(qHello);
    expect(() => q.computer.receive(qHello)).toThrow();
    const r = peers();
    const rHello = r.phone.start();
    const reply = r.computer.receive(rHello);
    const begin = r.phone.receive(reply as Envelope);
    expect(() => r.computer.receive({ ...(begin as Envelope), seq: 2 })).toThrow();
  });

  it("caps ciphertext before attempting to decode or authenticate it", () => {
    const p = peers();
    const hello = p.phone.start();
    const body = hello.body as { n: Uint8Array; c: Uint8Array };
    expect(() =>
      p.computer.receive({ ...hello, body: { ...body, c: new Uint8Array(2_049) } }),
    ).toThrow();
    expect(p.computer.closed).toBe(true);
  });

  it("closes on elapsed handshake deadline", () => {
    const p = peers();
    const hello = p.phone.start();
    const reply = p.computer.receive(hello);
    p.clock.now = 15_001;
    expect(() => p.phone.receive(reply as Envelope)).toThrow();
    expect(p.phone.closed).toBe(true);
  });

  it("puts v2 capability on the first hello", () => {
    const p = peers();
    const hello = p.phone.start();
    const decoded = decodeCbor(
      open(
        p.pairKey,
        hello.body as { n: Uint8Array; c: Uint8Array },
        helloAd(p.phoneFp, p.computerFp),
      ),
    ) as { features: string[] };
    expect(decoded.features).toContain(V2_FEATURE);
  });
});
