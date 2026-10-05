import { beforeEach, describe, expect, it, vi } from "vitest";
import { candidateForNative } from "../src/net/direct/candidate";
import { createDirectPeer } from "../src/net/direct/peer";

const native = vi.hoisted(() => {
  const channel = { close: vi.fn(), binaryType: "arraybuffer" };
  return {
    channel,
    peer: {
      createDataChannel: vi.fn(() => channel),
      setRemoteDescription: vi.fn(async () => {}),
      addIceCandidate: vi.fn(async (value: { sdpMLineIndex: unknown; sdpMid?: unknown }) => {
        // The iOS release converter invokes intValue on this JSON field.
        if (!Number.isInteger(value.sdpMLineIndex) || value.sdpMid === null)
          throw new Error("iOS cannot convert null ICE locators");
      }),
      close: vi.fn(),
    },
  };
});
vi.mock("react-native-webrtc", () => ({
  RTCPeerConnection: class {
    constructor() {
      Object.assign(this, native.peer);
    }
  },
  RTCSessionDescription: class {
    constructor(value: Record<string, unknown>) {
      Object.assign(this, value);
    }
  },
}));

const candidate = "candidate:1 1 UDP 2116026367 192.0.2.1 5000 typ host";
const answer = "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=mid:0\r\n";
const events = () => ({
  description: vi.fn(),
  candidate: vi.fn(),
  open: vi.fn(),
  message: vi.fn(),
  closed: vi.fn(),
});
beforeEach(() => vi.clearAllMocks());

describe("native ICE candidate locators", () => {
  it("passes a numeric locator to the iOS bridge for a MID-only Mac candidate", async () => {
    const peer = await createDirectPeer(events());
    await peer.acceptAnswer(answer);
    await expect(peer.candidate(candidate, "0", null)).resolves.toBeUndefined();
    expect(native.peer.addIceCandidate).toHaveBeenCalledWith({
      candidate,
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    peer.close();
  });

  it("derives the section index rather than assuming zero", () => {
    const sdp = `v=0\nm=audio 9 UDP/TLS/RTP/SAVPF 0\na=mid:audio\n${answer.slice(5)}`;
    expect(candidateForNative(candidate, "0", null, sdp).sdpMLineIndex).toBe(1);
  });

  it("derives a missing MID and omits it when the accepted section has none", () => {
    expect(candidateForNative(candidate, null, 0, answer)).toEqual({
      candidate,
      sdpMid: "0",
      sdpMLineIndex: 0,
    });
    const value = candidateForNative(
      candidate,
      null,
      0,
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\n",
    );
    expect(value).toEqual({ candidate, sdpMLineIndex: 0 });
    expect(Object.values(value)).not.toContain(null);
  });

  it.each([
    [null, null],
    ["unknown", null],
    ["wrong", 0],
    ["0", 1],
  ] as const)("rejects unavailable or inconsistent locators (%s, %s)", async (mid, index) => {
    const peer = await createDirectPeer(events());
    await peer.acceptAnswer(answer);
    await expect(peer.candidate(candidate, mid, index)).rejects.toThrow(/ICE media section/);
    expect(native.peer.addIceCandidate).not.toHaveBeenCalled();
    peer.close();
  });

  it("rejects candidates before an answer and rejects ambiguous media IDs", async () => {
    const peer = await createDirectPeer(events());
    await expect(peer.candidate(candidate, "0", null)).rejects.toThrow(/remote description/);
    expect(native.peer.addIceCandidate).not.toHaveBeenCalled();
    expect(() => candidateForNative(candidate, "0", null, answer + answer.slice(5))).toThrow(
      /mismatch/,
    );
    expect(() => candidateForNative(candidate, "0", null, `${answer}a=mid:duplicate\r\n`)).toThrow(
      /ambiguous/,
    );
    peer.close();
  });
});
