import { x25519 } from "@noble/curves/ed25519.js";
import { describe, expect, it, vi } from "vitest";
import { utf8 } from "../src/bytes.js";
import type { RoutableEnvelope } from "../src/envelope.js";
import {
  type NativeDirectEvents,
  type NativeDirectFactory,
  type NativeDirectPeer,
  V2PairEndpoint,
  type V2TransportState,
} from "../src/session-v2-endpoint.js";

const computerFp = "a".repeat(26),
  phoneFp = "b".repeat(26);
const phonePrivate = new Uint8Array(32).fill(3),
  computerPrivate = new Uint8Array(32).fill(7);
function fixture(
  options: {
    certificateMismatch?: boolean;
    floorBlocked?: boolean;
    malformedCandidate?: boolean;
    failNativeAttempts?: number;
    now?: () => number;
    prepareReady?: () => boolean;
    holdFirstOffer?: { reject?: (reason: Error) => void };
    holdFirstFactory?: { resolve?: () => void; events?: NativeDirectEvents; closes?: number };
  } = {},
) {
  const queue: Array<() => Promise<void> | void> = [];
  const events: Partial<Record<"phone" | "computer", NativeDirectEvents>> = {};
  const received = { phone: [] as Uint8Array[], computer: [] as Uint8Array[] };
  const failures: string[] = [];
  const floors = { phone: false, computer: false };
  const states = { phone: [] as V2TransportState[], computer: [] as V2TransportState[] };
  let relayBytes = 0,
    directBytes = 0;
  let phoneCreations = 0;
  const peers = {} as Record<"phone" | "computer", V2PairEndpoint>;
  const native =
    (role: "phone" | "computer"): NativeDirectFactory =>
    async (callbacks) => {
      if (role === "phone") {
        phoneCreations += 1;
        if (phoneCreations <= (options.failNativeAttempts ?? 0)) throw new Error("ICE unavailable");
      }
      events[role] = callbacks;
      const opposite = role === "phone" ? "computer" : "phone";
      const digest = new Uint8Array(32).fill(role === "phone" ? 13 : 17);
      const fingerprint = [...digest].map((b) => b.toString(16).padStart(2, "0")).join(":");
      const sdp = `v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\na=ice-ufrag:abc\r\na=ice-pwd:abcdefghijklmnopqrstuv\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;
      const held = role === "phone" && phoneCreations === 1 ? options.holdFirstFactory : undefined;
      const peer: NativeDirectPeer = {
        async offer() {
          if (phoneCreations === 1 && options.holdFirstOffer)
            await new Promise<void>((_, reject) => {
              options.holdFirstOffer!.reject = reject;
            });
          callbacks.description(sdp, "offer");
          if (options.malformedCandidate) callbacks.candidate("invalid", "0", null);
        },
        async answer() {
          callbacks.description(sdp, "answer");
        },
        async acceptAnswer() {
          queue.push(() => {
            events.computer!.open();
            events.phone!.open();
          });
        },
        async candidate() {},
        async remoteCertificate(expected) {
          return options.certificateMismatch ? new Uint8Array(32) : expected.slice();
        },
        send(bytes) {
          directBytes += bytes.length;
          const copy = bytes.slice();
          queue.push(() => events[opposite]!.message(copy));
          return true;
        },
        close() {
          if (held) held.closes = (held.closes ?? 0) + 1;
        },
      };
      if (held) {
        held.events = callbacks;
        await new Promise<void>((resolve) => {
          held.resolve = resolve;
        });
      }
      return peer;
    };
  for (const role of ["phone", "computer"] as const) {
    const other = role === "phone" ? "computer" : "phone";
    peers[role] = new V2PairEndpoint({
      role,
      computerFp,
      phoneFp,
      keys: {
        staticPrivate: role === "phone" ? phonePrivate : computerPrivate,
        remoteStatic: x25519.getPublicKey(role === "phone" ? computerPrivate : phonePrivate),
        pairKey: new Uint8Array(32).fill(11),
      },
      sendRelay(envelope: RoutableEnvelope) {
        if (envelope.v === 2) relayBytes += envelope.body.length;
        queue.push(() => peers[other].receiveRelay(envelope));
        return true;
      },
      async commitFloor() {
        if (options.floorBlocked && role === "computer") throw new Error("disk full");
        floors[role] = true;
      },
      prepareReady() {
        return floors[role] && (options.prepareReady?.() ?? true);
      },
      terminal(bytes) {
        received[role].push(bytes);
      },
      routeChanged() {},
      stateChanged(state) {
        states[role].push(state);
      },
      failure(stage) {
        failures.push(`${role}:${stage}`);
      },
      native: native(role),
      allowDirect: true,
      now: options.now,
    });
  }
  const pump = async () => {
    for (let turns = 0; turns < 150; turns++) {
      const task = queue.shift();
      if (task) await task();
      await Promise.resolve();
      if (!queue.length) {
        await Promise.resolve();
        if (!queue.length) return;
      }
    }
    throw new Error("endpoint queue did not quiesce");
  };
  return {
    ...peers,
    floors,
    states,
    received,
    failures,
    phoneCreations: () => phoneCreations,
    pump,
    bytes: () => ({ relayBytes, directBytes }),
    close() {
      peers.phone.close();
      peers.computer.close();
    },
  };
}
describe("paired v2 endpoint", () => {
  it("reports committed routes and retry state without sending repeated UI updates while idle", async () => {
    vi.useFakeTimers();
    const f = fixture({ now: () => Date.now() });
    try {
      f.phone.begin();
      await f.pump();
      expect(f.states.phone.at(-1)).toMatchObject({
        route: "direct",
        phase: "direct",
        ready: true,
        retryPending: false,
      });
      const count = f.states.phone.length;
      await vi.advanceTimersByTimeAsync(300);
      expect(f.states.phone).toHaveLength(count);
      f.phone.interruptDirect();
      await f.pump();
      expect(f.states.phone.at(-1)).toMatchObject({
        route: null,
        ready: false,
        retryPending: true,
        lastFailure: "interrupted",
      });
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("closes a late-created peer and ignores its callbacks after a replacement commits", async () => {
    vi.useFakeTimers();
    const held: NonNullable<Parameters<typeof fixture>[0]>["holdFirstFactory"] = {};
    const f = fixture({ now: () => Date.now(), holdFirstFactory: held });
    try {
      f.phone.begin();
      await f.pump();
      f.phone.interruptDirect();
      await f.pump();
      await vi.advanceTimersByTimeAsync(6_200);
      await f.pump();
      expect(f.phone.activeRoute).toBe("direct");
      const failures = [...f.failures];
      const received = f.phone.diagnostics.directReceived;
      held.events!.description("malformed old SDP", "offer");
      held.events!.candidate("malformed old candidate", null, null);
      held.events!.open();
      held.events!.message(new Uint8Array([1]));
      held.events!.closed();
      held.resolve!();
      await f.pump();
      expect(held.closes).toBe(1);
      expect(f.failures).toEqual(failures);
      expect(f.phone.diagnostics.directReceived).toBe(received);
      expect(f.phone.sendTerminal(utf8("replacement remains live"))).toBe(true);
      await f.pump();
      expect(f.received.computer).toEqual([utf8("replacement remains live")]);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("does not retry while the encrypted relay route is unavailable", async () => {
    vi.useFakeTimers();
    const f = fixture({ failNativeAttempts: 1, now: () => Date.now() });
    try {
      f.phone.begin();
      await f.pump();
      f.phone.relayLost();
      await vi.advanceTimersByTimeAsync(120_000);
      await f.pump();
      expect(f.phoneCreations()).toBe(1);
      expect(f.phone.sendTerminal(utf8("offline"))).toBe(false);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("retries failed native attempts with backoff while relay terminal traffic stays usable", async () => {
    vi.useFakeTimers();
    const f = fixture({ failNativeAttempts: 2, now: () => Date.now() });
    try {
      f.phone.begin();
      await f.pump();
      expect(f.phoneCreations()).toBe(1);
      expect(f.phone.sendTerminal(utf8("relay remains live"))).toBe(true);
      await f.pump();
      await vi.advanceTimersByTimeAsync(3_900);
      await f.pump();
      expect(f.phoneCreations()).toBe(1);
      await vi.advanceTimersByTimeAsync(2_200);
      await f.pump();
      expect(f.phoneCreations()).toBe(2);
      // First retry is at 4–6s; its next delay is 8–12s. Stay below the
      // earliest combined deadline (12s), regardless of the random jitter.
      await vi.advanceTimersByTimeAsync(5_800);
      await f.pump();
      expect(f.phoneCreations()).toBe(2);
      await vi.advanceTimersByTimeAsync(6_400);
      await f.pump();
      expect(f.phoneCreations()).toBe(3);
      expect(f.phone.activeRoute).toBe("direct");
      expect(f.received.computer).toEqual([utf8("relay remains live")]);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("waits for pending input to drain and cancels retries when direct is disabled or closed", async () => {
    vi.useFakeTimers();
    let drained = true;
    const f = fixture({
      failNativeAttempts: 1,
      now: () => Date.now(),
      prepareReady: () => drained,
    });
    try {
      f.phone.begin();
      await f.pump();
      drained = false;
      await vi.advanceTimersByTimeAsync(10_000);
      await f.pump();
      expect(f.phoneCreations()).toBe(1);
      drained = true;
      f.phone.dropDirect();
      await vi.advanceTimersByTimeAsync(70_000);
      await f.pump();
      expect(f.phoneCreations()).toBe(1);
      f.phone.close();
      await vi.advanceTimersByTimeAsync(70_000);
      expect(f.phoneCreations()).toBe(1);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("ignores a stale rejected offer after a newer attempt has committed", async () => {
    vi.useFakeTimers();
    const held: { reject?: (reason: Error) => void } = {};
    const f = fixture({ now: () => Date.now(), holdFirstOffer: held });
    try {
      f.phone.begin();
      await f.pump();
      await vi.advanceTimersByTimeAsync(21_200);
      await f.pump();
      expect(f.phoneCreations()).toBe(2);
      expect(f.phone.activeRoute).toBe("direct");
      held.reject!(new Error("late native failure"));
      await f.pump();
      expect(f.phone.activeRoute).toBe("direct");
      expect(f.phone.sendTerminal(utf8("new channel survives"))).toBe(true);
      await f.pump();
      expect(f.received.computer).toEqual([utf8("new channel survives")]);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("refreshes the encrypted connection at the attempt cap instead of growing route ID sets", async () => {
    vi.useFakeTimers();
    const f = fixture({ now: () => Date.now(), failNativeAttempts: 100 });
    try {
      f.phone.begin();
      await f.pump();
      for (let n = 0; n < 33; n++) {
        await vi.advanceTimersByTimeAsync(61_000);
        await f.pump();
      }
      expect(f.phoneCreations()).toBe(32);
      expect(f.failures.filter((failure) => failure === "phone:bootstrap")).toHaveLength(1);
    } finally {
      f.close();
      vi.useRealTimers();
    }
  });
  it("contains malformed native candidate callbacks and keeps the encrypted relay usable", async () => {
    const f = fixture({ malformedCandidate: true });
    try {
      f.phone.begin();
      await f.pump();
      expect(f.phone.diagnostics.lastFailure).toBe("local-candidate");
      expect(f.phone.activeRoute).toBe("relay");
      expect(f.phone.sendTerminal(utf8("relay fixture"))).toBe(true);
      await f.pump();
      expect(f.received.computer).toEqual([utf8("relay fixture")]);
    } finally {
      f.close();
    }
  });
  it("bootstraps both floors, authenticates a native channel, and moves terminal traffic off relay", async () => {
    const f = fixture();
    try {
      f.phone.begin();
      await f.pump();
      expect(f.floors).toEqual({ phone: true, computer: true });
      expect(f.failures).toEqual([]);
      expect(f.phone.activeRoute).toBe("direct");
      expect(f.computer.activeRoute).toBe("direct");
      const before = f.bytes();
      expect(f.phone.sendTerminal(utf8("disposable input"))).toBe(true);
      expect(f.computer.sendTerminal(utf8("screen"))).toBe(true);
      await f.pump();
      expect(f.bytes().relayBytes).toBe(before.relayBytes);
      expect(f.bytes().directBytes).toBeGreaterThan(before.directBytes);
      expect(f.received.computer).toEqual([utf8("disposable input")]);
      f.phone.relayLost();
      f.computer.relayLost();
      expect(f.phone.sendTerminal(utf8("still direct"))).toBe(true);
      await f.pump();
      expect(f.received.computer).toHaveLength(2);
    } finally {
      f.close();
    }
  });
  it("refuses terminal when the durable floor cannot be written", async () => {
    const f = fixture({ floorBlocked: true });
    try {
      f.phone.begin();
      await f.pump();
      expect(f.computer.activeRoute).toBeNull();
      expect(f.phone.sendTerminal(utf8("input"))).toBe(false);
      expect(f.failures).toContain("computer:bootstrap");
    } finally {
      f.close();
    }
  });
  it("keeps relay terminal traffic when live DTLS certificate does not match signed SDP", async () => {
    const f = fixture({ certificateMismatch: true });
    try {
      f.phone.begin();
      await f.pump();
      expect(f.phone.activeRoute).toBe("relay");
      expect(f.computer.activeRoute).toBe("relay");
      expect(f.phone.sendTerminal(utf8("relay input"))).toBe(true);
      await f.pump();
      expect(f.received.computer).toEqual([utf8("relay input")]);
    } finally {
      f.close();
    }
  });
});
