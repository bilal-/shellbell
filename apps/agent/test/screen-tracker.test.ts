import { applyDiff, applySnapshot, type InnerMessage, type ScreenState } from "@shellbell/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import { SessionGone } from "../src/backends/types.js";
import { createLogger, type Logger } from "../src/log.js";
import { ScreenTracker } from "../src/screen-tracker.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });
const text = (m: InnerMessage) =>
  (m.type === "screen.snapshot"
    ? m.lines
    : m.type === "screen.diff"
      ? m.changed.map((c) => c.line)
      : []
  ).map((l) => l.r[0]?.t ?? "");

let backend: FakeBackend;
let sent: { conn: string; msg: InnerMessage }[];
let tracker: ScreenTracker;

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  backend.addSession("S", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
  sent = [];
  tracker = new ScreenTracker({
    backend,
    sink: (conn, msg) => {
      sent.push({ conn, msg });
    },
    log,
    now: () => Date.now(),
  });
  tracker.start();
});
afterEach(() => {
  tracker.stop();
  vi.useRealTimers();
});

const flush = async () => {
  await vi.advanceTimersByTimeAsync(130);
};

const restartAtOneFramePerSecond = () => {
  tracker.stop();
  sent = [];
  tracker = new ScreenTracker({
    backend,
    sink: (conn, msg) => {
      sent.push({ conn, msg });
    },
    log,
    maxFramesPerSecond: 1,
    now: () => Date.now(),
  });
  tracker.start();
};

describe("ScreenTracker", () => {
  it("snapshot on view; diff with scroll when tailing; nothing when no viewers", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent[0]?.msg.type).toBe("screen.snapshot");
    expect(text(sent[0]?.msg as InnerMessage)).toEqual(["a", "b", "c"]);
    backend.appendLine("S", "d");
    tracker.markDirty("S"); // idempotent: the tracker also hears screen-changed itself
    await flush();
    const diff = sent[1]?.msg;
    expect(diff?.type).toBe("screen.diff");
    if (diff?.type !== "screen.diff") throw new Error();
    expect(diff.scroll).toBe(1);
    expect(diff.changed).toEqual([{ i: 2, line: { r: [{ t: "d" }] } }]);
    expect(diff.scrollbackTotal).toBe(11);
    expect(diff.gen).toBe(2);
    tracker.setViewed("p1", null);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    expect(sent.length).toBe(2);
  });

  it("saturated history: detects scroll by overlap and keeps a monotonic scrollbackTotal", async () => {
    backend.saturated = true;
    backend.capabilities = { ...backend.capabilities, absoluteLines: false };
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    const diff = sent[1]?.msg;
    if (diff?.type !== "screen.diff") throw new Error(`expected diff, got ${diff?.type}`);
    expect(diff.scroll).toBe(1);
    expect(diff.scrollbackTotal).toBe(11);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    const msg2 = sent[2]?.msg as { scrollbackTotal: number } | undefined;
    expect(msg2?.scrollbackTotal).toBe(12);
  });

  it("clear → snapshot with reset; >60% change → snapshot", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.clear("S");
    tracker.markDirty("S");
    await flush();
    const snap = sent[1]?.msg;
    expect(snap?.type).toBe("screen.snapshot");
    expect((snap as { reset?: boolean }).reset).toBe(true);
    backend.setLines("S", ["x", "y", "z"]);
    tracker.markDirty("S");
    await flush();
    expect(sent[2]?.msg.type).toBe("screen.snapshot");
    const msg3 = sent[2]?.msg as { reset?: boolean } | undefined;
    expect(msg3?.reset).toBeUndefined();
  });

  it("a lagging viewer gets a snapshot; an up-to-date viewer gets the diff", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    tracker.setViewed("p2", "S"); // joins at gen 2 → snapshot
    await flush();
    expect(sent.filter((s) => s.conn === "p2").map((s) => s.msg.type)).toEqual(["screen.snapshot"]);
    backend.appendLine("S", "e");
    tracker.markDirty("S");
    await flush();
    const last = sent
      .slice(-2)
      .map((s) => [s.conn, s.msg.type].join(":"))
      .sort();
    expect(last).toEqual(["p1:screen.diff", "p2:screen.diff"]);
  });

  it("forceSnapshot sends a fresh snapshot to one viewer", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.forceSnapshot("p1", "S");
    await flush();
    expect(sent.map((s) => s.msg.type)).toEqual(["screen.snapshot", "screen.snapshot"]);
  });

  it("does not poll unviewed sessions and coalesces bursts into one getScreen per tick", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    const before = backend.getScreenCalls;
    for (let i = 0; i < 10; i++) backend.appendLine("S", `l${i}`);
    tracker.markDirty("S");
    await flush();
    expect(backend.getScreenCalls - before).toBe(1);
  });

  it("session removal drops viewers silently", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.sessionRemoved("S");
    expect(tracker.viewedBy("S")).toEqual([]);
  });

  it("pushes the viewed set to the backend and stops when the last viewer leaves", async () => {
    backend.addSession("T", { rows: 3, lines: ["x", "y", "z"] });
    tracker.setViewed("p1", "S");
    expect(backend.watched.at(-1)).toEqual(["S"]);
    tracker.setViewed("p2", "T");
    expect(backend.watched.at(-1)).toEqual(["S", "T"]);
    // A second viewer on a session already watched changes nothing, so nothing is re-sent.
    const calls = backend.watched.length;
    tracker.setViewed("p3", "S");
    expect(backend.watched.length).toBe(calls);
    tracker.setViewed("p1", null);
    tracker.setViewed("p3", null);
    expect(backend.watched.at(-1)).toEqual(["T"]);
    tracker.sessionRemoved("T");
    expect(backend.watched.at(-1)).toEqual([]);
  });

  it("marks dirty from the backend's own screen-changed event, with no explicit markDirty", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent).toHaveLength(1);
    backend.appendLine("S", "d"); // emits screen-changed; the tracker subscribed in start()
    await flush();
    expect(sent).toHaveLength(2);
    expect(sent[1]?.msg.type).toBe("screen.diff");
  });

  it("caps TOTAL sink calls per second across all viewers and coalesces the rest", async () => {
    // Plan 02 parked item: every frame leaves through the agent's single relay socket, which the
    // relay caps at 60 msg/s (close 4429). 10 viewers at 8 fps is 80 msg/s without a GLOBAL bucket;
    // a per-viewer cap of 40 would not stop it. 7 flushes of 130 ms stay inside one 1 s window.
    for (let i = 0; i < 10; i++) tracker.setViewed(`v${i}`, "S");
    for (let t = 0; t < 7; t++) {
      backend.appendLine("S", `line${t}`);
      tracker.markDirty("S");
      await flush();
    }
    expect(sent.length).toBeGreaterThanOrEqual(10); // at least one tick was served in full
    expect(sent.length).toBeLessThanOrEqual(40); // 70 attempts, 40 tokens
  });

  it("delivers six static viewers without recapturing", async () => {
    for (let i = 0; i < 6; i++) tracker.setViewed(`p${i}`, "S");
    await vi.advanceTimersByTimeAsync(125);
    expect(new Set(sent.map((x) => x.conn)).size).toBe(5);
    const captures = backend.getScreenCalls;
    await vi.advanceTimersByTimeAsync(125);
    expect(new Set(sent.map((x) => x.conn)).size).toBe(6);
    expect(backend.getScreenCalls).toBe(captures);
    expect(new Set(sent.map((x) => ("gen" in x.msg ? x.msg.gen : -1)))).toEqual(new Set([1]));
  });

  describe("pending delivery", () => {
    it("delivers the first snapshot after an initially empty bucket without recapturing", async () => {
      restartAtOneFramePerSecond();
      tracker.setViewed("p1", "S");

      await vi.advanceTimersByTimeAsync(125);
      expect(sent).toHaveLength(0);
      const captures = backend.getScreenCalls;

      await vi.advanceTimersByTimeAsync(875);
      expect(sent).toHaveLength(1);
      expect(sent[0]?.msg.type).toBe("screen.snapshot");
      expect(backend.getScreenCalls).toBe(captures);
    });

    it("delivers final output after quietness without recapturing", async () => {
      restartAtOneFramePerSecond();
      tracker.setViewed("p1", "S");
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(1);

      backend.appendLine("S", "final");
      await vi.advanceTimersByTimeAsync(125);
      expect(sent).toHaveLength(1);
      const captures = backend.getScreenCalls;

      await vi.advanceTimersByTimeAsync(875);
      expect(sent).toHaveLength(2);
      expect(text(sent[1]?.msg as InnerMessage)).toContain("final");
      expect(backend.getScreenCalls).toBe(captures);
    });

    it("retries a refused prepared snapshot without recapturing or changing generation", async () => {
      tracker.stop();
      const attempts: InnerMessage[] = [];
      let available = false;
      tracker = new ScreenTracker({
        backend,
        sink: (_conn, msg) => {
          attempts.push(msg);
          return available;
        },
        log,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("p1", "S");

      await vi.advanceTimersByTimeAsync(125);
      const captures = backend.getScreenCalls;
      available = true;
      await vi.advanceTimersByTimeAsync(125);

      expect(attempts).toHaveLength(2);
      expect(attempts.map((msg) => msg.type)).toEqual(["screen.snapshot", "screen.snapshot"]);
      expect(attempts.map((msg) => ("gen" in msg ? msg.gen : -1))).toEqual([1, 1]);
      expect(backend.getScreenCalls).toBe(captures);
    });

    it("preserves an undelivered diff when a new viewer triggers an unchanged recapture", async () => {
      tracker.stop();
      let oldState: ScreenState | undefined;
      const oldFrames: InnerMessage[] = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn, msg) => {
          if (conn !== "old") return;
          oldFrames.push(msg);
          if (msg.type === "screen.snapshot") {
            oldState = applySnapshot(oldState, msg);
          } else if (msg.type === "screen.diff") {
            if (!oldState) throw new Error("diff received before snapshot");
            const applied = applyDiff(oldState, msg);
            expect(applied.gap).toBe(false);
            oldState = applied.state;
          }
        },
        log,
        maxFramesPerSecond: 4,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("old", "S");
      await vi.advanceTimersByTimeAsync(250);

      backend.appendLine("S", "d");
      await vi.advanceTimersByTimeAsync(125);
      expect(oldState?.lines.map((line) => line.r[0]?.t)).toEqual(["a", "b", "c"]);

      tracker.setViewed("new", "S");
      await vi.advanceTimersByTimeAsync(125);

      const current = await backend.getScreen("S");
      expect(oldFrames.map((msg) => msg.type)).toEqual(["screen.snapshot", "screen.diff"]);
      expect(oldState?.lines).toEqual(current.lines);
    });

    it("continues delivering to other viewers when one sink throws", async () => {
      tracker.stop();
      const attempted: string[] = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn, msg) => {
          attempted.push(conn);
          if (conn === "throwing") throw new Error("transport failed");
          sent.push({ conn, msg });
        },
        log,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("throwing", "S");
      tracker.setViewed("healthy", "S");

      await vi.advanceTimersByTimeAsync(125);

      expect(attempted).toContain("throwing");
      expect(sent.some(({ conn }) => conn === "healthy")).toBe(true);
    });

    it("does not retry a refused frame after its viewer is dropped", async () => {
      tracker.stop();
      const attempts: string[] = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn) => {
          attempts.push(conn);
          return false;
        },
        log,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("gone", "S");

      await vi.advanceTimersByTimeAsync(125);
      tracker.dropViewer("gone");
      await vi.advanceTimersByTimeAsync(250);

      expect(attempts).toEqual(["gone"]);
    });

    it("captures current content after the last viewer leaves and a new viewer subscribes", async () => {
      tracker.stop();
      const attempts: { conn: string; msg: InnerMessage }[] = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn, msg) => {
          attempts.push({ conn, msg });
          return conn !== "old";
        },
        log,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("old", "S");
      await vi.advanceTimersByTimeAsync(125);
      const captures = backend.getScreenCalls;

      tracker.dropViewer("old");
      backend.setLines("S", ["new-a", "new-b", "new-c"]);
      tracker.setViewed("new", "S");
      await vi.advanceTimersByTimeAsync(125);

      const fresh = attempts.find(({ conn }) => conn === "new")?.msg;
      expect(fresh?.type).toBe("screen.snapshot");
      expect(text(fresh as InnerMessage)).toEqual(["new-a", "new-b", "new-c"]);
      expect(backend.getScreenCalls).toBe(captures + 1);
      expect(attempts.filter(({ conn }) => conn === "old")).toHaveLength(1);
    });

    it("cancels a pending frame when its viewer unsubscribes", async () => {
      restartAtOneFramePerSecond();
      tracker.setViewed("p1", "S");
      await vi.advanceTimersByTimeAsync(125);
      expect(sent).toHaveLength(0);

      tracker.setViewed("p1", null);
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(0);
    });

    it("cancels a pending frame when its session is removed", async () => {
      restartAtOneFramePerSecond();
      tracker.setViewed("p1", "S");
      await vi.advanceTimersByTimeAsync(125);
      expect(sent).toHaveLength(0);

      backend.emit({ type: "session-removed", sessionId: "S" });
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(0);
    });

    it("cancels a pending frame when the tracker stops", async () => {
      restartAtOneFramePerSecond();
      tracker.setViewed("p1", "S");
      await vi.advanceTimersByTimeAsync(125);
      expect(sent).toHaveLength(0);

      tracker.stop();
      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(0);
    });

    it("discards an obsolete capture when a session is removed and recreated", async () => {
      let release: () => void = () => {};
      backend.getScreenGate = new Promise((resolve) => {
        release = resolve;
      });
      tracker.setViewed("old-viewer", "S");
      await vi.advanceTimersByTimeAsync(125);
      expect(backend.getScreenCalls).toBe(1);

      backend.emit({ type: "session-removed", sessionId: "S" });
      tracker.setViewed("new-viewer", "S");
      release();
      await vi.advanceTimersByTimeAsync(0);

      expect(sent.map((x) => x.conn)).not.toContain("old-viewer");
      expect(tracker.viewedBy("S")).toEqual(["new-viewer"]);
    });
  });

  it("ignores SessionGone from an obsolete capture after notifying exact removed viewers", async () => {
    const onSessionGone = vi.fn();
    tracker.stop();
    tracker = new ScreenTracker({
      backend,
      sink: (conn, msg) => {
        sent.push({ conn, msg });
      },
      log,
      onSessionGone,
      now: () => Date.now(),
    });
    tracker.start();

    let release: () => void = () => {};
    backend.getScreenGate = new Promise((resolve) => {
      release = resolve;
    });
    backend.throwOnNextGetScreen("S", new SessionGone("S"));
    tracker.setViewed("old-viewer", "S");
    const tickPromise = (tracker as unknown as { tick: () => Promise<void> }).tick();
    expect(backend.getScreenCalls).toBe(1);

    backend.emit({ type: "session-removed", sessionId: "S" });
    tracker.setViewed("new-viewer", "S");
    expect(tracker.viewedBy("S")).toEqual(["new-viewer"]);

    release();
    await tickPromise;

    expect(onSessionGone).toHaveBeenCalledExactlyOnceWith("S", ["old-viewer"]);
    expect(tracker.viewedBy("S")).toEqual(["new-viewer"]);
  });

  it("suppresses no-op ticks: unchanged content wakes no already-current viewer", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    const before = sent.length;
    tracker.markDirty("S"); // dirty, but the backend's content is unchanged
    await flush();
    expect(sent.length).toBe(before);
  });

  it("resize forces a fresh snapshot even mid-session", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush(); // p1 now has a diff behind it (gen 2)
    backend.addSession("S", { cols: 30, rows: 3, lines: ["x", "y", "z"], scrollbackTotal: 11 });
    tracker.markDirty("S");
    await flush();
    expect(sent.at(-1)?.msg.type).toBe("screen.snapshot");
  });

  it("setIntervalMs re-arms the timer at the new interval", async () => {
    tracker.setViewed("p1", "S");
    await flush();
    tracker.setIntervalMs(500);
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await vi.advanceTimersByTimeAsync(200); // < 500 ms since the re-arm: no tick yet
    expect(sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(310); // 510 ms total: past the new interval
    expect(sent).toHaveLength(2);
  });

  it("stop() prevents a getScreen already in flight from reaching the sink", async () => {
    let release: () => void = () => {};
    backend.getScreenGate = new Promise((resolve) => {
      release = resolve;
    });
    tracker.setViewed("p1", "S");
    await vi.advanceTimersByTimeAsync(130); // tick fires; getScreen is now awaiting the gate
    expect(backend.getScreenCalls).toBeGreaterThan(0);
    tracker.stop();
    release();
    await vi.advanceTimersByTimeAsync(0); // let the in-flight getScreen settle
    expect(sent).toHaveLength(0);
  });

  it("stop() ignores SessionGone from a getScreen already in flight", async () => {
    const onSessionGone = vi.fn();
    tracker.stop();
    tracker = new ScreenTracker({
      backend,
      sink: (conn, msg) => {
        sent.push({ conn, msg });
      },
      log,
      onSessionGone,
      now: () => Date.now(),
    });
    tracker.start();

    let release: () => void = () => {};
    backend.getScreenGate = new Promise((resolve) => {
      release = resolve;
    });
    backend.throwOnNextGetScreen("S", new SessionGone("S"));
    tracker.setViewed("p1", "S");
    const tickPromise = (tracker as unknown as { tick: () => Promise<void> }).tick();
    expect(backend.getScreenCalls).toBe(1);

    tracker.stop();
    release();
    await tickPromise;

    expect(onSessionGone).not.toHaveBeenCalled();
    expect(tracker.viewedBy("S")).toEqual(["p1"]);
    expect(sent).toHaveLength(0);
  });

  describe("getScreen error handling (spec §8.6)", () => {
    it("SessionGone drops session state and viewers, and calls onSessionGone", async () => {
      const onSessionGone = vi.fn();
      tracker.stop();
      sent = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn, msg) => {
          sent.push({ conn, msg });
        },
        log,
        onSessionGone,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("p1", "S");
      await flush();
      backend.throwOnNextGetScreen("S", new SessionGone("S"));
      backend.appendLine("S", "d");
      tracker.markDirty("S");
      await flush();
      expect(onSessionGone).toHaveBeenCalledWith("S", ["p1"]);
      expect(tracker.viewedBy("S")).toEqual([]);
    });

    it("a transient error keeps viewers and resyncs them on the next successful tick", async () => {
      tracker.setViewed("p1", "S");
      await flush(); // initial snapshot
      backend.throwOnNextGetScreen("S", new Error("rpc timeout"));
      backend.appendLine("S", "d");
      tracker.markDirty("S");
      await flush(); // this tick's getScreen throws; the viewer must not be dropped
      expect(tracker.viewedBy("S")).toEqual(["p1"]);
      expect(sent).toHaveLength(1); // nothing sent for the failed tick
      await flush(); // retried automatically: `dirty` was re-armed after the failure
      expect(sent).toHaveLength(2);
      expect(sent[1]?.msg.type).toBe("screen.snapshot"); // forceSnapshot was set after the error
    });
  });

  describe("fairness under a scarce global budget", () => {
    it("rotates scarce tokens fairly across sessions", async () => {
      restartAtOneFramePerSecond();
      backend.addSession("T", { rows: 3, lines: ["x", "y", "z"], scrollbackTotal: 20 });
      tracker.setViewed("viewer-s", "S");
      tracker.setViewed("viewer-t", "T");

      for (let tick = 0; tick < 3000 / 125; tick++) {
        backend.appendLine("S", `busy-${tick}`);
        await vi.advanceTimersByTimeAsync(125);
      }

      expect(sent.some(({ conn }) => conn === "viewer-t")).toBe(true);
      expect(sent.length).toBeLessThanOrEqual(3);
    });

    it("delivers static generation 1 across sessions without recapturing", async () => {
      restartAtOneFramePerSecond();
      backend.addSession("T", { rows: 3, lines: ["x", "y", "z"], scrollbackTotal: 20 });
      tracker.setViewed("viewer-s", "S");
      tracker.setViewed("viewer-t", "T");

      await vi.advanceTimersByTimeAsync(125);
      expect(sent).toHaveLength(0);
      const captures = backend.getScreenCalls;

      await vi.advanceTimersByTimeAsync(875);
      expect(sent).toHaveLength(1);
      expect(backend.getScreenCalls).toBe(captures);

      await vi.advanceTimersByTimeAsync(1000);
      expect(sent).toHaveLength(2);
      expect(sent.map(({ conn }) => conn).sort()).toEqual(["viewer-s", "viewer-t"]);
      expect(sent.map(({ msg }) => ("gen" in msg ? msg.gen : -1))).toEqual([1, 1]);
      expect(backend.getScreenCalls).toBe(captures);
    });

    it("counts a throwing send as spent when rotating across sessions", async () => {
      tracker.stop();
      backend.addSession("T", { rows: 3, lines: ["x", "y", "z"], scrollbackTotal: 20 });
      sent = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn, msg) => {
          if (conn === "viewer-s") throw new Error("transport refused");
          sent.push({ conn, msg });
        },
        log,
        maxFramesPerSecond: 1,
        now: () => Date.now(),
      });
      tracker.start();
      tracker.setViewed("viewer-s", "S");
      tracker.setViewed("viewer-t", "T");

      await vi.advanceTimersByTimeAsync(2000);

      expect(sent.some(({ conn }) => conn === "viewer-t")).toBe(true);
    });

    it("10 viewers, continuous output for 3s: every viewer is served, total capped at 40/s", async () => {
      const conns = Array.from({ length: 10 }, (_, i) => `v${i}`);
      for (const c of conns) tracker.setViewed(c, "S");
      const ticksPerSecond = 1000 / 125; // default intervalMs
      const seconds = 3;
      for (let t = 0; t < ticksPerSecond * seconds; t++) {
        backend.appendLine("S", `l${t}`);
        tracker.markDirty("S");
        await vi.advanceTimersByTimeAsync(125);
      }
      expect(sent.length).toBeLessThanOrEqual(40 * seconds);
      for (const c of conns) {
        const count = sent.filter((s) => s.conn === c).length;
        expect(count).toBeGreaterThanOrEqual(2);
      }
    });

    it("a viewer coalesced 3+ consecutive ticks is served a degraded catch-up snapshot, fairly", async () => {
      // 4 viewers, 1 token/tick: a fair round-robin serves exactly one viewer per pass, in order,
      // so whichever viewer is served last has been coalesced 3+ times when its turn finally comes.
      tracker.stop();
      sent = [];
      tracker = new ScreenTracker({
        backend,
        sink: (conn, msg) => {
          sent.push({ conn, msg });
        },
        log,
        maxFramesPerSecond: 1,
        now: () => Date.now(),
      });
      tracker.start();
      const conns = ["v0", "v1", "v2", "v3"];
      for (const c of conns) tracker.setViewed(c, "S");
      const pass = async () => {
        backend.appendLine("S", "out");
        tracker.markDirty("S");
        await vi.advanceTimersByTimeAsync(1100); // > 1 bucket window: at most one fresh token
      };
      // Drive passes until every viewer has been served once (bounded so a fairness regression
      // that starves someone fails loudly instead of hanging).
      const seen = new Set<string>();
      for (let i = 0; i < 10 && seen.size < conns.length; i++) {
        await pass();
        for (const { conn } of sent) seen.add(conn);
      }
      // No viewer starves: exactly one token is minted per successful tick, so once every viewer
      // has appeared, each has appeared exactly once — no repeats, no omissions.
      expect(seen).toEqual(new Set(conns));
      expect(sent).toHaveLength(conns.length);
      const last = sent.at(-1);
      expect(conns).toContain(last?.conn);
      const frame = last?.msg;
      if (frame?.type !== "screen.snapshot")
        throw new Error(`expected snapshot, got ${frame?.type}`);
      expect(frame.degraded).toBe(true); // the last one in was necessarily coalesced 3+ times
      for (const line of frame.lines) {
        expect(line.r.length).toBeLessThanOrEqual(1);
        expect(line.r[0]?.fg).toBeUndefined();
      }
    });
  });

  it("still oversize after stripStyles: sends the degraded frame anyway, warns once per session", async () => {
    tracker.stop();
    sent = [];
    const warn = vi.fn();
    const tinyLog: Logger = {
      debug: () => {},
      info: () => {},
      warn,
      error: () => {},
      child: () => tinyLog,
    };
    tracker = new ScreenTracker({
      backend,
      sink: (conn, msg) => {
        sent.push({ conn, msg });
      },
      log: tinyLog,
      maxEncodedBytes: 10,
      now: () => Date.now(),
    });
    tracker.start();
    tracker.setViewed("p1", "S");
    await flush();
    expect(sent).toHaveLength(1);
    const frame = sent[0]?.msg;
    if (frame?.type !== "screen.snapshot") throw new Error(`expected snapshot, got ${frame?.type}`);
    expect(frame.degraded).toBe(true);
    for (const line of frame.lines) expect(line.r.length).toBeLessThanOrEqual(1);
    expect(warn).toHaveBeenCalledTimes(1);
    backend.appendLine("S", "d");
    tracker.markDirty("S");
    await flush();
    expect(warn).toHaveBeenCalledTimes(1); // logged once per session, not every tick
  });

  describe("round-trips through the shipped screen applier", () => {
    const replay = (state: ScreenState | undefined, msg: InnerMessage): ScreenState => {
      if (msg.type === "screen.snapshot") return applySnapshot(state, msg);
      if (msg.type !== "screen.diff") throw new Error(`unexpected message type ${msg.type}`);
      if (!state) throw new Error("diff received before any snapshot");
      const { state: next, gap } = applyDiff(state, msg);
      expect(gap).toBe(false);
      return next;
    };

    it("(a) append: a viewer's diff reconstructs the backend's screen", async () => {
      tracker.setViewed("p1", "S");
      await flush();
      let state = replay(undefined, sent[0]?.msg as InnerMessage);
      backend.appendLine("S", "d");
      tracker.markDirty("S");
      await flush();
      state = replay(state, sent[1]?.msg as InnerMessage);
      const screen = await backend.getScreen("S");
      expect(state.lines).toEqual(screen.lines);
    });

    it("(b) saturated scroll-by-overlap reconstructs the backend's screen", async () => {
      backend.saturated = true;
      backend.capabilities = { ...backend.capabilities, absoluteLines: false };
      tracker.setViewed("p1", "S");
      await flush();
      let state = replay(undefined, sent[0]?.msg as InnerMessage);
      backend.appendLine("S", "d");
      tracker.markDirty("S");
      await flush();
      state = replay(state, sent[1]?.msg as InnerMessage);
      const screen = await backend.getScreen("S");
      expect(state.lines).toEqual(screen.lines);
    });

    it("(c) clear: the reset snapshot reconstructs the backend's screen", async () => {
      tracker.setViewed("p1", "S");
      await flush();
      let state = replay(undefined, sent[0]?.msg as InnerMessage);
      backend.clear("S");
      tracker.markDirty("S");
      await flush();
      state = replay(state, sent[1]?.msg as InnerMessage);
      const screen = await backend.getScreen("S");
      expect(state.lines).toEqual(screen.lines);
    });

    it("(d) a lagging viewer's catch-up snapshot reconstructs the backend's screen", async () => {
      tracker.setViewed("p1", "S");
      await flush();
      backend.appendLine("S", "d");
      tracker.markDirty("S");
      await flush();
      tracker.setViewed("p2", "S"); // joins lagging: gets a full catch-up snapshot
      await flush();
      const p2msgs = sent.filter((s) => s.conn === "p2");
      const state = replay(undefined, p2msgs[0]?.msg as InnerMessage);
      const screen = await backend.getScreen("S");
      expect(state.lines).toEqual(screen.lines);
    });
  });
});

describe("processScreen guards the last viewer unsubscribing mid-getScreen (minor: rrOffset NaN)", () => {
  it("does not corrupt rrOffset when the only viewer leaves while getScreen is still in flight", async () => {
    let releaseGate: () => void = () => {};
    backend.getScreenGate = new Promise((r) => {
      releaseGate = r;
    });
    tracker.setViewed("p1", "S");
    // Drive tick() directly rather than racing vitest's fake-timer flushing against the gated
    // getScreen promise below -- deterministic regardless of how advanceTimersByTimeAsync
    // schedules microtasks.
    const tickPromise = (tracker as unknown as { tick: () => Promise<void> }).tick();
    tracker.setViewed("p1", null); // the only viewer unsubscribes mid-`getScreen`
    releaseGate();
    await tickPromise;
    // processScreen must have bailed out before touching rrOffset: nothing to send, no viewers.
    expect(sent).toHaveLength(0);
    // A NaN rrOffset (the pre-fix bug) would wedge the round-robin math forever; a fresh viewer
    // must still get a normal snapshot on the very next tick.
    tracker.setViewed("p2", "S");
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.msg.type).toBe("screen.snapshot");
  });
});

describe("per-backend absoluteLines via BackendRegistry.capabilitiesOf (minor: was AND-ed across all backends)", () => {
  it("runs overlap detection only for the backend whose own capability says absoluteLines: false", async () => {
    const iterm = new FakeBackend("iterm2");
    iterm.addSession("A", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });
    const tmux = new FakeBackend("tmux");
    tmux.capabilities = { ...tmux.capabilities, absoluteLines: false };
    tmux.addSession("B", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 10 });

    const registry = new BackendRegistry(log);
    registry.add(iterm);
    registry.add(tmux);
    // Sanity: the old facade-wide AND would report `false` for every session once any backend
    // (tmux) lacks absoluteLines -- exactly the bug this fix removes from the tracker's path.
    expect(registry.capabilities.absoluteLines).toBe(false);
    expect(registry.capabilitiesOf("iterm2:A")?.absoluteLines).toBe(true);
    expect(registry.capabilitiesOf("tmux:B")?.absoluteLines).toBe(false);

    const localSent: { conn: string; msg: InnerMessage }[] = [];
    const t = new ScreenTracker({
      backend: registry,
      sink: (conn, msg) => {
        localSent.push({ conn, msg });
      },
      log,
      now: () => Date.now(),
    });
    t.start();
    try {
      t.setViewed("v-iterm", "iterm2:A");
      t.setViewed("v-tmux", "tmux:B");
      await vi.advanceTimersByTimeAsync(130);
      localSent.length = 0;

      // Saturated: scrollbackTotal stays flat while content shifts by one row. A real iTerm2
      // session never actually looks like this (its absolute counter keeps climbing), but forcing
      // it here isolates which code path processScreen took for each session.
      iterm.saturated = true;
      tmux.saturated = true;
      iterm.appendLine("A", "d");
      tmux.appendLine("B", "d");
      t.markDirty("iterm2:A");
      t.markDirty("tmux:B");
      await vi.advanceTimersByTimeAsync(130);

      const itermMsg = localSent.find((s) => s.conn === "v-iterm")?.msg;
      const tmuxMsg = localSent.find((s) => s.conn === "v-tmux")?.msg;
      // iterm2 (absoluteLines: true): overlap detection is skipped, so the tracker can't tell
      // this is just a scroll -- it falls back to a full re-snapshot.
      expect(itermMsg?.type).toBe("screen.snapshot");
      // tmux (absoluteLines: false): overlap detection runs and finds the one-row shift.
      if (tmuxMsg?.type !== "screen.diff") throw new Error(`expected diff, got ${tmuxMsg?.type}`);
      expect(tmuxMsg.scroll).toBe(1);
    } finally {
      t.stop();
    }
  });

  it("pushes the monotonic reported value down to the backend each frame (spec 8.11)", async () => {
    // Uses whatever FakeBackend/tracker harness this file already builds; the assertion is that
    // the tracker's own `reported` (not the backend's raw scrollbackTotal) is what arrives.
    const tmuxBackend = new FakeBackend("tmux");
    tmuxBackend.addSession("%1", { rows: 3, lines: ["a", "b", "c"], scrollbackTotal: 0 });
    const t = new ScreenTracker({
      backend: tmuxBackend,
      sink: () => {},
      log,
      now: () => Date.now(),
    });
    t.start();
    try {
      t.setViewed("p1", "%1");
      await flush();
      tmuxBackend.appendLine("%1", "d");
      t.markDirty("%1");
      await flush();
      expect(tmuxBackend.reported.at(-1)?.[0]).toBe("%1");
      expect(tmuxBackend.reported.at(-1)?.[1]).toBeGreaterThan(0);
      // Monotonic: never decreases across frames, even when the backend's own counter does.
      const values = tmuxBackend.reported.map(([, v]) => v);
      expect(values).toEqual([...values].sort((a, b) => a - b));
    } finally {
      t.stop();
    }
  });
});
