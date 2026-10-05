import { describe, expect, it, vi } from "vitest";
import { decodeCbor, encodeCbor } from "../src/codec.js";
import { fingerprint, generateIdentity, randomBytes } from "../src/crypto.js";
import { V2RelayBootstrap } from "../src/session-v2-bootstrap.js";

function peers(clock = { now: 0 }) {
  const phoneIdentity = generateIdentity();
  const computerIdentity = generateIdentity();
  const pairKey = randomBytes(32);
  const computerFp = fingerprint(computerIdentity.ed25519.pub);
  const phoneFp = fingerprint(phoneIdentity.ed25519.pub);
  const phone = new V2RelayBootstrap({
    role: "phone",
    computerFp,
    phoneFp,
    keys: {
      staticPrivate: phoneIdentity.x25519.priv,
      remoteStatic: computerIdentity.x25519.pub,
      pairKey,
    },
    newId: () => new Uint8Array(16).fill(1),
    now: () => clock.now,
  });
  const computer = new V2RelayBootstrap({
    role: "computer",
    computerFp,
    phoneFp,
    keys: {
      staticPrivate: computerIdentity.x25519.priv,
      remoteStatic: phoneIdentity.x25519.pub,
      pairKey,
    },
    newId: () => new Uint8Array(16).fill(2),
    now: () => clock.now,
  });
  return { phone, computer, clock };
}

function exchange() {
  const { phone, computer } = peers();
  const begin = phone.begin();
  const accept = computer.receive(begin);
  if (!accept) throw new Error("accept missing");
  const noise1 = phone.receive(accept);
  if (!noise1) throw new Error("noise1 missing");
  const noise2 = computer.receive(noise1);
  if (!noise2) throw new Error("noise2 missing");
  const confirm1 = phone.receive(noise2);
  if (!confirm1) throw new Error("phone confirmation missing");
  const confirm2 = computer.receive(confirm1);
  if (!confirm2) throw new Error("computer confirmation missing");
  return { phone, computer, begin, accept, noise1, noise2, confirm1, confirm2 };
}

describe("v2 relay bootstrap coordinator", () => {
  it("requires ordered Noise and bidirectional key confirmation before exposing a session", () => {
    const { phone, computer, confirm2 } = exchange();
    expect(computer.ready).toBe(true);
    expect(phone.ready).toBe(false);
    expect(() => phone.takeReadySession()).toThrow();
    expect(phone.receive(confirm2)).toBeNull();
    expect(phone.ready).toBe(true);
    const sender = phone.takeReadySession();
    const receiver = computer.takeReadySession();
    const frame = sender.seal(new Uint8Array([1, 2, 3]));
    expect(receiver.open(frame)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects replayed or mismatched transcript IDs without accepting data", () => {
    const { phone, computer } = peers();
    const accept = computer.receive(phone.begin());
    if (!accept) throw new Error("accept missing");
    const changed = decodeCbor(accept) as Record<string, unknown>;
    changed.sessionId = new Uint8Array(16).fill(9);
    expect(() => phone.receive(encodeCbor(changed))).toThrow();
    expect(phone.ready).toBe(false);
    expect(() => phone.receive(accept)).toThrow();
  });

  it("closes the attempt after a tampered Noise message instead of retrying it", () => {
    const { phone, computer } = peers();
    const accept = computer.receive(phone.begin());
    if (!accept) throw new Error("accept missing");
    const noise1 = phone.receive(accept);
    if (!noise1) throw new Error("noise1 missing");
    const changed = decodeCbor(noise1) as Record<string, unknown>;
    const message = new Uint8Array(changed.message as Uint8Array);
    message[47] = (message[47] ?? 0) ^ 1;
    changed.message = message;
    expect(() => computer.receive(encodeCbor(changed))).toThrow();
    expect(computer.ready).toBe(false);
    expect(() => computer.receive(noise1)).toThrow();
  });

  it("fails closed when confirmation is tampered or the attempt expires", () => {
    const { phone, confirm2 } = exchange();
    const changed = decodeCbor(confirm2) as Record<string, unknown>;
    changed.frame = new Uint8Array([1, 2, 3]);
    expect(() => phone.receive(encodeCbor(changed))).toThrow();
    expect(phone.ready).toBe(false);

    const later = peers({ now: 0 });
    const accept = later.computer.receive(later.phone.begin());
    if (!accept) throw new Error("accept missing");
    later.clock.now = 15_001;
    expect(() => later.phone.receive(accept)).toThrow(/expired/i);
  });

  it("erases an idle attempt when its deadline passes without another message", async () => {
    vi.useFakeTimers();
    try {
      const { phone, computer } = peers();
      const accept = computer.receive(phone.begin());
      if (!accept) throw new Error("accept missing");
      await vi.advanceTimersByTimeAsync(15_001);
      expect(phone.ready).toBe(false);
      expect(() => phone.receive(accept)).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });
});
