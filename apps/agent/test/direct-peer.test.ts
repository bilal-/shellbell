import type { DirectIceServer, NativeDirectEvents } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({
  candidate: null as null | ((c: string, mid: string) => void),
  config: null as null | { iceServers?: string[] },
}));
vi.mock("node-datachannel", () => ({
  default: {
    PeerConnection: class {
      constructor(_name: string, config: { iceServers?: string[] }) {
        callbacks.config = config;
      }
      onLocalCandidate(cb: typeof callbacks.candidate) {
        callbacks.candidate = cb;
      }
      onLocalDescription() {}
      onStateChange() {}
      onDataChannel() {}
      close() {}
    },
  },
}));

import {
  createDirectPeer,
  directPeerFactory,
  libdatachannelIceServers,
} from "../src/direct-peer.js";

describe("libdatachannel ICE servers", () => {
  it("puts TURN credentials into each UDP TURN URL, keeps STUN and drops TCP/TLS TURN", () => {
    expect(
      libdatachannelIceServers([
        { urls: ["stun:stun.cloudflare.com:3478"] },
        {
          urls: [
            "turn:turn.example.test:3478?transport=udp",
            "turn:turn.example.test:3478?transport=tcp",
            "turns:turn.example.test:443?transport=tcp",
            "turn:turn.example.test:3479",
          ],
          username: "u:1",
          credential: "p@2",
        },
      ]),
    ).toEqual([
      "stun:stun.cloudflare.com:3478",
      "turn:u%3A1:p%402@turn.example.test:3478?transport=udp",
      "turn:u%3A1:p%402@turn.example.test:3479",
    ]);
  });

  it("creates each peer with the TURN servers current at that moment", async () => {
    let servers: DirectIceServer[] = [{ urls: ["stun:stun.cloudflare.com:3478"] }];
    const factory = directPeerFactory(() => servers);
    const events = { candidate() {}, description() {}, open() {}, message() {}, closed() {} };
    (await factory(events)).close();
    expect(callbacks.config?.iceServers).toEqual(["stun:stun.cloudflare.com:3478"]);
    servers = [...servers, { urls: ["turn:t.example.test:3478"], username: "u", credential: "c" }];
    (await factory(events)).close();
    expect(callbacks.config?.iceServers).toEqual([
      "stun:stun.cloudflare.com:3478",
      "turn:u:c@t.example.test:3478",
    ]);
  });
});

describe("native direct callbacks", () => {
  it("converts libdatachannel SDP candidate attributes to WebRTC candidate values", async () => {
    const candidate = vi.fn();
    const events: NativeDirectEvents = {
      candidate,
      description() {},
      open() {},
      message() {},
      closed() {},
    };
    const peer = await createDirectPeer(events);
    try {
      callbacks.candidate!("a=candidate:1 1 UDP 123 192.0.2.1 5000 typ host", "0");
      expect(candidate).toHaveBeenCalledWith(
        "candidate:1 1 UDP 123 192.0.2.1 5000 typ host",
        "0",
        null,
      );
      callbacks.candidate!("candidate:2 1 UDP 124 192.0.2.2 5001 typ host", "0");
      expect(candidate).toHaveBeenLastCalledWith(
        "candidate:2 1 UDP 124 192.0.2.2 5001 typ host",
        "0",
        null,
      );
    } finally {
      peer.close();
    }
  });
  it("contains consumer errors before they escape a native callback", async () => {
    const closed = vi.fn(() => {
      throw new Error("consumer close failure");
    });
    const peer = await createDirectPeer({
      candidate() {
        throw new Error("invalid candidate");
      },
      closed,
      description() {},
      open() {},
      message() {},
    });
    try {
      expect(() => callbacks.candidate!("a=candidate:bad", "0")).not.toThrow();
      expect(closed).toHaveBeenCalledOnce();
    } finally {
      peer.close();
    }
  });
});
