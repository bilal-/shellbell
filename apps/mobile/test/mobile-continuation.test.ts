import {
  CONTINUATION_EXTENSIONS,
  prepareStreamSnapshot,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  StreamSender,
  type StreamTransferMeta,
} from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { MobileScreenStream, VtLog } from "../src/net/mobile-screen-stream";
import { RetainedTerminal } from "../src/net/retained-terminal";
import type { VtReplayLog, VtSeed } from "../src/terminal/vt-replay-log";

const SID = "tmux:history";
const SUB = "S".repeat(22);
const CAP = "C".repeat(22);
const bytes = (text: string) => new TextEncoder().encode(text);
const seed = (patch: Partial<VtSeed> = {}): VtSeed => ({
  kind: "vt-seed",
  generation: 1,
  cols: 40,
  rows: 4,
  capture: CAP,
  disposition: "initial",
  reason: "start",
  cursor: "real",
  alternate: "real",
  ...patch,
});
function harness(terminal = new RetainedTerminal("computer-a", SID), subscriptionId = SUB) {
  let now = 0;
  let serial = 0;
  let controlsAt = 0;
  let admitApplied = true;
  const controls: StreamMessage[] = [];
  const queue: StreamChunk[] = [];
  const changed = vi.fn();
  const mobile = new MobileScreenStream({
    subscriptionId,
    sessionId: SID,
    vt: true,
    terminal,
    now: () => now,
    onChange: changed,
    sendControl: (message) => {
      controls.push(message);
      return message.type !== "stream.applied" || admitApplied;
    },
  });
  const sender = new StreamSender({
    subscriptionId,
    sessionId: SID,
    now: () => now,
    newTransferId: () => (++serial).toString(36).padStart(22, "0"),
    send: (chunk) => {
      queue.push(chunk);
      return true;
    },
  });
  const receive = (message: StreamMessage) => mobile.receive(message, 200);
  const pump = () => {
    let turns = 0;
    while (queue.length) {
      if (++turns > 100) throw new Error("Wire did not settle");
      receive(queue.shift()!);
      while (controlsAt < controls.length) {
        const control = controls[controlsAt++]!;
        if (control.type === "stream.ack") sender.acknowledge(subscriptionId, control.through);
      }
      sender.pump();
    }
  };
  mobile.start();
  return {
    terminal,
    mobile,
    controls,
    changed,
    receive,
    accept(extensions: readonly string[] = CONTINUATION_EXTENSIONS) {
      receive({ type: "stream.accepted", subscriptionId, extensions: [...extensions] });
    },
    offer(meta: StreamTransferMeta, text: string | Uint8Array) {
      expect(sender.offer(meta, typeof text === "string" ? bytes(text) : text).accepted).toBe(true);
      sender.pump();
      pump();
    },
    tick(time: number) {
      now = time;
      mobile.tick();
    },
    time(time: number) {
      now = time;
    },
    status(state: "quiescent" | "catching-up" | "paused", offset = 0, capture = CAP) {
      receive({ type: "stream.status", subscriptionId, generation: 1, capture, offset, state });
    },
    get log() {
      return mobile.snapshot.vt!.log as VtReplayLog;
    },
    set admitApplied(value: boolean) {
      admitApplied = value;
    },
  };
}

describe("negotiated phone continuation", () => {
  it("handles renderer failure on the retained log after rebinding without reporting it on the new wire", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "saved");
    h.log.apply(0);
    const old = h.log;
    old.beginRender();
    h.mobile.cancel(true);
    const next = harness(h.terminal, "N".repeat(22));
    old.render(0);
    expect(next.changed).toHaveBeenCalled();
    next.tick(50);
    expect(next.controls.some((m) => m.type === "stream.applied")).toBe(false);
    expect(next.mobile.rendererError(old, "checkpoint-missing")).toBe(true);
    expect(old.bytes).toBe(0);
    const fresh = harness(h.terminal, "F".repeat(22));
    expect(fresh.controls[0]).toMatchObject({ retained: false });
    fresh.accept();
    fresh.offer(seed(), "full fresh seed");
    fresh.log.apply(0);
    expect(fresh.mobile.snapshot.output?.state).toBe("live");
  });

  it("keeps the only checkpoint while its renderer is blocked across subscription replacement", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "saved");
    h.log.apply(0);
    const old = h.log;
    h.mobile.rendererError(old, "renderer");
    h.mobile.cancel(true);
    const next = harness(h.terminal, "N".repeat(22));
    next.accept();
    next.offer(seed({ disposition: "discontinuity", reason: "reconnect" }), "new screen");
    expect(old.isDisposed).toBe(false);
    expect(next.mobile.snapshot.output).toMatchObject({ state: "paused", reason: "renderer" });
    next.tick(30_000);
    expect(next.controls.some((m) => m.type === "stream.refresh")).toBe(false);
    next.mobile.rendererReady(old);
    expect(h.terminal.rendererBlocked).toBe(false);
    expect(next.changed).toHaveBeenCalled();
  });

  it("defers a rapid reseed until the first native seed has materialized", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "earlier rows");
    const old = h.log;
    h.offer(seed({ generation: 2, disposition: "discontinuity", reason: "resize" }), "resized");
    expect(h.mobile.snapshot.error).toBe("stalled");
    expect(old.isDisposed).toBe(false);
    old.apply(0);
    expect(old.hasRetained).toBe(true);
    h.mobile.cancel(true);
    const next = harness(h.terminal, "N".repeat(22));
    expect(next.controls[0]).toMatchObject({ retained: true });
  });

  it("preserves committed history when another reseed arrives before the previous seed parses", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "initial");
    h.log.apply(0);
    h.offer(seed({ generation: 2, disposition: "discontinuity", reason: "resize" }), "resized");
    const retained = h.log;
    const history = bytes("old history");
    retained.beginHistory({ bytes: history.length, rows: 1, dropped: false });
    retained.historyPart(0, history);
    retained.commitHistory();
    h.offer(
      seed({ generation: 3, disposition: "discontinuity", reason: "resize" }),
      "another resize",
    );
    expect(retained.isDisposed).toBe(false);
    expect(retained.history?.data).toEqual(history);
    expect(h.mobile.snapshot.error).toBe("stalled");
    retained.apply(0);
    expect(retained.hasRetained).toBe(true);
  });

  it("ACKs bounded native receipt before parsing and coalesces applied progress independently", () => {
    const h = harness();
    expect(h.controls[0]).toMatchObject({
      type: "stream.subscribe",
      mode: "vt",
      extensions: CONTINUATION_EXTENSIONS,
      retained: false,
    });
    h.accept();
    h.offer(seed(), "screen");
    expect(h.controls.some((value) => value.type === "stream.ack")).toBe(true);
    expect(h.log.appliedOffset).toBe(-1);
    expect(h.mobile.snapshot.output?.state).toBe("catching-up");
    expect(h.log.apply(0)).toBe(true);
    expect(h.mobile.snapshot.output?.state).toBe("live");
    expect(h.changed).toHaveBeenCalled();
    expect(h.mobile.nextDeadline()).toBe(50);
    h.tick(50);
    expect(h.controls.filter((value) => value.type === "stream.applied")).toEqual([
      { type: "stream.applied", subscriptionId: SUB, generation: 1, capture: CAP, offset: 0 },
    ]);
    h.offer({ kind: "vt", generation: 1, offset: 0 }, "abc");
    h.log.render(1);
    h.log.render(3);
    h.tick(100);
    expect(
      h.controls.filter((value) => value.type === "stream.applied").map((value) => value.offset),
    ).toEqual([0, 3]);
    expect(h.log.pendingApplied).toBeNull();
  });

  it("does not consume an applied report refused by transport admission", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    h.admitApplied = false;
    h.tick(50);
    expect(h.log.pendingApplied?.offset).toBe(0);
    expect(h.mobile.nextDeadline()).toBe(300);
    h.admitApplied = true;
    h.tick(300);
    expect(h.log.pendingApplied).toBeNull();
    expect(h.mobile.snapshot.status).toBe("live");
  });

  it("keeps current document restore progress separate from already reported application", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    h.offer({ kind: "vt", generation: 1, offset: 0 }, "tail");
    h.log.render(4);
    h.tick(50);
    h.log.beginRender();
    expect(h.log.appliedOffset).toBe(4);
    expect(h.log.renderedOffset).toBe(-1);
    expect(h.log.hasRetained).toBe(true);
    expect(h.mobile.snapshot.output?.state).toBe("catching-up");
    h.log.render(0);
    expect(h.mobile.snapshot.output?.state).toBe("catching-up");
    expect(h.log.pendingApplied).toBeNull();
    h.log.render(4);
    expect(h.mobile.snapshot.output?.state).toBe("live");
    expect(h.log.pendingApplied).toBeNull();
  });

  it("retains only the same focused owner across a new subscription and disposes before replacement", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "old history");
    h.log.apply(0);
    const old = h.log;
    h.mobile.cancel(true);
    const next = harness(h.terminal, "N".repeat(22));
    expect(next.controls[0]).toMatchObject({ retained: true });
    expect(next.log).toBe(old);
    next.accept();
    next.offer(
      seed({ disposition: "discontinuity", reason: "reconnect", capture: "D".repeat(22) }),
      "new screen",
    );
    expect(old.isDisposed).toBe(true);
    expect(old.bytes).toBe(0);
    expect(next.log.owner?.scope).toBe(old.owner?.scope);
    expect(next.log.owner?.subscriptionId).toBe("N".repeat(22));
    expect(next.log.apply(0)).toBe(false);
    expect(next.log.beginHistory({ bytes: 0, rows: 0, dropped: false })).toBe(true);
    expect(next.log.commitHistory()).toBe(true);
    expect(next.log.apply(0)).toBe(true);
    const changed = next.changed.mock.calls.length;
    expect(old.apply(0)).toBe(false);
    expect(next.changed).toHaveBeenCalledTimes(changed);
    h.mobile.cancel(); // obsolete owner cannot clear the replacement
    expect(next.log.isDisposed).toBe(false);
    next.mobile.cancel();
    expect(next.terminal.log).toBeNull();
    expect(
      () =>
        new MobileScreenStream({
          subscriptionId: SUB,
          sessionId: "tmux:other",
          terminal: h.terminal,
          vt: true,
          now: () => 0,
          sendControl: () => true,
        }),
    ).toThrow();
  });

  it("rejects unnegotiated seeds and partial acceptance remains on legacy records", () => {
    const denied = harness();
    denied.offer(seed(), "bad");
    expect(denied.mobile.snapshot.error).toBe("invalid-transfer");
    const partial = harness();
    partial.accept(["continuation-v1"]);
    partial.offer({ kind: "vt-state", generation: 1, cols: 40, rows: 4 }, "legacy");
    expect(partial.log).toBeInstanceOf(VtLog);
    expect(partial.mobile.snapshot.continuation).toBe(false);
    partial.tick(60_000);
    expect(partial.mobile.snapshot.status).toBe("live");
    const late = harness();
    late.offer({ kind: "vt-state", generation: 1, cols: 40, rows: 4 }, "legacy");
    late.accept();
    expect(late.mobile.snapshot.error).toBe("invalid-transfer");
  });

  it("pauses at ten seconds without healthy delivery and requests one fresh source at twenty", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    h.tick(50);
    h.tick(9_999);
    expect(h.mobile.snapshot.output?.state).toBe("live");
    h.tick(10_000);
    expect(h.mobile.snapshot.output).toMatchObject({ state: "paused", reason: "source" });
    expect(h.mobile.nextDeadline()).toBe(20_000);
    h.tick(20_000);
    h.tick(20_001);
    expect(h.controls.filter((value) => value.type === "stream.refresh")).toHaveLength(1);
    h.offer(
      seed({
        generation: 2,
        capture: "D".repeat(22),
        disposition: "discontinuity",
        reason: "refresh",
      }),
      "fresh screen",
    );
    expect(h.mobile.snapshot.output?.state).toBe("catching-up");
  });

  it("uses only current capture and delivered-offset quiescence as a healthy heartbeat", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    h.tick(50);
    h.time(9_000);
    h.status("quiescent", 0, "X".repeat(22));
    h.tick(10_000);
    expect(h.mobile.snapshot.output?.state).toBe("paused");
    h.status("quiescent");
    expect(h.mobile.snapshot.output?.state).toBe("live");
    h.offer({ kind: "vt", generation: 1, offset: 0 }, "new");
    h.log.render(3);
    h.time(19_000);
    h.status("quiescent", 0);
    h.tick(20_000);
    expect(h.mobile.snapshot.output?.state).toBe("paused");
    h.status("quiescent", 3);
    expect(h.mobile.snapshot.output?.state).toBe("live");
    h.status("paused", 3);
    expect(h.mobile.snapshot.output).toMatchObject({ state: "paused", reason: "source" });
  });

  it("starts the local backlog clock when bytes arrive after an idle prompt", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    h.tick(50);
    h.time(9_000);
    h.offer({ kind: "vt", generation: 1, offset: 0 }, "pending");
    h.tick(10_000);
    expect(h.mobile.snapshot.output?.state).toBe("catching-up");
    h.time(18_000);
    h.status("quiescent", 7);
    h.tick(19_000);
    expect(h.mobile.snapshot.output).toMatchObject({ state: "catching-up" });
    h.log.render(7);
    expect(h.mobile.snapshot.output?.state).toBe("live");
  });

  it("keeps renderer failure paused until a successful renderer recovery", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    h.tick(50);
    expect(h.mobile.rendererError(h.log, "renderer")).toBe(false);
    expect(h.mobile.snapshot.output).toMatchObject({ state: "paused", reason: "renderer" });
    h.tick(20_000);
    expect(h.controls.some((value) => value.type === "stream.refresh")).toBe(false);
    h.status("quiescent");
    h.mobile.rendererReady(h.log);
    expect(h.mobile.snapshot.output?.state).toBe("live");
  });

  it("labels Herdr replacement and clears every replay allocation on Ended", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "old");
    h.log.apply(0);
    const old = h.log;
    h.offer(
      seed({
        generation: 2,
        capture: "D".repeat(22),
        disposition: "replace",
        reason: "herdr-idle",
        cursor: "guessed",
        alternate: "unknown",
      }),
      "idle transcript",
    );
    expect(old.isDisposed).toBe(true);
    expect(h.mobile.snapshot.output?.replacement).toBe("herdr-idle");
    const current = h.log;
    h.receive({ type: "stream.error", subscriptionId: SUB, code: "session-gone" });
    expect(current.bytes).toBe(0);
    expect(h.mobile.snapshot.vt).toBeUndefined();
    expect(h.mobile.snapshot.output?.state).toBe("ended");
    expect(h.terminal.isEnded).toBe(true);
  });

  it("labels a retained raw buffer replaced by an older computer's snapshot fallback", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "old");
    h.log.apply(0);
    const old = h.log;
    h.mobile.cancel(true);
    const next = harness(h.terminal, "N".repeat(22));
    const record = prepareStreamSnapshot({
      gen: 1,
      cols: 40,
      rows: 1,
      cursor: { x: 0, y: 0 },
      scrollbackTotal: 0,
      lines: [{ r: [{ t: "snapshot" }] }],
    });
    if (!record.ok) throw new Error("Invalid fixture");
    next.offer({ kind: "snapshot", generation: 1 }, record.bytes);
    expect(old.isDisposed).toBe(true);
    expect(next.mobile.snapshot.vt).toBeUndefined();
    expect(next.mobile.snapshot.output?.replacement).toBe("snapshots");
    expect(next.mobile.snapshot.screen?.lines[0]?.r[0]?.t).toBe("snapshot");
  });

  it("retains a bounded native tail and asks for a discontinuity when its budget fills", () => {
    const h = harness();
    h.accept();
    h.offer(seed(), "screen");
    h.log.apply(0);
    const chunk = new Uint8Array(STREAM_LIMITS.screenBytes).fill(65);
    for (let i = 0; i < 9; i++)
      h.offer({ kind: "vt", generation: 1, offset: i * chunk.length }, chunk);
    expect(h.log.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(h.controls.filter((value) => value.type === "stream.refresh")).toHaveLength(1);
    expect(h.mobile.snapshot.status).toBe("live");
  });
});
