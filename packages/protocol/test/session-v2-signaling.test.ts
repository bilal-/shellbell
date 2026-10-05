import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor } from "../src/codec.js";
import {
  DirectSignalSchema,
  decodeDirectSignal,
  decodeV2Bootstrap,
  encodeDirectSignal,
  encodeV2Bootstrap,
  V2BootstrapSchema,
} from "../src/session-v2-signaling.js";

const sessionId = new Uint8Array(16).fill(1);
const offerId = new Uint8Array(16).fill(2);
const attemptId = new Uint8Array(16).fill(3);
const generation = Uint8Array.of(2, 0, 0, 0, 0, 0, 0, 0);
const firstGeneration = Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0);
const pending = { offerId, generation };
const admission = { sender: "phone" as const, sessionId, committedGeneration: firstGeneration };
function sdpFor(byte: number): string {
  const fingerprint = Array.from({ length: 32 }, () => byte.toString(16).padStart(2, "0"))
    .join(":")
    .toUpperCase();
  return [
    "v=0",
    "o=rtc 1 0 IN IP4 127.0.0.1",
    "s=-",
    "t=0 0",
    `a=fingerprint:sha-256 ${fingerprint}`,
    "m=application 9 UDP/DTLS/SCTP webrtc-datachannel",
    "c=IN IP4 0.0.0.0",
    "a=mid:0",
    "a=ice-ufrag:abcd",
    "a=ice-pwd:abcdefghijklmnopqrstuv",
    "a=sctp-port:5000",
    "",
  ].join("\r\n");
}

describe("v2 encrypted signaling contract", () => {
  it("bounds and round-trips direct offer and answer inside the encrypted session", () => {
    const offer = {
      type: "direct.offer" as const,
      sessionId,
      offerId,
      generation,
      sdp: sdpFor(4),
      phoneDtls: new Uint8Array(32).fill(4),
    };
    const answer = {
      type: "direct.answer" as const,
      sessionId,
      offerId,
      attemptId,
      generation,
      sdp: sdpFor(5),
      computerDtls: new Uint8Array(32).fill(5),
    };
    expect(decodeDirectSignal(encodeDirectSignal(offer), admission)).toEqual(offer);
    expect(
      decodeDirectSignal(encodeDirectSignal(answer), {
        ...admission,
        sender: "computer",
        pending,
      }),
    ).toEqual(answer);
    expect(encodeDirectSignal(offer).length).toBeLessThan(30_000);
    expect(() => encodeDirectSignal({ ...offer, sdp: "x".repeat(24_001) })).toThrow();
    expect(() => encodeDirectSignal({ ...offer, sdp: "v=0\n\0bad" })).toThrow();
    expect(() =>
      encodeDirectSignal({ ...offer, generation: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0) }),
    ).toThrow();
    expect(() =>
      encodeDirectSignal({
        ...offer,
        sdp: `${sdpFor(4)}a=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n`,
      }),
    ).toThrow();
    expect(() =>
      encodeDirectSignal({ ...offer, sdp: `${sdpFor(4)}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` }),
    ).toThrow();
    expect(() => encodeDirectSignal({ ...offer, sdp: sdpFor(5) })).toThrow();
    expect(() =>
      encodeDirectSignal({
        ...offer,
        sdp: `${sdpFor(4)} a=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n`,
      }),
    ).toThrow();
    expect(() =>
      encodeDirectSignal({ ...offer, sdp: `${sdpFor(4)}a=end-of-candidates\r\n` }),
    ).toThrow();
    expect(() =>
      encodeDirectSignal({ ...offer, sdp: `${sdpFor(4)}M=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` }),
    ).toThrow();
    expect(() =>
      encodeDirectSignal({
        ...offer,
        sdp: `${sdpFor(4)}A=candidate:1 1 udp 1 192.0.2.1 9 typ host\r\n`,
      }),
    ).toThrow();
    expect(() =>
      encodeDirectSignal({
        ...offer,
        sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
      }),
    ).toThrow();
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(offer), { ...admission, sender: "computer" }),
    ).toThrow();
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(offer), null as unknown as typeof admission),
    ).toThrow(/malformed/);
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(offer), {
        ...admission,
        committedGeneration: generation,
      }),
    ).toThrow();
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(offer), {
        ...admission,
        sessionId: new Uint8Array(16).fill(9),
      }),
    ).toThrow();
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(answer), {
        ...admission,
        sender: "computer",
        pending: { ...pending, offerId: new Uint8Array(16).fill(9) },
      }),
    ).toThrow();
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(answer), {
        ...admission,
        sender: "computer",
        committedGeneration: generation,
        pending,
      }),
    ).toThrow();
    expect(() =>
      decodeDirectSignal(encodeDirectSignal(answer), { ...admission, pending }),
    ).toThrow();
  });

  it("bounds ICE candidates independently of cumulative attempt resource caps", () => {
    const candidate = {
      type: "direct.candidate" as const,
      sessionId,
      offerId,
      generation,
      index: 0,
      candidate: "candidate:1 1 udp 1234 192.0.2.1 12345 typ host",
      mid: "0",
      mlineIndex: 0,
    };
    expect(decodeDirectSignal(encodeDirectSignal(candidate), { ...admission, pending })).toEqual(
      candidate,
    );
    expect(() => decodeDirectSignal(encodeDirectSignal(candidate), admission)).toThrow();
    expect(() => encodeDirectSignal({ ...candidate, candidate: "x".repeat(1025) })).toThrow();
    expect(() => encodeDirectSignal({ ...candidate, candidate: "not-an-ice-candidate" })).toThrow();
    expect(() => encodeDirectSignal({ ...candidate, index: 32 })).toThrow();
    expect(() => encodeDirectSignal({ ...candidate, mlineIndex: 1 })).toThrow();
    expect(() => encodeDirectSignal({ ...candidate, mid: null, mlineIndex: null })).toThrow();
    expect(() => encodeDirectSignal({ ...candidate, mid: "bad\nmid" })).toThrow();
    expect(() =>
      encodeDirectSignal({ ...candidate, unexpected: true } as typeof candidate),
    ).toThrow();
    const end = {
      type: "direct.end" as const,
      sessionId,
      offerId,
      generation,
      count: 1,
    };
    expect(decodeDirectSignal(encodeDirectSignal(end), { ...admission, pending })).toEqual(end);
    expect(() => decodeDirectSignal(encodeDirectSignal(end), admission)).toThrow();
    expect(DirectSignalSchema.safeParse({ ...end, count: 33 }).success).toBe(false);
  });

  it("rejects oversized and malformed direct messages before use", () => {
    expect(() => decodeDirectSignal(new Uint8Array(30_001), admission)).toThrow(/large/i);
    expect(() =>
      decodeDirectSignal(encodeCbor({ type: "direct.offer", sdp: sdpFor(4) }), admission),
    ).toThrow();
    const raw = encodeDirectSignal({
      type: "direct.abort",
      sessionId,
      offerId,
      generation,
      reason: "timeout",
    });
    expect((decodeCbor(raw) as { type: string }).type).toBe("direct.abort");
  });

  it("keeps the legacy encrypted bootstrap bounded and version-intent explicit", () => {
    const begin = {
      type: "session.v2.begin" as const,
      sessionId,
      generation: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0),
    };
    const accept = { ...begin, type: "session.v2.accept" as const, attemptId };
    expect(V2BootstrapSchema.parse(begin)).toEqual(begin);
    expect(V2BootstrapSchema.parse(accept)).toEqual(accept);
    expect(
      decodeV2Bootstrap(encodeV2Bootstrap(begin), {
        sender: "phone",
        expectedType: "session.v2.begin",
      }),
    ).toEqual(begin);
    expect(
      decodeV2Bootstrap(encodeV2Bootstrap(accept), {
        sender: "computer",
        expectedType: "session.v2.accept",
        sessionId,
      }),
    ).toEqual(accept);
    expect(() =>
      decodeV2Bootstrap(encodeV2Bootstrap(begin), {
        sender: "computer",
        expectedType: "session.v2.begin",
      }),
    ).toThrow();
    expect(() =>
      decodeV2Bootstrap(encodeV2Bootstrap(accept), {
        sender: "computer",
        expectedType: "session.v2.accept",
        sessionId: new Uint8Array(16).fill(9),
      }),
    ).toThrow();
    expect(() =>
      decodeV2Bootstrap(new Uint8Array(1_025), {
        sender: "phone",
        expectedType: "session.v2.begin",
      }),
    ).toThrow(/large/i);
    expect(() =>
      decodeV2Bootstrap(encodeCbor({ ...begin, type: "session.v2.fake" }), {
        sender: "phone",
        expectedType: "session.v2.begin",
      }),
    ).toThrow();
    expect(V2BootstrapSchema.safeParse({ ...begin, generation }).success).toBe(false);
    expect(
      V2BootstrapSchema.safeParse({
        type: "session.v2.noise1",
        sessionId,
        attemptId,
        message: new Uint8Array(48),
      }).success,
    ).toBe(true);
    const noise1 = {
      type: "session.v2.noise1" as const,
      sessionId,
      attemptId,
      message: new Uint8Array(48),
    };
    expect(
      decodeV2Bootstrap(encodeV2Bootstrap(noise1), {
        sender: "phone",
        expectedType: "session.v2.noise1",
        sessionId,
        attemptId,
      }),
    ).toEqual(noise1);
    expect(() =>
      decodeV2Bootstrap(encodeV2Bootstrap(noise1), {
        sender: "computer",
        expectedType: "session.v2.noise1",
        sessionId,
        attemptId,
      }),
    ).toThrow();
    expect(() =>
      decodeV2Bootstrap(encodeV2Bootstrap(noise1), {
        sender: "phone",
        expectedType: "session.v2.noise1",
        sessionId,
        attemptId: new Uint8Array(16).fill(9),
      }),
    ).toThrow();
    expect(
      V2BootstrapSchema.safeParse({
        type: "session.v2.confirm",
        sessionId,
        attemptId,
        frame: new Uint8Array(513),
      }).success,
    ).toBe(false);
  });
});
