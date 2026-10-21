import { STREAM_LIMITS } from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { VT_CHECKPOINT_BYTES, VT_HISTORY_BYTES } from "../src/terminal/vt-checkpoint";
import { VT_REPLAY_SEGMENT_BYTES, VtReplayLog, type VtSeed } from "../src/terminal/vt-replay-log";

const meta: VtSeed = {
  kind: "vt-seed",
  generation: 7,
  cols: 80,
  rows: 24,
  capture: "aaaaaaaaaaaaaaaaaaaaaa",
  disposition: "initial",
  reason: "start",
  cursor: "real",
  alternate: "real",
};
const bytes = (text: string) => new TextEncoder().encode(text);
const log = (disposition: VtSeed["disposition"] = "initial", seed = bytes("seed")) =>
  new VtReplayLog({ ...meta, disposition }, seed);

describe("native VT replay log", () => {
  it("separates bounded receipt from checkpointed parser progress", () => {
    const source = log();
    expect(source.bytes).toBe(4);
    expect(source.append(0, bytes("one"))).toBe("ok");
    expect(source.append(3, bytes("two"))).toBe("ok");
    expect(source.receivedOffset).toBe(6);
    expect(source.hasRetained).toBe(false);
    expect(source.pendingApplied).toBeNull();
    expect(source.apply(0)).toBe(true);
    expect(source.hasRetained).toBe(true);
    expect(source.pendingApplied).toEqual({ generation: 7, capture: meta.capture, offset: 0 });
    expect(source.apply(3)).toBe(true);
    expect(source.apply(6)).toBe(true);
    expect(source.pendingApplied?.offset).toBe(6);
    // Backpressure leaves the report pending until control admission succeeds.
    expect(source.pendingApplied?.offset).toBe(6);
    expect(source.didReport(6)).toBe(true);
    expect(source.pendingApplied).toBeNull();
    // Replaying earlier bytes after a WebView reload cannot regress reported application.
    expect(source.apply(0)).toBe(false);
    expect(source.apply(3)).toBe(false);
    expect(source.apply(6)).toBe(true);
    expect(source.pendingApplied).toBeNull();
    expect(source.append(6, bytes("!"))).toBe("ok");
    expect(source.apply(7)).toBe(true);
    expect(source.pendingApplied?.offset).toBe(7);
  });

  it("requires every history part and native commit before a discontinuity can be applied", () => {
    const source = log("discontinuity");
    expect(source.history).toBeNull();
    expect(source.append(0, bytes("tail"))).toBe("ok");
    expect(source.apply(0)).toBe(false);
    expect(source.beginHistory({ bytes: 7, rows: 1, dropped: true })).toBe(true);
    expect(source.bytes).toBe(4 + VT_REPLAY_SEGMENT_BYTES + 7);
    expect(source.historyPart(0, bytes("hist"))).toBe(true);
    expect(source.commitHistory()).toBe(false);
    expect(source.history).toBeNull();
    expect(source.apply(4)).toBe(false);
    expect(source.historyPart(4, bytes("ory"))).toBe(true);
    expect(source.commitHistory()).toBe(true);
    expect(source.history).toEqual({ data: bytes("history"), rows: 1, dropped: true });
    expect(source.apply(4)).toBe(true);
    expect(source.hasRetained).toBe(true);
  });

  it("counts seed, reserved history and received tail against one 4MiB cap", () => {
    const source = log("discontinuity", new Uint8Array(STREAM_LIMITS.screenBytes));
    let remaining = VT_CHECKPOINT_BYTES - source.bytes;
    while (remaining > 0) {
      const size = Math.min(remaining, STREAM_LIMITS.screenBytes);
      expect(source.append(source.receivedOffset, new Uint8Array(size))).toBe("ok");
      remaining -= size;
    }
    expect(source.bytes).toBe(VT_CHECKPOINT_BYTES);
    expect(source.append(source.receivedOffset, bytes("!"))).toBe("full");
    expect(source.bytes).toBe(VT_CHECKPOINT_BYTES);
    expect(source.beginHistory({ bytes: VT_HISTORY_BYTES, rows: 10000, dropped: false })).toBe(
      true,
    );
    // Filling/committing the already reserved allocation consumes no second budget.
    for (let at = 0; at < VT_HISTORY_BYTES; at += 256 * 1024)
      expect(source.historyPart(at, new Uint8Array(256 * 1024))).toBe(true);
    expect(source.commitHistory()).toBe(true);
    expect(source.bytes).toBe(VT_CHECKPOINT_BYTES);
  });

  it("coalesces tiny writes without forcing periodic reseeds", () => {
    const source = log();
    for (let i = 0; i < 20000; i++) expect(source.append(i, bytes("x"))).toBe("ok");
    expect(source.receivedOffset).toBe(20000);
    expect(source.bytes).toBe(4 + 2 * VT_REPLAY_SEGMENT_BYTES);
    expect(source.read(0)?.byteLength).toBe(20000);
    expect(source.read(VT_REPLAY_SEGMENT_BYTES - 1, 3)).toEqual(bytes("xxx"));
    const earlier = source.read(19999)!;
    expect(source.append(20000, bytes("new"))).toBe("ok");
    expect(earlier).toEqual(bytes("x"));
    expect(source.read(20000)).toEqual(bytes("new"));
    expect(source.read(20003)).toBeNull();
  });

  it("owns received bytes so later transfer-buffer reuse cannot corrupt replay", () => {
    const seed = bytes("seed");
    const tail = bytes("tail");
    const history = bytes("old");
    const source = log("discontinuity", seed);
    source.append(0, tail);
    source.beginHistory({ bytes: 3, rows: 1, dropped: false });
    source.historyPart(0, history);
    source.commitHistory();
    seed.fill(0);
    tail.fill(0);
    history.fill(0);
    expect(source.seed).toEqual(bytes("seed"));
    expect(source.read(0)).toEqual(bytes("tail"));
    expect(source.history?.data).toEqual(bytes("old"));
  });

  it("reads exact bytes across segment and original transfer boundaries", () => {
    const source = log();
    const input = Uint8Array.from({ length: 200000 }, (_, i) => i % 251);
    let offset = 0;
    for (const length of [1, 16382, 2, 65537, 911, 1167, 116000]) {
      expect(source.append(offset, input.subarray(offset, offset + length))).toBe("ok");
      offset += length;
    }
    expect(offset).toBe(input.length);
    const replay = new Uint8Array(input.length);
    for (let at = 0; at < input.length; ) {
      const part = source.read(at, 13371)!;
      replay.set(part, at);
      at += part.length;
    }
    expect(replay).toEqual(input);
    expect(source.read(0)).toEqual(input);
  });

  it("rejects out-of-order, oversized and duplicate history parts without committing a partial buffer", () => {
    const source = log("discontinuity");
    expect(source.beginHistory({ bytes: 8, rows: 1, dropped: false })).toBe(true);
    expect(source.beginHistory({ bytes: 8, rows: 1, dropped: false })).toBe(false);
    expect(source.historyPart(1, bytes("a"))).toBe(false);
    expect(source.historyPart(0, bytes("123456789"))).toBe(false);
    expect(source.historyPart(0, bytes("1234"))).toBe(true);
    expect(source.historyPart(0, bytes("1234"))).toBe(false);
    expect(source.commitHistory()).toBe(false);
    expect(source.historyPart(4, bytes("5678"))).toBe(true);
    expect(source.commitHistory()).toBe(true);
    expect(source.commitHistory()).toBe(false);
    expect(source.historyPart(8, bytes("extra"))).toBe(false);
  });

  it("rejects invalid progress and receipt offsets without advancing", () => {
    const source = log();
    expect(source.append(1, bytes("gap"))).toBe("invalid");
    expect(source.append(0, new Uint8Array())).toBe("invalid");
    expect(source.append(0, bytes("abc"))).toBe("ok");
    for (const offset of [-1, 0.5, NaN, Infinity, 4]) {
      expect(source.apply(offset)).toBe(false);
      expect(source.didReport(offset)).toBe(false);
    }
    expect(source.pendingApplied).toBeNull();
    expect(source.didReport(0)).toBe(false);
    expect(source.apply(3)).toBe(true);
    expect(source.didReport(4)).toBe(false);
    expect(source.didReport(3)).toBe(true);
    expect(source.didReport(2)).toBe(false);
  });

  it("rejects invalid allocations before reserving memory", () => {
    const source = log("discontinuity");
    for (const header of [
      { bytes: -1, rows: 1, dropped: false },
      { bytes: VT_HISTORY_BYTES + 1, rows: 1, dropped: false },
      { bytes: NaN, rows: 1, dropped: false },
      { bytes: 1, rows: 0, dropped: false },
      { bytes: 0, rows: 1, dropped: false },
      { bytes: 1, rows: 10001, dropped: false },
    ])
      expect(source.beginHistory(header)).toBe(false);
    expect(source.bytes).toBe(4 + VT_HISTORY_BYTES);
    expect(() => log("initial", new Uint8Array(STREAM_LIMITS.screenBytes + 1))).toThrow();
  });

  it("can commit an explicitly empty retained history after eviction", () => {
    const source = log("discontinuity");
    expect(source.beginHistory({ bytes: 0, rows: 0, dropped: true })).toBe(true);
    expect(source.commitHistory()).toBe(true);
    expect(source.apply(0)).toBe(true);
    expect(source.history?.dropped).toBe(true);
  });

  it.each(["initial", "replace"] as const)(
    "does not import old phone history for a %s seed",
    (disposition) => {
      const source = log(disposition);
      expect(source.history?.rows).toBe(0);
      expect(source.beginHistory({ bytes: 3, rows: 1, dropped: false })).toBe(false);
      expect(source.apply(0)).toBe(true);
    },
  );

  it("releases checkpoint references and refuses further work after the owning view ends", () => {
    const source = log("discontinuity");
    source.append(0, bytes("tail"));
    source.beginHistory({ bytes: 3, rows: 1, dropped: false });
    source.historyPart(0, bytes("old"));
    source.dispose();
    expect(source.bytes).toBe(0);
    expect(source.seed).toHaveLength(0);
    expect(source.read(0)).toBeNull();
    expect(source.history).toBeNull();
    expect(source.hasRetained).toBe(false);
    expect(source.pendingApplied).toBeNull();
    expect(source.commitHistory()).toBe(false);
    expect(source.beginHistory({ bytes: 0, rows: 0, dropped: false })).toBe(false);
    expect(source.append(0, bytes("late"))).toBe("invalid");
    expect(source.apply(0)).toBe(false);
    expect(source.didReport(0)).toBe(false);
  });
});
