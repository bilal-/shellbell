import { EventEmitter } from "node:events";
import { STREAM_LIMITS, type StreamChunk, type StreamMessage } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { AgentVtStream, VT_BACKLOG_BYTES, VT_HISTORY_LINES } from "../src/agent-vt-stream.js";
import type { VtSource } from "../src/backends/types.js";

const subscriptionId = "AAAAAAAAAAAAAAAAAAAAAA";
const sessionId = "tmux:%1";

class FakeSource extends EventEmitter {
  reseeds: (number | undefined)[] = [];
  started: (number | undefined)[] = [];
  closed = false;
  async start(historyLines?: number) {
    this.started.push(historyLines);
  }
  async reseed(historyLines?: number) {
    this.reseeds.push(historyLines);
  }
  close() {
    this.closed = true;
  }
  seed(generation: number, data = "screen") {
    this.emit("seed", { generation, cols: 80, rows: 24, data });
  }
}

function harness() {
  const source = new FakeSource();
  const chunks: StreamChunk[] = [];
  const controls: StreamMessage[] = [];
  const closed: string[] = [];
  let transfer = 0;
  const stream = new AgentVtStream({
    subscriptionId,
    sessionId,
    source: source as unknown as VtSource,
    now: () => 0,
    newTransferId: () => `${"T".repeat(20)}${String(++transfer).padStart(2, "0")}`,
    sendChunk: (chunk) => {
      chunks.push(chunk);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
    onReady: () => {},
    onClosed: (reason) => closed.push(reason),
  });
  const ack = () => {
    const through = chunks.at(-1)?.sequence;
    if (through) stream.receive({ type: "stream.ack", subscriptionId, through }, 100);
  };
  /** Acknowledges what was sent, then sends until nothing more is admitted. */
  const drain = () => {
    ack();
    while (stream.sendOne()) ack();
  };
  const text = (chunk: StreamChunk) => Buffer.from(chunk.data).toString();
  return { source, stream, chunks, controls, closed, ack, drain, text };
}

describe("AgentVtStream", () => {
  it("sends a seed, then output batched while a transfer was in flight", async () => {
    const { source, stream, chunks, drain, text } = harness();
    await stream.start();
    expect(source.started).toEqual([VT_HISTORY_LINES]);
    source.seed(1);
    source.emit("bytes", Buffer.from("a"), 1);
    expect(stream.sendOne()).toBe(true);
    // The seed is in flight, so later output waits and is sent as one transfer.
    source.emit("bytes", Buffer.from("b"), 1);
    source.emit("bytes", Buffer.from("c"), 0);
    drain();
    expect(chunks.map((c) => [c.meta, text(c)])).toEqual([
      [{ kind: "vt-state", generation: 1, cols: 80, rows: 24 }, "screen"],
      [{ kind: "vt", generation: 1, offset: 0 }, "ab"],
    ]);
    source.emit("bytes", Buffer.from("de"), 1);
    drain();
    expect(chunks.at(-1)!.meta).toEqual({ kind: "vt", generation: 1, offset: 2 });
  });

  it("drops output past the backlog and reseeds once the lane is free", async () => {
    const { source, stream, chunks, drain, ack } = harness();
    await stream.start();
    source.seed(1);
    expect(stream.sendOne()).toBe(true);
    source.emit("bytes", new Uint8Array(VT_BACKLOG_BYTES), 1);
    source.emit("bytes", new Uint8Array(1), 1);
    expect(source.reseeds).toEqual([]);
    ack();
    stream.sendOne();
    expect(source.reseeds).toEqual([VT_HISTORY_LINES]);
    source.emit("bytes", new Uint8Array(1), 1);
    source.seed(2);
    drain();
    expect(chunks.map((c) => c.meta.kind)).toEqual(["vt-state", "vt-state"]);
    expect(chunks.at(-1)!.meta).toMatchObject({ generation: 2 });
  });

  it("halves the history while a seed is larger than one transfer", async () => {
    const { source, stream, chunks } = harness();
    await stream.start();
    source.seed(1, "x".repeat(STREAM_LIMITS.screenBytes + 1));
    expect(source.reseeds).toEqual([VT_HISTORY_LINES / 2]);
    expect(stream.sendOne()).toBe(false);
    source.seed(2);
    expect(stream.sendOne()).toBe(true);
    expect(chunks[0]!.meta).toMatchObject({ kind: "vt-state", generation: 2 });
  });

  it("answers history requests as unavailable and reseeds on refresh", async () => {
    const { source, stream, controls } = harness();
    await stream.start();
    const requestId = "R".repeat(22);
    stream.receive(
      { type: "stream.history.get", subscriptionId, requestId, before: 0, count: 10 },
      100,
    );
    expect(controls).toEqual([
      { type: "stream.error", subscriptionId, requestId, code: "history-unavailable" },
    ]);
    stream.receive({ type: "stream.refresh", subscriptionId }, 100);
    expect(source.reseeds).toEqual([VT_HISTORY_LINES]);
  });

  it.each([
    ["pane-gone", "session-gone"],
    ["unsettled", "unsupported"],
    ["exited", "unsupported"],
  ])("closes with %s as %s", async (end, code) => {
    const { source, stream, controls, closed } = harness();
    await stream.start();
    source.emit("end", end);
    expect(controls).toEqual([{ type: "stream.error", subscriptionId, code }]);
    expect(closed).toEqual([code]);
    expect(source.closed).toBe(true);
    expect(stream.sendOne()).toBe(false);
  });

  it("closes its source quietly when cancelled", async () => {
    const { source, stream, controls, closed } = harness();
    await stream.start();
    stream.receive({ type: "stream.cancel", subscriptionId }, 100);
    expect(controls).toEqual([]);
    expect(closed).toEqual(["cancelled"]);
    expect(source.closed).toBe(true);
  });
});
