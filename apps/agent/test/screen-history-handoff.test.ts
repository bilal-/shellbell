import { decodeCbor, encodeCbor, type InnerMessage, parseInner } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HistoryCapture, Screen, ScreenReadOptions } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { type ScreenFrameContext, ScreenTracker } from "../src/screen-tracker.js";
import { FakeBackend } from "./fakes/fake-backend.js";

class CaptureBackend extends FakeBackend {
  reads: { args: unknown[]; capture?: HistoryCapture }[] = [];
  evidence = true;
  override async getScreen(...args: [id: string, options?: ScreenReadOptions]): Promise<Screen> {
    const [id, options] = args;
    const capture = options?.history && this.evidence ? Object.freeze({}) : undefined;
    this.reads.push({ args, capture });
    const screen = await super.getScreen(id);
    return { ...screen, ...(capture ? { historyCapture: capture } : {}) };
  }
}

interface Delivery {
  conn: string;
  message: InnerMessage;
  context: ScreenFrameContext;
}

let backend: CaptureBackend;
let tracker: ScreenTracker;
let deliveries: Delivery[];
let accept: (delivery: Delivery) => boolean | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  backend = new CaptureBackend();
  backend.addSession("S", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
  deliveries = [];
  accept = () => undefined;
  tracker = new ScreenTracker({
    backend,
    sink: (conn, message, context) => {
      const delivery = { conn, message, context };
      deliveries.push(delivery);
      return accept(delivery);
    },
    log: createLogger({ stdout: false }),
    now: () => Date.now(),
  });
  tracker.start();
});

afterEach(() => {
  tracker.stop();
  vi.useRealTimers();
});

const tick = () => vi.advanceTimersByTimeAsync(125);

function holdRead(): () => Promise<void> {
  let resolve!: () => void;
  backend.getScreenGate = new Promise<void>((done) => {
    resolve = done;
  });
  return async () => {
    backend.getScreenGate = null;
    resolve();
    await vi.advanceTimersByTimeAsync(0);
  };
}

function assertContext(delivery: Delivery, capture?: HistoryCapture): void {
  const { message, context } = delivery;
  if (message.type !== "screen.snapshot" && message.type !== "screen.diff") throw new Error();
  expect(Object.isFrozen(context)).toBe(true);
  expect(context.generation).toBe(message.gen);
  expect(context.reported).toBe(message.scrollbackTotal);
  expect(context.capture).toBe(capture);
  const decoded = decodeCbor(encodeCbor(message));
  expect(parseInner(decoded)).toEqual(message);
  for (const key of [
    "context",
    "capture",
    "historyCapture",
    "historyRequested",
    "generation",
    "reported",
  ])
    expect(decoded).not.toHaveProperty(key);
}

describe("screen history capture handoff", () => {
  it("requests opt-in evidence and binds its exact token to the snapshot coordinates", async () => {
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([["S", { history: true }]]);
    expect(deliveries[0]?.message.type).toBe("screen.snapshot");
    expect(deliveries[0]?.context.historyRequested).toBe(true);
    expect(deliveries[0]?.context.generation).toBe(1);
    expect(deliveries[0]?.context.reported).toBe(10);
    assertContext(deliveries[0] as Delivery, backend.reads[0]?.capture);
  });

  it("keeps omitted and false viewers on one-argument reads and suppresses no-op frames", async () => {
    tracker.setViewed("legacy", "S");
    tracker.setViewed("false", "S", { history: false });
    await tick();
    tracker.markDirty("S");
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([["S"], ["S"]]);
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "false"]);
    for (const d of deliveries) {
      expect(d.context.historyRequested).toBe(false);
      assertContext(d);
    }
  });

  it.each([true, false])(
    "ends demand after an accepted snapshot (evidence=%s), leaving live diffs ordinary",
    async (evidence) => {
      backend.evidence = evidence;
      tracker.setViewed("legacy", "S");
      tracker.setViewed("phone", "S", { history: true });
      await tick();
      expect(deliveries.map((d) => d.message.type)).toEqual(["screen.snapshot", "screen.snapshot"]);
      for (const d of deliveries) assertContext(d, backend.reads[0]?.capture);
      backend.appendLine("S", "d");
      await tick();
      expect(backend.reads.map((r) => r.args)).toEqual([["S", { history: true }], ["S"]]);
      for (const d of deliveries.slice(2)) {
        expect(d.message.type).toBe("screen.diff");
        expect(d.context).not.toHaveProperty("capture");
        assertContext(d);
      }
      expect(deliveries).toHaveLength(4);
      tracker.markDirty("S");
      await tick();
      expect(backend.reads[2]?.args).toEqual(["S"]);
      expect(deliveries).toHaveLength(4);
    },
  );

  it("keeps evidence off a legacy diff sharing an opted-in capture", async () => {
    tracker.setViewed("legacy", "S");
    await tick();
    backend.saturated = true;
    backend.capabilities = { ...backend.capabilities, absoluteLines: false };
    backend.appendLine("S", "d");
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    const legacy = deliveries.find(
      (d) => d.conn === "legacy" && d.message.type === "screen.diff",
    ) as Delivery;
    expect(legacy.context.historyRequested).toBe(true);
    expect(legacy.context).not.toHaveProperty("capture");
    assertContext(legacy);
    const phone = deliveries.find((d) => d.conn === "phone") as Delivery;
    expect(phone.context.reported).toBe(11);
    expect(phone.context.generation).toBe(2);
    assertContext(phone, backend.reads[1]?.capture);
  });

  it("preserves the prepared snapshot and evidence on an ordinary no-op read", async () => {
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    tracker.forceSnapshot("phone", "S");
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([["S", { history: true }], ["S"]]);
    expect(deliveries[1]?.message).toBe(deliveries[0]?.message);
    expect(deliveries[1]?.context).toBe(deliveries[0]?.context);
    assertContext(deliveries[1] as Delivery, backend.reads[0]?.capture);
  });

  it.each(["false", "throw"])(
    "retries the exact prepared evidence after sink %s without another read",
    async (refusal) => {
      accept = () => {
        if (refusal === "throw") throw new Error("blocked");
        return false;
      };
      tracker.setViewed("phone", "S", { history: true });
      await tick();
      await tick();
      expect(backend.reads).toHaveLength(1);
      expect(deliveries).toHaveLength(2);
      expect(deliveries[1]?.message).toBe(deliveries[0]?.message);
      expect(deliveries[1]?.context).toBe(deliveries[0]?.context);
      // A fresh dirty read still opts in while the first snapshot is refused.
      tracker.markDirty("S");
      accept = () => true;
      await tick();
      expect(backend.reads.map((r) => r.args)).toEqual([
        ["S", { history: true }],
        ["S", { history: true }],
      ]);
      assertContext(deliveries[2] as Delivery, backend.reads[1]?.capture);
      backend.appendLine("S", "d");
      await tick();
      expect(backend.reads[2]?.args).toEqual(["S"]);
    },
  );

  it("preserves pending legacy rows when same-generation history preparation replaces a budget-blocked diff", async () => {
    tracker.stop();
    let budgetNow = 0;
    tracker = new ScreenTracker({
      backend,
      sink: (conn, message, context) => {
        deliveries.push({ conn, message, context });
      },
      log: createLogger({ stdout: false }),
      maxFramesPerSecond: 8,
      now: () => budgetNow,
    });
    tracker.start();
    tracker.setViewed("legacy", "S");
    budgetNow = 125;
    await tick();
    expect(deliveries[0]?.context.generation).toBe(1);

    // The first snapshot spent the only token. Prepare gen 2 without delivering it.
    backend.setLines("S", ["CHANGED", "b", "c"]);
    await tick();
    expect(backend.reads).toHaveLength(2);
    expect(deliveries).toHaveLength(1);

    // This unchanged read must own fresh evidence without discarding the legacy update.
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([["S"], ["S"], ["S", { history: true }]]);
    expect(deliveries).toHaveLength(1);
    budgetNow = 250;
    await tick();
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "legacy"]);
    expect(deliveries[1]?.context.generation).toBe(2);

    // Reconstruct the receiver's rows rather than accepting a generation-only success.
    let legacyRows: string[] = [];
    for (const { message } of deliveries) {
      if (message.type === "screen.snapshot") {
        legacyRows = message.lines.map((line) => line.r.map((run) => run.t).join(""));
      } else if (message.type === "screen.diff") {
        for (let i = 0; i < message.scroll; i++) {
          legacyRows.shift();
          legacyRows.push("");
        }
        for (const { i, line } of message.changed)
          legacyRows[i] = line.r.map((run) => run.t).join("");
      }
    }
    expect(legacyRows).toEqual(["CHANGED", "b", "c"]);

    budgetNow = 375;
    await tick();
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "legacy", "phone"]);
    expect(deliveries[2]?.message.type).toBe("screen.snapshot");
    expect(deliveries[2]?.context.generation).toBe(2);
    assertContext(deliveries[2] as Delivery, backend.reads[2]?.capture);
    expect(backend.reads).toHaveLength(3);
  });

  it("rebuilds same-generation snapshots from fresh capture without waking current legacy viewers", async () => {
    tracker.setViewed("legacy", "S");
    await tick();
    accept = ({ conn }) => conn !== "phone";
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    const refused = deliveries[1] as Delivery;
    assertContext(refused, backend.reads[1]?.capture);
    tracker.markDirty("S");
    accept = () => true;
    await tick();
    const fresh = deliveries[2] as Delivery;
    expect(fresh.context.generation).toBe(1);
    expect(fresh.context.generation).toBe(refused.context.generation);
    expect(fresh.message).not.toBe(refused.message);
    expect(fresh.context).not.toBe(refused.context);
    expect(fresh.context.capture).not.toBe(refused.context.capture);
    assertContext(fresh, backend.reads[2]?.capture);
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "phone", "phone"]);
  });

  it("holds a history viewer added during an ordinary read for a fresh opted-in read", async () => {
    const release = holdRead();
    tracker.setViewed("legacy", "S");
    await tick();
    tracker.setViewed("phone", "S", { history: true });
    await release();
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy"]);
    expect(backend.reads.map((r) => r.args)).toEqual([["S"]]);
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([["S"], ["S", { history: true }]]);
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "phone"]);
    assertContext(deliveries[1] as Delivery, backend.reads[1]?.capture);
  });

  it("does not give a same-connection replacement the previous viewer's in-flight capture", async () => {
    tracker.setViewed("legacy", "S");
    const release = holdRead();
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    tracker.setViewed("phone", "S", { history: true });
    await release();
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy"]);
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([
      ["S", { history: true }],
      ["S", { history: true }],
    ]);
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "phone"]);
    assertContext(deliveries[1] as Delivery, backend.reads[1]?.capture);
  });

  it("delivers to eligible history viewers while a newly added viewer waits for its own capture", async () => {
    const release = holdRead();
    tracker.setViewed("first", "S", { history: true });
    await tick();
    tracker.setViewed("second", "S", { history: true });
    await release();
    expect(deliveries.map((d) => d.conn)).toEqual(["first"]);
    assertContext(deliveries[0] as Delivery, backend.reads[0]?.capture);
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([
      ["S", { history: true }],
      ["S", { history: true }],
    ]);
    expect(deliveries.map((d) => d.conn)).toEqual(["first", "second"]);
    assertContext(deliveries[1] as Delivery, backend.reads[1]?.capture);
  });

  it.each(["stop", "remove", "last-viewer"])(
    "discards obsolete capture after %s and requires fresh evidence on recreation",
    async (action) => {
      const release = holdRead();
      tracker.setViewed("phone", "S", { history: true });
      await tick();
      if (action === "stop") tracker.stop();
      else if (action === "remove") tracker.sessionRemoved("S");
      else tracker.setViewed("phone", null);
      if (action === "stop") tracker.start();
      tracker.setViewed("phone", "S", { history: true });
      await release();
      expect(deliveries).toHaveLength(0);
      await tick();
      expect(backend.reads.map((r) => r.args)).toEqual([
        ["S", { history: true }],
        ["S", { history: true }],
      ]);
      expect(deliveries).toHaveLength(1);
      assertContext(deliveries[0] as Delivery, backend.reads[1]?.capture);
    },
  );

  it.each(["remove", "replace"])(
    "checks selected viewer identity after reentrant sink %s",
    async (action) => {
      tracker.setViewed("legacy", "S");
      tracker.setViewed("phone", "S", { history: true });
      accept = ({ conn }) => {
        if (conn === "legacy") {
          if (action === "remove") tracker.setViewed("phone", null);
          else tracker.setViewed("phone", "S", { history: true });
        }
        return true;
      };
      await tick();
      expect(deliveries.map((d) => d.conn)).toEqual(["legacy"]);
      await tick();
      if (action === "replace") {
        expect(backend.reads.map((r) => r.args)).toEqual([
          ["S", { history: true }],
          ["S", { history: true }],
        ]);
        assertContext(deliveries[1] as Delivery, backend.reads[1]?.capture);
      } else expect(backend.reads).toHaveLength(1);
    },
  );

  it.each(["accept", "false", "throw"])(
    "discards delivery and %s bookkeeping after a sink synchronously stops and restarts",
    async (outcome) => {
      tracker.setViewed("first", "S", { history: true });
      tracker.setViewed("second", "S");
      let restart = true;
      accept = ({ conn }) => {
        if (conn === "first" && restart) {
          restart = false;
          tracker.stop();
          tracker.start();
          if (outcome === "throw") throw new Error("obsolete sink attempt");
          return outcome !== "false";
        }
        return true;
      };

      await tick();
      expect(deliveries.map((delivery) => delivery.conn)).toEqual(["first"]);
      const obsolete = deliveries[0] as Delivery;
      assertContext(obsolete, backend.reads[0]?.capture);

      await tick();
      // The obsolete callback cannot accept first's history demand or penalize it
      // with a skipped-frame count. Equal priority leaves second first in rotation.
      expect(backend.reads.map((read) => read.args)).toEqual([
        ["S", { history: true }],
        ["S", { history: true }],
      ]);
      expect(deliveries.map((delivery) => delivery.conn)).toEqual(["first", "second", "first"]);
      for (const delivery of deliveries.slice(1)) {
        assertContext(delivery, backend.reads[1]?.capture);
        expect(delivery.message).not.toBe(obsolete.message);
        expect(delivery.context).not.toBe(obsolete.context);
        expect(delivery.context.generation).toBe(obsolete.context.generation);
      }
      expect(deliveries[1]?.context).toBe(deliveries[2]?.context);

      tracker.markDirty("S");
      await tick();
      expect(backend.reads[2]?.args).toEqual(["S"]);
      expect(deliveries).toHaveLength(3);
    },
  );

  it("retains opt-in demand across backend failure", async () => {
    backend.throwOnNextGetScreen("S", new Error("offline"));
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    expect(deliveries).toHaveLength(0);
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([
      ["S", { history: true }],
      ["S", { history: true }],
    ]);
    assertContext(deliveries[0] as Delivery, backend.reads[1]?.capture);
  });

  it("returns to ordinary reads when the remaining viewer is legacy", async () => {
    const release = holdRead();
    tracker.setViewed("legacy", "S");
    tracker.setViewed("phone", "S", { history: true });
    await tick();
    tracker.setViewed("phone", null);
    await release();
    backend.appendLine("S", "d");
    await tick();
    expect(backend.reads.map((r) => r.args)).toEqual([["S", { history: true }], ["S"]]);
    expect(deliveries.map((d) => d.conn)).toEqual(["legacy", "legacy"]);
    assertContext(deliveries[1] as Delivery);
  });
});
