import {
  bytesEqual,
  type DirectIceServer,
  directIceServers,
  hexToBytes,
  type NativeDirectFactory,
  V2_FRAME_BYTES,
} from "@shellbell/protocol";

/** The shipped libdatachannel uses libjuice, which only speaks TURN over UDP. */
const udpOnly = (url: string) => !/^turns:/.test(url) && !/[?&]transport=tcp(?:&|$)/.test(url);

/**
 * libdatachannel takes one URL per server, with TURN credentials in the URL itself. TCP and
 * TLS TURN are dropped because libjuice ignores them; the phone still uses those, so a
 * blocked phone network reaches this computer's UDP through TURN.
 */
export function libdatachannelIceServers(servers: readonly DirectIceServer[]): string[] {
  return servers.flatMap((server) =>
    server.urls
      .filter(udpOnly)
      .map((url) =>
        server.username && server.credential
          ? url.replace(
              /^(turns?):/,
              `$1:${encodeURIComponent(server.username)}:${encodeURIComponent(server.credential)}@`,
            )
          : url,
      ),
  );
}

export interface DirectPeerOptions {
  /**
   * False when the owner turned TURN off: no data may pass through a TURN server, even the
   * phone's. TURN works if either side offers a relayed route, so the computer refuses them.
   */
  turn?: boolean;
}

/** A relayed candidate names a TURN server's allocation; its address is that server's. */
const relayCandidate = /\styp\s+relay(?:\s|$)/;
const candidateAddress = (candidate: string) => candidate.split(/\s+/)[4] ?? "";

/** Native data channel. Loaded only for an authenticated paired-v2 endpoint. */
export function directPeerFactory(
  iceServers: () => DirectIceServer[],
  options: DirectPeerOptions = {},
): NativeDirectFactory {
  const turn = options.turn !== false;
  return (events) =>
    openDirectPeer(
      events,
      libdatachannelIceServers(turn ? iceServers() : directIceServers()),
      turn,
    );
}
/** STUN only; used when no relay has issued TURN servers. */
export const createDirectPeer: NativeDirectFactory = directPeerFactory(() => directIceServers());

const openDirectPeer = async (
  events: Parameters<NativeDirectFactory>[0],
  iceServers: string[],
  turn = true,
): ReturnType<NativeDirectFactory> => {
  const { default: rtc } = await import("node-datachannel");
  const peer = new rtc.PeerConnection("shellbell-v2", { iceServers });
  let channel: import("node-datachannel").DataChannel | null = null;
  let closed = false;
  /** Addresses of TURN allocations the phone offered; a route through any of them is refused. */
  const refusedAddresses = new Set<string>();
  /** True when the connected route passes through a TURN server, from either side. */
  const relayed = () => {
    const pair = peer.getSelectedCandidatePair();
    if (!pair) return true;
    return (
      pair.local.type === "relay" ||
      pair.remote.type === "relay" ||
      refusedAddresses.has(pair.remote.address)
    );
  };
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
        guarded(() => {
          if (!turn && relayed()) {
            fail();
            return;
          }
          events.open();
        });
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
          if (bytes.length > V2_FRAME_BYTES) {
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
      if (!turn && relayCandidate.test(candidate)) {
        refusedAddresses.add(candidateAddress(candidate));
        return;
      }
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
        bytes.length > V2_FRAME_BYTES ||
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
