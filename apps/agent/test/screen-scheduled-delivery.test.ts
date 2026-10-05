import { applyDiff, applySnapshot, type InnerMessage, type ScreenState } from "@shellbell/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  type HistoryCapture,
  type Screen,
  type ScreenReadOptions,
  SessionGone,
} from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { type ScreenFrameContext, ScreenTracker } from "../src/screen-tracker.js";
import { WireScheduler } from "../src/wire-scheduler.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });
let backend: FakeBackend;
let tracker: ScreenTracker;
const tick = () => vi.advanceTimersByTimeAsync(125);

function lines(state: ScreenState | undefined): string[] {
  return state?.lines.map((line) => line.r.map((run) => run.t).join("")) ?? [];
}

function reconstruct(state: ScreenState | undefined, message: InnerMessage): ScreenState {
  if (message.type === "screen.snapshot") return applySnapshot(state, message);
  if (message.type === "screen.diff" && state) {
    const result = applyDiff(state, message);
    expect(result.gap).toBe(false);
    return result.state;
  }
  throw new Error("invalid screen sequence");
}

function scheduled(
  onReady: (sessionId: string) => void,
  options: { backend?: FakeBackend; maxFramesPerSecond?: number } = {},
): ScreenTracker {
  tracker = new ScreenTracker({
    backend: options.backend ?? backend,
    log,
    delivery: "scheduled",
    maxFramesPerSecond: options.maxFramesPerSecond,
    now: () => Date.now(),
    onReady,
  });
  tracker.start();
  return tracker;
}

function offer(connId: string, received: InnerMessage[]): boolean {
  return tracker.offerPrepared(connId, (message) => {
    received.push(message);
    return true;
  });
}

class CaptureBackend extends FakeBackend {
  reads: { id: string; history: boolean; capture?: HistoryCapture }[] = [];
  evidence = true;
  override async getScreen(id: string, options?: ScreenReadOptions): Promise<Screen> {
    const capture = options?.history && this.evidence ? Object.freeze({}) : undefined;
    this.reads.push({ id, history: options?.history === true, capture });
    const screen = await super.getScreen(id);
    return { ...screen, ...(capture ? { historyCapture: capture } : {}) };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  backend.addSession("S", { rows: 3, lines: ["a", "b", "c"] });
});

afterEach(() => {
  tracker?.stop();
  vi.useRealTimers();
});

it.each(["legacy", "bounded"] as const)(
  "%s preparation delivers wrap-only changes without inventing text or scroll",
  async (preparation) => {
    const received: InnerMessage[] = [];
    const read = backend.getScreen.bind(backend);
    let wrapped = false;
    backend.getScreen = async (id) => {
      const screen = await read(id);
      screen.lines[0] = { ...screen.lines[0]!, w: wrapped };
      return screen;
    };
    tracker = scheduled(() => {
      offer("p1", received);
    });
    tracker.setViewed("p1", "S", { preparation });
    await tick();
    expect(received[0]).toMatchObject({
      type: "screen.snapshot",
      lines: [{ r: [{ t: "a" }], w: false }, { r: [{ t: "b" }] }, { r: [{ t: "c" }] }],
    });
    wrapped = true;
    tracker.markDirty("S");
    await tick();
    expect(received[1]).toMatchObject({
      type: "screen.diff",
      scroll: 0,
      gen: 2,
      changed: [{ i: 0, line: { r: [{ t: "a" }], w: true } }],
    });
    wrapped = false;
    tracker.markDirty("S");
    await tick();
    expect(received[2]).toMatchObject({
      type: "screen.diff",
      scroll: 0,
      gen: 3,
      changed: [{ i: 0, line: { r: [{ t: "a" }], w: false } }],
    });
  },
);

it("offers an initial snapshot at 125 ms even below the automatic local frame budget", async () => {
  const accepted: InnerMessage[] = [];
  tracker = new ScreenTracker({
    backend,
    log,
    delivery: "scheduled",
    maxFramesPerSecond: 1,
    now: () => Date.now(),
    onReady: () => {
      tracker.offerPrepared("p1", (message) => {
        accepted.push(message);
        return true;
      });
    },
  });
  tracker.start();
  tracker.setViewed("p1", "S");
  await vi.advanceTimersByTimeAsync(125);
  expect(accepted.map((message) => message.type)).toEqual(["screen.snapshot"]);
});

it("uses adjacent diffs and reconstructs a skipped generation from a full snapshot", async () => {
  const received: InnerMessage[] = [];
  let ready = false;
  scheduled(() => {
    if (ready) offer("p1", received);
  });
  tracker.setViewed("p1", "S");
  ready = true;
  await tick();
  let state = reconstruct(undefined, received[0] as InnerMessage);
  expect(lines(state)).toEqual(["a", "b", "c"]);
  backend.appendLine("S", "d");
  await tick();
  expect(received[1]?.type).toBe("screen.diff");
  state = reconstruct(state, received[1] as InnerMessage);
  expect(lines(state)).toEqual(["b", "c", "d"]);
  ready = false;
  backend.appendLine("S", "e");
  await tick();
  backend.appendLine("S", "f");
  ready = true;
  await tick();
  expect(received[2]?.type).toBe("screen.snapshot");
  state = reconstruct(state, received[2] as InnerMessage);
  expect(lines(state)).toEqual(["d", "e", "f"]);
});

it("keeps a refused frame for quiet retry and degrades after three scheduler cycles only", async () => {
  const offered: InnerMessage[] = [];
  const received: InnerMessage[] = [];
  scheduled(() => {
    tracker.offerPrepared("p1", (message) => {
      offered.push(message);
      return false;
    });
  });
  tracker.setViewed("p1", "S");
  await tick();
  const reads = backend.getScreenCalls;
  for (let i = 0; i < 5; i++) {
    tracker.offerPrepared("p1", (message) => {
      if (message.type !== "screen.snapshot") throw new Error("expected snapshot");
      expect(message.degraded).toBeUndefined();
      return false;
    });
  }
  expect(offered).toHaveLength(1);
  await tick();
  await tick();
  expect(backend.getScreenCalls).toBe(reads);
  expect(offer("p1", received)).toBe(true);
  expect(received[0]?.type).toBe("screen.snapshot");
  expect(received[0]).toHaveProperty("degraded", true);
  expect(offer("p1", received)).toBe(false);
  expect(received).toHaveLength(1);
});

it("returns false without callback in automatic mode and while stopped", async () => {
  const callback = vi.fn(() => true);
  tracker = new ScreenTracker({ backend, log, sink: () => true, now: () => Date.now() });
  tracker.start();
  tracker.setViewed("p1", "S");
  await tick();
  expect(tracker.offerPrepared("p1", callback)).toBe(false);
  tracker.stop();
  expect(tracker.offerPrepared("p1", callback)).toBe(false);
  expect(callback).not.toHaveBeenCalled();
});

it("does not offer a generation twice or reenter the same viewer", async () => {
  const received: InnerMessage[] = [];
  const nested = vi.fn(() => true);
  scheduled(() => {
    expect(
      tracker.offerPrepared("p1", (message) => {
        received.push(message);
        expect(tracker.offerPrepared("p1", nested)).toBe(false);
        return true;
      }),
    ).toBe(true);
  });
  tracker.setViewed("p1", "S");
  await tick();
  await tick();
  expect(nested).not.toHaveBeenCalled();
  expect(received).toHaveLength(1);
  expect(offer("p1", received)).toBe(false);
});

it("wakes once per pending session cycle and stays quiet after both viewers accept", async () => {
  const received: InnerMessage[] = [];
  const readiness = vi.fn(() => {
    offer("p1", received);
    offer("p2", received);
  });
  scheduled(readiness);
  tracker.setViewed("p1", "S");
  tracker.setViewed("p2", "S");
  await tick();
  expect(readiness).toHaveBeenCalledTimes(1);
  expect(received).toHaveLength(2);
  await tick();
  expect(readiness).toHaveBeenCalledTimes(1);
  expect(backend.getScreenCalls).toBe(1);
});

it("rotates the start across two continuously pending sessions once per cycle", async () => {
  backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
  const order: string[] = [];
  scheduled((sessionId) => {
    order.push(sessionId);
  });
  tracker.setViewed("p1", "S");
  tracker.setViewed("p2", "T");
  for (let cycle = 0; cycle < 4; cycle++) await tick();
  expect(order).toEqual(["S", "T", "T", "S", "S", "T", "T", "S"]);
});

it("does not let a delayed older capture rewind a newer traversal start", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class DelayedFirstBackend extends FakeBackend {
    private first = true;
    override async getScreen(id: string): Promise<Screen> {
      if (id === "S" && this.first) {
        this.first = false;
        await gate;
      }
      return super.getScreen(id);
    }
  }
  const delayedBackend = new DelayedFirstBackend();
  delayedBackend.addSession("S", { rows: 3, lines: ["a", "b", "c"] });
  delayedBackend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
  const order: string[] = [];
  try {
    scheduled(
      (sessionId) => {
        order.push(sessionId);
      },
      { backend: delayedBackend },
    );
    tracker.setViewed("p1", "S");
    tracker.setViewed("p2", "T");
    await tick();
    await tick();
  } finally {
    release();
    await vi.advanceTimersByTimeAsync(0);
  }
  expect(order).toEqual(["T", "T", "S"]);
  order.length = 0;
  await tick();
  expect(order).toEqual(["S", "T"]);
});

it("allows a replacement viewer to offer independently while the retired callback runs", async () => {
  const received: InnerMessage[] = [];
  scheduled(() => {});
  tracker.setViewed("anchor", "S");
  tracker.setViewed("p1", "S");
  await tick();
  expect(
    tracker.offerPrepared("p1", (message) => {
      received.push(message);
      tracker.dropViewer("p1");
      tracker.setViewed("p1", "S");
      expect(offer("p1", received)).toBe(true);
      return true;
    }),
  ).toBe(true);
  expect(received).toHaveLength(2);
  expect(offer("p1", received)).toBe(false);
});

it.each(["true", "false", "throw"])(
  "keeps replacement ownership separate after synchronous %s callback retirement",
  async (outcome) => {
    const received: InnerMessage[] = [];
    scheduled(() => {});
    tracker.setViewed("p1", "S");
    await tick();
    const callback = (message: InnerMessage) => {
      received.push(message);
      tracker.dropViewer("p1");
      tracker.setViewed("p1", "S");
      if (outcome === "throw") throw new Error("private terminal payload");
      return outcome === "true";
    };
    if (outcome === "throw") {
      expect(() => tracker.offerPrepared("p1", callback)).toThrow("scheduled screen offer failed");
    } else {
      expect(tracker.offerPrepared("p1", callback)).toBe(outcome === "true");
    }
    expect(offer("p1", received)).toBe(false);
    await tick();
    expect(offer("p1", received)).toBe(true);
    expect(received.map((m) => m.type)).toEqual(["screen.snapshot", "screen.snapshot"]);
  },
);

it.each(["true", "false", "throw"])(
  "does not book a stale %s callback across stop and restart",
  async (outcome) => {
    const received: InnerMessage[] = [];
    scheduled(() => {});
    tracker.setViewed("p1", "S");
    await tick();
    const callback = (message: InnerMessage) => {
      received.push(message);
      tracker.stop();
      tracker.start();
      if (outcome === "throw") throw new Error("private terminal payload");
      return outcome === "true";
    };
    if (outcome === "throw") {
      expect(() => tracker.offerPrepared("p1", callback)).toThrow("scheduled screen offer failed");
    } else {
      expect(tracker.offerPrepared("p1", callback)).toBe(outcome === "true");
    }
    expect(
      tracker.offerPrepared(
        "p1",
        vi.fn(() => true),
      ),
    ).toBe(false);
    await tick();
    expect(offer("p1", received)).toBe(true);
    expect(received).toHaveLength(2);
  },
);

it.each(["true", "false", "throw"])(
  "does not book a stale %s callback across session removal and recreation",
  async (outcome) => {
    scheduled(() => {});
    tracker.setViewed("p1", "S");
    await tick();
    const callback = () => {
      tracker.sessionRemoved("S");
      backend.addSession("S", { rows: 3, lines: ["x", "y", "z"] });
      tracker.setViewed("p1", "S");
      if (outcome === "throw") throw new Error("private terminal payload");
      return outcome === "true";
    };
    if (outcome === "throw") {
      expect(() => tracker.offerPrepared("p1", callback)).toThrow("scheduled screen offer failed");
    } else {
      expect(tracker.offerPrepared("p1", callback)).toBe(outcome === "true");
    }
    expect(
      tracker.offerPrepared(
        "p1",
        vi.fn(() => true),
      ),
    ).toBe(false);
    await tick();
    const received: InnerMessage[] = [];
    expect(offer("p1", received)).toBe(true);
    expect(lines(reconstruct(undefined, received[0] as InnerMessage))).toEqual(["x", "y", "z"]);
  },
);

it("retiring and recreating a session does not deliver its old prepared frame", async () => {
  const received: InnerMessage[] = [];
  scheduled(() => {});
  tracker.setViewed("p1", "S");
  await tick();
  backend.emit({ type: "session-removed", sessionId: "S" });
  backend.addSession("S", { rows: 3, lines: ["x", "y", "z"] });
  tracker.setViewed("p1", "S");
  expect(offer("p1", received)).toBe(false);
  await tick();
  expect(offer("p1", received)).toBe(true);
  expect(lines(reconstruct(undefined, received[0] as InnerMessage))).toEqual(["x", "y", "z"]);
});

it.each(["scheduled", "automatic"])(
  "retires exact viewer keys before notifying a %s SessionGone observer",
  async (delivery) => {
    const removed: string[][] = [];
    const ready: InnerMessage[] = [];
    tracker = new ScreenTracker({
      backend,
      log,
      now: () => Date.now(),
      ...(delivery === "scheduled"
        ? { delivery: "scheduled" as const, onReady: () => {} }
        : { delivery: "automatic" as const, sink: () => true }),
      onSessionGone: (_sid, keys) => {
        removed.push([...keys]);
        expect(tracker.viewedBy("S")).toEqual([]);
        backend.addSession("S", { lines: ["new", "b", "c"] });
        tracker.setViewed("replacement", "S");
      },
    });
    tracker.start();
    tracker.setViewed("old", "S");
    backend.throwOnNextGetScreen("S", new SessionGone("S"));
    await tick();
    expect(removed).toEqual([["old"]]);
    expect(tracker.viewedBy("S")).toEqual(["replacement"]);
    if (delivery === "scheduled") {
      await tick();
      expect(
        tracker.offerPrepared("replacement", (message) => {
          ready.push(message);
          return true;
        }),
      ).toBe(true);
      expect(lines(reconstruct(undefined, ready[0] as InnerMessage))).toEqual(["new", "b", "c"]);
    }
  },
);

it("captures exact removed viewer keys once for a backend event and contains rejected observer", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const removed: string[][] = [];
    tracker = new ScreenTracker({
      backend,
      log,
      delivery: "scheduled",
      now: () => Date.now(),
      onReady: () => {},
      onSessionGone: (_sid, keys) => {
        removed.push([...keys]);
        expect(tracker.viewedBy("S")).toEqual([]);
        tracker.setViewed("new", "S");
        return Promise.reject(new Error("private observer error"));
      },
    });
    tracker.start();
    tracker.setViewed("a", "S");
    tracker.setViewed("b", "S");
    backend.emit({ type: "session-removed", sessionId: "S" });
    expect(removed).toEqual([["a", "b"]]);
    expect(tracker.viewedBy("S")).toEqual(["new"]);
    await Promise.resolve();
    expect(unhandled).toEqual([]);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

it.each([true, false])(
  "binds history=%s capture context to the exact snapshot",
  async (evidence) => {
    const captureBackend = new CaptureBackend();
    captureBackend.addSession("S", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
    captureBackend.evidence = evidence;
    const received: { message: InnerMessage; context: ScreenFrameContext }[] = [];
    scheduled(() => {}, { backend: captureBackend });
    tracker.setViewed("p1", "S", { history: true });
    await tick();
    expect(captureBackend.reads[0]).toMatchObject({ id: "S", history: true });
    expect(
      tracker.offerPrepared("p1", (message, context) => {
        received.push({ message, context });
        return true;
      }),
    ).toBe(true);
    expect(received[0]?.message.type).toBe("screen.snapshot");
    expect(received[0]?.context).toMatchObject({
      generation: 1,
      reported: 10,
      historyRequested: true,
    });
    expect(Object.isFrozen(received[0]?.context)).toBe(true);
    expect(received[0]?.context.capture).toBe(captureBackend.reads[0]?.capture);
    captureBackend.appendLine("S", "d");
    await tick();
    expect(captureBackend.reads[1]?.history).toBe(false);
  },
);

it("a history viewer joining during capture waits for its own evidence", async () => {
  const captureBackend = new CaptureBackend();
  captureBackend.addSession("S", { rows: 3, lines: ["a", "b", "c"] });
  let release!: () => void;
  captureBackend.getScreenGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    scheduled(() => {}, { backend: captureBackend });
    tracker.setViewed("legacy", "S");
    await tick();
    tracker.setViewed("phone", "S", { history: true });
  } finally {
    captureBackend.getScreenGate = null;
    release();
  }
  await vi.advanceTimersByTimeAsync(0);
  expect(
    tracker.offerPrepared(
      "phone",
      vi.fn(() => true),
    ),
  ).toBe(false);
  await tick();
  expect(captureBackend.reads.map((read) => read.history)).toEqual([false, true]);
  const received: InnerMessage[] = [];
  expect(offer("phone", received)).toBe(true);
  expect(received[0]?.type).toBe("screen.snapshot");
});

it("a new history viewer's no-op capture preserves a pending legacy changed row", async () => {
  const captureBackend = new CaptureBackend();
  captureBackend.addSession("S", { rows: 3, lines: ["a", "b", "c"] });
  scheduled(() => {}, { backend: captureBackend });
  tracker.setViewed("legacy", "S");
  await tick();
  const received: InnerMessage[] = [];
  let state = reconstruct(
    undefined,
    (() => {
      tracker.offerPrepared("legacy", (message) => {
        received.push(message);
        return true;
      });
      return received[0] as InnerMessage;
    })(),
  );
  captureBackend.setLines("S", ["a", "changed", "c"]);
  await tick();
  tracker.setViewed("phone", "S", { history: true });
  await tick();
  expect(offer("legacy", received)).toBe(true);
  expect(received[1]?.type).toBe("screen.diff");
  state = reconstruct(state, received[1] as InnerMessage);
  expect(lines(state)).toEqual(["a", "changed", "c"]);
  const phone: InnerMessage[] = [];
  expect(offer("phone", phone)).toBe(true);
  expect(lines(reconstruct(undefined, phone[0] as InnerMessage))).toEqual(lines(state));
});

it.each(["throw", "void", "number", "reject", "hostile thenable"])(
  "contains a %s offer result and retains a full snapshot for retry",
  async (failure) => {
    const received: InnerMessage[] = [];
    scheduled(() => {});
    tracker.setViewed("p1", "S");
    await tick();
    const bad = () => {
      if (failure === "throw") throw new Error("private terminal payload");
      if (failure === "void") return undefined as unknown as boolean;
      if (failure === "number") return 1 as unknown as boolean;
      if (failure === "reject")
        return Promise.reject(new Error("private terminal payload")) as unknown as boolean;
      return {
        // biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable contract test.
        get then() {
          throw new Error("private terminal payload");
        },
      } as unknown as boolean;
    };
    expect(() => tracker.offerPrepared("p1", bad)).toThrow("scheduled screen offer failed");
    await vi.advanceTimersByTimeAsync(0);
    expect(offer("p1", received)).toBe(true);
    expect(received[0]?.type).toBe("screen.snapshot");
    expect(backend.getScreenCalls).toBe(1);
  },
);

it.each(["throw", "reject"])(
  "contains %s readiness and still advances a healthy session",
  async (failure) => {
    backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
    const received: InnerMessage[] = [];
    scheduled((sessionId) => {
      if (sessionId === "S") {
        if (failure === "throw") throw new Error("private terminal payload");
        return Promise.reject(new Error("private terminal payload")) as unknown as undefined;
      }
      offer("healthy", received);
    });
    tracker.setViewed("failing", "S");
    tracker.setViewed("healthy", "T");
    await tick();
    await vi.advanceTimersByTimeAsync(0);
    expect(lines(reconstruct(undefined, received[0] as InnerMessage))).toEqual(["x", "y", "z"]);
  },
);

it("does not let one pending backend capture block another session's readiness", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  class SplitBackend extends FakeBackend {
    override async getScreen(id: string, _options?: ScreenReadOptions): Promise<Screen> {
      if (id === "S") await gate;
      return super.getScreen(id);
    }
  }
  const splitBackend = new SplitBackend();
  splitBackend.addSession("S", { rows: 3, lines: ["a", "b", "c"] });
  splitBackend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
  const received: InnerMessage[] = [];
  try {
    scheduled(
      (sessionId) => {
        if (sessionId === "T") offer("healthy", received);
      },
      { backend: splitBackend },
    );
    tracker.setViewed("slow", "S");
    tracker.setViewed("healthy", "T");
    await tick();
    expect(lines(reconstruct(undefined, received[0] as InnerMessage))).toEqual(["x", "y", "z"]);
  } finally {
    release();
    await vi.advanceTimersByTimeAsync(0);
  }
});

it("a real one-frame scheduler refunds refusal so a healthy persistent producer proceeds", async () => {
  backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
  const received: InnerMessage[] = [];
  const scheduler = new WireScheduler({ now: () => Date.now(), maxFramesPerSecond: 1 });
  const failures: InnerMessage[] = [];
  scheduled(() => {
    scheduler.pump();
  });
  scheduler.register("refusing", () =>
    tracker.offerPrepared("refusing", (message) => {
      failures.push(message);
      return false;
    }),
  );
  scheduler.register("healthy", () => offer("healthy", received));
  tracker.setViewed("refusing", "S");
  tracker.setViewed("healthy", "T");
  await vi.advanceTimersByTimeAsync(1000);
  expect(failures.length).toBeGreaterThan(0);
  expect(received).toHaveLength(1);
  expect(lines(reconstruct(undefined, received[0] as InnerMessage))).toEqual(["x", "y", "z"]);
  expect(scheduler.pump()).toBe(0);
  scheduler.clear();
});

it("a real one-frame scheduler charges literal true once even when its viewer retires", async () => {
  backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
  const received: InnerMessage[] = [];
  const scheduler = new WireScheduler({ now: () => Date.now(), maxFramesPerSecond: 1 });
  let admitted = 0;
  scheduled(() => {
    scheduler.pump();
  });
  scheduler.register("retiring", () =>
    tracker.offerPrepared("retiring", () => {
      admitted++;
      tracker.dropViewer("retiring");
      return true;
    }),
  );
  scheduler.register("healthy", () => offer("healthy", received));
  tracker.setViewed("retiring", "S");
  tracker.setViewed("healthy", "T");
  await vi.advanceTimersByTimeAsync(1000);
  expect(admitted).toBe(1);
  expect(received).toHaveLength(0);
  await vi.advanceTimersByTimeAsync(1000);
  expect(received).toHaveLength(1);
  scheduler.clear();
});

it.each(["throw", "void", "number", "reject", "hostile thenable"])(
  "a real one-frame scheduler charges and retires a %s producer",
  async (failure) => {
    backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
    const errors: unknown[] = [];
    const scheduler = new WireScheduler({
      now: () => Date.now(),
      maxFramesPerSecond: 1,
      onError: (error) => {
        errors.push(error);
      },
    });
    const received: InnerMessage[] = [];
    let attempts = 0;
    scheduled(() => {
      scheduler.pump();
    });
    scheduler.register("uncertain", () =>
      tracker.offerPrepared("uncertain", () => {
        attempts++;
        if (failure === "throw") throw new Error("private terminal payload");
        if (failure === "void") return undefined as unknown as boolean;
        if (failure === "number") return 1 as unknown as boolean;
        if (failure === "reject")
          return Promise.reject(new Error("private terminal payload")) as unknown as boolean;
        return {
          // biome-ignore lint/suspicious/noThenProperty: intentional hostile thenable contract test.
          get then() {
            throw new Error("private terminal payload");
          },
        } as unknown as boolean;
      }),
    );
    scheduler.register("healthy", () => offer("healthy", received));
    tracker.setViewed("uncertain", "S");
    tracker.setViewed("healthy", "T");
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(1);
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).not.toContain("terminal payload");
    expect(received).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(attempts).toBe(1);
    expect(received).toHaveLength(1);
    scheduler.clear();
  },
);
