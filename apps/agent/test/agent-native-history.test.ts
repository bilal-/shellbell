import {
  decodeStreamHistory,
  decodeStreamScreen,
  type InnerMessageOf,
  STREAM_LIMITS,
  type StreamChunk,
  StreamReceiver,
} from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import {
  AgentScreenStream,
  type AgentScreenStreamOptions,
  type AgentStreamHistoryOptions,
} from "../src/agent-screen-stream.js";
import {
  type HistoryReadRequest,
  type HistoryReadResult,
  SessionGone,
} from "../src/backends/types.js";

const subscriptionId = "A".repeat(22);
const requestId = "C".repeat(22);
const otherId = "D".repeat(22);
const thirdId = "E".repeat(22);

function snapshot(gen = 1, rows = 3, text = "a", reported = 10): InnerMessageOf<"screen.snapshot"> {
  return {
    type: "screen.snapshot",
    sessionId: "S",
    gen,
    scrollbackTotal: reported,
    cols: Math.max(3, text.length),
    rows,
    cursor: { x: 0, y: rows - 1 },
    lines: Array.from({ length: rows }, () => ({ r: [{ t: text }] })),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fixture(
  read: (sessionId: string, request: HistoryReadRequest) => Promise<HistoryReadResult>,
  overrides: Partial<AgentScreenStreamOptions> = {},
) {
  let now = 0;
  let transfer = 0;
  const chunks: StreamChunk[] = [];
  const controls: unknown[] = [];
  const closed: string[] = [];
  const capture = Object.freeze({ token: "first" });
  const onReady = vi.fn();
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => now,
    newTransferId: () => String.fromCharCode(66 + transfer++).repeat(22),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
    requestSnapshot: () => {},
    onClosed: (reason) => {
      closed.push(reason);
    },
    history: { read, onReady },
    ...overrides,
  });
  const offerInitial = (withCapture = true) => {
    expect(
      stream.offer(snapshot(), {
        generation: 1,
        reported: 10,
        historyRequested: true,
        ...(withCapture ? { capture } : {}),
      }),
    ).toBe(true);
  };
  const ackInitial = () => {
    expect(stream.sendOne()).toBe(true);
    stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
  };
  const get = (id = requestId, before = 10, count = 2) =>
    stream.receive(
      { type: "stream.history.get", subscriptionId, requestId: id, before, count },
      128,
    );
  return {
    stream,
    chunks,
    controls,
    closed,
    capture,
    onReady,
    offerInitial,
    ackInitial,
    get,
    at: (value: number) => {
      now = value;
    },
  };
}

const twoRows: HistoryReadResult = {
  status: "page",
  from: 8,
  to: 10,
  oldestAvailable: 0,
  lines: [{ r: [{ t: "older" }] }, { r: [{ t: "newer" }] }],
};

it("reads native history from the first fully ACKed snapshot anchor", () => {
  const read = vi.fn(
    async (_sessionId: string, _request: HistoryReadRequest): Promise<HistoryReadResult> => ({
      status: "unavailable",
      reason: "busy",
    }),
  );
  const capture = Object.freeze({});
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    newTransferId: () => "B".repeat(22),
    sendChunk: () => true,
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: () => {},
    history: { read, onReady: () => {} },
  });
  const snapshot: InnerMessageOf<"screen.snapshot"> = {
    type: "screen.snapshot",
    sessionId: "S",
    gen: 1,
    scrollbackTotal: 10,
    cols: 3,
    rows: 3,
    cursor: { x: 0, y: 2 },
    lines: ["a", "b", "c"].map((t) => ({ r: [{ t }] })),
  };
  expect(
    stream.offer(snapshot, { generation: 1, reported: 10, historyRequested: true, capture }),
  ).toBe(true);
  expect(stream.sendOne()).toBe(true);
  stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
  stream.receive(
    { type: "stream.history.get", subscriptionId, requestId, before: 10, count: 2 },
    128,
  );
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[1]).toMatchObject({ capture, reported: 10, before: 10, count: 2 });
});

it("reconstructs a native page with the first ACKed generation after later live output", async () => {
  const read = vi.fn(async (_sessionId: string, _request: HistoryReadRequest) => twoRows);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  expect(
    f.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
  f.get();
  await Promise.resolve();
  expect(f.onReady).toHaveBeenCalledTimes(1);
  expect(f.stream.sendOne()).toBe(true);
  const chunk = f.chunks[2];
  expect(chunk?.meta).toEqual({ kind: "history", generation: 1, requestId, before: 10 });
  let record: ReturnType<typeof decodeStreamHistory> | undefined;
  const peer = new StreamReceiver({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    accept: (meta, bytes) => {
      if (meta.kind === "history") record = decodeStreamHistory(meta, bytes);
      else decodeStreamScreen(meta, bytes);
    },
    acknowledge: () => true,
  });
  for (const sent of f.chunks) expect(peer.receive(sent, 128)).toBe("accepted");
  expect(record).toMatchObject({
    kind: "history",
    generation: 1,
    requestId,
    before: 10,
    status: "page",
    from: 8,
    to: 10,
    nextBefore: 8,
    lines: twoRows.lines,
  });
  expect(read.mock.calls[0]?.[1]).toMatchObject({ capture: f.capture, reported: 10, before: 10 });
});

it("keeps a history read occupied until its chunk is ACKed, independent of a later screen ACK", async () => {
  const read = vi.fn(async (_sessionId: string, _request: HistoryReadRequest) => twoRows);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(f.stream.sendOne()).toBe(true);
  expect(
    f.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(2);
  expect(f.controls).toEqual([]);
  // History transfer sequence 2 has completed while the later screen sequence 3 remains.
  expect(f.chunks[1]?.meta.kind).toBe("history");
  expect(f.chunks[2]?.meta.kind).toBe("snapshot");
});

it("denies missing anchor, future cursor, and exhausted shared credits without reading", () => {
  const read = vi.fn(async () => twoRows);
  const f = fixture(read);
  f.offerInitial();
  f.get(requestId);
  expect(f.controls).toMatchObject([
    { type: "stream.error", requestId, code: "history-unavailable" },
  ]);
  f.ackInitial();
  f.get(otherId, 11);
  expect(f.controls[1]).toMatchObject({ requestId: otherId, code: "history-unavailable" });
  expect(read).not.toHaveBeenCalled();

  const missing = fixture(read);
  missing.offerInitial(false);
  missing.ackInitial();
  missing.get();
  expect(missing.controls[0]).toMatchObject({ requestId, code: "history-unavailable" });
  expect(
    missing.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: true,
      capture: Object.freeze({ token: "too-late" }),
    }),
  ).toBe(true);
  expect(missing.stream.sendOne()).toBe(true);
  missing.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
  missing.get(otherId);
  expect(missing.controls[1]).toMatchObject({ requestId: otherId, code: "history-unavailable" });

  const full = fixture(read);
  full.offerInitial();
  full.ackInitial();
  expect(
    full.stream.offer(snapshot(2, 160, "界".repeat(450), 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  for (let i = 0; i < STREAM_LIMITS.unacked; i++) expect(full.stream.sendOne()).toBe(true);
  full.get();
  expect(full.controls[0]).toMatchObject({ requestId, code: "history-unavailable" });
  expect(read).not.toHaveBeenCalled();
});

it("deduplicates active and latest IDs while rejecting a different ID during a read", async () => {
  const pending = deferred<HistoryReadResult>();
  const read = vi.fn((_sessionId: string, _request: HistoryReadRequest) => pending.promise);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  f.get();
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.controls).toMatchObject([{ requestId: otherId, code: "history-unavailable" }]);
  pending.resolve({ status: "unavailable", reason: "changed" });
  await Promise.resolve();
  f.get();
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.controls).toMatchObject([
    { requestId: otherId, code: "history-unavailable" },
    { requestId, code: "history-unavailable" },
  ]);
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(2);
});

it("treats an older ID as fresh after another ID becomes the latest settled request", async () => {
  const read = vi.fn(async () => ({ status: "unavailable", reason: "busy" }) as const);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get(requestId);
  await Promise.resolve();
  f.get(otherId);
  await Promise.resolve();
  f.get(requestId);
  expect(read).toHaveBeenCalledTimes(3);
});

it("times out a native read at 15 seconds and leaves live screen viewing usable", async () => {
  const pending = deferred<HistoryReadResult>();
  const read = vi.fn((_sessionId: string, _request: HistoryReadRequest) => pending.promise);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  const signal = read.mock.calls[0]?.[1].signal;
  expect(f.stream.nextDeadline()).toBe(STREAM_LIMITS.totalMs);
  f.at(STREAM_LIMITS.totalMs);
  f.stream.tick();
  expect(signal?.aborted).toBe(true);
  expect(f.controls).toMatchObject([{ requestId, code: "history-unavailable" }]);
  pending.resolve(twoRows);
  await Promise.resolve();
  expect(f.onReady).not.toHaveBeenCalled();
  expect(
    f.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  expect(f.closed).toEqual([]);
});

it("does not overlap another physical read while a timed-out provider promise remains unsettled", async () => {
  const pending = deferred<HistoryReadResult>();
  const read = vi.fn((_sessionId: string, _request: HistoryReadRequest) => pending.promise);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  f.at(STREAM_LIMITS.totalMs);
  f.stream.tick();
  f.get(otherId);
  f.get(thirdId);
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.controls).toMatchObject([
    { requestId, code: "history-unavailable" },
    { requestId: otherId, code: "history-unavailable" },
    { requestId: thirdId, code: "history-unavailable" },
  ]);
  pending.resolve({ status: "cancelled" });
  await Promise.resolve();
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(2);
});

it("latches backend reset while retaining the original anchor across refresh", async () => {
  const read = vi.fn(async () => ({ status: "reset" }) as const);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(f.controls[0]).toMatchObject({ requestId, code: "history-reset" });
  f.stream.receive({ type: "stream.refresh", subscriptionId }, 128);
  const replacement = Object.freeze({ token: "later" });
  expect(
    f.stream.offer(snapshot(2, 3, "a", 100), {
      generation: 2,
      reported: 100,
      historyRequested: true,
      capture: replacement,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
  expect(f.stream.historyAnchor()?.capture).toBe(f.capture);
  f.get(otherId);
  expect(f.controls[1]).toMatchObject({ requestId: otherId, code: "history-reset" });
  expect(read).toHaveBeenCalledTimes(1);
});

it("closes on SessionGone and turns ordinary read rejection into a request error", async () => {
  const gone = fixture(async () => {
    throw new SessionGone("S");
  });
  gone.offerInitial();
  gone.ackInitial();
  gone.get();
  await Promise.resolve();
  expect(gone.closed).toEqual(["session-gone"]);
  const failed = fixture(async () => {
    throw new Error("backend");
  });
  failed.offerInitial();
  failed.ackInitial();
  failed.get();
  await Promise.resolve();
  expect(failed.controls[0]).toMatchObject({ requestId, code: "history-unavailable" });
  expect(failed.closed).toEqual([]);
});

it.each(["unsupported", "unanchored", "busy", "changed", "fetch-window"] as const)(
  "maps native %s to one request-scoped unavailable error",
  async (reason) => {
    const f = fixture(async () => ({ status: "unavailable", reason }));
    f.offerInitial();
    f.ackInitial();
    f.get();
    await Promise.resolve();
    expect(f.controls).toMatchObject([{ requestId, code: "history-unavailable" }]);
    expect(f.closed).toEqual([]);
  },
);

it("maps a current cancelled native result to request-scoped unavailable", async () => {
  const f = fixture(async () => ({ status: "cancelled" }));
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(f.controls).toMatchObject([{ requestId, code: "history-unavailable" }]);
  expect(f.closed).toEqual([]);
});

it("preserves page suffix and emits both native boundary kinds", async () => {
  const oversizedOlder = { r: [{ t: "x".repeat(3000) }, { t: "y".repeat(2000) }] };
  const suffix = fixture(async () => ({
    status: "page",
    from: 8,
    to: 10,
    oldestAvailable: 0,
    lines: [oversizedOlder, { r: [{ t: "newest" }] }],
  }));
  suffix.offerInitial();
  suffix.ackInitial();
  suffix.get();
  await Promise.resolve();
  expect(suffix.controls).toEqual([]);
  expect(suffix.closed).toEqual([]);
  expect(suffix.onReady).toHaveBeenCalledTimes(1);
  expect(suffix.stream.sendOne()).toBe(true);
  const chunk = suffix.chunks[1]!;
  expect(decodeStreamHistory(chunk.meta, chunk.data)).toMatchObject({
    status: "page",
    before: 10,
    from: 9,
    to: 10,
    nextBefore: 9,
    lines: [{ r: [{ t: "newest" }] }],
  });
  const end = fixture(async () => ({ status: "boundary", reason: "end", oldestAvailable: 10 }));
  end.offerInitial();
  end.ackInitial();
  end.get();
  await Promise.resolve();
  expect(end.stream.sendOne()).toBe(true);
  expect(decodeStreamHistory(end.chunks[1]!.meta, end.chunks[1]!.data)).toMatchObject({
    status: "boundary",
    reason: "end",
    before: 10,
    oldestAvailable: 10,
  });
  const truncated = fixture(async () => ({
    status: "boundary",
    reason: "truncated",
    oldestAvailable: 11,
  }));
  truncated.offerInitial();
  truncated.ackInitial();
  truncated.get();
  await Promise.resolve();
  expect(truncated.stream.sendOne()).toBe(true);
  expect(decodeStreamHistory(truncated.chunks[1]!.meta, truncated.chunks[1]!.data)).toMatchObject({
    status: "boundary",
    reason: "truncated",
    before: 10,
    oldestAvailable: 11,
  });
});

it("reports an oversized newest row but closes on malformed page ranges or counts", async () => {
  const huge = fixture(async () => ({
    status: "page",
    from: 9,
    to: 10,
    oldestAvailable: 0,
    lines: [{ r: [{ t: "x".repeat(3000) }, { t: "y".repeat(2000) }] }],
  }));
  huge.offerInitial();
  huge.ackInitial();
  huge.get();
  await Promise.resolve();
  expect(huge.controls[0]).toMatchObject({ requestId, code: "history-line-too-large" });
  expect(huge.closed).toEqual([]);
  const malformed = fixture(async () => ({
    status: "page",
    from: 8,
    to: 9,
    oldestAvailable: 0,
    lines: [{ r: [{ t: "a" }] }, { r: [{ t: "b" }] }],
  }));
  malformed.offerInitial();
  malformed.ackInitial();
  malformed.get();
  await Promise.resolve();
  expect(malformed.closed).toEqual(["invalid-transfer"]);
  const excess = fixture(async () => ({
    status: "page",
    from: 7,
    to: 10,
    oldestAvailable: 0,
    lines: [{ r: [{ t: "a" }] }, { r: [{ t: "b" }] }, { r: [{ t: "c" }] }],
  }));
  excess.offerInitial();
  excess.ackInitial();
  excess.get();
  await Promise.resolve();
  expect(excess.closed).toEqual(["invalid-transfer"]);
  const badOutcome = fixture(
    async () => ({ status: "unavailable", reason: "made-up" }) as unknown as HistoryReadResult,
  );
  badOutcome.offerInitial();
  badOutcome.ackInitial();
  badOutcome.get();
  await Promise.resolve();
  expect(badOutcome.closed).toEqual(["invalid-transfer"]);
});

it("keeps request metadata authoritative over extra native page fields", async () => {
  const f = fixture(
    async () =>
      ({
        ...twoRows,
        before: 9,
        generation: 77,
        requestId: otherId,
        kind: "history",
      }) as unknown as HistoryReadResult,
  );
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(f.stream.sendOne()).toBe(true);
  const chunk = f.chunks[1]!;
  expect(chunk.meta).toEqual({ kind: "history", generation: 1, requestId, before: 10 });
  expect(decodeStreamHistory(chunk.meta, chunk.data)).toMatchObject({
    status: "page",
    generation: 1,
    requestId,
    before: 10,
    from: 8,
    to: 10,
  });
  expect(f.closed).toEqual([]);
});

it("rejects native range forged to match an overridden before before sending", async () => {
  const f = fixture(
    async () =>
      ({
        status: "page",
        before: 9,
        generation: 77,
        requestId: otherId,
        from: 7,
        to: 9,
        oldestAvailable: 0,
        lines: [{ r: [{ t: "older" }] }, { r: [{ t: "newer" }] }],
      }) as unknown as HistoryReadResult,
  );
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(f.chunks).toHaveLength(1);
  expect(f.closed).toEqual(["invalid-transfer"]);
});

it("cancels a pending read before abort callbacks and ignores its late result", async () => {
  const pending = deferred<HistoryReadResult>();
  const read = vi.fn((_sessionId: string, _request: HistoryReadRequest) => pending.promise);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  const signal = read.mock.calls[0]![1].signal;
  let controlsAtAbort = -1;
  signal.addEventListener("abort", () => {
    controlsAtAbort = f.controls.length;
  });
  f.stream.cancel();
  expect(signal.aborted).toBe(true);
  expect(controlsAtAbort).toBe(0);
  pending.resolve(twoRows);
  await Promise.resolve();
  expect(f.onReady).not.toHaveBeenCalled();
  expect(f.controls).toEqual([]);
  expect(f.closed).toEqual(["cancelled"]);
});

it("does not publish a read that settles after its deadline without an intervening tick", async () => {
  const pending = deferred<HistoryReadResult>();
  const read = vi.fn((_sessionId: string, _request: HistoryReadRequest) => pending.promise);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  f.at(STREAM_LIMITS.totalMs);
  pending.resolve(twoRows);
  await Promise.resolve();
  expect(f.controls[0]).toMatchObject({ requestId, code: "history-unavailable" });
  expect(f.onReady).not.toHaveBeenCalled();
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(2);
});

it("reconciles a native rejection at its deadline and frees the settled read fence", async () => {
  const pending = deferred<HistoryReadResult>();
  const read = vi.fn((_sessionId: string, _request: HistoryReadRequest) => pending.promise);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get();
  f.at(STREAM_LIMITS.totalMs);
  pending.reject(new Error("late provider failure"));
  await Promise.resolve();
  expect(f.controls).toMatchObject([{ requestId, code: "history-unavailable" }]);
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(2);
});

it("keeps the five-second unsent-history deadline despite screen ACK activity", async () => {
  const pending = deferred<HistoryReadResult>();
  const f = fixture(() => pending.promise);
  f.offerInitial();
  f.ackInitial();
  f.get();
  expect(
    f.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  f.at(1000);
  pending.resolve(twoRows);
  await Promise.resolve();
  expect(f.stream.nextDeadline()).toBe(5000);
  f.at(STREAM_LIMITS.progressMs - 1);
  f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
  expect(f.stream.nextDeadline()).toBe(6000);
  f.at(6000);
  f.stream.tick();
  expect(f.closed).toEqual(["stalled"]);
});

it("stalls before transport when the history ready deadline arrives between pump and send", async () => {
  let clock = 0;
  let steps: number[] = [];
  const attempted: StreamChunk[] = [];
  const f = fixture(async () => twoRows, {
    now: () => steps.shift() ?? clock,
    sendChunk: (chunk) => {
      attempted.push(chunk);
      return true;
    },
  });
  f.offerInitial();
  f.ackInitial();
  expect(
    f.stream.offer(snapshot(2, 160, "界".repeat(450), 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  expect(attempted[1]?.count).toBeGreaterThan(1);
  f.get();
  await Promise.resolve();
  clock = 1000;
  f.stream.receive({ type: "stream.ack", subscriptionId, through: 2 }, 128);
  expect(f.stream.nextDeadline()).toBe(5000);
  steps = [4999, 5000, 5000, 5000];
  expect(f.stream.sendOne()).toBe(false);
  expect(attempted).toHaveLength(2);
  expect(f.closed).toEqual(["stalled"]);
  expect(f.stream.nextDeadline()).toBeNull();
});

it("reconstructs interleaved screen and history with one four-credit pool", async () => {
  const rows = Array.from({ length: 10 }, () => ({ r: [{ t: "界".repeat(1000) }] }));
  const f = fixture(async () => ({
    status: "page",
    from: 0,
    to: 10,
    oldestAvailable: 0,
    lines: rows,
  }));
  f.offerInitial();
  f.ackInitial();
  expect(
    f.stream.offer(snapshot(2, 160, "界".repeat(450), 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  f.get(requestId, 10, 10);
  await Promise.resolve();
  for (let i = 0; i < STREAM_LIMITS.unacked; i++) expect(f.stream.sendOne()).toBe(true);
  expect(f.stream.sendOne()).toBe(false);
  expect(f.chunks.slice(1, 5).map((chunk) => chunk.meta.kind)).toEqual([
    "history",
    "snapshot",
    "history",
    "snapshot",
  ]);
  let acknowledged = 1;
  for (let i = 0; i < 40; i++) {
    f.stream.receive({ type: "stream.ack", subscriptionId, through: f.chunks.length }, 128);
    acknowledged = f.chunks.length;
    while (f.stream.sendOne()) expect(f.chunks.length - acknowledged).toBeLessThanOrEqual(4);
    if (f.chunks.length === acknowledged) break;
  }
  expect(f.chunks.length).toBeGreaterThan(6);
  let history: ReturnType<typeof decodeStreamHistory> | undefined;
  let screen: ReturnType<typeof decodeStreamScreen> | undefined;
  const peer = new StreamReceiver({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    accept: (meta, bytes) => {
      if (meta.kind === "history") history = decodeStreamHistory(meta, bytes);
      else screen = decodeStreamScreen(meta, bytes);
    },
    acknowledge: () => true,
  });
  for (const chunk of f.chunks) expect(peer.receive(chunk, 128)).toBe("accepted");
  expect(history).toMatchObject({
    status: "page",
    generation: 1,
    before: 10,
    from: 0,
    to: 10,
    nextBefore: 0,
    lines: rows,
  });
  expect(screen).toMatchObject({ kind: "snapshot", gen: 2, rows: 160 });
  expect(f.closed).toEqual([]);
});

it("releases a screen lane while its history lane still has unacknowledged chunks", async () => {
  const rows = Array.from({ length: 10 }, () => ({ r: [{ t: "界".repeat(1000) }] }));
  const read = vi.fn(async () => ({
    status: "page" as const,
    from: 0,
    to: 10,
    oldestAvailable: 0,
    lines: rows,
  }));
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.get(requestId, 10, 10);
  await Promise.resolve();
  expect(f.stream.sendOne()).toBe(true);
  expect(f.chunks[1]?.count).toBeGreaterThan(1);
  expect(
    f.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
  expect(f.stream.sendOne()).toBe(true);
  f.stream.receive({ type: "stream.ack", subscriptionId, through: 3 }, 128);
  f.get(otherId);
  expect(read).toHaveBeenCalledTimes(1);
  expect(f.controls[0]).toMatchObject({ requestId: otherId, code: "history-unavailable" });
  expect(
    f.stream.offer(snapshot(3, 3, "b", 13), {
      generation: 3,
      reported: 13,
      historyRequested: false,
    }),
  ).toBe(true);
});

it("retries a refused history chunk with the same sequence and index", async () => {
  const attempted: StreamChunk[] = [];
  let refused = false;
  const f = fixture(async () => twoRows, {
    sendChunk: (chunk) => {
      attempted.push(chunk);
      if (chunk.meta.kind === "history" && !refused) {
        refused = true;
        return false;
      }
      return true;
    },
  });
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(f.stream.sendOne()).toBe(false);
  expect(f.stream.sendOne()).toBe(true);
  expect(attempted.map((chunk) => [chunk.sequence, chunk.index])).toEqual([
    [1, 0],
    [2, 0],
    [2, 0],
  ]);
  expect(attempted[1]?.data).toEqual(attempted[2]?.data);
});

it("supports a synchronous onReady pump or cancellation after transfer ownership is installed", async () => {
  let stream!: AgentScreenStream;
  const read = async () => twoRows;
  const pumped = fixture(read, {
    history: {
      read,
      onReady: () => {
        expect(stream.sendOne()).toBe(true);
      },
    },
  });
  stream = pumped.stream;
  pumped.offerInitial();
  pumped.ackInitial();
  pumped.get();
  await Promise.resolve();
  expect(pumped.chunks[1]?.meta.kind).toBe("history");
  expect(pumped.closed).toEqual([]);

  const cancelled = fixture(read, {
    history: {
      read,
      onReady: () => {
        stream.cancel();
      },
    },
  });
  stream = cancelled.stream;
  cancelled.offerInitial();
  cancelled.ackInitial();
  cancelled.get();
  await Promise.resolve();
  expect(cancelled.closed).toEqual(["cancelled"]);
  expect(cancelled.chunks).toHaveLength(1);
});

it("copies nested reader callbacks and treats failed callback contracts as invalid transfers", async () => {
  const original = vi.fn(async () => twoRows);
  const replaced = vi.fn(async () => ({ status: "reset" }) as const);
  const history: AgentStreamHistoryOptions = { read: original, onReady: vi.fn() };
  const f = fixture(original, { history });
  history.read = replaced;
  history.onReady = vi.fn();
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(original).toHaveBeenCalledTimes(1);
  expect(replaced).not.toHaveBeenCalled();
  expect(history.onReady).not.toHaveBeenCalled();

  const rejected = fixture(async () => ({ status: "unavailable", reason: "busy" }), {
    sendControl: () => Promise.reject(new Error("control rejected")) as unknown as boolean,
  });
  rejected.offerInitial();
  rejected.ackInitial();
  rejected.get();
  await vi.waitFor(() => expect(rejected.closed).toEqual(["invalid-transfer"]));

  const ready = fixture(async () => twoRows, {
    history: {
      read: async () => twoRows,
      onReady: () => Promise.reject(new Error("ready rejected")),
    },
  });
  ready.offerInitial();
  ready.ackInitial();
  ready.get();
  await vi.waitFor(() => expect(ready.closed).toEqual(["invalid-transfer"]));
});

it("treats literal false control results as best effort and keeps viewing active", async () => {
  const sent = vi.fn((_message: unknown) => false);
  const f = fixture(async () => ({ status: "unavailable", reason: "busy" }), {
    sendControl: sent,
  });
  f.offerInitial();
  f.ackInitial();
  f.get();
  await Promise.resolve();
  expect(sent).toHaveBeenCalledTimes(1);
  expect(sent.mock.calls[0]?.[0]).toMatchObject({ requestId, code: "history-unavailable" });
  expect(f.closed).toEqual([]);
  expect(
    f.stream.offer(snapshot(2, 3, "a", 12), {
      generation: 2,
      reported: 12,
      historyRequested: false,
    }),
  ).toBe(true);
});

it("ignores stale subscription history requests before envelope validation", () => {
  const read = vi.fn(async () => twoRows);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.stream.receive(
    { type: "stream.history.get", subscriptionId: otherId, requestId, before: 10, count: 2 },
    STREAM_LIMITS.envelopeBytes + 1,
  );
  expect(read).not.toHaveBeenCalled();
  expect(f.closed).toEqual([]);
  f.get();
  expect(read).toHaveBeenCalledTimes(1);
});

it("contains a late rejected read after cancellation and a synchronous read exception", async () => {
  const pending = deferred<HistoryReadResult>();
  const late = fixture(() => pending.promise);
  late.offerInitial();
  late.ackInitial();
  late.get();
  late.stream.cancel();
  pending.reject(new Error("late"));
  await Promise.resolve();
  expect(late.closed).toEqual(["cancelled"]);
  expect(late.controls).toEqual([]);

  const immediate = fixture(() => {
    throw new Error("synchronous provider fault");
  });
  immediate.offerInitial();
  immediate.ackInitial();
  immediate.get();
  expect(immediate.controls[0]).toMatchObject({ requestId, code: "history-unavailable" });
  expect(immediate.closed).toEqual([]);
});

it("closes on a failed clock without trying to read history", () => {
  const read = vi.fn(async () => twoRows);
  const f = fixture(read);
  f.offerInitial();
  f.ackInitial();
  f.at(Number.NaN);
  f.get();
  expect(read).not.toHaveBeenCalled();
  expect(f.closed).toEqual(["invalid-transfer"]);
});
