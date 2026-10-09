import {
  applyStreamScreen,
  decodeStreamScreen,
  encodeCbor,
  prepareStreamSnapshot,
  type ScreenSnapshot,
  STREAM_LIMITS,
  type StreamChunk,
  StreamReceiver,
} from "@shellbell/protocol";
import { afterEach, expect, it, vi } from "vitest";
import { AgentScreenStream } from "../src/agent-screen-stream.js";
import type { HistoryCapture, Screen, ScreenReadOptions } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { WireScheduler } from "../src/wire-scheduler.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const subscriptionId = "A".repeat(22);
const styled = (text: string) => ({ r: [{ t: text, fg: 1 as const }] });

afterEach(() => vi.useRealTimers());

async function runColoredCycle(sustained: boolean): Promise<void> {
  vi.useFakeTimers();
  const began = Date.now();
  const backend = new FakeBackend();
  backend.addSession("S", { cols: 20, rows: 3, lines: ["a", "b", "c"] });
  const read = backend.getScreen.bind(backend);
  backend.getScreen = async (id: string) => {
    const screen = await read(id);
    return {
      ...screen,
      lines: screen.lines.map((line) => styled(line.r.map((run) => run.t).join(""))),
    };
  };
  const chunks: StreamChunk[] = [];
  const records: { kind: string; gen: number; degraded: boolean; bytes: number }[] = [];
  let rendered: ScreenSnapshot | undefined;
  let transfer = 0;
  let tracker: ScreenTracker;
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => Date.now(),
    newTransferId: () => String(++transfer).padStart(22, "B"),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: () => true,
    requestSnapshot: () => tracker.forceSnapshot("phone", "S"),
    onClosed: (reason) => {
      throw new Error(`unexpected close: ${reason}`);
    },
  });
  const receiver = new StreamReceiver({
    subscriptionId,
    sessionId: "S",
    now: () => Date.now(),
    accept: (meta, bytes) => {
      const record = decodeStreamScreen(meta, bytes);
      records.push({
        kind: record.kind,
        gen: record.gen,
        degraded: "degraded" in record && record.degraded === true,
        bytes: bytes.byteLength,
      });
      const result = applyStreamScreen(rendered, record);
      expect(result.ok).toBe(true);
      if (result.ok) rendered = result.screen;
    },
    acknowledge: (through) => {
      // ACK generation is immediate; a slow network can still delay delivery.
      setTimeout(() => stream.receive({ type: "stream.ack", subscriptionId, through }, 128), 500);
      return true;
    },
  });
  const scheduler = new WireScheduler({ now: () => Date.now() });
  tracker = new ScreenTracker({
    backend,
    log: createLogger({ stdout: false }),
    delivery: "scheduled",
    now: () => Date.now(),
    onReady: () => {
      scheduler.pump();
    },
  });
  scheduler.register("phone", () => {
    if (stream.canOfferScreen()) {
      tracker.offerPrepared("phone", (message, context) => {
        if (message.type !== "screen.snapshot" && message.type !== "screen.diff") return false;
        return stream.offer(message, context);
      });
    }
    return stream.sendOne();
  });
  tracker.start();
  tracker.setViewed("phone", "S", { preparation: "bounded" });
  try {
    await vi.advanceTimersByTimeAsync(125);
    for (const chunk of chunks.splice(0)) expect(receiver.receive(chunk, 1024)).toBe("accepted");
    expect(receiver.nextDeadline()).toBeNull();
    if (sustained) {
      expect(stream.canOfferScreen()).toBe(false);
      expect(stream.canOfferScreen()).toBe(false);
      expect(transfer).toBe(1);
      let callsAfterFinalUpdate: number | undefined;
      for (let step = 1; step <= 14; step++) {
        if (step <= 10) backend.appendLine("S", `line ${step}`);
        await vi.advanceTimersByTimeAsync(125);
        expect(receiver.tick()).toBe("open");
        scheduler.pump();
        for (const chunk of chunks.splice(0))
          expect(receiver.receive(chunk, 1024)).toBe("accepted");
        if (step === 10) callsAfterFinalUpdate = backend.getScreenCalls;
        if (step > 10) expect(backend.getScreenCalls).toBe(callsAfterFinalUpdate);
      }
      expect(records).toHaveLength(4);
      expect(records.every((record) => record.kind === "snapshot")).toBe(true);
      expect(records.every((record) => !record.degraded)).toBe(true);
      expect(records.at(-1)?.gen).toBe(11);
      expect(rendered?.lines).toEqual([styled("line 8"), styled("line 9"), styled("line 10")]);
      expect(rendered?.cursor).toEqual({ x: 0, y: 2 });
      expect(records.reduce((sum, record) => sum + record.bytes, 0)).toBeGreaterThan(0);
      return;
    }
    backend.appendLine("S", "d");
    await vi.advanceTimersByTimeAsync(125);
    for (const chunk of chunks.splice(0)) expect(receiver.receive(chunk, 1024)).toBe("accepted");
    await vi.advanceTimersByTimeAsync(375);
    expect(Date.now()).toBe(began + 625);
    expect(receiver.tick()).toBe("open");
    scheduler.pump();
    for (const chunk of chunks.splice(0)) expect(receiver.receive(chunk, 1024)).toBe("accepted");
    expect(records.map((record) => record.kind)).toEqual(["snapshot", "diff"]);
    expect(rendered?.lines).toEqual([styled("b"), styled("c"), styled("d")]);
    expect(records.some((record) => record.degraded)).toBe(false);
  } finally {
    tracker.stop();
    stream.cancel();
    receiver.cancel();
  }
}

it("preserves an adjacent colored diff through the 500 ms network ACK delay", () =>
  runColoredCycle(false));
it("coalesces sustained output but sends the newest quiet styled frame", () =>
  runColoredCycle(true));

const largeStyledScreen = (): Screen => ({
  cols: 512,
  rows: 256,
  cursor: { x: 3, y: 255 },
  scrollbackTotal: 0,
  lines: Array.from({ length: 256 }, () => ({
    r: Array.from({ length: 64 }, () => ({ t: "abcdefgh", fg: 1 as const })),
  })),
});

it("keeps the original styled frame for bounded viewers regardless of legacy offer order", async () => {
  vi.useFakeTimers();
  const source = largeStyledScreen();
  const normalized = prepareStreamSnapshot({ ...source, gen: 1 });
  expect(normalized.ok).toBe(true);
  if (!normalized.ok) return;
  expect(normalized.bytes.byteLength).toBeGreaterThan(262_144);
  expect(normalized.bytes.byteLength).toBeLessThanOrEqual(STREAM_LIMITS.screenBytes);
  expect(normalized.snapshot.degraded).toBeUndefined();
  for (const order of [
    ["legacy", "bounded"],
    ["bounded", "legacy"],
  ]) {
    const backend = new FakeBackend();
    backend.addSession("S", { cols: 512, rows: 256 });
    backend.getScreen = async () => source;
    const tracker = new ScreenTracker({
      backend,
      log: createLogger({ stdout: false }),
      delivery: "scheduled",
      now: () => Date.now(),
      onReady: () => {},
    });
    tracker.start();
    try {
      tracker.setViewed("legacy", "S");
      tracker.setViewed("explicit", "S", { preparation: "legacy" });
      tracker.setViewed("bounded", "S", { preparation: "bounded" });
      await vi.advanceTimersByTimeAsync(125);
      const offered: Record<string, ScreenSnapshot> = {};
      for (const name of order) {
        expect(
          tracker.offerPrepared(name, (message) => {
            expect(message.type).toBe("screen.snapshot");
            if (message.type === "screen.snapshot") offered[name] = message;
            return true;
          }),
        ).toBe(true);
      }
      expect(offered.legacy?.degraded).toBe(true);
      expect(
        tracker.offerPrepared("explicit", (message) => {
          expect(message).toEqual(offered.legacy);
          return true;
        }),
      ).toBe(true);
      expect(offered.legacy?.lines[0]?.r[0]?.fg).toBeUndefined();
      expect(offered.bounded?.degraded).toBeUndefined();
      expect(offered.bounded?.lines).toEqual(source.lines);
      const {
        type: _type,
        sessionId: _sessionId,
        ...bounded
      } = offered.bounded as ScreenSnapshot & { type: string; sessionId: string };
      expect(prepareStreamSnapshot(bounded).ok).toBe(true);
    } finally {
      tracker.stop();
    }
  }
  expect(encodeCbor({ ...source, gen: 1 }).byteLength).toBeGreaterThan(262_144);
});

it("delegates structural fallback and irreducible size closure to the bounded encoder", () => {
  const excessive: ScreenSnapshot = {
    ...largeStyledScreen(),
    gen: 1,
    lines: Array.from({ length: 256 }, () => ({
      r: Array.from({ length: 129 }, () => ({ t: "x", fg: 1 as const })),
    })),
  };
  const fallback = prepareStreamSnapshot(excessive);
  expect(fallback.ok).toBe(true);
  if (fallback.ok) {
    expect(fallback.snapshot.degraded).toBe(true);
    expect(fallback.snapshot.lines[0]?.r.map((run) => run.t).join("")).toBe("x".repeat(129));
  }
  const fallbackChunks: StreamChunk[] = [];
  const fallbackStream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    newTransferId: () => "C".repeat(22),
    sendChunk: (chunk) => {
      fallbackChunks.push(chunk);
      return true;
    },
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: (reason) => {
      throw new Error(`unexpected close ${reason}`);
    },
  });
  let receivedFallback: ReturnType<typeof decodeStreamScreen> | undefined;
  const fallbackReceiver = new StreamReceiver({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    accept: (meta, bytes) => {
      receivedFallback = decodeStreamScreen(meta, bytes);
    },
    acknowledge: () => true,
  });
  try {
    expect(
      fallbackStream.offer(
        { ...excessive, type: "screen.snapshot", sessionId: "S" },
        { generation: 1, reported: 0, historyRequested: false },
      ),
    ).toBe(true);
    while (fallbackStream.sendOne()) {
      /* drain one logical transfer */
    }
    for (const chunk of fallbackChunks)
      expect(fallbackReceiver.receive(chunk, 1024)).toBe("accepted");
    expect(receivedFallback?.kind).toBe("snapshot");
    expect(receivedFallback && "degraded" in receivedFallback && receivedFallback.degraded).toBe(
      true,
    );
  } finally {
    fallbackStream.cancel();
    fallbackReceiver.cancel();
  }
  const tooLarge: ScreenSnapshot = {
    ...largeStyledScreen(),
    gen: 1,
    lines: Array.from({ length: 256 }, () => ({ r: [{ t: "🚀".repeat(512) }] })),
  };
  expect(prepareStreamSnapshot(tooLarge)).toEqual({ ok: false, code: "screen-too-large" });
  const sent: StreamChunk[] = [];
  const closed: string[] = [];
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    newTransferId: () => "B".repeat(22),
    sendChunk: (chunk) => {
      sent.push(chunk);
      return true;
    },
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: (reason) => {
      closed.push(reason);
    },
  });
  expect(
    stream.offer(
      { ...tooLarge, type: "screen.snapshot", sessionId: "S" },
      { generation: 1, reported: 0, historyRequested: false },
    ),
  ).toBe(false);
  expect(closed).toEqual(["screen-too-large"]);
  expect(stream.sendOne()).toBe(false);
  expect(sent).toEqual([]);
});

it("queries screen readiness without allocating and keeps pending chunks moving", () => {
  let now = 0;
  let ids = 0;
  const chunks: StreamChunk[] = [];
  const closed: string[] = [];
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => now,
    newTransferId: () => String(++ids).padStart(22, "B"),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: (reason) => {
      closed.push(reason);
    },
  });
  const source = largeStyledScreen();
  expect(stream.canOfferScreen()).toBe(true);
  expect(stream.canOfferScreen()).toBe(true);
  expect(ids).toBe(0);
  expect(
    stream.offer(
      { ...source, type: "screen.snapshot", sessionId: "S", gen: 1 },
      { generation: 1, reported: 0, historyRequested: false },
    ),
  ).toBe(true);
  expect(ids).toBe(1);
  expect(stream.canOfferScreen()).toBe(false);
  for (let i = 0; i < STREAM_LIMITS.unacked; i++) expect(stream.sendOne()).toBe(true);
  expect(stream.sendOne()).toBe(false);
  expect(stream.canOfferScreen()).toBe(false);
  expect(ids).toBe(1);
  stream.receive({ type: "stream.ack", subscriptionId, through: 4 }, 128);
  expect(stream.canOfferScreen()).toBe(false);
  expect(stream.sendOne()).toBe(true);
  let acknowledged = 4;
  while (stream.sendOne()) {
    if (chunks.length - acknowledged === STREAM_LIMITS.unacked) {
      acknowledged = chunks.length;
      stream.receive({ type: "stream.ack", subscriptionId, through: acknowledged }, 128);
    }
  }
  expect(chunks.length).toBeGreaterThan(STREAM_LIMITS.unacked);
  expect(stream.canOfferScreen()).toBe(false);
  stream.receive({ type: "stream.ack", subscriptionId, through: chunks.length }, 128);
  expect(stream.canOfferScreen()).toBe(true);
  stream.cancel();
  expect(stream.canOfferScreen()).toBe(false);
  expect(closed).toEqual(["cancelled"]);

  const stalled = new AgentScreenStream({
    subscriptionId: "C".repeat(22),
    sessionId: "S",
    now: () => now,
    newTransferId: () => "D".repeat(22),
    sendChunk: () => true,
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: (reason) => closed.push(reason),
  });
  expect(stalled.canOfferScreen()).toBe(true);
  now = STREAM_LIMITS.progressMs;
  expect(stalled.canOfferScreen()).toBe(false);
  expect(closed.at(-1)).toBe("stalled");
});

it("shares wire credit with actual history chunks", async () => {
  let ids = 0;
  const chunks: StreamChunk[] = [];
  const capture = Object.freeze({});
  const stream = new AgentScreenStream({
    subscriptionId,
    sessionId: "S",
    now: () => 0,
    newTransferId: () => String(++ids).padStart(22, "B"),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: () => true,
    requestSnapshot: () => {},
    onClosed: (reason) => {
      throw new Error(`unexpected close ${reason}`);
    },
    history: {
      read: async () => ({
        status: "page",
        from: 0,
        to: 200,
        oldestAvailable: 0,
        lines: Array.from({ length: 200 }, () => ({ r: [{ t: "h".repeat(280) }] })),
      }),
      onReady: () => {},
    },
  });
  const initial = {
    type: "screen.snapshot" as const,
    sessionId: "S",
    cols: 3,
    rows: 3,
    cursor: { x: 0, y: 2 },
    scrollbackTotal: 200,
    gen: 1,
    lines: [styled("a"), styled("b"), styled("c")],
  };
  try {
    expect(
      stream.offer(initial, { generation: 1, reported: 200, historyRequested: true, capture }),
    ).toBe(true);
    expect(stream.sendOne()).toBe(true);
    stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    expect(stream.canOfferScreen()).toBe(true);
    stream.receive(
      {
        type: "stream.history.get",
        subscriptionId,
        requestId: "R".repeat(22),
        before: 200,
        count: 200,
      },
      128,
    );
    await vi.waitFor(() => expect(ids).toBe(2));
    expect(stream.canOfferScreen()).toBe(true);
    for (let i = 0; i < STREAM_LIMITS.unacked; i++) expect(stream.sendOne()).toBe(true);
    expect(chunks.slice(1).every((chunk) => chunk.meta.kind === "history")).toBe(true);
    expect(stream.canOfferScreen()).toBe(false);
    stream.receive({ type: "stream.ack", subscriptionId, through: 5 }, 128);
    expect(stream.canOfferScreen()).toBe(true);
  } finally {
    stream.cancel();
  }
});

it("validates preparation before replacing ownership and preserves explicit legacy", async () => {
  vi.useFakeTimers();
  const backend = new FakeBackend();
  backend.addSession("S", { lines: ["a", "b", "c"] });
  backend.addSession("T", { lines: ["x", "y", "z"] });
  const tracker = new ScreenTracker({
    backend,
    log: createLogger({ stdout: false }),
    delivery: "scheduled",
    onReady: () => {},
  });
  tracker.start();
  try {
    tracker.setViewed("phone", "S", { preparation: "legacy" });
    expect(() => tracker.setViewed("phone", "T", { preparation: "other" as "legacy" })).toThrow(
      TypeError,
    );
    expect(() => tracker.setViewed("phone", "T", { preparation: null as never })).toThrow(
      TypeError,
    );
    expect(tracker.viewedBy("S")).toEqual(["phone"]);
    expect(tracker.viewedBy("T")).toEqual([]);
    tracker.setViewed("phone", "S");
    await vi.advanceTimersByTimeAsync(125);
    expect(tracker.offerPrepared("phone", (message) => message.type === "screen.snapshot")).toBe(
      true,
    );
    tracker.setViewed("phone", null, { preparation: "other" as "legacy" });
    expect(tracker.viewedBy("S")).toEqual([]);
  } finally {
    tracker.stop();
  }
  const automatic = new ScreenTracker({
    backend,
    log: createLogger({ stdout: false }),
    sink: () => true,
  });
  automatic.setViewed("phone", "S", { preparation: "legacy" });
  expect(() => automatic.setViewed("phone", "T", { preparation: "bounded" })).toThrow(TypeError);
  expect(automatic.viewedBy("S")).toEqual(["phone"]);
  expect(automatic.viewedBy("T")).toEqual([]);
});

it("keeps bounded history captures with the current viewer after replacement and cancellation", async () => {
  vi.useFakeTimers();
  const captures: HistoryCapture[] = [];
  const reads: boolean[] = [];
  class CaptureBackend extends FakeBackend {
    override async getScreen(id: string, options?: ScreenReadOptions): Promise<Screen> {
      reads.push(options?.history === true);
      const screen = await super.getScreen(id);
      const capture = Object.freeze({ read: reads.length });
      captures.push(capture);
      return { ...screen, historyCapture: capture };
    }
  }
  const backend = new CaptureBackend();
  backend.addSession("S", { lines: ["a", "b", "c"], scrollbackTotal: 3 });
  const tracker = new ScreenTracker({
    backend,
    log: createLogger({ stdout: false }),
    delivery: "scheduled",
    onReady: () => {},
  });
  tracker.start();
  try {
    tracker.setViewed("phone", "S", { history: true, preparation: "bounded" });
    await vi.advanceTimersByTimeAsync(125);
    expect(
      tracker.offerPrepared("phone", (_message, context) => {
        expect(context.capture).toBe(captures[0]);
        tracker.setViewed("phone", "S", { history: true, preparation: "bounded" });
        return true;
      }),
    ).toBe(true);
    await vi.advanceTimersByTimeAsync(125);
    expect(
      tracker.offerPrepared("phone", (_message, context) => {
        expect(context.capture).toBe(captures[1]);
        return true;
      }),
    ).toBe(true);
    expect(reads).toEqual([true, true]);
    tracker.setViewed("phone", null);
    expect(tracker.offerPrepared("phone", () => true)).toBe(false);
  } finally {
    tracker.stop();
  }
});
