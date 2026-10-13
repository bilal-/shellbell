import { isIP } from "node:net";
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

/** How long an opened channel may wait for its route to be shown direct, and how often to recheck. */
const ROUTE_VERIFY_MS = 3000;
const ROUTE_CHECK_MS = 250;
/** Messages held while the route is unverified; the secure handshake needs only a few. */
const HELD_MESSAGES = 16;

/** Canonical address, so the phone's and libjuice's spellings of one address compare equal. */
export function canonicalAddress(address: string): string {
  const bare = address.trim().replace(/%.*$/, "").toLowerCase();
  if (isIP(bare) !== 6) return bare;
  try {
    return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return bare;
  }
}

/** The address and type of an ICE candidate line, or null when it is malformed. */
export function candidateParts(candidate: string): { address: string; type: string } | null {
  const fields = candidate.trim().replace(/^a=/, "").split(/\s+/);
  const typ = fields.indexOf("typ");
  if (!fields[0]?.startsWith("candidate:") || fields.length < 8 || typ !== 6) return null;
  return { address: canonicalAddress(fields[4]!), type: fields[7]! };
}

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
  /** With TURN off: addresses the phone announced as its own, and as TURN allocations. */
  const directAddresses = new Set<string>();
  const relayAddresses = new Set<string>();
  /**
   * With TURN off, a route counts only when it is shown direct: neither end is a TURN
   * allocation, and the phone's end is an address it announced as its own. A route whose phone
   * address is unknown, such as checks arriving from the phone's TURN allocation, is refused.
   */
  const direct = () => {
    const pair = peer.getSelectedCandidatePair();
    if (!pair || pair.local.type === "relay" || pair.remote.type === "relay") return false;
    const remote = canonicalAddress(pair.remote.address);
    return directAddresses.has(remote) && !relayAddresses.has(remote);
  };
  let verified = turn;
  let checker: ReturnType<typeof setInterval> | null = null;
  const held: Uint8Array[] = [];
  const stopChecking = () => {
    if (checker) clearInterval(checker);
    checker = null;
  };
  const fail = () => {
    stopChecking();
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
          if (turn) {
            events.open();
            return;
          }
          // Trickled candidates can arrive after the channel opens, so allow a short wait for
          // the route to be shown direct, then keep checking for as long as it stays open.
          const deadline = Date.now() + ROUTE_VERIFY_MS;
          const check = () =>
            guarded(() => {
              if (direct()) {
                if (verified) return;
                verified = true;
                events.open();
                for (const bytes of held.splice(0)) events.message(bytes);
              } else if (verified || Date.now() >= deadline) fail();
            });
          checker = setInterval(check, ROUTE_CHECK_MS);
          checker.unref?.();
          check();
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
          if (!verified) {
            // Nothing reaches the endpoint until the route is shown direct.
            if (held.length >= HELD_MESSAGES) fail();
            else held.push(bytes);
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
      if (!turn) {
        const parts = candidateParts(candidate);
        if (!parts) return;
        if (parts.type === "relay") {
          relayAddresses.add(parts.address);
          return;
        }
        if (parts.type === "host" || parts.type === "srflx") directAddresses.add(parts.address);
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
        !verified ||
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
      stopChecking();
      channel?.close();
      channel = null;
      peer.close();
    },
  };
};
