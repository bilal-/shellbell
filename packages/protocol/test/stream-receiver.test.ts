import { describe, expect, it } from "vitest";
import * as protocol from "../src/index.js";
import type { StreamChunk, StreamTransferMeta } from "../src/stream-wire.js";

const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
const transferId = "BBBBBBBBBBBBBBBBBBBBBB";
const otherId = "CCCCCCCCCCCCCCCCCCCCCC";
const sessionId = "tmux:1";
const screen = { kind: "snapshot", generation: 1 } as const;
const history = { kind: "history", generation: 1, requestId: otherId, before: 0 } as const;
function chunk(overrides: Partial<StreamChunk> = {}): StreamChunk {
  return {
    type: "stream.chunk",
    subscriptionId,
    sessionId,
    transferId,
    sequence: 1,
    index: 0,
    count: 1,
    totalBytes: 1,
    data: new Uint8Array([42]),
    meta: screen,
    ...overrides,
  };
}
function partial(overrides: Partial<StreamChunk> = {}) {
  return chunk({ count: 32, totalBytes: 524288, data: new Uint8Array(16384), ...overrides });
}
function harness(
  options: {
    accept?: (meta: StreamTransferMeta, bytes: Uint8Array) => void;
    acknowledge?: (through: number) => boolean;
    subscription?: string;
  } = {},
) {
  expect(protocol).toHaveProperty("StreamReceiver");
  let now = 0;
  const applied: { meta: StreamTransferMeta; bytes: Uint8Array }[] = [];
  const acks: number[] = [];
  const receiver = new protocol.StreamReceiver({
    subscriptionId: options.subscription ?? subscriptionId,
    sessionId,
    now: () => now,
    accept:
      options.accept ??
      ((meta, bytes) => {
        applied.push({ meta, bytes });
      }),
    acknowledge:
      options.acknowledge ??
      ((through) => {
        acks.push(through);
        return true;
      }),
  });
  return {
    receiver,
    applied,
    acks,
    time: (value: number) => {
      now = value;
    },
  };
}

describe("StreamReceiver bounded assembly and acknowledgement", () => {
  it("applies one-frame records once and acknowledges at exactly 500ms", () => {
    const { receiver, applied, acks, time } = harness();
    expect(receiver.receive(chunk(), 100)).toBe("accepted");
    expect(applied).toEqual([{ meta: screen, bytes: new Uint8Array([42]) }]);
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.nextDeadline()).toBe(500);
    time(499);
    expect(receiver.tick()).toBe("open");
    expect(acks).toEqual([]);
    expect(receiver.receive(chunk(), 100)).toBe("ignored");
    expect(receiver.nextDeadline()).toBe(500);
    time(500);
    expect(receiver.tick()).toBe("open");
    expect(acks).toEqual([1]);
    expect(receiver.nextDeadline()).toBeNull();
    receiver.receive(chunk(), 100);
    receiver.tick();
    expect(applied).toHaveLength(1);
    expect(acks).toEqual([1]);
  });

  it("acknowledges four accepted envelopes immediately and copies bytes into bounded assemblies", () => {
    const { receiver, applied, acks } = harness();
    const bytes = new Uint8Array(16384).fill(7);
    const meta: StreamTransferMeta = { kind: "snapshot", generation: 1 };
    receiver.receive(partial({ data: bytes, meta }), 17000);
    bytes.fill(99);
    meta.generation = 99;
    receiver.receive(
      partial({ transferId: otherId, sequence: 2, count: 4, totalBytes: 65536, meta: history }),
      17000,
    );
    expect(receiver.retainedBytes).toBe(589824);
    receiver.receive(partial({ sequence: 3, index: 1 }), 17000);
    receiver.receive(
      partial({
        transferId: otherId,
        sequence: 4,
        index: 1,
        count: 4,
        totalBytes: 65536,
        meta: history,
      }),
      17000,
    );
    expect(acks).toEqual([4]);
    expect(applied).toEqual([]);
    let sequence = 4;
    for (let index = 2; index < 32; index++) {
      expect(receiver.receive(partial({ sequence: ++sequence, index }), 17000)).toBe("accepted");
      expect(receiver.retainedBytes).toBeLessThanOrEqual(589824);
    }
    expect(applied).toHaveLength(1);
    expect(applied[0]?.bytes).toHaveLength(524288);
    expect(applied[0]?.bytes[0]).toBe(7);
    expect(applied[0]?.bytes[16383]).toBe(7);
    expect(applied[0]?.bytes[16384]).toBe(0);
    expect(applied[0]?.meta).toEqual(screen);
    expect(receiver.retainedBytes).toBe(65536);
    for (let index = 2; index < 4; index++)
      receiver.receive(
        partial({
          transferId: otherId,
          sequence: ++sequence,
          index,
          count: 4,
          totalBytes: 65536,
          meta: history,
        }),
        17000,
      );
    expect(applied).toHaveLength(2);
    expect(applied[1]?.bytes).toHaveLength(65536);
    expect(receiver.retainedBytes).toBe(0);
    expect(acks.at(-1)).toBe(36);
  });

  it.each([0, -1, 32769, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid actual envelope length %s",
    (size) => {
      const { receiver, applied } = harness();
      expect(receiver.receive(partial(), size)).toBe("invalid");
      expect(receiver.retainedBytes).toBe(0);
      expect(applied).toEqual([]);
      expect(receiver.tick()).toBe("closed");
    },
  );

  it.each([
    { totalBytes: 524289 },
    { totalBytes: Number.MAX_SAFE_INTEGER },
    { count: 33 },
    { count: 1 },
    { data: new Uint8Array(16385) },
    { meta: history },
  ])("rejects inconsistent or oversized declaration before retaining assembly: case %#", (bad) => {
    const { receiver, applied } = harness();
    expect(receiver.receive(partial(bad), 32768)).toBe("invalid");
    expect(receiver.retainedBytes).toBe(0);
    expect(applied).toEqual([]);
  });

  it.each([
    { sequence: 3, index: 1 },
    { sequence: 2, index: 2 },
    { sequence: 2, index: 1, transferId: otherId },
    { sequence: 2, index: 0, transferId: otherId },
    { sequence: 2, index: 1, meta: { kind: "diff", generation: 1 } },
    { sequence: 2, index: 1, meta: { kind: "snapshot", generation: 2 } },
    { sequence: 2, index: 1, count: 31, totalBytes: 507904 },
  ] satisfies Partial<StreamChunk>[])(
    "stops and releases on gap, overlap, index or metadata change: %j",
    (bad) => {
      const { receiver, applied, acks, time } = harness();
      receiver.receive(partial(), 17000);
      expect(receiver.receive(partial(bad), 17000)).toBe("invalid");
      expect(receiver.retainedBytes).toBe(0);
      expect(receiver.nextDeadline()).toBeNull();
      time(10000);
      expect(receiver.tick()).toBe("closed");
      expect(applied).toEqual([]);
      expect(acks).toEqual([]);
    },
  );

  it("rejects changed history request or cursor and transfer identity crossing lanes", () => {
    for (const meta of [{ ...history, requestId: transferId }, { ...history, before: 1 }, screen]) {
      const { receiver } = harness();
      receiver.receive(partial({ count: 4, totalBytes: 65536, meta: history }), 17000);
      expect(
        receiver.receive(
          partial({ sequence: 2, index: 1, count: 4, totalBytes: 65536, meta }),
          17000,
        ),
      ).toBe("invalid");
      expect(receiver.retainedBytes).toBe(0);
    }
  });

  it("ignores stale subscription/session and accepted duplicates without progress or ack flood", () => {
    const { receiver, acks, time } = harness();
    receiver.receive(partial(), 17000);
    time(4999);
    expect(receiver.receive(partial(), 17000)).toBe("ignored");
    expect(
      receiver.receive(partial({ sequence: 2, index: 1, subscriptionId: otherId }), 17000),
    ).toBe("ignored");
    expect(
      receiver.receive(partial({ sequence: 2, index: 1, sessionId: "tmux:other" }), 17000),
    ).toBe("ignored");
    receiver.tick();
    expect(acks).toEqual([1]);
    expect(receiver.nextDeadline()).toBe(5000);
    time(5000);
    expect(receiver.tick()).toBe("stalled");
    expect(receiver.retainedBytes).toBe(0);
  });

  it("validates constructor identity", () => {
    harness();
    expect(
      () =>
        new protocol.StreamReceiver({
          subscriptionId: "bad",
          sessionId,
          now: () => 0,
          accept: () => {},
          acknowledge: () => true,
        }),
    ).toThrow();
    expect(
      () =>
        new protocol.StreamReceiver({
          subscriptionId,
          sessionId: "",
          now: () => 0,
          accept: () => {},
          acknowledge: () => true,
        }),
    ).toThrow();
  });

  it("applies an exact full chunk and a multi-chunk record with a final one-byte remainder", () => {
    const { receiver, applied } = harness();
    expect(
      receiver.receive(chunk({ totalBytes: 16384, data: new Uint8Array(16384).fill(7) }), 32768),
    ).toBe("accepted");
    expect(
      receiver.receive(
        chunk({
          sequence: 2,
          transferId: otherId,
          count: 2,
          totalBytes: 16385,
          data: new Uint8Array(16384).fill(8),
        }),
        17000,
      ),
    ).toBe("accepted");
    expect(applied).toHaveLength(1);
    expect(
      receiver.receive(
        chunk({
          sequence: 3,
          transferId: otherId,
          index: 1,
          count: 2,
          totalBytes: 16385,
          data: new Uint8Array([9]),
        }),
        100,
      ),
    ).toBe("accepted");
    expect(applied).toHaveLength(2);
    expect(applied[1]?.bytes).toHaveLength(16385);
    expect(applied[1]?.bytes[16383]).toBe(8);
    expect(applied[1]?.bytes[16384]).toBe(9);
  });

  it("does not postpone the first pending acknowledgement when later frames arrive", () => {
    const { receiver, time, acks } = harness();
    receiver.receive(partial(), 17000);
    time(499);
    receiver.receive(partial({ sequence: 2, index: 1 }), 17000);
    expect(receiver.nextDeadline()).toBe(500);
    time(500);
    receiver.tick();
    expect(acks).toEqual([2]);
    expect(receiver.nextDeadline()).toBe(5499);
  });
});

describe("StreamReceiver timeout and lifecycle isolation", () => {
  it.each([
    ["old subscription", { subscriptionId: otherId }],
    ["another session", { sessionId: "tmux:other" }],
  ] satisfies [string, Partial<StreamChunk>][])(
    "ignores an expired %s frame without expiring the current assembly",
    (_identity, staleIdentity) => {
      const { receiver, time, applied, acks } = harness();
      const first = chunk({ count: 2, totalBytes: 32768, data: new Uint8Array(16384) });
      expect(receiver.receive(first, 17000)).toBe("accepted");
      time(500);
      expect(receiver.tick()).toBe("open");
      expect(acks).toEqual([1]);
      expect(receiver.retainedBytes).toBe(32768);
      expect(receiver.nextDeadline()).toBe(5000);

      time(5000);
      const second = chunk({
        ...first,
        sequence: 2,
        index: 1,
        ...staleIdentity,
      });
      expect(receiver.receive(second, 17000)).toBe("ignored");
      expect(receiver.retainedBytes).toBe(32768);
      expect(receiver.nextDeadline()).toBe(5000);
      expect(applied).toEqual([]);
      expect(acks).toEqual([1]);

      expect(receiver.tick()).toBe("stalled");
      expect(receiver.retainedBytes).toBe(0);
      expect(receiver.nextDeadline()).toBeNull();
    },
  );

  it("stalls a matching frame at the exact progress deadline without accepting it", () => {
    const { receiver, time, applied } = harness();
    const first = chunk({ count: 2, totalBytes: 32768, data: new Uint8Array(16384) });
    expect(receiver.receive(first, 17000)).toBe("accepted");
    time(5000);
    expect(receiver.receive(chunk({ ...first, sequence: 2, index: 1 }), 17000)).toBe("stalled");
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.nextDeadline()).toBeNull();
    expect(applied).toEqual([]);
  });

  it("expires at 5 seconds before issuing a pending delayed acknowledgement", () => {
    const { receiver, time, acks } = harness();
    receiver.receive(partial(), 17000);
    time(5000);
    expect(receiver.tick()).toBe("stalled");
    expect(acks).toEqual([]);
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.receive(partial({ sequence: 2, index: 1 }), 17000)).toBe("stalled");
  });

  it("cannot extend total deadline beyond 15 seconds with real progress", () => {
    const { receiver, time } = harness();
    receiver.receive(partial(), 17000);
    for (const [at, sequence, index] of [
      [4999, 2, 1],
      [9998, 3, 2],
      [14997, 4, 3],
    ]) {
      time(at!);
      expect(receiver.receive(partial({ sequence, index }), 17000)).toBe("accepted");
      receiver.tick();
    }
    expect(receiver.nextDeadline()).toBe(15000);
    time(15000);
    expect(receiver.receive(partial({ sequence: 5, index: 4 }), 17000)).toBe("stalled");
    expect(receiver.retainedBytes).toBe(0);
  });

  it("history progress cannot postpone a stalled screen", () => {
    const { receiver, time } = harness();
    receiver.receive(partial(), 17000);
    time(4999);
    receiver.receive(
      partial({ sequence: 2, transferId: otherId, count: 4, totalBytes: 65536, meta: history }),
      17000,
    );
    receiver.tick();
    expect(receiver.nextDeadline()).toBe(5000);
    time(5000);
    expect(receiver.tick()).toBe("stalled");
    expect(receiver.retainedBytes).toBe(0);
  });

  it("propagates accept failure, releases both lanes and never acknowledges the rejected final frame", () => {
    const failure = new Error("invalid decoded terminal record");
    const { receiver, acks, time } = harness({
      accept: () => {
        throw failure;
      },
    });
    receiver.receive(partial(), 17000);
    receiver.receive(partial({ sequence: 2, index: 1 }), 17000);
    receiver.receive(partial({ sequence: 3, index: 2 }), 17000);
    expect(() =>
      receiver.receive(chunk({ sequence: 4, transferId: otherId, meta: history }), 100),
    ).toThrow(failure);
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.nextDeadline()).toBeNull();
    time(10000);
    expect(receiver.tick()).toBe("closed");
    expect(acks).toEqual([]);
  });

  it.each(["false", "throw"])(
    "ack callback %s stops and releases immediately without retry",
    (mode) => {
      let calls = 0;
      const failure = new Error("ack refused");
      const { receiver, time } = harness({
        acknowledge: () => {
          calls++;
          if (mode === "throw") throw failure;
          return false;
        },
      });
      receiver.receive(partial(), 17000);
      time(500);
      if (mode === "throw") expect(() => receiver.tick()).toThrow(failure);
      else expect(receiver.tick()).toBe("stalled");
      expect(receiver.retainedBytes).toBe(0);
      expect(receiver.nextDeadline()).toBeNull();
      receiver.tick();
      expect(calls).toBe(1);
    },
  );

  it("refusal on the fourth-frame acknowledgement stalls without retaining either lane", () => {
    const { receiver, applied } = harness({ acknowledge: () => false });
    for (let index = 0; index < 3; index++)
      receiver.receive(partial({ sequence: index + 1, index }), 17000);
    expect(
      receiver.receive(
        partial({
          sequence: 4,
          transferId: otherId,
          index: 0,
          count: 4,
          totalBytes: 65536,
          meta: history,
        }),
        17000,
      ),
    ).toBe("stalled");
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.nextDeadline()).toBeNull();
    expect(applied).toEqual([]);
  });

  it("cancel midway suppresses delayed acknowledgements and a fresh subscription ignores old data", () => {
    const { receiver, acks, applied, time } = harness();
    receiver.receive(partial(), 17000);
    receiver.cancel();
    receiver.cancel();
    time(10000);
    expect(receiver.tick()).toBe("closed");
    expect(receiver.receive(chunk({ sequence: 2 }), 100)).toBe("ignored");
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.nextDeadline()).toBeNull();
    expect(acks).toEqual([]);
    expect(applied).toEqual([]);
    const fresh = harness({ subscription: otherId });
    expect(fresh.receiver.receive(chunk(), 100)).toBe("ignored");
    expect(fresh.receiver.receive(chunk({ subscriptionId: otherId }), 100)).toBe("accepted");
    expect(fresh.applied).toHaveLength(1);
  });

  it("accept may cancel synchronously without acknowledging the final frame or retaining another lane", () => {
    let calls = 0;
    const { receiver, acks, time } = harness({
      accept: () => {
        calls++;
        receiver.cancel();
      },
    });
    receiver.receive(partial(), 17000);
    receiver.receive(partial({ sequence: 2, index: 1 }), 17000);
    receiver.receive(partial({ sequence: 3, index: 2 }), 17000);
    receiver.receive(chunk({ sequence: 4, transferId: otherId, meta: history }), 100);
    expect(calls).toBe(1);
    expect(receiver.retainedBytes).toBe(0);
    expect(receiver.nextDeadline()).toBeNull();
    time(10000);
    expect(receiver.tick()).toBe("closed");
    expect(acks).toEqual([]);
    expect(receiver.receive(chunk({ sequence: 5 }), 100)).toBe("ignored");
    expect(calls).toBe(1);
  });

  it.each([true, false])(
    "acknowledge may cancel synchronously and return %s without resurrecting pending work",
    (accepted) => {
      let calls = 0;
      const { receiver, time } = harness({
        acknowledge: () => {
          calls++;
          receiver.cancel();
          return accepted;
        },
      });
      receiver.receive(partial(), 17000);
      time(500);
      expect(receiver.tick()).toBe("closed");
      expect(receiver.retainedBytes).toBe(0);
      expect(receiver.nextDeadline()).toBeNull();
      time(10000);
      expect(receiver.tick()).toBe("closed");
      expect(calls).toBe(1);
    },
  );

  it("one stalled pair cannot prevent a healthy pair from completing a maximum transfer", () => {
    expect(protocol).toHaveProperty("StreamSender");
    let now = 0;
    function pair(id: string) {
      const pending: StreamChunk[] = [];
      const applied: Uint8Array[] = [];
      const sender = new protocol.StreamSender({
        subscriptionId: id,
        sessionId,
        now: () => now,
        newTransferId: () => transferId,
        send: (frame) => {
          pending.push(frame);
          return true;
        },
      });
      const receiver = new protocol.StreamReceiver({
        subscriptionId: id,
        sessionId,
        now: () => now,
        accept: (_meta, bytes) => {
          applied.push(bytes);
        },
        acknowledge: (through) => sender.acknowledge(id, through) === "advanced",
      });
      return { sender, receiver, pending, applied };
    }
    const stalled = pair(subscriptionId);
    const healthy = pair(otherId);
    stalled.sender.offer(screen, new Uint8Array(524288));
    stalled.sender.pump();
    stalled.receiver.receive(stalled.pending.shift()!, 17000);
    now = 5000;
    expect(stalled.sender.tick()).toBe("stalled");
    expect(stalled.receiver.tick()).toBe("stalled");
    const bytes = new Uint8Array(524288).fill(23);
    healthy.sender.offer(screen, bytes);
    while (healthy.sender.retainedBytes > 0) {
      expect(healthy.sender.pump()).toBe(4);
      for (const frame of healthy.pending.splice(0))
        expect(healthy.receiver.receive(frame, 17000)).toBe("accepted");
      expect(healthy.sender.inFlight).toBe(0);
    }
    expect(healthy.applied).toEqual([bytes]);
    expect(healthy.receiver.retainedBytes).toBe(0);
    expect(stalled.sender.retainedBytes).toBe(0);
    expect(stalled.receiver.retainedBytes).toBe(0);
  });
});
