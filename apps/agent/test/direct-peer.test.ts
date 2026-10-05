import type { NativeDirectEvents } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";

const callbacks = vi.hoisted(() => ({
  candidate: null as null | ((c: string, mid: string) => void),
}));
vi.mock("node-datachannel", () => ({
  default: {
    PeerConnection: class {
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

import { createDirectPeer } from "../src/direct-peer.js";

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
