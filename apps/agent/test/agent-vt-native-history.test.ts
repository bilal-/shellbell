import { EventEmitter } from "node:events";
import {
  CONTINUATION_EXTENSIONS,
  decodeStreamHistory,
  NATIVE_HISTORY_EXTENSION,
  nativeHistoryProof,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentVtStream } from "../src/agent-vt-stream.js";
import type {
  HistoryReadRequest,
  HistoryReadResult,
  VtSeed,
  VtSource,
} from "../src/backends/types.js";

const subscriptionId = "S".repeat(22);
const requestId = "R".repeat(22);
const extensions = [...CONTINUATION_EXTENSIONS, NATIVE_HISTORY_EXTENSION];
const page = {
  status: "page",
  from: 0,
  to: 2,
  oldestAvailable: 0,
  lines: [{ r: [{ t: "old0" }] }, { r: [{ t: "old1" }] }],
} as const;

class Source extends EventEmitter {
  generation = 0;
  enabled = false;
  closed = false;
  calls: HistoryReadRequest[] = [];
  read: (request: HistoryReadRequest) => Promise<HistoryReadResult> = async () => ({
    ...page,
    lines: page.lines.map((line) => ({ r: [...line.r] })),
  });
  history = {
    enable: () => {
      this.enabled = true;
    },
    read: (request: HistoryReadRequest) => {
      this.calls.push(request);
      return this.read(request);
    },
  };
  continuation: VtSource["continuation"] = {
    cursor: "real",
    alternate: "real",
    probe: async () => ({ generation: this.generation, quiescent: true }),
  };
  async start() {}
  async reseed() {
    this.seed();
  }
  close() {
    this.closed = true;
  }
  seed(reason: "refresh" | "resize" = "refresh") {
    const seed: VtSeed = {
      generation: ++this.generation,
      cols: 80,
      rows: 24,
      data: "legacy full seed",
      continuation: { data: "screen only", reason },
      nativeHistory: {
        capture: Object.freeze({}),
        from: 2,
        to: 4,
        lines: [{ r: [{ t: "new2" }] }, { r: [{ t: "new3" }] }],
        replay: "prefix-safe full seed",
      },
    };
    this.emit("seed", seed);
    return seed;
  }
}

function harness(requested: readonly string[] = extensions) {
  let id = 0;
  let now = 0;
  let allowed = true;
  const source = new Source();
  const chunks: StreamChunk[] = [];
  const controls: StreamMessage[] = [];
  const closed: string[] = [];
  const stream = new AgentVtStream({
    subscriptionId,
    sessionId: "tmux:%1",
    source: source as VtSource,
    extensions: requested,
    now: () => now,
    newTransferId: () => String(++id).padStart(22, "0"),
    sendChunk: (chunk) => {
      if (!allowed) return false;
      chunks.push(chunk);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
    onReady() {},
    onClosed: (reason) => closed.push(reason),
  });
  const receive = (message: StreamMessage) => stream.receive(message, 128);
  const drain = () => {
    for (let n = 0; n < 100 && stream.sendOne(); n++) {
      const sequence = chunks.at(-1)?.sequence;
      if (sequence) receive({ type: "stream.ack", subscriptionId, through: sequence });
    }
  };
  const seed = (applied = true) => {
    const native = source.seed();
    drain();
    const meta = chunks.at(-1)!.meta;
    if (meta.kind !== "vt-seed") throw new Error("missing seed");
    if (applied)
      receive({
        type: "stream.applied",
        subscriptionId,
        capture: meta.capture,
        generation: meta.generation,
        offset: 0,
      });
    return { meta, native };
  };
  const request = (meta: Extract<StreamChunk["meta"], { kind: "vt-seed" }>, change = {}) =>
    receive({
      type: "stream.history.get",
      subscriptionId,
      requestId,
      capture: meta.capture,
      generation: meta.generation,
      before: 2,
      count: 2,
      ...change,
    });
  return {
    source,
    stream,
    chunks,
    controls,
    closed,
    receive,
    drain,
    seed,
    request,
    advance(ms: number) {
      now += ms;
      stream.tick();
    },
    allow(value: boolean) {
      allowed = value;
    },
  };
}

describe("negotiated native raw history delivery", () => {
  it("requires explicit extension acceptance and preserves base-only seed bytes", () => {
    const f = harness(CONTINUATION_EXTENSIONS);
    const { meta } = f.seed();
    expect(f.source.enabled).toBe(false);
    expect(meta.historyProof).toBeUndefined();
    expect(Buffer.from(f.chunks.at(-1)!.data).toString()).toBe("legacy full seed");
    f.request(meta);
    expect(f.source.calls).toHaveLength(0);
    f.stream.cancel();
  });

  it("binds the row proof and native read to the delivered/applied seed", async () => {
    const f = harness();
    const { meta, native } = f.seed(false);
    expect(f.source.enabled).toBe(true);
    expect(meta).toMatchObject({
      historyBefore: 2,
      historyRows: 2,
      historyProof: nativeHistoryProof(80, ["new2", "new3"]),
    });
    expect(Buffer.from(f.chunks.at(-1)!.data).toString()).toBe("prefix-safe full seed");
    f.request(meta);
    expect(f.source.calls).toHaveLength(0);
    f.receive({
      type: "stream.applied",
      subscriptionId,
      capture: meta.capture,
      generation: meta.generation,
      offset: 0,
    });
    f.request(meta);
    await vi.waitFor(() => expect(f.source.calls).toHaveLength(1));
    f.drain();
    expect(f.source.calls[0]).toMatchObject({
      capture: native.nativeHistory!.capture,
      reported: 4,
      before: 2,
      count: 2,
    });
    const chunk = f.chunks.at(-1)!;
    expect(chunk.meta).toMatchObject({
      kind: "history",
      capture: meta.capture,
      generation: meta.generation,
      before: 2,
    });
    expect(decodeStreamHistory(chunk.meta, chunk.data)).toMatchObject({
      status: "page",
      from: 0,
      to: 2,
    });
    f.stream.cancel();
  });

  it("rejects a wrong capture, generation or boundary before reading", () => {
    const f = harness();
    const { meta } = f.seed();
    for (const change of [{ capture: "X".repeat(22) }, { generation: 99 }, { before: 1 }])
      f.request(meta, change);
    expect(f.source.calls).toHaveLength(0);
    expect(
      f.controls
        .slice(-3)
        .every((message) => message.type === "stream.error" && message.code === "history-reset"),
    ).toBe(true);
    f.stream.cancel();
  });

  it("never carries an old native capture across a source divider", () => {
    const f = harness();
    const { meta } = f.seed();
    f.source.seed("resize");
    f.drain();
    const next = f.chunks.at(-1)!.meta;
    expect(next).toMatchObject({ kind: "vt-seed", disposition: "discontinuity" });
    expect("historyProof" in next).toBe(false);
    f.request(meta);
    expect(f.source.calls).toHaveLength(0);
    f.stream.cancel();
  });

  it("takes a full new capture on explicit refresh and drops late reads from the old one", async () => {
    const f = harness();
    const { meta } = f.seed();
    let resolve!: (result: HistoryReadResult) => void;
    f.source.read = () =>
      new Promise((r) => {
        resolve = r;
      });
    f.request(meta);
    f.receive({ type: "stream.refresh", subscriptionId, history: true });
    f.drain();
    expect(f.source.calls[0]!.signal.aborted).toBe(true);
    expect(f.chunks.at(-1)!.meta).toMatchObject({
      kind: "vt-seed",
      disposition: "replace",
      reason: "refresh",
      historyBefore: 2,
    });
    resolve({ status: "boundary", reason: "end", oldestAvailable: 2 });
    await Promise.resolve();
    await Promise.resolve();
    f.drain();
    expect(f.chunks.some((chunk) => chunk.meta.kind === "history")).toBe(false);
    f.stream.cancel();
  });

  it("does not reuse explicit replacement consent for a reseed before the refreshed seed is applied", () => {
    const f = harness();
    f.seed();
    f.receive({ type: "stream.refresh", subscriptionId, history: true });
    f.drain();
    expect(f.chunks.at(-1)!.meta).toMatchObject({
      kind: "vt-seed",
      disposition: "replace",
      reason: "refresh",
    });
    // No applied report for that replacement: a resize is still a discontinuity.
    f.source.seed("resize");
    f.drain();
    expect(f.chunks.at(-1)!.meta).toMatchObject({
      kind: "vt-seed",
      disposition: "discontinuity",
      reason: "resize",
    });
    expect(f.chunks.at(-1)!.meta).not.toHaveProperty("historyProof");
    f.stream.cancel();
  });

  it.each(["resize", "refresh"] as const)(
    "does not let a queued %s divider consume pending full-refresh intent",
    (reason) => {
      const f = harness();
      f.seed();
      f.source.seed(reason); // A divider is already queued before the request arrives.
      f.source.reseed = async () => {};
      f.receive({ type: "stream.refresh", subscriptionId, history: true });
      f.drain();
      expect(f.chunks.at(-1)!.meta).toMatchObject({
        kind: "vt-seed",
        disposition: "discontinuity",
        reason,
      });
      f.source.seed();
      f.drain();
      expect(f.chunks.at(-1)!.meta).toMatchObject({
        kind: "vt-seed",
        disposition: "replace",
        reason: "refresh",
      });
      f.stream.cancel();
    },
  );

  it("does not let an old applied report cancel an asynchronous history refresh", () => {
    const f = harness();
    const { meta } = f.seed();
    f.source.reseed = async () => {};
    f.receive({ type: "stream.refresh", subscriptionId, history: true });
    f.receive({
      type: "stream.applied",
      subscriptionId,
      capture: meta.capture,
      generation: meta.generation,
      offset: 0,
    });
    f.source.seed();
    f.drain();
    expect(f.chunks.at(-1)!.meta).toMatchObject({
      kind: "vt-seed",
      disposition: "replace",
      reason: "refresh",
      historyBefore: 2,
    });
    f.stream.cancel();
  });

  it("treats the next boundary as busy until the preceding page is acknowledged", async () => {
    const f = harness();
    const { meta } = f.seed();
    f.request(meta);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.stream.sendOne()).toBe(true);
    const chunk = f.chunks.at(-1)!;
    expect(chunk.meta.kind).toBe("history");
    f.request(meta, { requestId: "N".repeat(22), before: 0 });
    expect(f.controls.at(-1)).toMatchObject({ code: "history-unavailable" });
    f.receive({ type: "stream.ack", subscriptionId, through: chunk.sequence });
    f.source.read = async () => ({ status: "boundary", reason: "end", oldestAvailable: 0 });
    f.request(meta, { requestId: "N".repeat(22), before: 0 });
    expect(f.source.calls).toHaveLength(2);
    await Promise.resolve();
    await Promise.resolve();
    f.drain();
    f.stream.cancel();
  });

  it("retires the old anchor while an oversized replacement retries with less history", () => {
    const f = harness();
    const { meta } = f.seed();
    f.source.reseed = async () => {};
    f.source.emit("seed", {
      generation: 2,
      cols: 80,
      rows: 24,
      data: "seed",
      continuation: { data: "x".repeat(STREAM_LIMITS.screenBytes + 1), reason: "resize" },
    });
    f.request(meta);
    expect(f.source.calls).toHaveLength(0);
    expect(f.controls.at(-1)).toMatchObject({ code: "history-reset" });
    f.stream.cancel();
  });

  it("keeps a timed-out native read admitted until the original work settles", async () => {
    const f = harness();
    const { meta } = f.seed();
    let resolve!: (result: HistoryReadResult) => void;
    f.source.read = () =>
      new Promise((r) => {
        resolve = r;
      });
    f.request(meta);
    f.advance(STREAM_LIMITS.totalMs);
    expect(f.source.calls[0]!.signal.aborted).toBe(true);
    f.request(meta, { requestId: "N".repeat(22) });
    expect(f.source.calls).toHaveLength(1);
    resolve({ status: "cancelled" });
    await Promise.resolve();
    await Promise.resolve();
    f.request(meta, { requestId: "M".repeat(22) });
    expect(f.source.calls).toHaveLength(2);
    f.stream.cancel();
    resolve({ status: "cancelled" });
  });

  it("bounds a page whose first chunk cannot enter the route", async () => {
    const f = harness();
    const { meta } = f.seed();
    f.allow(false);
    f.request(meta);
    await Promise.resolve();
    await Promise.resolve();
    f.advance(STREAM_LIMITS.progressMs);
    expect(f.closed).toEqual(["stalled"]);
  });
});
