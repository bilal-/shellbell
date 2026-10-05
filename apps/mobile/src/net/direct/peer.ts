import { DIRECT_STUN_URL, hexToBytes, type NativeDirectFactory } from "@shellbell/protocol";
import { candidateForNative } from "./candidate";
import { verifyRemoteDtlsFingerprint } from "./fingerprint";

/** Native binary, reliable and ordered channel; no media capture permissions. */
export const createDirectPeer: NativeDirectFactory = async (events) => {
  const { RTCPeerConnection, RTCSessionDescription } = await import("react-native-webrtc");
  const peer = new RTCPeerConnection({ iceServers: [{ urls: DIRECT_STUN_URL }] });
  const channel = peer.createDataChannel("shellbell-v2", { ordered: true });
  channel.binaryType = "arraybuffer";
  let closed = false;
  let remoteSdp: string | undefined;
  const fail = () => {
    if (!closed) events.closed();
  };
  peer.onicecandidate = (event: {
    candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null } | null;
  }) => {
    const c = event.candidate;
    if (!closed && c?.candidate)
      events.candidate(c.candidate, c.sdpMid ?? null, c.sdpMLineIndex ?? null);
  };
  peer.onconnectionstatechange = () => {
    if (
      peer.connectionState === "failed" ||
      peer.connectionState === "closed" ||
      peer.connectionState === "disconnected"
    )
      fail();
  };
  channel.onopen = () => {
    if (!closed) events.open();
  };
  channel.onclose = fail;
  channel.onerror = fail;
  channel.onmessage = (event: { data: unknown }) => {
    if (closed) return;
    const data: unknown = event.data;
    if (!(data instanceof ArrayBuffer) && !(data instanceof Uint8Array)) {
      fail();
      return;
    }
    const bytes = new Uint8Array(data);
    if (bytes.length > 61_000) {
      fail();
      return;
    }
    events.message(bytes);
  };
  return {
    async offer() {
      const description = await peer.createOffer();
      await peer.setLocalDescription(description);
      if (!closed && description.sdp) events.description(description.sdp, "offer");
    },
    async answer() {
      throw new Error("phone is WebRTC initiator");
    },
    async acceptAnswer(sdp) {
      await peer.setRemoteDescription(new RTCSessionDescription({ type: "answer", sdp }));
      remoteSdp = sdp;
    },
    async candidate(candidate, mid, mlineIndex) {
      if (remoteSdp === undefined) throw new Error("ICE remote description unavailable");
      await peer.addIceCandidate(candidateForNative(candidate, mid, mlineIndex, remoteSdp));
    },
    async remoteCertificate(expected) {
      if (closed || channel.readyState !== "open") throw new Error("DTLS not connected");
      const value = [...expected].map((byte) => byte.toString(16).padStart(2, "0")).join(":");
      const actual = verifyRemoteDtlsFingerprint(await peer.getStats(), {
        algorithm: "sha-256",
        value,
      });
      return hexToBytes(actual.replaceAll(":", ""));
    },
    send(bytes) {
      if (
        closed ||
        channel.readyState !== "open" ||
        bytes.length > 61_000 ||
        channel.bufferedAmount + bytes.length > 262_144
      )
        return false;
      try {
        channel.send(bytes);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      channel.close();
      peer.close();
    },
  };
};
