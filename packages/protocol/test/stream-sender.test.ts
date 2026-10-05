import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import type { StreamChunk, StreamTransferMeta } from "../src/stream-wire.js";

const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
const staleId = "ZZZZZZZZZZZZZZZZZZZZZZ";
const sessionId = "tmux:1";
const screen = { kind: "snapshot", generation: 1 } as const;
const history = { kind: "history", generation: 1, requestId: staleId, before: 0 } as const;

function harness(send?: (chunk: StreamChunk) => boolean) {
  expect(protocol).toHaveProperty("StreamSender");
  let now = 0;
  let id = 0;
  const sent: StreamChunk[] = [];
  const sender = new protocol.StreamSender({
    subscriptionId,
    sessionId,
    now: () => now,
    newTransferId: () => String(++id).padStart(22, "A"),
    send:
      send ??
      ((chunk) => {
        sent.push(chunk);
        return true;
      }),
  });
  return {
    sender,
    sent,
    time: (value: number) => {
      now = value;
    },
  };
}

describe("StreamSender ownership and shared credits", () => {
  it("sends a one-frame record and retains it until the exact subscription acknowledges", () => {
    const { sender, sent } = harness();
    expect(sender.canOffer("snapshot")).toBe(true);
    const result = sender.offer(screen, new Uint8Array([42]));
    expect(result).toEqual({ accepted: true, transferId: "AAAAAAAAAAAAAAAAAAAAA1" });
    expect(sender.pump()).toBe(1);
    expect(sent[0]).toMatchObject({
      sequence: 1,
      index: 0,
      count: 1,
      totalBytes: 1,
      data: new Uint8Array([42]),
    });
    expect(sender.retainedBytes).toBe(1);
    expect(sender.acknowledge(staleId, 1)).toBe("ignored");
    expect(sender.inFlight).toBe(1);
    expect(sender.acknowledge(subscriptionId, 1)).toBe("advanced");
    expect(sender.retainedBytes).toBe(0);
    expect(sender.nextDeadline()).toBeNull();
    expect(sender.acknowledge(subscriptionId, 1)).toBe("duplicate");
    expect(sender.offer(screen, new Uint8Array([43])).accepted).toBe(true);
    sender.pump();
    expect(sent[1]?.sequence).toBe(2);
  });

  it("shares four credits fairly between one screen lane and one history lane", () => {
    const { sender, sent } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.offer(history, new Uint8Array(65536));
    expect(sender.retainedBytes).toBe(589824);
    expect(sender.canOffer("snapshot")).toBe(false);
    expect(sender.canOffer("diff")).toBe(false);
    expect(sender.offer({ kind: "diff", generation: 2 }, new Uint8Array([1]))).toEqual({
      accepted: false,
      reason: "busy",
    });
    expect(sender.offer(history, new Uint8Array([1]))).toEqual({ accepted: false, reason: "busy" });
    expect(sender.pump()).toBe(4);
    expect(sent.map((chunk) => chunk.meta.kind)).toEqual([
      "snapshot",
      "history",
      "snapshot",
      "history",
    ]);
    expect(sender.inFlight).toBe(4);
    expect(sender.pump()).toBe(0);
    expect(sender.acknowledge(subscriptionId, 5)).toBe("invalid");
    expect(sender.inFlight).toBe(4);
    expect(sender.acknowledge(subscriptionId, 4)).toBe("advanced");
    while (sender.retainedBytes > 0) {
      expect(sender.pump()).toBeGreaterThan(0);
      expect(sender.inFlight).toBeLessThanOrEqual(4);
      expect(sender.retainedBytes).toBeLessThanOrEqual(589824);
      sender.acknowledge(subscriptionId, sent.at(-1)!.sequence);
    }
    expect(sent).toHaveLength(36);
    expect(sent.map((chunk) => chunk.sequence)).toEqual(
      Array.from({ length: 36 }, (_, i) => i + 1),
    );
    expect(sent.filter((chunk) => chunk.meta.kind === "snapshot").at(-1)).toMatchObject({
      index: 31,
      count: 32,
    });
  });

  it("stops a refused pass without consuming sequence, credits, or queued deadlines", () => {
    let allowed = false;
    const attempts: StreamChunk[] = [];
    const { sender, time } = harness((chunk) => {
      attempts.push(chunk);
      return allowed;
    });
    sender.offer(screen, new Uint8Array(32768));
    time(20000);
    expect(sender.pump()).toBe(0);
    expect(attempts).toHaveLength(1);
    expect(sender.inFlight).toBe(0);
    expect(sender.nextDeadline()).toBeNull();
    expect(sender.tick()).toBe("open");
    allowed = true;
    expect(sender.pump()).toBe(2);
    expect(attempts.map((chunk) => chunk.sequence)).toEqual([1, 1, 2]);
    expect(sender.nextDeadline()).toBe(25000);
    expect(sender.pump()).toBe(0);
    expect(attempts).toHaveLength(3);
  });

  it("copies accepted bytes and metadata and rejects oversize input before copying", () => {
    const { sender, sent } = harness();
    const bytes = new Uint8Array([7]);
    const meta: StreamTransferMeta = { kind: "snapshot", generation: 1 };
    sender.offer(meta, bytes);
    bytes[0] = 99;
    meta.generation = 99;
    sender.pump();
    expect(sent[0]?.data).toEqual(new Uint8Array([7]));
    expect(sent[0]?.meta.generation).toBe(1);
    sender.acknowledge(subscriptionId, 1);
    expect(sender.offer(screen, new Uint8Array(524289))).toEqual({
      accepted: false,
      reason: "too-large",
    });
    expect(sender.offer(history, new Uint8Array(65537))).toEqual({
      accepted: false,
      reason: "too-large",
    });
    expect(sender.retainedBytes).toBe(0);
  });

  it("owns Buffer inputs and isolates the retained record from a refused send callback", () => {
    const bytes = Buffer.from([7]);
    const sent: StreamChunk[] = [];
    const { sender } = harness((frame) => {
      sent.push(frame);
      if (sent.length === 1) {
        frame.data[0] = 99;
        frame.meta.generation = 99;
        return false;
      }
      return true;
    });
    sender.offer(screen, bytes);
    bytes[0] = 42;
    sender.pump();
    expect(sender.pump()).toBe(1);
    expect(sent[1]?.data).toEqual(new Uint8Array([7]));
    expect(sent[1]?.meta.generation).toBe(1);
  });

  it("uses an exact full chunk and final remainder without resending acknowledged frames", () => {
    const { sender, sent } = harness();
    sender.offer(screen, new Uint8Array(16385));
    expect(sender.pump()).toBe(2);
    expect(sent.map((frame) => frame.data.length)).toEqual([16384, 1]);
    expect(sender.acknowledge(subscriptionId, 1)).toBe("advanced");
    expect(sender.retainedBytes).toBe(16385);
    expect(sender.inFlight).toBe(1);
    expect(sender.pump()).toBe(0);
    expect(sender.acknowledge(subscriptionId, 2)).toBe("advanced");
    expect(sender.retainedBytes).toBe(0);
  });

  it("stops at sequence exhaustion without sending an unsafe integer", () => {
    const { sender, sent } = harness();
    // Advancing quadrillions of frames is infeasible; seed only this numeric boundary.
    Reflect.set(sender, "lastSequence", Number.MAX_SAFE_INTEGER - 1);
    sender.offer(screen, new Uint8Array(32768));
    expect(sender.pump()).toBe(1);
    expect(sent.map((frame) => frame.sequence)).toEqual([Number.MAX_SAFE_INTEGER]);
    expect(sender.tick()).toBe("closed");
    expect(sender.inFlight).toBe(0);
    expect(sender.retainedBytes).toBe(0);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects invalid acknowledgement %s without credit",
    (through) => {
      const { sender } = harness();
      sender.offer(screen, new Uint8Array([1]));
      sender.pump();
      expect(sender.acknowledge(subscriptionId, through)).toBe("invalid");
      expect(sender.inFlight).toBe(1);
    },
  );

  it("validates constructor identity, metadata, empty bytes and generated transfer IDs", () => {
    const { sender } = harness();
    expect(
      () =>
        new protocol.StreamSender({
          subscriptionId: "bad",
          sessionId,
          now: () => 0,
          newTransferId: () => staleId,
          send: () => true,
        }),
    ).toThrow();
    expect(
      () =>
        new protocol.StreamSender({
          subscriptionId,
          sessionId: "",
          now: () => 0,
          newTransferId: () => staleId,
          send: () => true,
        }),
    ).toThrow();
    expect(() => sender.offer(screen, new Uint8Array())).toThrow();
    expect(() => sender.offer({ kind: "diff", generation: -1 }, new Uint8Array([1]))).toThrow();
    const bad = new protocol.StreamSender({
      subscriptionId,
      sessionId,
      now: () => 0,
      newTransferId: () => "bad",
      send: () => true,
    });
    expect(() => bad.offer(screen, new Uint8Array([1]))).toThrow();
    expect(bad.retainedBytes).toBe(0);
    expect(sender.retainedBytes).toBe(0);
  });
});

describe("StreamSender deadlines and terminal paths", () => {
  it("stalls at exactly 5 seconds and does not let stale or invalid acknowledgements postpone it", () => {
    const { sender, time } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.offer(history, new Uint8Array(65536));
    sender.pump();
    time(4999);
    expect(sender.tick()).toBe("open");
    expect(sender.acknowledge(staleId, 4)).toBe("ignored");
    expect(sender.acknowledge(subscriptionId, 5)).toBe("invalid");
    expect(sender.nextDeadline()).toBe(5000);
    time(5000);
    expect(sender.tick()).toBe("stalled");
    expect(sender.retainedBytes).toBe(0);
    expect(sender.inFlight).toBe(0);
    expect(sender.pump()).toBe(0);
    expect(sender.nextDeadline()).toBeNull();
    expect(sender.offer(screen, new Uint8Array([1]))).toEqual({
      accepted: false,
      reason: "closed",
    });
  });

  it("extends only the acknowledged transfer, never via duplicate acknowledgements", () => {
    const { sender, time } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.offer(history, new Uint8Array(65536));
    sender.pump();
    sender.acknowledge(subscriptionId, 1);
    time(4999);
    expect(sender.acknowledge(subscriptionId, 1)).toBe("duplicate");
    expect(sender.acknowledge(subscriptionId, 2)).toBe("advanced");
    expect(sender.nextDeadline()).toBe(5000);
    time(5000);
    expect(sender.tick()).toBe("stalled");
  });

  it("a stale-subscription acknowledgement cannot mutate credits even when this subscription is due to expire", () => {
    const { sender, time } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.pump();
    time(5000);
    expect(sender.acknowledge(staleId, 4)).toBe("ignored");
    expect(sender.inFlight).toBe(4);
    expect(sender.retainedBytes).toBe(524288);
    expect(sender.nextDeadline()).toBe(5000);
    expect(sender.tick()).toBe("stalled");
  });

  it("real progress just before idle expiry cannot extend the fixed 15 second deadline", () => {
    const { sender, time } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.pump();
    for (const [at, through] of [
      [4999, 1],
      [9998, 2],
      [14997, 3],
    ]) {
      time(at!);
      expect(sender.acknowledge(subscriptionId, through!)).toBe("advanced");
      expect(sender.tick()).toBe("open");
    }
    expect(sender.nextDeadline()).toBe(15000);
    time(15000);
    expect(sender.tick()).toBe("stalled");
    expect(sender.retainedBytes).toBe(0);
  });

  it("does not revive an expired sender by acknowledging or pumping before tick", () => {
    const { sender, time } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.pump();
    time(5000);
    expect(sender.acknowledge(subscriptionId, 1)).toBe("ignored");
    expect(sender.pump()).toBe(0);
    expect(sender.tick()).toBe("stalled");
  });

  it("releases both lanes and propagates send failure", () => {
    const failure = new Error("private callback details");
    const { sender } = harness(() => {
      throw failure;
    });
    sender.offer(screen, new Uint8Array(524288));
    sender.offer(history, new Uint8Array(65536));
    expect(() => sender.pump()).toThrow(failure);
    expect(sender.retainedBytes).toBe(0);
    expect(sender.inFlight).toBe(0);
    expect(sender.tick()).toBe("closed");
    expect(sender.pump()).toBe(0);
  });

  it("releases an existing lane if transfer ID generation throws", () => {
    harness();
    const failure = new Error("ID generator failed");
    let calls = 0;
    const sender = new protocol.StreamSender({
      subscriptionId,
      sessionId,
      now: () => 0,
      newTransferId: () => {
        if (++calls === 2) throw failure;
        return staleId;
      },
      send: () => true,
    });
    sender.offer(screen, new Uint8Array([1]));
    expect(() => sender.offer(history, new Uint8Array([2]))).toThrow(failure);
    expect(sender.retainedBytes).toBe(0);
    expect(sender.tick()).toBe("closed");
  });

  it("checks expiry between callbacks and never sends more frames after the deadline", () => {
    let now = 0;
    let calls = 0;
    harness();
    const sender = new protocol.StreamSender({
      subscriptionId,
      sessionId,
      now: () => now,
      newTransferId: () => staleId,
      send: () => {
        if (++calls === 2) now = 5000;
        return true;
      },
    });
    sender.offer(screen, new Uint8Array(524288));
    expect(sender.pump()).toBe(2);
    expect(calls).toBe(2);
    expect(sender.retainedBytes).toBe(0);
    expect(sender.tick()).toBe("stalled");
  });

  it("cancel midway is idempotent and suppresses all later work", () => {
    const { sender, sent, time } = harness();
    sender.offer(screen, new Uint8Array(524288));
    sender.offer(history, new Uint8Array(65536));
    sender.pump();
    sender.cancel();
    sender.cancel();
    time(20000);
    expect(sender.tick()).toBe("closed");
    expect(sender.canOffer("history")).toBe(false);
    expect(sender.pump()).toBe(0);
    expect(sender.acknowledge(subscriptionId, 4)).toBe("ignored");
    expect(sender.inFlight).toBe(0);
    expect(sender.retainedBytes).toBe(0);
    expect(sender.nextDeadline()).toBeNull();
    expect(sent).toHaveLength(4);
  });

  it.each([true, false])(
    "a send callback that cancels and returns %s cannot resurrect credits or keep pumping",
    (accepted) => {
      let calls = 0;
      const { sender } = harness(() => {
        calls++;
        sender.cancel();
        return accepted;
      });
      sender.offer(screen, new Uint8Array(524288));
      sender.offer(history, new Uint8Array(65536));
      expect(sender.pump()).toBe(accepted ? 1 : 0);
      expect(calls).toBe(1);
      expect(sender.retainedBytes).toBe(0);
      expect(sender.inFlight).toBe(0);
      expect(sender.nextDeadline()).toBeNull();
      expect(sender.tick()).toBe("closed");
      expect(sender.pump()).toBe(0);
    },
  );
});
