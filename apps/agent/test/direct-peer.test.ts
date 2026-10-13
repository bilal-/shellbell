import type { DirectIceServer, NativeDirectEvents } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";

type Candidate = { type: string; address: string };
const callbacks = vi.hoisted(() => ({
  candidate: null as null | ((c: string, mid: string) => void),
  config: null as null | { iceServers?: string[] },
  dataChannel: null as null | ((dc: unknown) => void),
  remote: [] as string[],
  pair: null as null | { local: Candidate; remote: Candidate },
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
      onDataChannel(cb: (dc: unknown) => void) {
        callbacks.dataChannel = cb;
      }
      addRemoteCandidate(candidate: string) {
        callbacks.remote.push(candidate);
      }
      getSelectedCandidatePair() {
        return callbacks.pair;
      }
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

describe("with TURN turned off", () => {
  const phoneRelay = "candidate:3 1 UDP 5 203.0.113.9 50000 typ relay raddr 0.0.0.0 rport 0";
  function channel() {
    let opened: () => void = () => {};
    return {
      getLabel: () => "shellbell-v2",
      onOpen: (cb: () => void) => {
        opened = cb;
      },
      onClosed() {},
      onError() {},
      onMessage() {},
      close() {},
      open: () => opened(),
    };
  }
  function events() {
    return {
      candidate() {},
      description() {},
      message() {},
      open: vi.fn(),
      closed: vi.fn(),
    };
  }

  it("uses STUN only, whatever TURN servers the relay issued", async () => {
    const factory = directPeerFactory(
      () => [{ urls: ["turn:t.example.test:3478"], username: "u", credential: "c" }],
      { turn: false },
    );
    (await factory(events())).close();
    expect(callbacks.config?.iceServers?.some((url) => url.startsWith("turn"))).toBe(false);
  });

  it("never adds the phone's relayed candidates", async () => {
    callbacks.remote = [];
    const peer = await directPeerFactory(() => [], { turn: false })(events());
    try {
      await peer.candidate("candidate:1 1 UDP 9 192.0.2.1 5000 typ host", "0", null);
      await peer.candidate(phoneRelay, "0", null);
      expect(callbacks.remote).toEqual(["candidate:1 1 UDP 9 192.0.2.1 5000 typ host"]);
    } finally {
      peer.close();
    }
  });

  it.each([
    ["the computer's own TURN allocation", { type: "relay", address: "198.51.100.1" }, "host"],
    [
      "a phone TURN allocation seen as a new peer address",
      { type: "host", address: "192.0.2.5" },
      "prflx",
    ],
  ] as const)("refuses a connection routed through %s", async (_label, local, remoteType) => {
    const peer = await directPeerFactory(() => [], { turn: false })(events());
    const handlers = events();
    const opened = await directPeerFactory(() => [], { turn: false })(handlers);
    try {
      await opened.candidate(phoneRelay, "0", null);
      callbacks.pair = {
        local,
        remote: { type: remoteType, address: remoteType === "prflx" ? "203.0.113.9" : "192.0.2.7" },
      };
      const dc = channel();
      callbacks.dataChannel!(dc);
      dc.open();
      expect(handlers.open).not.toHaveBeenCalled();
      expect(handlers.closed).toHaveBeenCalledOnce();
    } finally {
      peer.close();
      opened.close();
    }
  });

  it("opens a direct route", async () => {
    const handlers = events();
    const peer = await directPeerFactory(() => [], { turn: false })(handlers);
    try {
      callbacks.pair = {
        local: { type: "host", address: "192.0.2.5" },
        remote: { type: "srflx", address: "198.51.100.7" },
      };
      const dc = channel();
      callbacks.dataChannel!(dc);
      dc.open();
      expect(handlers.open).toHaveBeenCalledOnce();
    } finally {
      peer.close();
    }
  });
});
