import { nativeHistoryProof, type StreamHistoryPage } from "@shellbell/protocol";
import { Terminal } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { TERMINAL_BUFFER_LIMIT } from "../src/terminal/buffer";
import { restoreVtHistory, VT_CHECKPOINT_BYTES } from "../src/terminal/vt-checkpoint";
import { encodeNativeHistoryPage } from "../src/terminal/vt-native-page";
import { VtReplayLog, type VtSeed } from "../src/terminal/vt-replay-log";

const meta: VtSeed = {
  kind: "vt-seed",
  generation: 1,
  cols: 20,
  rows: 4,
  capture: "C".repeat(22),
  disposition: "initial",
  reason: "start",
  cursor: "real",
  alternate: "real",
  historyBefore: 4,
  historyRows: 2,
  historyProof: nativeHistoryProof(20, ["new4", "new5"])!,
};
const page = (before = 4): StreamHistoryPage => ({
  kind: "history",
  generation: 1,
  requestId: "R".repeat(22),
  before,
  status: "page",
  from: before - 2,
  to: before,
  nextBefore: before - 2,
  oldestAvailable: 0,
  lines: [
    { r: [{ t: `old${before - 2}`, fg: 1 }] },
    { r: [{ t: `old${before - 1}`, bg: [1, 2, 3] }] },
  ],
});
const source = () => {
  const log = new VtReplayLog(meta, new TextEncoder().encode("seed"));
  log.apply(0);
  log.didReport(0);
  return log;
};

describe("native history in phone memory", () => {
  it("cannot stage a page until the matching seed has physical row proof", () => {
    const log = source();
    expect(log.olderBefore).toBeNull();
    expect(log.prependNativeHistory(page(), meta.capture, 2)).toBe("invalid");
    log.verifyNativeHistory(true);
    expect(log.olderBefore).toBe(4);
    expect(log.prependNativeHistory(page(), "X".repeat(22), 2)).toBe("invalid");
    expect(log.prependNativeHistory({ ...page(), generation: 2 }, meta.capture, 2)).toBe("invalid");
    expect(log.prependNativeHistory(page(3), meta.capture, 2)).toBe("invalid");
    expect(log.prependNativeHistory(page(), meta.capture, 2)).toBe("ok");
    expect(log.olderBefore).toBeNull();
    expect(log.hasRetained).toBe(false);
  });

  it("holds applied progress until hidden replay catches up and is presented", () => {
    const log = source();
    log.verifyNativeHistory(true);
    expect(log.append(0, new Uint8Array([1, 2]))).toBe("ok");
    expect(log.prependNativeHistory(page(), meta.capture, 2)).toBe("ok");
    log.beginRender();
    expect(log.render(0)).toBe(true);
    expect(log.commitNativeHistory()).toBe(false);
    expect(log.apply(2)).toBe(false);
    expect(log.render(2)).toBe(true);
    expect(log.pendingApplied).toBeNull();
    expect(log.appliedOffset).toBe(0);
    expect(log.isRestoring).toBe(true);
    expect(log.commitNativeHistory()).toBe(true);
    expect(log.pendingApplied?.offset).toBe(2);
    expect(log.olderBefore).toBe(2);
    expect(log.isRestoring).toBe(false);
  });

  it("prepends consecutive pages in order and accounts for both prefixes during rebuild", async () => {
    const log = source();
    log.verifyNativeHistory(true);
    expect(log.prependNativeHistory(page(), meta.capture, 2)).toBe("ok");
    log.beginRender();
    log.render(0);
    log.commitNativeHistory();
    const prior = log.history!.data.byteLength;
    expect(log.prependNativeHistory(page(2), meta.capture, 4)).toBe("ok");
    expect(log.bytes).toBe(log.seed.length + log.history!.data.byteLength + prior);
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    try {
      await restoreVtHistory(term, log.history!, 20, 4);
      expect(
        Array.from({ length: term.buffer.normal.baseY }, (_, i) =>
          term.buffer.normal.getLine(i)!.translateToString(true),
        ),
      ).toEqual(["old0", "old1", "old2", "old3"]);
      expect(term.buffer.normal.getLine(0)!.getCell(0)!.getFgColor()).toBe(1);
      expect(term.buffer.normal.getLine(1)!.getCell(0)!.getBgColor()).toBe(0x010203);
    } finally {
      term.dispose();
    }
    log.beginRender();
    log.render(0);
    log.commitNativeHistory();
    expect(log.bytes).toBe(log.seed.length + log.history!.data.byteLength);
    expect(log.olderBefore).toBe(0);
  });

  it("refuses older pages at the row or peak byte budget without replacing current history", () => {
    const log = source();
    log.verifyNativeHistory(true);
    const current = log.history;
    expect(log.prependNativeHistory(page(), meta.capture, TERMINAL_BUFFER_LIMIT)).toBe("full");
    while (log.bytes + 524288 <= VT_CHECKPOINT_BYTES)
      expect(log.append(log.receivedOffset, new Uint8Array(524288))).toBe("ok");
    const remaining = VT_CHECKPOINT_BYTES - log.bytes;
    if (remaining) expect(log.append(log.receivedOffset, new Uint8Array(remaining))).toBe("ok");
    expect(log.prependNativeHistory(page(), meta.capture, 2)).toBe("full");
    expect(log.history).toBe(current);
    expect(log.bytes).toBeLessThanOrEqual(VT_CHECKPOINT_BYTES);
  });

  it("keeps a failed proof stopped across later callbacks and releases every stage on disposal", () => {
    const log = source();
    log.verifyNativeHistory(false);
    log.verifyNativeHistory(true);
    expect(log.olderBefore).toBeNull();
    const active = source();
    active.verifyNativeHistory(true);
    active.prependNativeHistory(page(), meta.capture, 2);
    active.dispose();
    expect(active.bytes).toBe(0);
    expect(active.pendingPrepend).toBeNull();
    expect(active.commitNativeHistory()).toBe(false);
  });
});

describe("native physical row encoding", () => {
  it("does not reinterpret controls, truncate overwide rows or invent soft wraps", () => {
    for (const lines of [
      [{ r: [{ t: "\x1b[2J" }] }],
      [{ r: [{ t: "x".repeat(21) }] }],
      [{ r: [{ t: "wrapped" }], w: true }],
    ])
      expect(encodeNativeHistoryPage(lines, 20)).toBeNull();
  });
  it("replays blank, wide and full-width rows at their exact physical boundaries", async () => {
    const lines = [
      { r: [{ t: "界".repeat(10), n: 20 }] },
      { r: [] },
      { r: [{ t: "x".repeat(20) }] },
    ];
    const encoded = encodeNativeHistoryPage(lines, 20)!;
    const term = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    try {
      await restoreVtHistory(term, { ...encoded, dropped: false }, 20, 4);
      const rows = Array.from({ length: term.buffer.normal.baseY }, (_, i) =>
        term.buffer.normal.getLine(i)!.translateToString(true),
      );
      expect(rows).toEqual(["界".repeat(10), "", "x".repeat(20)]);
      expect(nativeHistoryProof(20, rows)).toBe(encoded.proof);
    } finally {
      term.dispose();
    }
  });
});
