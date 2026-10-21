import type { StreamChunk, StreamTransferMeta } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { StreamAppliedProgress } from "../src/stream-applied-progress.js";

const subscriptionId = "S".repeat(22);
const capture = "C".repeat(22);
const meta: StreamTransferMeta = {
  kind: "vt-seed",
  generation: 1,
  cols: 80,
  rows: 24,
  capture,
  disposition: "initial",
  reason: "start",
  cursor: "real",
  alternate: "real",
};
const report = (generation: number, offset: number, id = capture) => ({
  type: "stream.applied" as const,
  subscriptionId,
  generation,
  offset,
  capture: id,
});
function chunk(metadata: StreamTransferMeta, totalBytes = 1, index = 0, count = 1): StreamChunk {
  return {
    type: "stream.chunk",
    subscriptionId,
    sessionId: "tmux:1",
    transferId: "T".repeat(22),
    sequence: index + 1,
    index,
    count,
    totalBytes,
    data: new Uint8Array(1),
    meta: metadata,
  };
}

describe("applied progress", () => {
  it("never infers application from delivery, including an incomplete seed", () => {
    const progress = new StreamAppliedProgress();
    progress.admit(chunk(meta, 16385, 0, 2));
    expect(progress.receive(report(1, 0))).toBe("invalid");
    progress.admit(chunk(meta, 16385, 1, 2));
    expect(progress.matches(1, capture, 0)).toBe(false);
    expect(progress.receive(report(1, 0))).toBe("advanced");
    expect(progress.matches(1, capture, 0)).toBe(true);
    expect(progress.receive(report(1, 0))).toBe("ignored");
  });

  it("accepts only monotonic applied bytes within complete admitted transfers", () => {
    const progress = new StreamAppliedProgress();
    progress.admit(chunk(meta));
    progress.admit(chunk({ kind: "vt", generation: 1, offset: 0 }, 20));
    expect(progress.receive(report(1, 21))).toBe("invalid");
    expect(progress.receive(report(2, 0))).toBe("invalid");
    expect(progress.receive(report(1, 5, "X".repeat(22)))).toBe("invalid");
    expect(progress.receive(report(1, 5))).toBe("advanced");
    expect(progress.receive(report(1, 4))).toBe("invalid");
    expect(progress.receive(report(1, 20))).toBe("advanced");
    expect(progress.matches(1, capture, 19)).toBe(false);
    expect(progress.matches(1, capture, 20)).toBe(true);
  });

  it("fences a late old renderer behind a new generation without closing the new stream", () => {
    const progress = new StreamAppliedProgress();
    progress.admit(chunk(meta));
    progress.receive(report(1, 0));
    progress.admit(chunk({ ...meta, generation: 2, capture: "N".repeat(22) }));
    expect(progress.receive(report(1, 0))).toBe("ignored");
    expect(progress.matches(1, capture, 0)).toBe(false);
    expect(progress.receive(report(2, 0))).toBe("invalid");
    expect(progress.receive(report(2, 0, "N".repeat(22)))).toBe("advanced");
  });
});
