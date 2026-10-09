import {
  encodeCbor,
  encodeStreamDiff,
  prepareStreamSnapshot,
  type ScreenDiff,
  type ScreenSnapshot,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamHistoryPage,
  type StreamMessage,
  type StreamReceiver,
  StreamSender,
} from "@shellbell/protocol";
import { describe, expect, it } from "vitest";
import { MobileScreenStream } from "../src/net/mobile-screen-stream.js";
import { BoundedHistoryWindow } from "../src/store/bounded-history.js";

const SUBSCRIPTION = "S".repeat(22);
const TRANSFER = "T".repeat(22);
const SESSION = "tmux:window-1";

function screen(gen = 7, scrollbackTotal = 42, text = "x", reset = false): ScreenSnapshot {
  return {
    cols: 8,
    rows: 1,
    cursor: { x: 1, y: 0 },
    lines: [{ r: [{ t: text, fg: [1, 2, 3] }] }],
    scrollbackTotal,
    gen,
    ...(reset ? { reset: true } : {}),
  };
}

function historyPage(
  request: Extract<StreamMessage, { type: "stream.history.get" }>,
  from: number,
): StreamHistoryPage {
  return {
    kind: "history",
    status: "page",
    generation: 7,
    requestId: request.requestId,
    before: request.before,
    from,
    to: request.before,
    oldestAvailable: 0,
    nextBefore: from,
    lines: Array.from({ length: request.before - from }, (_, i) => ({
      r: [{ t: String(from + i) }],
    })),
  };
}

function harness(
  options: { retainedHistory?: BoundedHistoryWindow; refreshHistory?: boolean } = {},
) {
  let time = 0;
  let transfer = 0;
  const controls: StreamMessage[] = [];
  const queued: StreamChunk[] = [];
  const mobile = new MobileScreenStream({
    subscriptionId: SUBSCRIPTION,
    sessionId: SESSION,
    now: () => time,
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
    ...options,
  });
  const sender = new StreamSender({
    subscriptionId: SUBSCRIPTION,
    sessionId: SESSION,
    now: () => time,
    newTransferId: () => (++transfer).toString(36).padStart(22, "0"),
    send: (chunk) => {
      queued.push(chunk);
      return true;
    },
  });
  let acknowledged = 0;
  return {
    mobile,
    sender,
    controls,
    queued,
    setTime(value: number) {
      time = value;
    },
    tickAt(value: number) {
      time = value;
      mobile.tick();
    },
    deliver() {
      const chunk = queued.shift();
      if (!chunk) throw new Error("missing queued chunk");
      mobile.receive(chunk, 200);
      return chunk;
    },
    deliverAcks() {
      for (; acknowledged < controls.length; acknowledged++) {
        const control = controls[acknowledged];
        if (control?.type === "stream.ack") {
          expect(sender.acknowledge(SUBSCRIPTION, control.through)).toBe("advanced");
        }
      }
    },
    offerSnapshot(value: ScreenSnapshot) {
      const prepared = prepareStreamSnapshot(value);
      if (!prepared.ok) throw new Error("invalid snapshot fixture");
      expect(
        sender.offer({ kind: "snapshot", generation: value.gen }, prepared.bytes).accepted,
      ).toBe(true);
      return sender.pump();
    },
    offerDiff(value: ScreenDiff) {
      expect(
        sender.offer({ kind: "diff", generation: value.gen }, encodeStreamDiff(value)).accepted,
      ).toBe(true);
      return sender.pump();
    },
    offerHistory(request: Extract<StreamMessage, { type: "stream.history.get" }>, from: number) {
      const record = historyPage(request, from);
      expect(
        sender.offer(
          { kind: "history", generation: 7, requestId: request.requestId, before: request.before },
          encodeCbor(record),
        ).accepted,
      ).toBe(true);
      return sender.pump();
    },
    lastGet() {
      const result = controls
        .filter(
          (message): message is Extract<StreamMessage, { type: "stream.history.get" }> =>
            message.type === "stream.history.get",
        )
        .at(-1);
      if (!result) throw new Error("missing history request");
      return result;
    },
  };
}

describe("history recovery", () => {
  it("keeps loaded rows at the native fetch limit and stops retrying that capture", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.deliverAcks();
    h.mobile.requestOlder();
    h.offerHistory(h.lastGet(), 40);
    h.deliver();
    h.tickAt(500);
    h.deliverAcks();
    const cached = h.mobile.snapshot.history;
    h.mobile.requestOlder();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: h.lastGet().requestId,
        code: "history-unavailable",
        historyReason: "fetch-window",
      },
      150,
    );
    expect(h.mobile.snapshot.historyStatus).toBe("limited");
    expect(h.mobile.snapshot.history).toBe(cached);
    expect(h.mobile.snapshot.history?.readOnly).toBe(false);
    const count = h.controls.length;
    expect(h.mobile.requestOlder()).toBe(false);
    h.tickAt(1000);
    expect(h.controls).toHaveLength(count);
    // Live output still flows even though this capture's older rows cannot be fetched.
    h.offerDiff({
      gen: 8,
      scroll: 0,
      changed: [{ i: 0, line: { r: [{ t: "new" }] } }],
      cursor: { x: 3, y: 0 },
      scrollbackTotal: 42,
    });
    h.deliver();
    expect(h.mobile.snapshot.screen?.gen).toBe(8);
    expect(h.mobile.snapshot.historyStatus).toBe("limited");
  });

  const oldId = "O".repeat(22);
  const retained = (withRows = true) => {
    const window = new BoundedHistoryWindow({ subscriptionId: oldId, generation: 7, before: 42 });
    if (withRows) {
      expect(
        window.prepend(
          oldId,
          historyPage(
            {
              type: "stream.history.get",
              subscriptionId: oldId,
              requestId: "R".repeat(22),
              before: 42,
              count: 1,
            },
            41,
          ),
        ),
      ).toBe(true);
    }
    window.detach();
    return window;
  };

  it("reconnects an empty history cache without requiring a manual refresh", () => {
    const h = harness({ retainedHistory: retained(false) });
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.tickAt(500);
    expect(h.mobile.snapshot.historyStatus).toBe("ready");
    expect(h.mobile.snapshot.history?.readOnly).toBe(false);
    expect(h.mobile.requestOlder()).toBe(true);
    expect(h.lastGet().before).toBe(42);
  });

  it("retains an explicit skipped-row gap across reconnect even without cached lines", () => {
    const window = new BoundedHistoryWindow({ subscriptionId: oldId, generation: 7, before: 42 });
    expect(window.skip(oldId, 42)).toBe(true);
    window.detach();
    const h = harness({ retainedHistory: window });
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.snapshot.history?.gaps).toEqual([{ from: 41, to: 42 }]);
  });

  it.each(["end", "truncated"] as const)(
    "finishes explicit refresh at an empty %s boundary",
    (reason) => {
      const h = harness({ retainedHistory: retained(), refreshHistory: true });
      h.mobile.start();
      h.offerSnapshot(screen(7, 0));
      h.deliver();
      h.tickAt(500);
      h.deliverAcks();
      const request = h.lastGet();
      const record = {
        kind: "history",
        status: "boundary",
        generation: 7,
        requestId: request.requestId,
        before: 0,
        reason,
        oldestAvailable: reason === "end" ? 0 : 1,
      };
      expect(
        h.sender.offer(
          { kind: "history", generation: 7, requestId: request.requestId, before: 0 },
          encodeCbor(record),
        ).accepted,
      ).toBe(true);
      h.sender.pump();
      h.deliver();
      expect(h.mobile.snapshot.historyStatus).toBe(reason);
      expect(h.mobile.snapshot.history?.readOnly).toBe(false);
      expect(h.mobile.snapshot.history?.rows).toEqual([]);
      expect(h.mobile.snapshot.history?.anchor.subscriptionId).toBe(SUBSCRIPTION);
    },
  );

  it("keeps a busy refresh retryable on the same capture while retaining old rows", () => {
    const h = harness({ retainedHistory: retained(), refreshHistory: true });
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.tickAt(500);
    const request = h.lastGet();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: request.requestId,
        code: "history-unavailable",
      },
      100,
    );
    expect(h.mobile.snapshot.history?.rows[0]?.row).toBe(41);
    expect(h.mobile.snapshot).toMatchObject({
      historyStatus: "unavailable",
      historyRefreshPending: true,
    });
    expect(h.mobile.requestOlder()).toBe(true);
    expect(h.lastGet()).toMatchObject({
      subscriptionId: request.subscriptionId,
      before: request.before,
    });
    expect(h.lastGet().requestId).not.toBe(request.requestId);
    h.deliverAcks();
    h.offerHistory(h.lastGet(), 40);
    h.deliver();
    expect(h.mobile.snapshot.historyRefreshPending).toBe(false);
    expect(h.mobile.snapshot.history?.readOnly).toBe(false);
  });
});

describe("MobileScreenStream", () => {
  it("sends the completed screen ACK before requesting anchored history immediately", () => {
    const time = 0;
    const controls: StreamMessage[] = [];
    const queued: StreamChunk[] = [];
    const mobile = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      sendControl: (message) => {
        controls.push(message);
        return true;
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    const prepared = prepareStreamSnapshot({
      cols: 8,
      rows: 1,
      cursor: { x: 1, y: 0 },
      lines: [{ r: [{ t: "x" }] }],
      scrollbackTotal: 42,
      gen: 7,
    });
    if (!prepared.ok) throw new Error("invalid snapshot fixture");
    expect(mobile.start()).toBe(true);
    expect(mobile.requestOlder()).toBe(true);
    expect(sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes).accepted).toBe(true);
    expect(sender.pump()).toBe(1);
    const chunk = queued.shift();
    if (!chunk) throw new Error("missing queued chunk");
    mobile.receive(chunk, 200);
    expect(controls.map(({ type }) => type)).toEqual([
      "stream.subscribe",
      "stream.ack",
      "stream.history.get",
    ]);
    expect(controls[1]).toEqual({ type: "stream.ack", subscriptionId: SUBSCRIPTION, through: 1 });
    expect(controls[2]).toMatchObject({
      type: "stream.history.get",
      subscriptionId: SUBSCRIPTION,
      before: 42,
      count: 200,
    });
  });

  it("reconstructs styled live diffs while old generations cannot replace the acknowledged history anchor", () => {
    const h = harness();
    expect(h.mobile.start()).toBe(true);
    expect(h.offerSnapshot(screen())).toBe(1);
    h.deliver();
    h.tickAt(500);
    h.deliverAcks();
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.screen?.lines[0]?.r[0]?.fg).toEqual([1, 2, 3]);
    expect(h.mobile.snapshot.history?.anchor).toEqual({
      subscriptionId: SUBSCRIPTION,
      generation: 7,
      before: 42,
    });
    expect(h.mobile.nextDeadline()).toBeNull();

    expect(
      h.offerDiff({
        scroll: 0,
        changed: [{ i: 0, line: { r: [{ t: "y", bg: [4, 5, 6] }] } }],
        cursor: { x: 1, y: 0 },
        scrollbackTotal: 99,
        gen: 8,
      }),
    ).toBe(1);
    h.deliver();
    expect(h.mobile.snapshot.screen?.lines[0]?.r[0]?.t).toBe("y");
    expect(h.mobile.snapshot.screen?.lines[0]?.r[0]?.bg).toEqual([4, 5, 6]);
    expect(h.mobile.snapshot.history?.anchor.before).toBe(42);
    h.tickAt(1000);
    h.deliverAcks();

    expect(
      h.offerDiff({
        scroll: 0,
        changed: [{ i: 0, line: { r: [{ t: "old" }] } }],
        cursor: { x: 1, y: 0 },
        scrollbackTotal: 2,
        gen: 7,
      }),
    ).toBe(1);
    h.deliver();
    expect(h.mobile.snapshot.screen?.gen).toBe(8);
    expect(h.mobile.snapshot.screen?.lines[0]?.r[0]?.t).toBe("y");
    expect(h.controls.filter(({ type }) => type === "stream.refresh")).toHaveLength(0);
    h.tickAt(1500);
    h.deliverAcks();

    expect(
      h.offerDiff({
        scroll: 0,
        changed: [{ i: 0, line: { r: [{ t: "gap" }] } }],
        cursor: { x: 1, y: 0 },
        scrollbackTotal: 100,
        gen: 10,
      }),
    ).toBe(1);
    h.deliver();
    expect(h.controls.filter(({ type }) => type === "stream.refresh")).toHaveLength(1);
    expect(h.mobile.snapshot.screen?.gen).toBe(8);
    h.tickAt(2000);
    h.deliverAcks();
    expect(
      h.offerDiff({
        scroll: 0,
        changed: [{ i: 0, line: { r: [{ t: "gap2" }] } }],
        cursor: { x: 1, y: 0 },
        scrollbackTotal: 101,
        gen: 11,
      }),
    ).toBe(1);
    h.deliver();
    expect(h.controls.filter(({ type }) => type === "stream.refresh")).toHaveLength(1);
    h.tickAt(2500);
    h.deliverAcks();
    expect(h.offerSnapshot(screen(10, 105, "recover"))).toBe(1);
    h.deliver();
    expect(h.mobile.snapshot.screen?.gen).toBe(10);
    expect(h.mobile.snapshot.history?.anchor.before).toBe(42);
  });

  it("keeps one history request owned through page ACK and continues from a short page only on queued intent", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    expect(h.mobile.requestOlder()).toBe(true);
    h.tickAt(500);
    h.deliverAcks();
    const first = h.lastGet();
    expect(first.before).toBe(42);
    expect(h.offerHistory(first, 40)).toBe(1);
    h.deliver();
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([40, 41]);
    expect(h.mobile.snapshot.history?.nextBefore).toBe(40);
    expect(h.mobile.requestOlder()).toBe(true);
    expect(h.controls.filter(({ type }) => type === "stream.history.get")).toHaveLength(1);
    h.tickAt(1000);
    expect(h.controls.map(({ type }) => type).slice(-2)).toEqual([
      "stream.ack",
      "stream.history.get",
    ]);
    const second = h.lastGet();
    expect(second.before).toBe(40);
    expect(second.requestId).not.toBe(first.requestId);
    h.deliverAcks();
    expect(h.offerHistory(second, 39)).toBe(1);
    h.deliver();
    h.tickAt(1500);
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([39, 40, 41]);
    expect(h.controls.filter(({ type }) => type === "stream.history.get")).toHaveLength(2);
  });

  it("keeps live output during the 20,500-ms first-history-response allowance and discards late old records", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.mobile.requestOlder();
    h.tickAt(500);
    h.deliverAcks();
    const first = h.lastGet();
    expect(h.mobile.nextDeadline()).toBe(20500);
    h.tickAt(15500);
    expect(h.mobile.snapshot.historyStatus).toBe("loading");
    h.tickAt(20499);
    expect(h.mobile.snapshot.historyStatus).toBe("loading");
    h.tickAt(20500);
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.historyStatus).toBe("unavailable");
    expect(h.mobile.nextDeadline()).toBeNull();
    expect(h.mobile.requestOlder()).toBe(true);
    const second = h.lastGet();
    expect(second.requestId).not.toBe(first.requestId);
    h.offerHistory(first, 40);
    h.deliver();
    expect(h.mobile.snapshot.history?.rows).toEqual([]);
    expect(h.mobile.snapshot.historyStatus).toBe("loading");
    h.tickAt(21500);
    h.deliverAcks();
    h.offerHistory(second, 41);
    h.deliver();
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([41]);
  });

  it("retains old browsing through failed refresh and two oversized skips before atomic first-page replacement", () => {
    const OLD = "O".repeat(22);
    const old = new BoundedHistoryWindow({ subscriptionId: OLD, generation: 5, before: 10 });
    expect(
      old.prepend(OLD, {
        kind: "history",
        status: "page",
        generation: 5,
        requestId: "R".repeat(22),
        before: 10,
        from: 8,
        to: 10,
        oldestAvailable: 0,
        nextBefore: 8,
        lines: [{ r: [{ t: "old8" }] }, { r: [{ t: "old9" }] }],
      }),
    ).toBe(true);
    old.detach();
    const retained = old.snapshot;
    const h = harness({ retainedHistory: old, refreshHistory: true });
    h.mobile.start();
    h.offerSnapshot(screen(7, 10));
    h.deliver();
    h.tickAt(500);
    const failed = h.lastGet();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: failed.requestId,
        code: "history-unavailable",
      },
      100,
    );
    expect(h.mobile.snapshot.history).toBe(retained);
    expect(h.mobile.snapshot.historyStatus).toBe("unavailable");
    expect(h.controls.filter(({ type }) => type === "stream.history.get")).toHaveLength(1);
    expect(h.mobile.requestOlder()).toBe(true);
    const first = h.lastGet();
    expect(first.before).toBe(10);
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: first.requestId,
        code: "history-line-too-large",
      },
      100,
    );
    expect(h.mobile.skipOversized()).toBe(true);
    expect(h.mobile.snapshot.history).toBe(retained);
    expect(h.mobile.requestOlder()).toBe(true);
    const second = h.lastGet();
    expect(second.before).toBe(9);
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: second.requestId,
        code: "history-line-too-large",
      },
      100,
    );
    expect(h.mobile.skipOversized()).toBe(true);
    expect(h.mobile.requestOlder()).toBe(true);
    const third = h.lastGet();
    expect(third.before).toBe(8);
    h.offerHistory(third, 6);
    h.deliver();
    expect(h.mobile.historyWindow).toBe(old);
    expect(h.mobile.snapshot.history?.anchor).toEqual({
      subscriptionId: SUBSCRIPTION,
      generation: 7,
      before: 10,
    });
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([6, 7]);
    expect(h.mobile.snapshot.history?.gaps).toEqual([{ from: 8, to: 10 }]);
    expect(retained.rows.map(({ row }) => row)).toEqual([8, 9]);
  });

  it("admits the fourth accepted envelope ACK immediately before draining dependent history", () => {
    const h = harness();
    h.mobile.start();
    expect(h.mobile.requestOlder()).toBe(true);
    const wide: ScreenSnapshot = {
      cols: 256,
      rows: 256,
      cursor: { x: 0, y: 0 },
      lines: Array.from({ length: 256 }, () => ({ r: [{ t: "x".repeat(240) }] })),
      scrollbackTotal: 123,
      gen: 7,
    };
    const prepared = prepareStreamSnapshot(wide);
    if (!prepared.ok) throw new Error("invalid wide fixture");
    expect(Math.ceil(prepared.bytes.length / STREAM_LIMITS.chunkBytes)).toBe(4);
    expect(h.offerSnapshot(wide)).toBe(4);
    for (let n = 0; n < 3; n++) h.deliver();
    expect(h.controls.map(({ type }) => type)).toEqual(["stream.subscribe"]);
    h.deliver();
    expect(h.controls.map(({ type }) => type)).toEqual([
      "stream.subscribe",
      "stream.ack",
      "stream.history.get",
    ]);
    expect(h.controls[1]).toMatchObject({ type: "stream.ack", through: 4 });
    expect(h.lastGet().before).toBe(123);
  });

  it("does not resurrect a stream cancelled reentrantly by its clock before subscribe", () => {
    const controls: StreamMessage[] = [];
    let mobile: MobileScreenStream;
    mobile = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => {
        mobile.cancel();
        return 0;
      },
      sendControl: (message) => {
        controls.push(message);
        return true;
      },
    });
    expect(mobile.start()).toBe(false);
    expect(mobile.snapshot.status).toBe("closed");
    expect(controls.filter(({ type }) => type === "stream.subscribe")).toEqual([]);
    expect(controls.filter(({ type }) => type === "stream.cancel")).toHaveLength(1);
    expect(mobile.nextDeadline()).toBeNull();
  });

  it("keeps loaded rows read-only across later screen reset while live rendering continues", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.mobile.requestOlder();
    h.tickAt(500);
    h.deliverAcks();
    h.offerHistory(h.lastGet(), 41);
    h.deliver();
    h.tickAt(1000);
    h.deliverAcks();
    const retainedRow = h.mobile.snapshot.history?.rows[0];
    expect(retainedRow?.row).toBe(41);
    expect(h.offerSnapshot(screen(8, 45, "new", true))).toBe(1);
    h.deliver();
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.screen?.lines[0]?.r[0]?.t).toBe("new");
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.snapshot.history?.readOnly).toBe(true);
    expect(h.mobile.snapshot.history?.rows[0]).toBe(retainedRow);
    expect(h.mobile.requestOlder()).toBe(false);
    expect(h.mobile.protectHistory(retainedRow?.key ?? "missing")).toBe(true);
  });

  it("honors request-scoped end, stale errors and unscoped history-error rejection without erasing rows", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.mobile.requestOlder();
    h.tickAt(500);
    const request = h.lastGet();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: "Z".repeat(22),
        code: "history-reset",
      },
      100,
    );
    expect(h.mobile.snapshot.historyStatus).toBe("loading");
    const boundary = {
      kind: "history" as const,
      status: "boundary" as const,
      generation: 7,
      requestId: request.requestId,
      before: 42,
      reason: "end" as const,
      oldestAvailable: 42,
    };
    expect(
      h.sender.offer(
        { kind: "history", generation: 7, requestId: request.requestId, before: 42 },
        encodeCbor(boundary),
      ).accepted,
    ).toBe(true);
    expect(h.sender.pump()).toBe(1);
    h.deliver();
    expect(h.mobile.snapshot.historyStatus).toBe("end");
    expect(h.mobile.requestOlder()).toBe(false);
    h.tickAt(1000);
    expect(h.mobile.snapshot.history?.rows).toEqual([]);
    h.mobile.receive(
      { type: "stream.error", subscriptionId: SUBSCRIPTION, code: "history-unavailable" },
      100,
    );
    expect(h.mobile.snapshot.status).toBe("closed");
    expect(h.mobile.snapshot.error).toBe("invalid-transfer");
  });

  it("rejects the actual over-budget envelope and malformed record without publishing terminal text", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    const chunk = h.queued.shift();
    if (!chunk) throw new Error("missing chunk");
    h.mobile.receive(chunk, STREAM_LIMITS.envelopeBytes + 1);
    expect(h.mobile.snapshot).toMatchObject({ status: "closed", error: "invalid-transfer" });
    expect(h.mobile.snapshot.screen).toBeUndefined();
    expect(h.mobile.nextDeadline()).toBeNull();
    expect(h.controls.filter(({ type }) => type === "stream.cancel")).toHaveLength(1);
    h.mobile.receive(chunk, 100);
    h.mobile.cancel();
    expect(h.controls.filter(({ type }) => type === "stream.cancel")).toHaveLength(1);

    const malformed = harness();
    malformed.mobile.start();
    expect(
      malformed.sender.offer(
        { kind: "snapshot", generation: 7 },
        encodeCbor({ kind: "snapshot", secret: "do not log" }),
      ).accepted,
    ).toBe(true);
    malformed.sender.pump();
    malformed.deliver();
    expect(malformed.mobile.snapshot).toMatchObject({
      status: "closed",
      error: "invalid-transfer",
    });
    expect(JSON.stringify(malformed.mobile.snapshot)).not.toContain("do not log");
  });

  it("classifies refused versus unknown control admission and keeps history refusal local", async () => {
    const subscribeControls: StreamMessage[] = [];
    const refused = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => 0,
      sendControl: (message) => {
        subscribeControls.push(message);
        return message.type !== "stream.subscribe";
      },
    });
    expect(refused.start()).toBe(false);
    expect(refused.snapshot).toMatchObject({ status: "closed", error: "stalled" });
    expect(subscribeControls.map(({ type }) => type)).toEqual([
      "stream.subscribe",
      "stream.cancel",
    ]);

    let clock = 0;
    const controls: StreamMessage[] = [];
    const queued: StreamChunk[] = [];
    const local = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => clock,
      sendControl: (message) => {
        controls.push(message);
        return message.type !== "stream.history.get";
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => clock,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    const prepared = prepareStreamSnapshot(screen());
    if (!prepared.ok) throw new Error("invalid fixture");
    local.start();
    local.requestOlder();
    sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes);
    sender.pump();
    const chunk = queued.shift();
    if (!chunk) throw new Error("missing chunk");
    local.receive(chunk, 100);
    clock = 500;
    local.tick();
    expect(local.snapshot.status).toBe("live");
    expect(local.snapshot.historyStatus).toBe("unavailable");
    expect(local.nextDeadline()).toBeNull();

    const thenable = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => 0,
      sendControl: () => Promise.reject(new Error("secret rejection")) as unknown as boolean,
    });
    expect(thenable.start()).toBe(false);
    await Promise.resolve();
    expect(thenable.snapshot).toMatchObject({ status: "closed", error: "invalid-transfer" });
    expect(JSON.stringify(thenable.snapshot)).not.toContain("secret rejection");
  });

  it("releases partial receiver bytes when its own clock callback cancels the stream", () => {
    let clockCalls = 0;
    let mobile: MobileScreenStream;
    const controls: StreamMessage[] = [];
    const queued: StreamChunk[] = [];
    mobile = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => {
        clockCalls++;
        if (clockCalls === 3) mobile.cancel();
        return 0;
      },
      sendControl: (message) => {
        controls.push(message);
        return true;
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => 0,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    const wide: ScreenSnapshot = {
      cols: 256,
      rows: 256,
      cursor: { x: 0, y: 0 },
      lines: Array.from({ length: 256 }, () => ({ r: [{ t: "x".repeat(240) }] })),
      scrollbackTotal: 3,
      gen: 7,
    };
    const prepared = prepareStreamSnapshot(wide);
    if (!prepared.ok) throw new Error("invalid snapshot fixture");

    expect(mobile.start()).toBe(true);
    const receiver = Reflect.get(mobile, "receiver") as StreamReceiver;
    expect(receiver.retainedBytes).toBe(0);
    expect(sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes).accepted).toBe(true);
    expect(sender.pump()).toBe(4);
    const first = queued.shift();
    if (!first) throw new Error("missing first chunk");
    mobile.receive(first, 200);

    expect(clockCalls).toBe(3);
    expect(mobile.snapshot).toMatchObject({ status: "closed", historyStatus: "reset" });
    expect(mobile.snapshot.error).toBeUndefined();
    expect(mobile.nextDeadline()).toBeNull();
    expect(receiver.retainedBytes).toBe(0);
    expect(controls.map(({ type }) => type)).toEqual(["stream.subscribe", "stream.cancel"]);
    mobile.cancel();
    mobile.tick();
    const second = queued.shift();
    if (!second) throw new Error("missing second chunk");
    mobile.receive(second, 200);
    expect(receiver.retainedBytes).toBe(0);
    expect(mobile.nextDeadline()).toBeNull();
    expect(controls.map(({ type }) => type)).toEqual(["stream.subscribe", "stream.cancel"]);
  });

  it("fails closed on reentrant ACK-control delivery and non-finite clock without a live retry loop", () => {
    let reentrant: MobileScreenStream;
    const queued: StreamChunk[] = [];
    let time = 0;
    let reentryCalls = 0;
    reentrant = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      sendControl: (message) => {
        if (message.type === "stream.ack" && queued[0]) {
          reentryCalls++;
          reentrant.receive(queued[0], 100);
        }
        return true;
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    const prepared = prepareStreamSnapshot(screen());
    if (!prepared.ok) throw new Error("invalid fixture");
    reentrant.start();
    sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes);
    sender.pump();
    const chunk = queued[0];
    if (!chunk) throw new Error("missing chunk");
    reentrant.receive(chunk, 100);
    expect(reentrant.snapshot.status).toBe("closed");
    time = 500;
    reentrant.tick();
    expect(reentryCalls).toBe(1);
    expect(reentrant.snapshot).toMatchObject({ status: "closed", error: "invalid-transfer" });
    expect(reentrant.nextDeadline()).toBeNull();

    const invalidClock = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => Number.NaN,
      sendControl: () => true,
    });
    expect(invalidClock.start()).toBe(false);
    expect(invalidClock.snapshot).toMatchObject({ status: "closed", error: "invalid-transfer" });
  });

  it("treats ACK and refresh refusal as stream-local stalls, with no dependent history send", () => {
    for (const failure of [false, "throw"] as const) {
      let time = 0;
      const controls: StreamMessage[] = [];
      const queued: StreamChunk[] = [];
      const mobile = new MobileScreenStream({
        subscriptionId: SUBSCRIPTION,
        sessionId: SESSION,
        now: () => time,
        sendControl: (message) => {
          controls.push(message);
          if (message.type === "stream.ack") {
            if (failure === "throw") throw new Error("private ACK payload");
            return false;
          }
          return true;
        },
      });
      const sender = new StreamSender({
        subscriptionId: SUBSCRIPTION,
        sessionId: SESSION,
        now: () => time,
        newTransferId: () => TRANSFER,
        send: (chunk) => {
          queued.push(chunk);
          return true;
        },
      });
      const prepared = prepareStreamSnapshot(screen());
      if (!prepared.ok) throw new Error("invalid fixture");
      mobile.start();
      mobile.requestOlder();
      sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes);
      sender.pump();
      const chunk = queued.shift();
      if (!chunk) throw new Error("missing chunk");
      mobile.receive(chunk, 100);
      time = 500;
      mobile.tick();
      expect(mobile.snapshot).toMatchObject({
        status: "closed",
        error: failure === false ? "stalled" : "invalid-transfer",
      });
      expect(controls.filter(({ type }) => type === "stream.history.get")).toEqual([]);
      expect(controls.filter(({ type }) => type === "stream.cancel")).toHaveLength(1);
    }

    const controls: StreamMessage[] = [];
    const queued: StreamChunk[] = [];
    const mobile = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => 0,
      sendControl: (message) => {
        controls.push(message);
        return message.type !== "stream.refresh";
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => 0,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    mobile.start();
    sender.offer(
      { kind: "diff", generation: 9 },
      encodeStreamDiff({
        scroll: 0,
        changed: [],
        cursor: { x: 0, y: 0 },
        scrollbackTotal: 1,
        gen: 9,
      }),
    );
    sender.pump();
    const chunk = queued.shift();
    if (!chunk) throw new Error("missing diff chunk");
    mobile.receive(chunk, 100);
    expect(mobile.snapshot).toMatchObject({ status: "closed", error: "stalled" });
    expect(controls.filter(({ type }) => type === "stream.refresh")).toHaveLength(1);
  });

  it("bounds first-screen and partial-assembly deadlines despite a backward clock", () => {
    const h = harness();
    h.mobile.start();
    expect(h.mobile.nextDeadline()).toBe(5000);
    h.tickAt(-1000);
    expect(h.mobile.nextDeadline()).toBe(5000);
    h.tickAt(4999);
    expect(h.mobile.snapshot.status).toBe("loading");
    h.tickAt(5000);
    expect(h.mobile.snapshot).toMatchObject({ status: "closed", error: "stalled" });

    const partial = harness();
    partial.mobile.start();
    const wide: ScreenSnapshot = {
      cols: 256,
      rows: 256,
      cursor: { x: 0, y: 0 },
      lines: Array.from({ length: 256 }, () => ({ r: [{ t: "x".repeat(240) }] })),
      scrollbackTotal: 3,
      gen: 7,
    };
    expect(partial.offerSnapshot(wide)).toBe(4);
    partial.deliver();
    expect(partial.mobile.nextDeadline()).toBe(500);
    partial.tickAt(500);
    expect(partial.mobile.nextDeadline()).toBe(5000);
    partial.tickAt(5000);
    expect(partial.mobile.snapshot).toMatchObject({ status: "closed", error: "stalled" });
    expect(partial.mobile.snapshot.screen).toBeUndefined();
    expect(partial.mobile.nextDeadline()).toBeNull();
  });

  it("ignores well-formed foreign ownership but rejects malformed current control", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    const chunk = h.queued[0];
    if (!chunk) throw new Error("missing chunk");
    h.mobile.receive({ ...chunk, subscriptionId: "F".repeat(22) }, 200);
    h.mobile.receive({ ...chunk, sessionId: "other-session" }, 200);
    expect(h.mobile.snapshot.status).toBe("loading");
    h.deliver();
    expect(h.mobile.snapshot.status).toBe("live");
    h.mobile.receive({ type: "stream.ack", subscriptionId: SUBSCRIPTION, through: 1 }, 100);
    expect(h.mobile.snapshot).toMatchObject({ status: "closed", error: "invalid-transfer" });
  });

  it("does not bypass a completed page's ACK barrier if a contradictory request error arrives", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.mobile.requestOlder();
    h.tickAt(500);
    const first = h.lastGet();
    h.offerHistory(first, 41);
    h.deliver();
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([41]);
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: first.requestId,
        code: "history-unavailable",
      },
      100,
    );
    expect(h.mobile.requestOlder()).toBe(true);
    expect(h.controls.filter(({ type }) => type === "stream.history.get")).toHaveLength(1);
    h.tickAt(1000);
    expect(h.controls.filter(({ type }) => type === "stream.history.get")).toHaveLength(2);
    expect(h.lastGet().before).toBe(41);
  });

  it("captures and validates constructor identity once despite changing external getters", () => {
    let idReads = 0;
    const controls: StreamMessage[] = [];
    const options = {
      get subscriptionId() {
        idReads++;
        return idReads === 1 ? SUBSCRIPTION : "bad-id";
      },
      sessionId: SESSION,
      now: () => 0,
      sendControl: (message: StreamMessage) => {
        controls.push(message);
        return true;
      },
    };
    const mobile = new MobileScreenStream(options);
    expect(mobile.start()).toBe(true);
    expect(idReads).toBe(1);
    expect(controls[0]).toEqual({
      type: "stream.subscribe",
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
    });
  });

  it("switches from the 20,500-ms first-response clock to assembly progress on a matching first chunk", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.mobile.requestOlder();
    h.tickAt(500);
    h.deliverAcks();
    const request = h.lastGet();
    h.tickAt(20499);
    expect(h.mobile.snapshot.historyStatus).toBe("loading");
    const styled = { r: [{ t: "界".repeat(2500), fg: [1, 2, 3] as [number, number, number] }] };
    const record: StreamHistoryPage = {
      kind: "history",
      status: "page",
      generation: 7,
      requestId: request.requestId,
      before: 42,
      from: 34,
      to: 42,
      oldestAvailable: 0,
      nextBefore: 34,
      lines: Array(8).fill(styled),
    };
    expect(
      h.sender.offer(
        { kind: "history", generation: 7, requestId: request.requestId, before: 42 },
        encodeCbor(record),
      ).accepted,
    ).toBe(true);
    expect(h.sender.pump()).toBe(4);
    h.deliver();
    h.tickAt(21000);
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.historyStatus).toBe("loading");
    for (let n = 0; n < 3; n++) h.deliver();
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([
      34, 35, 36, 37, 38, 39, 40, 41,
    ]);
    expect(h.mobile.snapshot.history?.nextBefore).toBe(34);
  });

  it("keeps loaded history read-only on request-scoped reset without stopping live output", () => {
    const h = harness();
    h.mobile.start();
    h.offerSnapshot(screen());
    h.deliver();
    h.mobile.requestOlder();
    h.tickAt(500);
    h.deliverAcks();
    h.offerHistory(h.lastGet(), 41);
    h.deliver();
    h.tickAt(1000);
    h.deliverAcks();
    const retained = h.mobile.snapshot.history?.rows[0];
    expect(retained?.row).toBe(41);
    expect(h.mobile.requestOlder()).toBe(true);
    const request = h.lastGet();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: request.requestId,
        code: "history-reset",
      },
      100,
    );
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.screen?.gen).toBe(7);
    expect(h.mobile.snapshot.historyStatus).toBe("reset");
    expect(h.mobile.snapshot.history?.readOnly).toBe(true);
    expect(h.mobile.snapshot.history?.rows[0]).toBe(retained);
    expect(h.mobile.requestOlder()).toBe(false);
  });

  it("never drains history after the ACK sink synchronously cancels the owner", () => {
    let time = 0;
    const controls: StreamMessage[] = [];
    const queued: StreamChunk[] = [];
    let mobile: MobileScreenStream;
    mobile = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      sendControl: (message) => {
        controls.push(message);
        if (message.type === "stream.ack") mobile.cancel();
        return true;
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    const prepared = prepareStreamSnapshot(screen());
    if (!prepared.ok) throw new Error("invalid fixture");
    mobile.start();
    mobile.requestOlder();
    sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes);
    sender.pump();
    const chunk = queued.shift();
    if (!chunk) throw new Error("missing chunk");
    mobile.receive(chunk, 100);
    time = 500;
    mobile.tick();
    expect(mobile.snapshot.status).toBe("closed");
    expect(controls.map(({ type }) => type)).toEqual([
      "stream.subscribe",
      "stream.ack",
      "stream.cancel",
    ]);
    expect(mobile.nextDeadline()).toBeNull();
  });

  it("contains throwing input getters and invalid constructor options without exposing payload errors", () => {
    expect(
      () =>
        new MobileScreenStream({
          subscriptionId: "invalid",
          sessionId: SESSION,
          now: () => 0,
          sendControl: () => true,
        }),
    ).toThrowError(new TypeError("Invalid mobile stream options"));
    const h = harness();
    h.mobile.start();
    const hostile = new Proxy(
      { type: "stream.error", subscriptionId: SUBSCRIPTION, code: "stalled" },
      {
        get() {
          throw new Error("secret getter text");
        },
      },
    );
    h.mobile.receive(hostile as StreamMessage, 100);
    expect(h.mobile.snapshot).toMatchObject({ status: "closed", error: "invalid-transfer" });
    expect(JSON.stringify(h.mobile.snapshot)).not.toContain("secret getter text");
    expect(h.controls.filter(({ type }) => type === "stream.cancel")).toHaveLength(1);
  });

  it("enforces first-screen and first-history deadlines on late receive even before a scheduled tick", () => {
    const lateScreen = harness();
    lateScreen.mobile.start();
    lateScreen.setTime(5000);
    lateScreen.offerSnapshot(screen());
    lateScreen.deliver();
    expect(lateScreen.mobile.snapshot).toMatchObject({ status: "closed", error: "stalled" });
    expect(lateScreen.mobile.snapshot.screen).toBeUndefined();

    const lateHistory = harness();
    lateHistory.mobile.start();
    lateHistory.offerSnapshot(screen());
    lateHistory.deliver();
    lateHistory.mobile.requestOlder();
    lateHistory.tickAt(500);
    lateHistory.deliverAcks();
    const request = lateHistory.lastGet();
    lateHistory.setTime(21000);
    lateHistory.offerHistory(request, 41);
    lateHistory.deliver();
    expect(lateHistory.mobile.snapshot.status).toBe("live");
    expect(lateHistory.mobile.snapshot.historyStatus).toBe("unavailable");
    expect(lateHistory.mobile.snapshot.history?.rows).toEqual([]);
  });

  it("uses the ordinary empty window for explicit-refresh skips when no old cache is retained", () => {
    const h = harness({ refreshHistory: true });
    h.mobile.start();
    h.offerSnapshot(screen(7, 10));
    h.deliver();
    h.tickAt(500);
    const first = h.lastGet();
    h.mobile.receive(
      {
        type: "stream.error",
        subscriptionId: SUBSCRIPTION,
        requestId: first.requestId,
        code: "history-line-too-large",
      },
      100,
    );
    expect(h.mobile.skipOversized()).toBe(true);
    expect(h.mobile.snapshot.history?.nextBefore).toBe(9);
    expect(h.mobile.snapshot.history?.gaps).toEqual([{ from: 9, to: 10 }]);
    expect(h.mobile.requestOlder()).toBe(true);
    const second = h.lastGet();
    expect(second.before).toBe(9);
    h.offerHistory(second, 8);
    h.deliver();
    expect(h.mobile.snapshot.status).toBe("live");
    expect(h.mobile.snapshot.history?.rows.map(({ row }) => row)).toEqual([8]);
    expect(h.mobile.snapshot.history?.gaps).toEqual([{ from: 9, to: 10 }]);
  });

  it("lets an outer consumer reconcile settled ACK and reentrant cancellation after each action", () => {
    let time = 0;
    let mobile: MobileScreenStream;
    const controls: StreamMessage[] = [];
    const queued: StreamChunk[] = [];
    const observed: Array<{ status: string; deadline: number | null }> = [];
    mobile = new MobileScreenStream({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      sendControl: (message) => {
        controls.push(message);
        if (message.type === "stream.ack") mobile.cancel();
        return true;
      },
    });
    const sender = new StreamSender({
      subscriptionId: SUBSCRIPTION,
      sessionId: SESSION,
      now: () => time,
      newTransferId: () => TRANSFER,
      send: (chunk) => {
        queued.push(chunk);
        return true;
      },
    });
    function reconcile<T>(action: () => T): T {
      try {
        return action();
      } finally {
        observed.push({ status: mobile.snapshot.status, deadline: mobile.nextDeadline() });
      }
    }

    expect(reconcile(() => mobile.start())).toBe(true);
    expect(reconcile(() => mobile.requestOlder())).toBe(true);
    const prepared = prepareStreamSnapshot(screen());
    if (!prepared.ok) throw new Error("invalid fixture");
    expect(sender.offer({ kind: "snapshot", generation: 7 }, prepared.bytes).accepted).toBe(true);
    expect(sender.pump()).toBe(1);
    const chunk = queued.shift();
    if (!chunk) throw new Error("missing snapshot chunk");
    reconcile(() => mobile.receive(chunk, 100));
    time = 500;
    reconcile(() => mobile.tick());
    expect(observed).toEqual([
      { status: "loading", deadline: 5000 },
      { status: "loading", deadline: 5000 },
      { status: "closed", deadline: null },
      { status: "closed", deadline: null },
    ]);
    expect(controls.map(({ type }) => type)).toEqual([
      "stream.subscribe",
      "stream.ack",
      "stream.cancel",
    ]);
    expect(mobile.snapshot.historyStatus).toBe("reset");
  });
});
