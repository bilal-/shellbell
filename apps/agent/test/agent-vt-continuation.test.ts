import { EventEmitter } from "node:events";
import {
  CONTINUATION_EXTENSIONS,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { AgentVtStream } from "../src/agent-vt-stream.js";
import type { VtSource } from "../src/backends/types.js";

const subscriptionId = "S".repeat(22);
class Source extends EventEmitter {
  continuation: VtSource["continuation"] = {
    cursor: "guessed",
    alternate: "unknown",
    probe: async () => ({ generation: this.generation, quiescent: true }),
  };
  generation = 0;
  closed = false;
  async start() {}
  async reseed() {
    this.seed();
  }
  close() {
    this.closed = true;
  }
  seed(reason: "resize" | "refresh" | "herdr-idle" = "refresh") {
    this.emit("seed", {
      generation: ++this.generation,
      cols: 80,
      rows: 24,
      data: "full source history and screen",
      continuation: { data: "live screen only", reason },
    });
  }
}
function harness(extensions: readonly string[] | null = CONTINUATION_EXTENSIONS, retained = false) {
  let now = 0;
  let id = 0;
  let allowControl = true;
  const source = new Source();
  const chunks: StreamChunk[] = [];
  const controls: StreamMessage[] = [];
  const events: string[] = [];
  const closed: string[] = [];
  const stream = new AgentVtStream({
    subscriptionId,
    sessionId: "herdr:pane",
    source,
    extensions: extensions ?? undefined,
    retained,
    now: () => now,
    newTransferId: () => String(++id).padStart(22, "0"),
    sendChunk: (chunk) => {
      chunks.push(chunk);
      events.push(chunk.type);
      return true;
    },
    sendControl: (control) => {
      if (!allowControl) return false;
      controls.push(control);
      events.push(control.type);
      return true;
    },
    onReady() {},
    onClosed: (reason) => closed.push(reason),
  });
  const ack = () => {
    if (chunks.length)
      stream.receive({ type: "stream.ack", subscriptionId, through: chunks.at(-1)!.sequence }, 100);
  };
  const drain = () => {
    ack();
    while (stream.sendOne()) ack();
  };
  const applied = (offset: number, overrides: object = {}) => {
    const meta = [...chunks].reverse().find((chunk) => chunk.meta.kind === "vt-seed")?.meta;
    if (meta?.kind !== "vt-seed") throw new Error("No negotiated seed");
    stream.receive(
      {
        type: "stream.applied",
        subscriptionId,
        capture: meta.capture,
        generation: meta.generation,
        offset,
        ...overrides,
      },
      100,
    );
  };
  return {
    stream,
    source,
    chunks,
    controls,
    events,
    closed,
    ack,
    drain,
    applied,
    clock: (value: number) => {
      now = value;
    },
    control: (enabled: boolean) => {
      allowControl = enabled;
    },
  };
}

describe("negotiated computer terminal subscriptions", () => {
  it("keeps legacy and partial-extension viewers on their exact old record shape", async () => {
    for (const extensions of [null, CONTINUATION_EXTENSIONS.slice(1)]) {
      const h = harness(extensions);
      const probe = vi.fn(async () => ({ generation: 1, quiescent: true }));
      h.source.continuation!.probe = probe;
      await h.stream.start();
      h.source.seed();
      h.drain();
      if (extensions === null) expect(h.controls).toEqual([]);
      else expect(h.controls[0]).toMatchObject({ type: "stream.accepted", extensions: [] });
      expect(h.chunks[0]!.meta).toEqual({ kind: "vt-state", generation: 1, cols: 80, rows: 24 });
      expect(Buffer.from(h.chunks[0]!.data).toString()).toBe("full source history and screen");
      h.clock(2000);
      h.stream.tick();
      expect(probe).not.toHaveBeenCalled();
      h.stream.receive(
        {
          type: "stream.applied",
          subscriptionId,
          capture: "C".repeat(22),
          generation: 1,
          offset: 0,
        },
        100,
      );
      expect(h.closed).toEqual(["invalid-transfer"]);
    }
  });

  it("admits the whole acceptance before the first extended record, retrying a full control path", async () => {
    const h = harness();
    h.control(false);
    await h.stream.start();
    h.source.seed();
    expect(h.stream.sendOne()).toBe(false);
    expect(h.chunks).toEqual([]);
    expect(h.stream.nextDeadline()).toBe(100);
    h.control(true);
    h.clock(100);
    h.drain();
    expect(h.events.slice(0, 2)).toEqual(["stream.accepted", "stream.chunk"]);
    expect(h.controls[0]).toMatchObject({ extensions: [...CONTINUATION_EXTENSIONS] });
    expect(h.chunks[0]!.meta).toMatchObject({
      kind: "vt-seed",
      disposition: "initial",
      reason: "start",
      cursor: "guessed",
      alternate: "unknown",
    });
    h.stream.cancel();
  });

  it("bounds a negotiation that cannot be delivered", async () => {
    const h = harness();
    h.control(false);
    await h.stream.start();
    h.source.seed();
    h.stream.sendOne();
    h.clock(STREAM_LIMITS.progressMs);
    h.stream.tick();
    expect(h.closed).toEqual(["stalled"]);
    expect(h.source.closed).toBe(true);
  });

  it("sends only the live screen on resize or a reconnect with retained rows", async () => {
    const h = harness();
    await h.stream.start();
    h.source.seed();
    h.drain();
    h.source.seed("resize");
    h.drain();
    expect(h.chunks.at(-1)!.meta).toMatchObject({ disposition: "discontinuity", reason: "resize" });
    expect(Buffer.from(h.chunks.at(-1)!.data).toString()).toBe("live screen only");
    const reconnect = harness(CONTINUATION_EXTENSIONS, true);
    await reconnect.stream.start();
    reconnect.source.seed();
    reconnect.drain();
    expect(reconnect.chunks[0]!.meta).toMatchObject({
      disposition: "discontinuity",
      reason: "reconnect",
    });
    expect(Buffer.from(reconnect.chunks[0]!.data).toString()).toBe("live screen only");
    h.stream.cancel();
    reconnect.stream.cancel();
  });

  it("labels Herdr idle replacement and includes its full bounded history", async () => {
    const h = harness();
    await h.stream.start();
    h.source.seed();
    h.drain();
    h.source.seed("herdr-idle");
    h.drain();
    expect(h.chunks.at(-1)!.meta).toMatchObject({ disposition: "replace", reason: "herdr-idle" });
    expect(Buffer.from(h.chunks.at(-1)!.data).toString()).toBe("full source history and screen");
    h.stream.cancel();
  });

  it("rejects applied reports before acceptance and beyond admitted output", async () => {
    const early = harness();
    await early.stream.start();
    early.stream.receive(
      { type: "stream.applied", subscriptionId, capture: "C".repeat(22), generation: 1, offset: 0 },
      100,
    );
    expect(early.closed).toEqual(["invalid-transfer"]);
    const h = harness();
    await h.stream.start();
    h.source.seed();
    h.drain();
    h.applied(0);
    expect(h.closed).toEqual([]);
    h.source.emit("bytes", new Uint8Array(10), 1);
    h.drain();
    h.applied(10);
    expect(h.closed).toEqual([]);
    h.applied(11);
    expect(h.closed).toEqual(["invalid-transfer"]);
  });

  it("does not let a receipt ACK establish a continuous resize", async () => {
    const h = harness();
    await h.stream.start();
    h.source.seed();
    h.drain();
    h.source.emit("bytes", new Uint8Array(10), 1);
    h.drain();
    h.source.seed("resize");
    h.drain();
    expect(h.chunks.at(-1)!.meta).toMatchObject({ disposition: "discontinuity" });
    h.stream.cancel();
  });

  it("sends status with all four terminal credits occupied, without calling backlog quiescent", async () => {
    const h = harness();
    await h.stream.start();
    h.source.seed();
    h.drain();
    h.source.emit("bytes", new Uint8Array(STREAM_LIMITS.chunkBytes * 5), 1);
    while (h.stream.sendOne()) {}
    expect(h.chunks).toHaveLength(5); // seed + four unacknowledged chunks
    h.clock(2000);
    h.stream.tick();
    await vi.waitFor(() => {
      h.stream.sendOne();
      expect(h.controls.at(-1)).toMatchObject({
        type: "stream.status",
        state: "catching-up",
        offset: 0,
      });
    });
    h.stream.cancel();
  });

  it("times out a hung probe once and fences its late success", async () => {
    const h = harness();
    let finish!: (value: { generation: number; quiescent: boolean }) => void;
    let probes = 0;
    h.source.continuation!.probe = () => {
      probes++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    await h.stream.start();
    h.source.seed();
    h.drain();
    h.clock(2000);
    h.stream.tick();
    await vi.waitFor(() => expect(probes).toBe(1));
    h.clock(4000);
    h.stream.tick();
    h.stream.sendOne();
    expect(h.controls.at(-1)).toMatchObject({ type: "stream.status", state: "paused" });
    h.clock(12000);
    h.stream.tick();
    expect(probes).toBe(1);
    finish({ generation: 1, quiescent: true });
    await vi.waitFor(() => expect(h.stream.nextDeadline()).toBe(14000));
    h.stream.sendOne();
    expect(h.controls.filter((m) => m.type === "stream.status")).toHaveLength(1);
    h.stream.cancel();
  });
});
