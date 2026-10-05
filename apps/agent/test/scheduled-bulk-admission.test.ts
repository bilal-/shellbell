import {
  derivePairKey,
  type Envelope,
  encodeCbor,
  encodeEnvelope,
  FRAME_LIMITS,
  fingerprint,
  generateIdentity,
  type InnerMessageOf,
  randomBytes,
  STREAM_LIMITS,
} from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type WebSocket from "ws";
import { createLogger } from "../src/log.js";
import { PhoneLink } from "../src/phone-link.js";
import { RelayClient } from "../src/relay-client.js";
import { WireScheduler } from "../src/wire-scheduler.js";
import { FakePhone } from "./fakes/fake-phone.js";
import { FakeRelay } from "./fakes/fake-relay.js";
import { waitFor } from "./fakes/wait.js";

const log = createLogger({ stdout: false });
const identity = generateIdentity();
const fp = fingerprint(identity.ed25519.pub);
let relay: FakeRelay;
let clients: RelayClient[];

function frame(ciphertextBytes = 8): Envelope {
  return {
    v: 1,
    t: "e2e",
    from: fp,
    to: fp,
    seq: 1,
    body: { n: new Uint8Array(24), c: new Uint8Array(ciphertextBytes) },
  };
}

function frameOfEncodedSize(target: number): Envelope {
  let ciphertextBytes = target - encodeEnvelope(frame(0)).byteLength;
  for (let attempt = 0; attempt < 4; attempt++) {
    ciphertextBytes += target - encodeEnvelope(frame(ciphertextBytes)).byteLength;
  }
  const value = frame(ciphertextBytes);
  expect(encodeEnvelope(value).byteLength).toBe(target);
  return value;
}

function client(): RelayClient {
  const value = new RelayClient({
    relayUrl: relay.url,
    fp,
    identity,
    name: "MBP",
    appVersion: "t",
    log,
    backoffMinMs: 50,
    backoffMaxMs: 100,
  });
  clients.push(value);
  return value;
}

async function connectedClient(): Promise<RelayClient> {
  const value = client();
  value.start();
  await waitFor(() => value.online);
  return value;
}

function interceptSocket(value: RelayClient, onSend?: (bytes: Uint8Array) => void) {
  const socket = (value as unknown as { ws: WebSocket }).ws;
  const originalAmount = Object.getOwnPropertyDescriptor(socket, "bufferedAmount");
  const sent: Uint8Array[] = [];
  const spy = vi.spyOn(socket, "send").mockImplementation((bytes) => {
    const copy = new Uint8Array(bytes as Uint8Array);
    sent.push(copy);
    onSend?.(copy);
  });
  return {
    socket,
    sent,
    setBuffered(amount: unknown) {
      Object.defineProperty(socket, "bufferedAmount", { configurable: true, value: amount });
    },
    restore() {
      spy.mockRestore();
      if (originalAmount) Object.defineProperty(socket, "bufferedAmount", originalAmount);
      else Reflect.deleteProperty(socket, "bufferedAmount");
    },
  };
}

beforeEach(async () => {
  relay = new FakeRelay(fp);
  await relay.start();
  clients = [];
});

afterEach(async () => {
  for (const value of clients) value.stop();
  await relay.stop();
});

describe("scheduled bulk admission", () => {
  it("sends encoded bytes once at idle and refuses both modes while any bytes remain buffered", async () => {
    const value = await connectedClient();
    const wire = interceptSocket(value);
    try {
      const env = frame();
      const bytes = encodeEnvelope(env);
      wire.setBuffered(0);
      expect(value.sendScheduledBulkEnvelope(env, "bounded")).toBe(true);
      expect(wire.sent).toEqual([bytes]);
      wire.setBuffered(1);
      expect(value.sendScheduledBulkEnvelope(env, "legacy")).toBe(false);
      expect(value.sendScheduledBulkEnvelope(env, "bounded")).toBe(false);
      expect(wire.sent).toEqual([bytes]);
      expect(value.sendBoundedEnvelope(env)).toBe(true);
      expect(wire.sent).toEqual([bytes, bytes]);
    } finally {
      wire.restore();
    }
  });

  it("applies both distinct caps to actual encoded envelopes", async () => {
    const value = await connectedClient();
    const wire = interceptSocket(value);
    try {
      wire.setBuffered(0);
      const boundedExact = frameOfEncodedSize(STREAM_LIMITS.envelopeBytes);
      const boundedOver = frameOfEncodedSize(STREAM_LIMITS.envelopeBytes + 1);
      const legacyExact = frameOfEncodedSize(FRAME_LIMITS.e2eFromAgent);
      const legacyOver = frameOfEncodedSize(FRAME_LIMITS.e2eFromAgent + 1);
      expect(value.sendScheduledBulkEnvelope(boundedExact, "bounded")).toBe(true);
      expect(value.sendScheduledBulkEnvelope(boundedOver, "bounded")).toBe(false);
      expect(value.sendScheduledBulkEnvelope(legacyExact, "legacy")).toBe(true);
      expect(value.sendScheduledBulkEnvelope(legacyOver, "legacy")).toBe(false);
      expect(wire.sent).toEqual([encodeEnvelope(boundedExact), encodeEnvelope(legacyExact)]);
    } finally {
      wire.restore();
    }
  });

  it("requires authenticated OPEN e2e traffic and a finite numeric empty buffer", async () => {
    const value = client();
    const env = frame();
    expect(value.sendScheduledBulkEnvelope(env, "legacy")).toBe(false);
    value.start();
    await waitFor(() => value.online);
    const wire = interceptSocket(value);
    try {
      const internals = value as unknown as { authed: boolean };
      internals.authed = false;
      expect(value.sendScheduledBulkEnvelope(env, "legacy")).toBe(false);
      internals.authed = true;
      for (const amount of [1, -1, Number.NaN, Infinity, "0", undefined, null]) {
        wire.setBuffered(amount);
        expect(value.sendScheduledBulkEnvelope(env, "legacy")).toBe(false);
        expect(value.sendScheduledBulkEnvelope(env, "bounded")).toBe(false);
      }
      wire.setBuffered(0);
      const ctrl: Envelope = {
        v: 1,
        t: "ctrl",
        from: fp,
        seq: 0,
        body: { type: "ping", at: 1 },
      };
      expect(value.sendScheduledBulkEnvelope(ctrl, "legacy")).toBe(false);
      expect(value.sendScheduledBulkEnvelope(env, "other" as "legacy")).toBe(false);
      expect(wire.sent).toEqual([]);
      value.stop();
      expect(value.sendScheduledBulkEnvelope(env, "legacy")).toBe(false);
    } finally {
      wire.restore();
    }
  });

  it("propagates socket send failure and leaves ordinary control eligibility alone", async () => {
    const value = await connectedClient();
    const wire = interceptSocket(value);
    try {
      wire.setBuffered(1);
      expect(value.sendScheduledBulkEnvelope(frame(), "bounded")).toBe(false);
      expect(value.sendEnvelope(frame())).toBe(true);
      expect(wire.sent).toHaveLength(1);
      wire.setBuffered(0);
      vi.spyOn(wire.socket, "send").mockImplementationOnce(() => {
        throw new Error("socket failed");
      });
      expect(() => value.sendScheduledBulkEnvelope(frame(), "legacy")).toThrow("socket failed");
      expect(wire.sent).toHaveLength(1);
    } finally {
      wire.restore();
    }
  });
});

type LegacyMessage = InnerMessageOf<"screen.snapshot" | "screen.diff" | "history">;

function legacyMessage(): LegacyMessage {
  return {
    type: "history",
    sessionId: "tmux:s1",
    before: 1,
    oldestAvailable: 0,
    lines: [{ r: [{ t: "hello" }] }],
  };
}

function phoneLink(callback?: (env: Envelope) => boolean) {
  const mac = generateIdentity();
  const phoneId = generateIdentity();
  const computerFp = fingerprint(mac.ed25519.pub);
  const phoneFp = fingerprint(phoneId.ed25519.pub);
  const code = randomBytes(16);
  const phone = new FakePhone(
    phoneId,
    computerFp,
    derivePairKey(phoneId.x25519.priv, mac.x25519.pub, code, computerFp, phoneFp),
  );
  const ordinary: Envelope[] = [];
  const link = new PhoneLink({
    phoneFp,
    connId: "c1",
    name: "phone",
    kPair: derivePairKey(mac.x25519.priv, phoneId.x25519.pub, code, computerFp, phoneFp),
    computerFp,
    send: (env) => {
      ordinary.push(env);
      return true;
    },
    ...(callback && { sendLegacyBulk: callback }),
    log,
  });
  const handshake = () => {
    link.handleEnvelope(phone.hello());
    phone.acceptHello(ordinary[0]!);
  };
  return { link, phone, ordinary, handshake };
}

describe("PhoneLink scheduled legacy bulk", () => {
  it("delivers a sealed history envelope under the handshake key and shares ordinary sequence", () => {
    const bulk: Envelope[] = [];
    const { link, phone, ordinary, handshake } = phoneLink((env) => {
      bulk.push(env);
      return true;
    });
    handshake();
    expect(link.sendLegacyBulk(legacyMessage())).toBe(true);
    expect(bulk).toHaveLength(1);
    expect(bulk[0]?.seq).toBe(1);
    expect(phone.open(bulk[0]!)).toEqual(legacyMessage());
    expect(link.sendBounded({ type: "sessions", list: [] })).toBe(false);
    expect(link.send({ type: "sessions", list: [] })).toBe(true);
    expect(ordinary[1]?.seq).toBe(2);
    expect(phone.open(ordinary[1]!)).toEqual({ type: "sessions", list: [] });
  });

  it("requires an explicit callback, usable handshake, and a legacy bulk message kind", () => {
    const missing = phoneLink();
    expect(missing.link.sendLegacyBulk(legacyMessage())).toBe(false);
    missing.handshake();
    expect(missing.link.sendLegacyBulk(legacyMessage())).toBe(false);
    expect(missing.ordinary).toHaveLength(1);

    const bulk: Envelope[] = [];
    const available = phoneLink((env) => {
      bulk.push(env);
      return true;
    });
    expect(available.link.sendLegacyBulk(legacyMessage())).toBe(false);
    available.handshake();
    expect(
      available.link.sendLegacyBulk({ type: "sessions", list: [] } as unknown as LegacyMessage),
    ).toBe(false);
    available.link.broken = true;
    expect(available.link.sendLegacyBulk(legacyMessage())).toBe(false);
    expect(bulk).toEqual([]);
    expect(available.ordinary).toHaveLength(1);
  });

  it("enforces exact encrypted legacy envelope bytes and retires an oversized sequence", () => {
    const calibration: Envelope[] = [];
    const sizing = phoneLink((env) => {
      calibration.push(env);
      return false;
    });
    sizing.handshake();
    const snapshot = (lastText: string): LegacyMessage => ({
      type: "screen.snapshot",
      sessionId: "tmux:s1",
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 0,
      gen: 1,
      cols: 4096,
      rows: 256,
      lines: [
        ...Array.from({ length: 255 }, () => ({ r: [{ t: "x".repeat(4096) }] })),
        { r: [{ t: lastText }] },
      ],
    });
    const baseline = snapshot("");
    expect(sizing.link.sendLegacyBulk(baseline)).toBe(false);
    const overhead = encodeEnvelope(calibration[0]!).byteLength - encodeCbor(baseline).byteLength;
    let low = 0;
    let high = 4096;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (
        encodeCbor(snapshot("y".repeat(middle))).byteLength + overhead <
        FRAME_LIMITS.e2eFromAgent
      )
        low = middle + 1;
      else high = middle;
    }
    expect(encodeCbor(snapshot("y".repeat(low))).byteLength + overhead).toBe(
      FRAME_LIMITS.e2eFromAgent,
    );
    const exact = snapshot("y".repeat(low));
    const over = snapshot("y".repeat(low + 1));
    const admitted: Envelope[] = [];
    const { link, phone, ordinary, handshake } = phoneLink((env) => {
      admitted.push(env);
      return true;
    });
    handshake();
    expect(link.sendLegacyBulk(exact)).toBe(true);
    expect(encodeEnvelope(admitted[0]!).byteLength).toBe(FRAME_LIMITS.e2eFromAgent);
    expect(phone.open(admitted[0]!)).toEqual(exact);
    expect(link.sendLegacyBulk(over)).toBe(false);
    expect(admitted).toHaveLength(1);
    expect(link.send({ type: "sessions", list: [] })).toBe(true);
    expect(ordinary[1]?.seq).toBe(3);
    expect(phone.open(ordinary[1]!)).toEqual({ type: "sessions", list: [] });
  });

  it("uses strict callback outcomes and keeps refused or throwing attempts out of ordinary send", async () => {
    const callbackWire: Envelope[] = [];
    let outcome: unknown = false;
    let thrown = false;
    const { link, phone, ordinary, handshake } = phoneLink((env) => {
      callbackWire.push(env);
      if (thrown) throw new Error("transport failed");
      return outcome as boolean;
    });
    handshake();
    expect(link.sendLegacyBulk(legacyMessage())).toBe(false);
    thrown = true;
    expect(() => link.sendLegacyBulk(legacyMessage())).toThrow("transport failed");
    thrown = false;
    outcome = undefined;
    expect(() => link.sendLegacyBulk(legacyMessage())).toThrow(TypeError);
    outcome = Promise.reject(new Error("late rejection"));
    expect(() => link.sendLegacyBulk(legacyMessage())).toThrow(TypeError);
    let hostileRead = 0;
    outcome = {
      // biome-ignore lint/suspicious/noThenProperty: Deliberately test a hostile thenable result.
      get then() {
        hostileRead++;
        throw new Error("hostile thenable");
      },
    };
    expect(() => link.sendLegacyBulk(legacyMessage())).toThrow(TypeError);
    await waitFor(() => hostileRead > 0);
    expect(ordinary).toHaveLength(1);
    expect(callbackWire.map((env) => env.seq)).toEqual([1, 2, 3, 4, 5]);
    outcome = true;
    expect(link.sendLegacyBulk(legacyMessage())).toBe(true);
    expect(phone.open(callbackWire[5]!)).toEqual(legacyMessage());
    expect(link.send({ type: "sessions", list: [] })).toBe(true);
    expect(ordinary[1]?.seq).toBe(7);
    expect(phone.open(ordinary[1]!)).toEqual({ type: "sessions", list: [] });
  });
});

describe("WireScheduler over one shared simulated socket buffer", () => {
  it("repeatedly advances both ready bulk producers only from idle, while ordinary control still sends", async () => {
    const value = await connectedClient();
    let buffered = 0;
    const admissions: { bytes: number; prior: number }[] = [];
    const wire = interceptSocket(value, (bytes) => {
      admissions.push({ bytes: bytes.byteLength, prior: buffered });
      buffered += bytes.byteLength;
      wire.setBuffered(buffered);
    });
    try {
      const legacy = frameOfEncodedSize(64 * 1024);
      const bounded = frameOfEncodedSize(32 * 1024);
      let now = 0;
      let legacyAttempts = 0;
      let boundedAttempts = 0;
      const scheduler = new WireScheduler({ now: () => now, maxFramesPerSecond: 8 });
      scheduler.register("legacy", () => {
        legacyAttempts++;
        return value.sendScheduledBulkEnvelope(legacy, "legacy");
      });
      scheduler.register("bounded", () => {
        boundedAttempts++;
        return value.sendScheduledBulkEnvelope(bounded, "bounded");
      });
      for (let tick = 0; tick < 48; tick++) {
        now += 125;
        buffered = Math.max(0, buffered - 16 * 1024);
        wire.setBuffered(buffered);
        scheduler.pump();
        if (tick === 0) {
          expect(buffered).toBeGreaterThan(0);
          expect(value.sendCtrl({ type: "lease", ttlMs: 1000 })).toBe(true);
        }
      }
      const bulk = admissions.filter(({ bytes }) => bytes === 64 * 1024 || bytes === 32 * 1024);
      expect(bulk.filter(({ bytes }) => bytes === 64 * 1024).length).toBeGreaterThanOrEqual(2);
      expect(bulk.filter(({ bytes }) => bytes === 32 * 1024).length).toBeGreaterThanOrEqual(2);
      expect(bulk.every(({ prior }) => prior === 0)).toBe(true);
      expect(admissions.some(({ bytes, prior }) => bytes < 1024 && prior > 0)).toBe(true);
      expect(legacyAttempts).toBeGreaterThan(
        bulk.filter(({ bytes }) => bytes === 64 * 1024).length,
      );
      expect(boundedAttempts).toBeGreaterThan(
        bulk.filter(({ bytes }) => bytes === 32 * 1024).length,
      );
    } finally {
      wire.restore();
    }
  });

  it("refunds literal refusal and retains thrown-send charge without stopping a healthy producer", async () => {
    const value = await connectedClient();
    const wire = interceptSocket(value);
    try {
      let now = 0;
      const errors: unknown[] = [];
      const scheduler = new WireScheduler({
        now: () => now,
        maxFramesPerSecond: 8,
        onError: (error) => errors.push(error),
      });
      const env = frame();
      let refused = 0;
      let healthy = 0;
      scheduler.register("refused", () => {
        refused++;
        return false;
      });
      scheduler.register("healthy", () => {
        healthy++;
        return value.sendScheduledBulkEnvelope(env, "bounded");
      });
      wire.setBuffered(0);
      now += 125;
      expect(scheduler.pump()).toBe(1);
      expect({ refused, healthy }).toEqual({ refused: 1, healthy: 1 });
      scheduler.clear();

      const broken = new WireScheduler({
        now: () => now,
        maxFramesPerSecond: 8,
        onError: (error) => errors.push(error),
      });
      broken.register("throws", () => value.sendScheduledBulkEnvelope(env, "legacy"));
      broken.register("healthy", () => value.sendScheduledBulkEnvelope(env, "bounded"));
      vi.spyOn(wire.socket, "send").mockImplementationOnce(() => {
        throw new Error("socket failed");
      });
      now += 125;
      expect(broken.pump()).toBe(0);
      expect(errors).toHaveLength(1);
      expect(wire.sent).toHaveLength(1);
      now += 125;
      expect(broken.pump()).toBe(1);
      expect(wire.sent).toHaveLength(2);
    } finally {
      wire.restore();
    }
  });
});
