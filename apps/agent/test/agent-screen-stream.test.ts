import {
  applyStreamScreen,
  decodeStreamScreen,
  encodeCbor,
  type InnerMessageOf,
  STREAM_LIMITS,
  type StreamChunk,
  StreamReceiver,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentScreenStream } from "../src/agent-screen-stream.js";
import { createLogger } from "../src/log.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { WireScheduler } from "../src/wire-scheduler.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const subscriptionId = "A".repeat(22);
const secondSubscriptionId = "C".repeat(22);
const transferId = "B".repeat(22);

function snapshot(gen = 1, rows = 3, text = "a"): InnerMessageOf<"screen.snapshot"> {
  return {
    type: "screen.snapshot",
    sessionId: "S",
    cols: Math.max(3, text.length),
    rows,
    cursor: { x: 0, y: rows - 1 },
    scrollbackTotal: 10,
    gen,
    lines: Array.from({ length: rows }, () => ({ r: [{ t: text }] })),
  };
}

function context(generation = 1, capture?: Readonly<object>) {
  return Object.freeze({ generation, reported: 10, historyRequested: true, capture });
}

function fixture(overrides: Partial<ConstructorParameters<typeof AgentScreenStream>[0]> = {}) {
  let now = 0;
  const chunks: StreamChunk[] = [];
  const controls: unknown[] = [];
  const closed: string[] = [];
  let requests = 0;
  let nextId = 0;
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => now,
    newTransferId: () => (nextId++ === 0 ? transferId : "D".repeat(22)),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
    requestSnapshot: () => {
      requests++;
    },
    onClosed: (reason) => {
      closed.push(reason);
    },
    ...overrides,
  });
  return {
    stream,
    chunks,
    controls,
    closed,
    requests: () => requests,
    at: (value: number) => {
      now = value;
    },
  };
}

it("binds the first snapshot capture only after complete ACK", () => {
  const chunks: StreamChunk[] = [];
  const capture = Object.freeze({});
  const subscriptionId = "A".repeat(22);
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    newTransferId: () => "B".repeat(22),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: () => {},
  });
  const snapshot: InnerMessageOf<"screen.snapshot"> = {
    type: "screen.snapshot",
    sessionId: "S",
    cols: 3,
    rows: 3,
    cursor: { x: 0, y: 2 },
    scrollbackTotal: 10,
    gen: 1,
    lines: ["a", "b", "c"].map((t) => ({ r: [{ t }] })),
  };
  const context = Object.freeze({ generation: 1, reported: 10, historyRequested: true, capture });
  expect(stream.offer(snapshot, context)).toBe(true);
  expect(stream.historyAnchor()).toBeUndefined();
  expect(stream.sendOne()).toBe(true);
  expect(chunks).toHaveLength(1);
  expect(stream.historyAnchor()).toBeUndefined();
  stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
  expect(stream.historyAnchor()).toMatchObject({ generation: 1, reported: 10 });
  expect(stream.historyAnchor()?.capture).toBe(capture);
  expect(Object.isFrozen(stream.historyAnchor())).toBe(true);
  stream.cancel();
});

describe("screen stream reconstruction and flow control", () => {
  it("sends one actual chunk per call and binds authority only after all chunks are ACKed", () => {
    const f = fixture();
    const capture = Object.freeze({ token: "first" });
    const large = snapshot(1, 160, "界".repeat(450));
    large.lines[0] = { r: [{ t: "界".repeat(450), fg: [255, 170, 0] }] };
    expect(f.stream.offer(large, context(1, capture))).toBe(true);
    expect(f.chunks).toHaveLength(0);
    for (let i = 0; i < STREAM_LIMITS.unacked; i++) {
      expect(f.stream.sendOne()).toBe(true);
      expect(f.chunks).toHaveLength(i + 1);
    }
    expect(f.stream.sendOne()).toBe(false);
    expect(f.chunks).toHaveLength(STREAM_LIMITS.unacked);
    expect(f.stream.historyAnchor()).toBeUndefined();
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    expect(f.stream.historyAnchor()).toBeUndefined();
    let acknowledged = 2;
    const count = f.chunks[0]?.count ?? 0;
    while (f.chunks.length < count) {
      while (f.stream.sendOne()) {
        /* fill available credit */
      }
      const through = Math.min(f.chunks.length - 1, count - 1);
      if (through > acknowledged) {
        f.stream.receive({ type: "stream.ack", subscriptionId, through }, 128);
        acknowledged = through;
      }
    }
    expect(f.chunks.length).toBeGreaterThan(STREAM_LIMITS.unacked);
    expect(f.stream.historyAnchor()).toBeUndefined();
    f.stream.receive({ type: "stream.ack", subscriptionId, through: f.chunks.length }, 128);
    expect(f.stream.historyAnchor()).toEqual({ generation: 1, reported: 10, capture });
  });

  it("reconstructs styled Unicode snapshot and following diff through a real receiver", () => {
    const delivered: StreamChunk[] = [];
    const f = fixture({
      sendChunk: (chunk) => {
        delivered.push(chunk);
        return true;
      },
    });
    let displayed: ReturnType<typeof snapshot> | undefined;
    const peer = new StreamReceiver({
      subscriptionId,
      sessionId: "S",
      now: () => 0,
      accept: (meta, bytes) => {
        const applied = applyStreamScreen(displayed, decodeStreamScreen(meta, bytes));
        expect(applied.ok).toBe(true);
        if (applied.ok) displayed = applied.screen as ReturnType<typeof snapshot>;
      },
      acknowledge: () => true,
    });
    const styled = snapshot();
    styled.lines[0] = { r: [{ t: "界", fg: [255, 170, 0] }] };
    expect(f.stream.offer(styled, context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    for (const chunk of delivered.splice(0)) expect(peer.receive(chunk, 128)).toBe("accepted");
    expect(displayed?.lines[0]).toEqual(styled.lines[0]);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    const diff: InnerMessageOf<"screen.diff"> = {
      type: "screen.diff",
      sessionId: "S",
      gen: 2,
      scroll: 0,
      changed: [{ i: 0, line: { r: [{ t: "é", fg: [0, 255, 0] }] } }],
      cursor: { x: 1, y: 0 },
      scrollbackTotal: 10,
    };
    expect(f.stream.offer(diff, context(2))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    for (const chunk of delivered.splice(0)) expect(peer.receive(chunk, 128)).toBe("accepted");
    expect(displayed?.gen).toBe(2);
    expect(displayed?.lines[0]).toEqual(diff.changed[0]?.line);
  });

  it("refused chunks retain position, and callback cancellation still reports an admitted chunk", () => {
    const chunks: StreamChunk[] = [];
    let accept = false;
    const f = fixture({
      sendChunk: (chunk) => {
        chunks.push(chunk);
        return accept;
      },
    });
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(false);
    accept = true;
    expect(f.stream.sendOne()).toBe(true);
    expect(chunks.map((chunk) => chunk.sequence)).toEqual([1, 1]);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 0]);

    let stream: AgentScreenStream;
    const cancel = fixture({
      sendChunk: () => {
        stream.cancel();
        return true;
      },
    });
    stream = cancel.stream;
    expect(stream.offer(snapshot(), context())).toBe(true);
    expect(stream.sendOne()).toBe(true);
    expect(stream.sendOne()).toBe(false);
    expect(cancel.closed).toEqual(["cancelled"]);
  });

  it("delegates actual envelope admission to the transport callback", () => {
    let capacity = 0;
    const f = fixture({
      sendChunk: (chunk) => encodeCbor(chunk).length <= capacity,
    });
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(false);
    capacity = STREAM_LIMITS.envelopeBytes;
    expect(f.stream.sendOne()).toBe(true);
  });

  it("uses a shared scheduler fairly across two subscriptions", () => {
    let now = 0;
    const order: string[] = [];
    const scheduler = new WireScheduler({ now: () => now, maxFramesPerSecond: 1 });
    const a = fixture({
      sendChunk: () => {
        order.push("a");
        return true;
      },
    });
    const b = fixture({
      subscriptionId: secondSubscriptionId,
      sendChunk: () => {
        order.push("b");
        return true;
      },
    });
    expect(a.stream.offer(snapshot(1, 160, "x".repeat(450)), context())).toBe(true);
    expect(b.stream.offer(snapshot(1, 160, "y".repeat(450)), context())).toBe(true);
    scheduler.register("a", () => a.stream.sendOne());
    scheduler.register("b", () => b.stream.sendOne());
    now = 1000;
    expect(scheduler.pump()).toBe(1);
    now = 2000;
    expect(scheduler.pump()).toBe(1);
    expect(order).toEqual(["a", "b"]);
  });

  it("lets the real tracker retry a refused pending frame after screen lane release", async () => {
    vi.useFakeTimers();
    const backend = new FakeBackend();
    backend.addSession("S", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
    const f = fixture();
    const offered: { generation: number; accepted: boolean }[] = [];
    const tracker = new ScreenTracker({
      backend,
      log: createLogger({ stdout: false }),
      now: () => Date.now(),
      sink: (_connection, message, frameContext) => {
        if (message.type !== "screen.snapshot" && message.type !== "screen.diff") return;
        const accepted = f.stream.offer(message, frameContext);
        offered.push({ generation: frameContext.generation, accepted });
        return accepted;
      },
    });
    try {
      tracker.start();
      tracker.setViewed("phone", "S", { history: true });
      await vi.advanceTimersByTimeAsync(125);
      expect(offered[0]).toEqual({ generation: 1, accepted: true });
      backend.appendLine("S", "d");
      await vi.advanceTimersByTimeAsync(125);
      expect(offered.some((offer) => !offer.accepted)).toBe(true);
      expect(f.stream.sendOne()).toBe(true);
      f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
      await vi.advanceTimersByTimeAsync(125);
      expect(offered.at(-1)?.accepted).toBe(true);
      expect(offered.at(-1)?.generation).toBeGreaterThan(1);
    } finally {
      tracker.stop();
      vi.useRealTimers();
    }
  });
});

describe("history authority and subscription identity", () => {
  it("requests one full snapshot after diff encoding fails, then recovers with its replacement", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    const invalidDiff: InnerMessageOf<"screen.diff"> = {
      type: "screen.diff",
      sessionId: "S",
      gen: 2,
      scroll: 0,
      changed: [
        { i: 0, line: { r: [{ t: "a" }] } },
        { i: 0, line: { r: [{ t: "b" }] } },
      ],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 10,
    };
    expect(f.stream.offer(invalidDiff, context(2))).toBe(false);
    expect(f.stream.offer(invalidDiff, context(2))).toBe(false);
    expect(f.requests()).toBe(1);
    expect(f.closed).toEqual([]);
    expect(f.stream.offer(snapshot(2), context(2))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    expect(f.stream.historyAnchor()?.generation).toBe(1);
    expect(f.closed).toEqual([]);
  });

  it("closes if a requested replacement snapshot itself cannot encode", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    const invalidDiff: InnerMessageOf<"screen.diff"> = {
      type: "screen.diff",
      sessionId: "S",
      gen: 2,
      scroll: 0,
      changed: [
        { i: 0, line: { r: [{ t: "a" }] } },
        { i: 0, line: { r: [{ t: "b" }] } },
      ],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 10,
    };
    expect(f.stream.offer(invalidDiff, context(2))).toBe(false);
    expect(f.requests()).toBe(1);
    const invalidSnapshot = snapshot(2);
    invalidSnapshot.lines = [{ r: [{ t: "only one row" }] }];
    expect(f.stream.offer(invalidSnapshot, context(2))).toBe(false);
    expect(f.closed).toEqual(["invalid-transfer"]);
    expect(f.stream.historyAnchor()).toBeUndefined();
  });

  it("keeps an unavailable first baseline unavailable after later snapshots", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    expect(f.stream.historyAnchor()).toEqual({ generation: 1, reported: 10 });
    const later = Object.freeze({ token: "later" });
    expect(f.stream.offer(snapshot(3), context(3, later))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    expect(f.stream.historyAnchor()).toEqual({ generation: 1, reported: 10 });
    f.stream.cancel();
    expect(f.stream.historyAnchor()).toBeUndefined();
  });

  it("refuses old and equal generations; refresh permits one equal-generation snapshot", () => {
    const f = fixture();
    const first = Object.freeze({ token: "first" });
    expect(f.stream.offer(snapshot(), context(1, first))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    expect(f.stream.offer(snapshot(0), context(0))).toBe(false);
    expect(f.stream.offer(snapshot(), context())).toBe(false);
    expect(
      f.stream.offer(
        {
          type: "screen.diff",
          sessionId: "S",
          gen: 3,
          scroll: 0,
          changed: [],
          cursor: { x: 0, y: 0 },
          scrollbackTotal: 10,
        },
        context(3),
      ),
    ).toBe(false);
    expect(f.requests()).toBe(1);
    f.stream.receive({ type: "stream.refresh", subscriptionId: secondSubscriptionId }, 128);
    expect(f.requests()).toBe(1);
    f.stream.receive({ type: "stream.refresh", subscriptionId }, 128);
    f.stream.receive({ type: "stream.refresh", subscriptionId }, 128);
    expect(f.requests()).toBe(1);
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    expect(f.stream.historyAnchor()?.capture).toBe(first);
    f.stream.receive({ type: "stream.refresh", subscriptionId }, 128);
    expect(f.requests()).toBe(2);
  });

  it("latches unusable initial diffs and accepts a skipped-generation full snapshot", () => {
    const f = fixture();
    const diff: InnerMessageOf<"screen.diff"> = {
      type: "screen.diff",
      sessionId: "S",
      gen: 1,
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 10,
    };
    expect(f.stream.offer(diff, context())).toBe(false);
    expect(f.stream.offer(diff, context())).toBe(false);
    expect(f.requests()).toBe(1);
    expect(f.stream.offer(snapshot(4), context(4))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    expect(f.stream.historyAnchor()?.generation).toBe(4);
  });

  it("keeps one refresh request through an active transfer and accepts its equal generation", () => {
    const f = fixture();
    const first = Object.freeze({ token: "first" });
    expect(f.stream.offer(snapshot(), context(1, first))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    const diff: InnerMessageOf<"screen.diff"> = {
      type: "screen.diff",
      sessionId: "S",
      gen: 2,
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 10,
    };
    expect(f.stream.offer(diff, context(2))).toBe(true);
    f.stream.receive({ type: "stream.refresh", subscriptionId }, 128);
    f.stream.receive({ type: "stream.refresh", subscriptionId }, 128);
    expect(f.requests()).toBe(1);
    expect(f.stream.offer(snapshot(2), context(2))).toBe(false);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    expect(f.stream.offer(snapshot(2), context(2, Object.freeze({ token: "later" })))).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 3 }, 128);
    expect(f.stream.historyAnchor()?.capture).toBe(first);
    expect(f.stream.offer(snapshot(2), context(2))).toBe(false);
  });

  it("ignores stale subscription messages and closes on future or malformed current ACKs", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId: secondSubscriptionId, through: 999 }, 0);
    f.stream.receive({ type: "stream.cancel", subscriptionId: secondSubscriptionId }, 0);
    expect(f.closed).toEqual([]);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    expect(f.closed).toEqual([]);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    expect(f.closed).toEqual(["invalid-transfer"]);
    expect(f.controls).toEqual([
      { type: "stream.error", subscriptionId, code: "invalid-transfer" },
    ]);
    f.stream.receive({ type: "stream.cancel", subscriptionId }, 128);
    expect(f.closed).toHaveLength(1);
  });

  it.each([0, -1, 1.5, STREAM_LIMITS.envelopeBytes + 1])(
    "rejects invalid original envelope length %s",
    (bytes) => {
      const f = fixture();
      f.stream.receive({ type: "stream.refresh", subscriptionId }, bytes);
      expect(f.closed).toEqual(["invalid-transfer"]);
    },
  );

  it("rejects current non-screen messages without granting history capability", () => {
    const f = fixture();
    f.stream.receive(
      {
        type: "stream.history.get",
        subscriptionId,
        requestId: transferId,
        before: 10,
        count: 1,
      },
      128,
    );
    expect(f.closed).toEqual(["invalid-transfer"]);
  });

  it("rejects malformed current ACK and mismatched frame coordinates", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context(2))).toBe(false);
    expect(f.stream.offer({ ...snapshot(), sessionId: "other" }, context())).toBe(false);
    expect(f.stream.offer({ ...snapshot(), scrollbackTotal: 11 }, context())).toBe(false);
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 0 } as never, 128);
    expect(f.closed).toEqual(["invalid-transfer"]);
  });

  it("does not retain a failed snapshot's capture or encode a busy offer", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    const busy = snapshot(2);
    busy.lines = [{ r: [{ t: "x" }] }];
    expect(f.stream.offer(busy, context(2, Object.freeze({ token: "busy" })))).toBe(false);
    expect(f.closed).toEqual([]);
    f.stream.cancel();
    expect(f.stream.historyAnchor()).toBeUndefined();
    const oversized = fixture();
    expect(
      oversized.stream.offer(
        snapshot(1, STREAM_LIMITS.rows + 1),
        context(1, Object.freeze({ token: "oversized" })),
      ),
    ).toBe(false);
    expect(oversized.closed).toEqual(["screen-too-large"]);
    expect(oversized.stream.historyAnchor()).toBeUndefined();
  });
});

describe("deadlines and callback faults", () => {
  it.each(["sendOne", "acknowledge"])(
    "reconciles a helper stall occurring between controller and %s clock reads",
    (operation) => {
      const now = 0;
      let step = false;
      let reads = 0;
      const f = fixture({
        now: () => {
          if (!step) return now;
          return reads++ === 0 ? STREAM_LIMITS.progressMs - 1 : STREAM_LIMITS.progressMs;
        },
      });
      expect(f.stream.offer(snapshot(1, 160, "界".repeat(450)), context())).toBe(true);
      expect(f.stream.sendOne()).toBe(true);
      step = true;
      if (operation === "sendOne") expect(f.stream.sendOne()).toBe(false);
      else f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
      expect(reads).toBeGreaterThanOrEqual(2);
      expect(f.closed).toEqual(["stalled"]);
      expect(f.stream.nextDeadline()).toBeNull();
      expect(f.stream.historyAnchor()).toBeUndefined();
      f.stream.tick();
      expect(f.closed).toHaveLength(1);
      expect(f.controls).toEqual([{ type: "stream.error", subscriptionId, code: "stalled" }]);
    },
  );

  it("retains the constructor's copied transfer-ID callback after caller mutation", () => {
    const chunks: StreamChunk[] = [];
    const originalId = "B".repeat(22);
    const mutatedId = "D".repeat(22);
    const options: ConstructorParameters<typeof AgentScreenStream>[0] = {
      subscriptionId,
      sessionId: "S",
      now: () => 0,
      newTransferId: () => originalId,
      sendChunk: (chunk) => {
        chunks.push(chunk);
        return true;
      },
      sendControl: () => true,
      requestSnapshot: () => {},
      onClosed: () => {},
    };
    const stream = new AgentScreenStream(options);
    options.newTransferId = () => mutatedId;
    expect(stream.offer(snapshot(), context())).toBe(true);
    expect(stream.sendOne()).toBe(true);
    expect(chunks[0]?.transferId).toBe(originalId);
  });

  it("rejects invalid constructor identities and initial clock", () => {
    expect(() => fixture({ subscriptionId: "bad" })).toThrow("Invalid screen stream identity");
    expect(() => fixture({ sessionId: "" })).toThrow("Invalid screen stream identity");
    expect(() => fixture({ now: () => Number.POSITIVE_INFINITY })).toThrow(
      "Invalid screen stream clock",
    );
  });

  it("expires the initial deadline exactly at five seconds", () => {
    const f = fixture();
    expect(f.stream.nextDeadline()).toBe(STREAM_LIMITS.progressMs);
    f.at(STREAM_LIMITS.progressMs - 1);
    f.stream.tick();
    expect(f.closed).toEqual([]);
    f.at(STREAM_LIMITS.progressMs);
    f.stream.tick();
    expect(f.closed).toEqual(["stalled"]);
    expect(f.stream.nextDeadline()).toBeNull();
    f.stream.tick();
    expect(f.controls).toHaveLength(1);
  });

  it("does not extend a refusal deadline with repeated send or repaint offers", () => {
    const f = fixture({ sendChunk: () => false });
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    f.at(100);
    expect(f.stream.sendOne()).toBe(false);
    expect(f.stream.nextDeadline()).toBe(STREAM_LIMITS.progressMs);
    f.at(1000);
    expect(f.stream.sendOne()).toBe(false);
    expect(f.stream.offer(snapshot(2), context(2))).toBe(false);
    f.at(STREAM_LIMITS.progressMs);
    f.stream.tick();
    expect(f.closed).toEqual(["stalled"]);
  });

  it("starts a new refusal deadline after an admitted chunk and preserves it", () => {
    let accept = true;
    const f = fixture({ sendChunk: () => accept });
    expect(f.stream.offer(snapshot(1, 160, "界".repeat(450)), context())).toBe(true);
    expect(f.stream.sendOne()).toBe(true);
    accept = false;
    f.at(100);
    expect(f.stream.sendOne()).toBe(false);
    expect(f.stream.nextDeadline()).toBe(STREAM_LIMITS.progressMs);
    f.at(1000);
    expect(f.stream.sendOne()).toBe(false);
    f.at(STREAM_LIMITS.progressMs);
    f.stream.tick();
    expect(f.closed).toEqual(["stalled"]);
  });

  it("uses helper progress deadline after first admission and no idle deadline after ACK", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    f.at(1000);
    expect(f.stream.sendOne()).toBe(true);
    expect(f.stream.nextDeadline()).toBe(1000 + STREAM_LIMITS.progressMs);
    f.at(5999);
    f.stream.tick();
    expect(f.closed).toEqual([]);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    expect(f.stream.nextDeadline()).toBeNull();
  });

  it("stalls active transfer at the helper's progress deadline", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(), context())).toBe(true);
    f.at(100);
    expect(f.stream.sendOne()).toBe(true);
    f.at(100 + STREAM_LIMITS.progressMs);
    f.stream.tick();
    expect(f.closed).toEqual(["stalled"]);
  });

  it("stalls at the helper's total deadline despite ACK progress", () => {
    const f = fixture();
    expect(f.stream.offer(snapshot(1, 160, "界".repeat(450)), context())).toBe(true);
    f.at(100);
    for (let i = 0; i < 4; i++) expect(f.stream.sendOne()).toBe(true);
    f.at(4000);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
    f.at(8000);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 4 }, 128);
    f.at(12000);
    expect(f.stream.sendOne()).toBe(true);
    f.stream.receive({ type: "stream.ack", subscriptionId, through: 5 }, 128);
    expect(f.stream.nextDeadline()).toBe(100 + STREAM_LIMITS.totalMs);
    f.at(100 + STREAM_LIMITS.totalMs - 1);
    f.stream.tick();
    expect(f.closed).toEqual([]);
    f.at(100 + STREAM_LIMITS.totalMs);
    f.stream.tick();
    expect(f.closed).toEqual(["stalled"]);
  });

  it("contains recursive sendOne without a second transport attempt", () => {
    let stream: AgentScreenStream;
    let calls = 0;
    const f = fixture({
      sendChunk: () => {
        calls++;
        expect(stream.sendOne()).toBe(false);
        return true;
      },
    });
    stream = f.stream;
    expect(stream.offer(snapshot(), context())).toBe(true);
    expect(stream.sendOne()).toBe(true);
    expect(calls).toBe(1);
  });

  it.each(["throw", "nonboolean"])(
    "closes and throws a payload-free error on uncertain %s chunk admission",
    (fault) => {
      const f = fixture({
        sendChunk: () => {
          if (fault === "throw") throw new Error("secret viewport payload");
          return undefined as unknown as boolean;
        },
      });
      expect(f.stream.offer(snapshot(), context())).toBe(true);
      expect(() => f.stream.sendOne()).toThrow("Screen stream send failed");
      expect(f.closed).toEqual(["invalid-transfer"]);
      expect(f.stream.nextDeadline()).toBeNull();
      expect(f.stream.historyAnchor()).toBeUndefined();
    },
  );

  it("contains rejected asynchronous callback values and closed-state reentrancy", async () => {
    let stream: AgentScreenStream;
    const f = fixture({
      sendChunk: () => Promise.reject(new Error("secret")) as unknown as boolean,
      sendControl: () => {
        stream.cancel();
        return Promise.reject(new Error("control")) as unknown as boolean;
      },
      onClosed: () => Promise.reject(new Error("observer")),
    });
    stream = f.stream;
    expect(stream.offer(snapshot(), context())).toBe(true);
    expect(() => stream.sendOne()).toThrow("Screen stream send failed");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stream.sendOne()).toBe(false);
    expect(stream.historyAnchor()).toBeUndefined();
  });

  it("closes on a rejected snapshot request only while still open", async () => {
    const f = fixture({ requestSnapshot: () => Promise.reject(new Error("request")) });
    const diff: InnerMessageOf<"screen.diff"> = {
      type: "screen.diff",
      sessionId: "S",
      gen: 1,
      scroll: 0,
      changed: [],
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 10,
    };
    expect(f.stream.offer(diff, context())).toBe(false);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.closed).toEqual(["invalid-transfer"]);
    const cancelled = fixture({ requestSnapshot: () => Promise.reject(new Error("late")) });
    expect(cancelled.stream.offer(diff, context())).toBe(false);
    cancelled.stream.cancel();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(cancelled.closed).toEqual(["cancelled"]);
  });

  it("closes after a post-construction clock or transfer-ID failure", () => {
    let now = 0;
    const clock = fixture({ now: () => now });
    now = Number.NaN;
    clock.stream.tick();
    expect(clock.closed).toEqual(["invalid-transfer"]);
    const id = fixture({
      newTransferId: () => {
        throw new Error("secret");
      },
    });
    expect(id.stream.offer(snapshot(), context())).toBe(false);
    expect(id.closed).toEqual(["invalid-transfer"]);
  });
});
