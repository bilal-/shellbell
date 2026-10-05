import {
  bytesEqual,
  DIRECT_STUN_URL,
  hexToBytes,
  type NativeDirectFactory,
} from "@shellbell/protocol";

/** Native data channel. Loaded only for an authenticated paired-v2 endpoint. */
export const createDirectPeer: NativeDirectFactory = async (events) => {
  const { default: rtc } = await import("node-datachannel");
  const peer = new rtc.PeerConnection("shellbell-v2", { iceServers: [DIRECT_STUN_URL] });
  let channel: import("node-datachannel").DataChannel | null = null;
  let closed = false;
  const fail = () => {
    if (!closed) {
      // Exceptions escaping a N-API callback can terminate the service process.
      try {
        events.closed();
      } catch {
        // The endpoint owns recovery; consumer failures must stay in JavaScript.
      }
    }
  };
  const guarded = (callback: () => void) => {
    if (closed) return;
    try {
      callback();
    } catch {
      fail();
    }
  };
  peer.onLocalDescription((sdp, type) => {
    guarded(() => {
      if (type === "offer" || type === "answer") events.description(sdp, type);
    });
  });
  peer.onLocalCandidate((candidate, mid) => {
    // libdatachannel emits an SDP attribute; signaling uses the attribute value.
    guarded(() => events.candidate(candidate.replace(/^a=candidate:/, "candidate:"), mid, null));
  });
  peer.onStateChange((state) => {
    if (state === "failed" || state === "closed" || state === "disconnected") fail();
  });
  peer.onDataChannel((dc) => {
    guarded(() => {
      if (channel || dc.getLabel() !== "shellbell-v2") {
        dc.close();
        fail();
        return;
      }
      channel = dc;
      dc.onOpen(() => {
        guarded(() => events.open());
      });
      dc.onClosed(fail);
      dc.onError(fail);
      dc.onMessage((message) => {
        guarded(() => {
          if (typeof message === "string") {
            fail();
            return;
          }
          const bytes =
            message instanceof ArrayBuffer ? new Uint8Array(message) : new Uint8Array(message);
          if (bytes.length > 61_000) {
            fail();
            return;
          }
          events.message(bytes);
        });
      });
    });
  });
  return {
    async offer() {
      throw new Error("computer is WebRTC responder");
    },
    async answer(sdp) {
      peer.setRemoteDescription(sdp, "offer");
    },
    async acceptAnswer() {
      throw new Error("computer is WebRTC responder");
    },
    async candidate(candidate, mid) {
      peer.addRemoteCandidate(candidate, mid ?? "0");
    },
    async remoteCertificate(expected) {
      if (!channel?.isOpen() || peer.state() !== "connected") throw new Error("DTLS not connected");
      const actual = peer.remoteFingerprint();
      if (actual.algorithm.toLowerCase() !== "sha-256")
        throw new Error("DTLS fingerprint algorithm");
      const digest = hexToBytes(actual.value.replaceAll(":", ""));
      if (!bytesEqual(expected, digest)) throw new Error("DTLS fingerprint mismatch");
      return digest;
    },
    send(bytes) {
      if (
        closed ||
        !channel?.isOpen() ||
        bytes.length > 61_000 ||
        channel.bufferedAmount() + bytes.length > 262_144
      )
        return false;
      try {
        return channel.sendMessageBinary(bytes);
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      channel?.close();
      channel = null;
      peer.close();
    },
  };
};
