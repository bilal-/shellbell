import { EventEmitter } from "node:events";
import {
  applyStreamScreen,
  decodeStreamScreen,
  encodeCbor,
  type InnerMessageOf,
  MAX_PAIRINGS,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  StreamReceiver,
} from "@shellbell/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentScreenStream } from "../src/agent-screen-stream.js";
import { BackendRegistry } from "../src/backends/registry.js";
import type { VtSource } from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import {
  type ServiceViewConnection,
  ServiceViewCoordinator,
  type ServiceViewLease,
} from "../src/service-view-coordinator.js";
import { FakeBackend } from "./fakes/fake-backend.js";

const log = createLogger({ stdout: false });
const SID = "iterm2:S";
const SUB_A = "AAAAAAAAAAAAAAAAAAAAAA";
const SUB_B = "BBBBBBBBBBBBBBBBBBBBBB";
const SUB_C = "CCCCCCCCCCCCCCCCCCCCCC";

let native: FakeBackend;
let registry: BackendRegistry;
let coordinator: ServiceViewCoordinator;
let transfer = 0;

function connection() {
  const chunks: StreamChunk[] = [];
  const controls: StreamMessage[] = [];
  const value: ServiceViewConnection = {
    sendChunk: (message) => {
      chunks.push(message);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
  };
  return { value, chunks, controls };
}

/** Chunks pass through `admit`, as on a shared socket; controls always send. */
function admittedConnection(admit: (chunk: StreamChunk) => boolean) {
  const delivered: StreamChunk[] = [];
  const controls: StreamMessage[] = [];
  const value: ServiceViewConnection = {
    sendChunk: (chunk) => {
      if (!admit(chunk)) return false;
      delivered.push(chunk);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
  };
  return { value, delivered, controls };
}

function subscribe(lease: ServiceViewLease, sessionId = SID, subscriptionId = SUB_A): void {
  lease.receive({ type: "stream.subscribe", subscriptionId, sessionId }, 100);
}

function frameBytes(message: StreamMessage): number {
  return encodeCbor(message).byteLength;
}

beforeEach(() => {
  vi.useFakeTimers();
  native = new FakeBackend();
  native.addSession("S", { lines: ["one", "two", "three"] });
  registry = new BackendRegistry(log);
  registry.add(native);
  transfer = 0;
  coordinator = new ServiceViewCoordinator({
    backend: registry,
    log,
    now: () => Date.now(),
    newTransferId: () => `${String(++transfer).padStart(22, "A")}`,
  });
  coordinator.start();
});
afterEach(() => {
  coordinator.stop();
  vi.useRealTimers();
});

it("locally terminates a bounded stream once with payload-free control", () => {
  const controls: StreamMessage[] = [];
  const closed: string[] = [];
  const stream = new AgentScreenStream({
    subscriptionId: SUB_A,
    sessionId: SID,
    now: () => Date.now(),
    newTransferId: () => SUB_B,
    sendChunk: () => true,
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
    requestSnapshot: () => {},
    onClosed: (reason) => {
      closed.push(reason);
    },
  });
  expect(() => stream.terminate("unsupported" as "invalid-transfer")).toThrow(TypeError);
  stream.terminate("session-gone");
  stream.terminate("session-gone");
  expect(controls).toEqual([{ type: "stream.error", subscriptionId: SUB_A, code: "session-gone" }]);
  expect(closed).toEqual(["session-gone"]);
  expect(stream.sendOne()).toBe(false);
});

it("retires only the replaced lease and preserves its new view", async () => {
  const first = connection();
  const replacement = connection();
  const old = coordinator.attach("same", first.value);
  subscribe(old);
  expect(old.viewedSessionId).toBe(SID);
  const current = coordinator.attach("same", replacement.value);
  subscribe(old, SID, SUB_B);
  expect(old.viewedSessionId).toBeNull();
  subscribe(current);
  expect(current.viewedSessionId).toBe(SID);
  old.close();
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(first.chunks).toHaveLength(0);
  expect(replacement.chunks.length).toBeGreaterThan(0);
});

it("bounds distinct connections and rejects invalid replacements before mutation", async () => {
  const current = connection();
  const lease = coordinator.attach("owner", current.value);
  expect(() => coordinator.attach("owner", null as unknown as ServiceViewConnection)).toThrow(
    TypeError,
  );
  subscribe(lease);
  expect(lease.viewedSessionId).toBe(SID);
  for (let i = 1; i < MAX_PAIRINGS; i++) coordinator.attach(`phone-${i}`, connection().value);
  expect(() => coordinator.attach("excess", connection().value)).toThrow(RangeError);
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(current.chunks.length).toBeGreaterThan(0);
});

it.each(["watched cleanup", "connection getter"] as const)(
  "does not exceed the connection cap when a distinct lease attaches during %s",
  async (reentry) => {
    native.addSession("U", { lines: ["newer"] });
    const previous = connection();
    const old = coordinator.attach("same", previous.value);
    subscribe(old);
    const peers = Array.from({ length: MAX_PAIRINGS - 1 }, (_, i) =>
      coordinator.attach(`peer-${i}`, connection().value),
    );
    let newer!: ServiceViewLease;
    let reentered = false;
    const attachNewer = () => {
      if (reentered) return;
      reentered = true;
      newer = coordinator.attach("newer", connection().value);
      subscribe(newer, "iterm2:U");
      expect(newer.viewedSessionId).toBe("iterm2:U");
    };
    if (reentry === "watched cleanup") {
      const original = native.setWatched.bind(native);
      vi.spyOn(native, "setWatched").mockImplementation((ids) => {
        original(ids);
        if (ids.length === 0) attachNewer();
      });
    }
    const outer = connection();
    const outerConnection: ServiceViewConnection =
      reentry === "connection getter"
        ? {
            ...outer.value,
            get sendChunk() {
              attachNewer();
              return outer.value.sendChunk;
            },
          }
        : outer.value;
    expect(() => coordinator.attach("same", outerConnection)).toThrow(
      new RangeError("Too many service view connections"),
    );
    expect(reentered).toBe(true);
    expect(old.viewedSessionId).toBeNull();
    expect(newer.viewedSessionId).toBe("iterm2:U");
    subscribe(peers[0]!);
    expect(peers[0]?.viewedSessionId).toBe(SID);
    peers[0]?.receive({ type: "stream.cancel", subscriptionId: SUB_A }, 100);
    expect(() => coordinator.attach("overflow", connection().value)).toThrow(RangeError);
    const internal = coordinator as unknown as { attachTokens: Map<string, object> };
    expect(internal.attachTokens.size).toBe(0);

    const captures: string[] = [];
    const getScreen = native.getScreen.bind(native);
    vi.spyOn(native, "getScreen").mockImplementation((id) => {
      captures.push(id);
      return getScreen(id);
    });
    await vi.advanceTimersByTimeAsync(150);
    coordinator.pump();
    expect(captures).toEqual(["U"]);
    expect(previous.chunks).toHaveLength(0);
    expect(outer.chunks).toHaveLength(0);

    newer.close();
    const replacement = connection();
    const recovered = coordinator.attach("same", replacement.value);
    subscribe(recovered);
    expect(recovered.viewedSessionId).toBe(SID);
    await vi.advanceTimersByTimeAsync(150);
    expect(replacement.chunks.length).toBeGreaterThan(0);
  },
);

it("rejects a changed SID for the same subscription", async () => {
  const bounded = connection();
  const lease = coordinator.attach("new", bounded.value);
  subscribe(lease);
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(bounded.chunks.length).toBeGreaterThan(0);
  subscribe(lease, "iterm2:other");
  expect(bounded.controls).toContainEqual({
    type: "stream.error",
    subscriptionId: SUB_A,
    code: "invalid-transfer",
  });
});

it("delivers a styled screen with history in bounded chunks", async () => {
  for (let i = 0; i < 5; i++) native.appendLine("S", `history-${i}`);
  const nativeScreen = native.getScreen.bind(native);
  vi.spyOn(native, "getScreen").mockImplementation(async (id) => {
    const screen = await nativeScreen(id);
    if (screen.lines[0]?.r[0]) {
      screen.lines[0] = { r: [{ ...screen.lines[0].r[0], fg: [255, 170, 0] }] };
    }
    return screen;
  });
  const viewer = admittedConnection(() => true);
  const lease = coordinator.attach("new", viewer.value);
  const request: StreamMessage = {
    type: "stream.subscribe",
    subscriptionId: SUB_A,
    sessionId: SID,
  };
  lease.receive(request, frameBytes(request));
  await vi.advanceTimersByTimeAsync(150);
  let displayed: InnerMessageOf<"screen.snapshot"> | undefined;
  const pendingAcks: number[] = [];
  const chunkBytes: number[] = [];
  const receiver = new StreamReceiver({
    subscriptionId: SUB_A,
    sessionId: SID,
    now: () => Date.now(),
    accept: (meta, bytes) => {
      const result = applyStreamScreen(displayed, decodeStreamScreen(meta, bytes));
      expect(result.ok).toBe(true);
      if (result.ok) displayed = result.screen as InnerMessageOf<"screen.snapshot">;
    },
    acknowledge: (through) => {
      pendingAcks.push(through);
      return true;
    },
  });
  const drain = () => {
    while (viewer.delivered.length > 0) {
      for (const chunk of viewer.delivered.splice(0)) {
        const bytes = frameBytes(chunk);
        chunkBytes.push(bytes);
        expect(receiver.receive(chunk, bytes)).toBe("accepted");
        const ack: StreamMessage = {
          type: "stream.ack",
          subscriptionId: SUB_A,
          through: chunk.sequence,
        };
        lease.receive(ack, frameBytes(ack));
      }
    }
    for (const through of pendingAcks.splice(0)) expect(through).toBeGreaterThan(0);
  };
  drain();
  expect(displayed?.lines.map((line) => line.r.map((run) => run.t).join(""))).toEqual([
    "history-2",
    "history-3",
    "history-4",
  ]);
  expect(displayed?.lines[0]?.r[0]?.fg).toEqual([255, 170, 0]);
  native.appendLine("S", "latest");
  await vi.advanceTimersByTimeAsync(150);
  drain();
  expect(displayed?.lines[2]?.r[0]?.t).toBe("latest");
  expect(chunkBytes).toHaveLength(2);
  expect(Math.max(...chunkBytes)).toBeLessThanOrEqual(32768);
});

it("retries a quiet prepared screen after socket drain without another capture", async () => {
  native.appendLine("S", "past");
  let writable = false;
  const viewer = admittedConnection(() => writable);
  const lease = coordinator.attach("new", viewer.value);
  subscribe(lease);
  await vi.advanceTimersByTimeAsync(125);
  expect(viewer.delivered).toHaveLength(0);
  const captures = native.getScreenCalls;
  writable = true;
  await vi.advanceTimersByTimeAsync(25);
  expect(native.getScreenCalls).toBe(captures);
  expect(viewer.delivered.length).toBeGreaterThan(0);
  coordinator.stop();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not redeliver a removal to a tracker registered by its own observer", async () => {
  coordinator.stop();
  const observed: string[] = [];
  coordinator = new ServiceViewCoordinator({
    backend: registry,
    log,
    now: () => Date.now(),
    newTransferId: () => SUB_B,
    onSessionGone: (sid) => {
      observed.push(sid);
      coordinator.stop();
      coordinator.start();
      const next = coordinator.attach("same", connection().value);
      subscribe(next, sid, SUB_C);
      expect(next.viewedSessionId).toBe(sid);
    },
  });
  coordinator.start();
  const old = coordinator.attach("same", connection().value);
  subscribe(old);
  native.emit({ type: "session-removed", sessionId: "S" });
  expect(observed).toEqual([SID]);
  expect(old.viewedSessionId).toBeNull();
  await vi.advanceTimersByTimeAsync(125);
  expect(native.getScreenCalls).toBeGreaterThan(0);
});

it("rejects a raw provider, nonfinite clocks and intervals without replacing active ownership", async () => {
  expect(
    () =>
      new ServiceViewCoordinator({
        backend: native as unknown as BackendRegistry,
        log,
        now: () => Date.now(),
        newTransferId: () => SUB_B,
      }),
  ).toThrow(TypeError);
  expect(
    () =>
      new ServiceViewCoordinator({
        backend: registry,
        log,
        now: () => Number.NaN,
        newTransferId: () => SUB_B,
      }),
  ).toThrow(RangeError);
  const old = connection();
  const lease = coordinator.attach("owner", old.value);
  subscribe(lease);
  expect(() => coordinator.setIntervalMs(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  await vi.advanceTimersByTimeAsync(125);
  expect(old.chunks).toHaveLength(1);
});

it("closes only the current bounded view on malformed bytes or a vanished session", async () => {
  const bounded = connection();
  const lease = coordinator.attach("new", bounded.value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  lease.receive({ type: "stream.ack", subscriptionId: SUB_A, through: 1 }, 0);
  expect(bounded.controls).toEqual([
    { type: "stream.error", subscriptionId: SUB_A, code: "invalid-transfer" },
  ]);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_B, sessionId: SID }, 100);
  native.emit({ type: "session-removed", sessionId: "S" });
  expect(bounded.controls).toEqual([
    { type: "stream.error", subscriptionId: SUB_A, code: "invalid-transfer" },
    { type: "stream.error", subscriptionId: SUB_B, code: "session-gone" },
  ]);
  native.emit({ type: "session-removed", sessionId: "S" });
  expect(bounded.controls).toHaveLength(2);
});

it("charges an uncertain send and continues serving a healthy lease", async () => {
  const errors: string[] = [];
  coordinator.stop();
  coordinator = new ServiceViewCoordinator({
    backend: registry,
    log,
    now: () => Date.now(),
    newTransferId: () => SUB_B,
    onError: () => {
      errors.push("producer");
    },
  });
  coordinator.start();
  const admitted: string[] = [];
  const bad = connection();
  bad.value.sendChunk = () => {
    admitted.push("uncertain");
    throw new Error("private transport error");
  };
  const good = connection();
  const old = coordinator.attach("bad", bad.value);
  const healthy = coordinator.attach("healthy", good.value);
  subscribe(old);
  subscribe(healthy);
  await vi.advanceTimersByTimeAsync(125);
  expect(admitted).toEqual(["uncertain"]);
  expect(old.viewedSessionId).toBeNull();
  expect(good.chunks.length).toBeGreaterThan(0);
  expect(errors).toEqual(["producer"]);
});

it("keeps a replacement after a reentrant admitted send and refuses old cleanup", async () => {
  const first = connection();
  const next = connection();
  let old!: ReturnType<ServiceViewCoordinator["attach"]>;
  let replacement!: ReturnType<ServiceViewCoordinator["attach"]>;
  first.value.sendChunk = () => {
    replacement = coordinator.attach("same", next.value);
    subscribe(replacement, SID, SUB_B);
    old.close();
    return true;
  };
  old = coordinator.attach("same", first.value);
  subscribe(old);
  await vi.advanceTimersByTimeAsync(125);
  expect(old.viewedSessionId).toBeNull();
  await vi.advanceTimersByTimeAsync(125);
  expect(next.chunks.length).toBeGreaterThan(0);
});

it("stops on a nonfinite running clock without multiplying timers or restarting itself", async () => {
  coordinator.stop();
  let clock = Date.now();
  const errors: number[] = [];
  coordinator = new ServiceViewCoordinator({
    backend: registry,
    log,
    now: () => clock,
    newTransferId: () => SUB_B,
    onError: () => {
      errors.push(1);
    },
  });
  coordinator.start();
  subscribe(coordinator.attach("one", connection().value));
  clock = Number.NaN;
  expect(coordinator.pump()).toBe(0);
  expect(errors).toEqual([1]);
  expect(vi.getTimerCount()).toBe(0);
  expect(coordinator.pump()).toBe(0);
  expect(errors).toEqual([1]);
});

it("uses registry-held bounded history permits across subscription replacement", async () => {
  const capture = Object.freeze({ native: "capture" });
  const getScreen = native.getScreen.bind(native);
  vi.spyOn(native, "getScreen").mockImplementation(async (id) => ({
    ...(await getScreen(id)),
    historyCapture: capture,
  }));
  let settle!: (result: {
    status: "page";
    from: number;
    to: number;
    oldestAvailable: number;
    lines: [];
  }) => void;
  const held = new Promise<{
    status: "page";
    from: number;
    to: number;
    oldestAvailable: number;
    lines: [];
  }>((resolve) => {
    settle = resolve;
  });
  const read = vi.fn(() => held);
  Object.assign(native, { getHistoryPage: read });
  for (let i = 0; i < 5; i++) native.appendLine("S", `old-${i}`);
  const sealed = admittedConnection(() => true);
  const lease = coordinator.attach("new", sealed.value);
  const subscribe = (subscriptionId: string): StreamMessage => ({
    type: "stream.subscribe",
    subscriptionId,
    sessionId: SID,
  });
  const receive = (message: StreamMessage) => lease.receive(message, frameBytes(message));
  const acknowledgeSnapshot = () => {
    const chunks = sealed.delivered
      .splice(0)
      .filter((message): message is StreamChunk => message.type === "stream.chunk");
    expect(chunks.length).toBeGreaterThan(0);
    receive({
      type: "stream.ack",
      subscriptionId: chunks.at(-1)?.subscriptionId as string,
      through: chunks.at(-1)?.sequence as number,
    });
  };
  receive(subscribe(SUB_A));
  await vi.advanceTimersByTimeAsync(125);
  acknowledgeSnapshot();
  receive({
    type: "stream.history.get",
    subscriptionId: SUB_A,
    requestId: "CCCCCCCCCCCCCCCCCCCCCC",
    before: 5,
    count: 1,
  });
  expect(read).toHaveBeenCalledTimes(1);
  receive(subscribe(SUB_B));
  await vi.advanceTimersByTimeAsync(125);
  acknowledgeSnapshot();
  receive({
    type: "stream.history.get",
    subscriptionId: SUB_B,
    requestId: "DDDDDDDDDDDDDDDDDDDDDD",
    before: 5,
    count: 1,
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(1);
  settle({ status: "page", from: 4, to: 5, oldestAvailable: 0, lines: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(
    sealed.delivered.some(
      (message) => message.type === "stream.chunk" && message.subscriptionId === SUB_A,
    ),
  ).toBe(false);
});

it("expires a refused bounded transfer while native capture stays quiet", async () => {
  const bounded = connection();
  bounded.value.sendChunk = () => false;
  const lease = coordinator.attach("new", bounded.value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 200);
  await vi.advanceTimersByTimeAsync(125);
  const captures = native.getScreenCalls;
  await vi.advanceTimersByTimeAsync(5_000);
  expect(native.getScreenCalls).toBe(captures);
  expect(bounded.controls).toContainEqual({
    type: "stream.error",
    subscriptionId: SUB_A,
    code: "stalled",
  });
  expect(vi.getTimerCount()).toBe(1);
});

it("does not let an old stop tail shut down a restart from a watched callback", async () => {
  const first = coordinator.attach("same", connection().value);
  subscribe(first);
  const replacement = connection();
  let restarted = false;
  const nativeSetWatched = native.setWatched.bind(native);
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    nativeSetWatched(ids);
    if (ids.length === 0 && !restarted) {
      restarted = true;
      coordinator.start();
      subscribe(coordinator.attach("same", replacement.value), SID, SUB_B);
    }
  });
  coordinator.stop();
  expect(restarted).toBe(true);
  expect(first.viewedSessionId).toBeNull();
  await vi.advanceTimersByTimeAsync(125);
  expect(replacement.chunks.length).toBeGreaterThan(0);
});

it("clears the coordinator wakeup immediately when the last bounded view closes", () => {
  const lease = coordinator.attach("new", connection().value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  expect(vi.getTimerCount()).toBe(2);
  lease.receive({ type: "stream.cancel", subscriptionId: SUB_A }, 100);
  expect(vi.getTimerCount()).toBe(1);
});

it("contains malformed current controls whose schema access throws", () => {
  const bounded = connection();
  const lease = coordinator.attach("new", bounded.value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  const hostile = new Proxy(
    {},
    {
      get: () => {
        throw new Error("private payload");
      },
    },
  ) as StreamMessage;
  expect(() => lease.receive(hostile, 100)).not.toThrow();
  expect(bounded.controls).toEqual([
    { type: "stream.error", subscriptionId: SUB_A, code: "invalid-transfer" },
  ]);
});

it("copies connection callbacks at attachment instead of following later mutation", async () => {
  const attached = connection();
  const lease = coordinator.attach("new", attached.value);
  attached.value.sendChunk = () => false;
  subscribe(lease);
  await vi.advanceTimersByTimeAsync(125);
  expect(attached.chunks.length).toBeGreaterThan(0);
});

it("binds a subscribe to its validated SID despite a later hostile getter", async () => {
  const bounded = connection();
  const lease = coordinator.attach("new", bounded.value);
  let reads = 0;
  const subscribe = {
    type: "stream.subscribe",
    subscriptionId: SUB_A,
    get sessionId() {
      reads++;
      if (reads === 1) return SID;
      throw new Error("private payload");
    },
  } as StreamMessage;
  expect(() => lease.receive(subscribe, 100)).not.toThrow();
  await vi.advanceTimersByTimeAsync(125);
  expect(bounded.chunks.some((chunk) => chunk.sessionId === SID)).toBe(true);
});

it("does not overwrite a reentrant attachment replacing the same connection ID", async () => {
  native.addSession("U", { lines: ["inner"] });
  const old = coordinator.attach("same", connection().value);
  subscribe(old);
  const inner = connection();
  const outer = connection();
  let innerLease!: ReturnType<ServiceViewCoordinator["attach"]>;
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      innerLease = coordinator.attach("same", inner.value);
      subscribe(innerLease, "iterm2:U", SUB_B);
    }
  });
  const obsolete = coordinator.attach("same", outer.value);
  subscribe(obsolete, SID, SUB_C);
  expect(obsolete.viewedSessionId).toBeNull();
  expect(innerLease.viewedSessionId).toBe("iterm2:U");
  expect(native.watched.at(-1)).toEqual(["U"]);
});

it("releases in-progress attachment tokens when a callback getter throws", () => {
  const base = connection().value;
  for (let i = 0; i < MAX_PAIRINGS * 2; i++) {
    const hostile = {
      ...base,
      get sendChunk() {
        throw new Error("private callback getter");
      },
    } as unknown as ServiceViewConnection;
    expect(() => coordinator.attach(`failed-${i}`, hostile)).toThrow("private callback getter");
  }
  const internal = coordinator as unknown as { attachTokens: Map<string, object> };
  expect(internal.attachTokens.size).toBe(0);
});

it("does not recreate an old view after cleanup stops and restarts the service", () => {
  native.addSession("U", { lines: ["replacement"] });
  const old = coordinator.attach("same", connection().value);
  subscribe(old);
  let newLease!: ReturnType<ServiceViewCoordinator["attach"]>;
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      coordinator.stop();
      coordinator.start();
      newLease = coordinator.attach("same", connection().value);
      subscribe(newLease, "iterm2:U", SUB_B);
    }
  });
  subscribe(old, "iterm2:T", SUB_C);
  expect(old.viewedSessionId).toBeNull();
  expect(newLease.viewedSessionId).toBe("iterm2:U");
  expect(native.watched.at(-1)).toEqual(["U"]);
});

it("does not install an outer bounded subscription after cleanup creates a newer one", async () => {
  native.addSession("T", { lines: ["outer"] });
  native.addSession("U", { lines: ["inner"] });
  const bounded = connection();
  const lease = coordinator.attach("same", bounded.value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      lease.receive(
        { type: "stream.subscribe", subscriptionId: SUB_B, sessionId: "iterm2:U" },
        100,
      );
    }
  });
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_C, sessionId: "iterm2:T" }, 100);
  expect(native.watched.at(-1)).toEqual(["U"]);
  await vi.advanceTimersByTimeAsync(125);
  expect(bounded.chunks.map((chunk) => chunk.subscriptionId)).toEqual([SUB_B]);
});

it("does not create a bounded view across close and restart during its cleanup", async () => {
  native.addSession("U", { lines: ["new"] });
  const old = coordinator.attach("same", connection().value);
  old.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  const replacement = connection();
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      old.close();
      coordinator.stop();
      coordinator.start();
      coordinator.attach("same", replacement.value).receive(
        {
          type: "stream.subscribe",
          subscriptionId: SUB_B,
          sessionId: "iterm2:U",
        },
        100,
      );
    }
  });
  old.receive({ type: "stream.subscribe", subscriptionId: SUB_C, sessionId: SID }, 100);
  expect(native.watched.at(-1)).toEqual(["U"]);
  await vi.advanceTimersByTimeAsync(125);
  expect(replacement.chunks.map((chunk) => chunk.subscriptionId)).toEqual([SUB_B]);
});

it("does not terminate replacement B when stale A control getter reenters then throws", async () => {
  const bounded = connection();
  const lease = coordinator.attach("same", bounded.value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  let reads = 0;
  const stale = {
    type: "stream.ack",
    get subscriptionId() {
      reads++;
      if (reads === 1) return SUB_A;
      lease.receive({ type: "stream.subscribe", subscriptionId: SUB_B, sessionId: SID }, 100);
      throw new Error("private stale getter");
    },
    through: 1,
  } as StreamMessage;
  expect(() => lease.receive(stale, 100)).not.toThrow();
  expect(bounded.controls).not.toContainEqual({
    type: "stream.error",
    subscriptionId: SUB_B,
    code: "invalid-transfer",
  });
  await vi.advanceTimersByTimeAsync(125);
  expect(bounded.chunks.some((chunk) => chunk.subscriptionId === SUB_B)).toBe(true);
});

it("does not dispatch an outer subscribe whose schema getter reenters a replacement", async () => {
  const bounded = connection();
  const lease = coordinator.attach("same", bounded.value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  let reentered = false;
  const outer = {
    type: "stream.subscribe",
    get subscriptionId() {
      if (!reentered) {
        reentered = true;
        lease.receive({ type: "stream.subscribe", subscriptionId: SUB_B, sessionId: SID }, 100);
      }
      return SUB_C;
    },
    sessionId: SID,
  } as StreamMessage;
  lease.receive(outer, 100);
  await vi.advanceTimersByTimeAsync(125);
  expect(bounded.chunks.map((chunk) => chunk.subscriptionId)).toEqual([SUB_B]);
  expect(bounded.controls).not.toContainEqual({
    type: "stream.error",
    subscriptionId: SUB_B,
    code: "invalid-transfer",
  });
});

it.each([SUB_A, SUB_C])(
  "ignores stale or unrelated %s ACK during A-to-B cleanup without invalidating B",
  async (subscriptionId) => {
    const bounded = connection();
    const lease = coordinator.attach("same", bounded.value);
    lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
    const original = native.setWatched.bind(native);
    let delivered = false;
    vi.spyOn(native, "setWatched").mockImplementation((ids) => {
      original(ids);
      if (!delivered && ids.length === 0) {
        delivered = true;
        lease.receive({ type: "stream.ack", subscriptionId, through: 1 }, 100);
      }
    });
    lease.receive({ type: "stream.subscribe", subscriptionId: SUB_B, sessionId: SID }, 100);
    expect(delivered).toBe(true);
    expect(native.watched.at(-1)).toEqual(["S"]);
    await vi.advanceTimersByTimeAsync(125);
    expect(bounded.chunks.map((chunk) => chunk.subscriptionId)).toEqual([SUB_B]);
  },
);

it("keeps no-view controls inert and same-active subscribe idempotent", async () => {
  const bounded = connection();
  const lease = coordinator.attach("same", bounded.value);
  lease.receive({ type: "stream.ack", subscriptionId: SUB_A, through: 1 }, 100);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  await vi.advanceTimersByTimeAsync(125);
  const firstSequence = bounded.chunks.at(-1)?.sequence;
  const captures = native.getScreenCalls;
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  await vi.advanceTimersByTimeAsync(125);
  expect(native.getScreenCalls).toBe(captures);
  expect(bounded.chunks.at(-1)?.sequence).toBe(firstSequence);
  expect(bounded.controls).toEqual([]);
});

it("fairly drains a shared encoded-byte socket between bounded viewers with partial-transfer and immediate completed-screen ACKs", async () => {
  for (let i = 0; i < 5; i++) native.appendLine("S", `past-${i}`);
  type Owner = "first" | "second";
  type Buffered = { owner: Owner; chunk: StreamChunk; bytes: number };
  const socket: { bytes: number; max: number; admitted: number; queue: Buffered[] } = {
    bytes: 0,
    max: 0,
    admitted: 0,
    queue: [],
  };
  let capacity = 1000;
  const admittedAtBytes: number[] = [];
  const admit = (owner: Owner, chunk: StreamChunk) => {
    const bytes = frameBytes(chunk);
    expect(bytes).toBeLessThanOrEqual(500);
    if (socket.bytes !== 0 || socket.bytes + bytes > capacity) return false;
    admittedAtBytes.push(socket.bytes);
    socket.bytes += bytes;
    socket.max = Math.max(socket.max, socket.bytes);
    socket.admitted++;
    socket.queue.push({ owner, chunk, bytes });
    return true;
  };
  const viewer = (owner: Owner, subscriptionId: string) => {
    const wire = admittedConnection((chunk) => admit(owner, chunk));
    const lease = coordinator.attach(owner, wire.value);
    const request: StreamMessage = { type: "stream.subscribe", subscriptionId, sessionId: SID };
    lease.receive(request, frameBytes(request));
    const state = {
      wire,
      lease,
      subscriptionId,
      displayed: undefined as InnerMessageOf<"screen.snapshot"> | undefined,
      receivedSinceAck: 0,
      firstPendingAt: 0,
      completedScreen: false,
      chunks: 0,
      generatedAcks: [] as number[],
      generatedAt: [] as number[],
      forwardedAcks: 0,
      receiver: null as unknown as StreamReceiver,
    };
    state.receiver = new StreamReceiver({
      subscriptionId,
      sessionId: SID,
      now: () => Date.now(),
      accept: (meta, bytes) => {
        const result = applyStreamScreen(state.displayed, decodeStreamScreen(meta, bytes));
        expect(result.ok).toBe(true);
        if (result.ok) state.displayed = result.screen as InnerMessageOf<"screen.snapshot">;
        state.completedScreen = true;
      },
      acknowledge: (through) => {
        expect(
          state.completedScreen ||
            state.receivedSinceAck === STREAM_LIMITS.unacked ||
            Date.now() - state.firstPendingAt >= STREAM_LIMITS.ackDelayMs,
        ).toBe(true);
        state.generatedAcks.push(through);
        state.generatedAt.push(Date.now());
        state.receivedSinceAck = 0;
        state.completedScreen = false;
        return true;
      },
    });
    return state;
  };
  const viewers = { first: viewer("first", SUB_A), second: viewer("second", SUB_B) };
  /** Delivers queued frames; `release` false keeps their bytes resident on the socket. */
  const drain = (release = true) => {
    const frames = socket.queue.splice(0);
    if (release) socket.bytes = 0;
    for (const { owner, chunk, bytes } of frames) {
      const state = viewers[owner];
      expect(state.wire.delivered.shift()).toBe(chunk);
      if (state.receivedSinceAck === 0) state.firstPendingAt = Date.now();
      state.receivedSinceAck++;
      expect(state.receiver.receive(chunk, bytes)).toBe("accepted");
      state.chunks++;
    }
    for (const state of Object.values(viewers)) {
      state.receiver.tick();
      for (const through of state.generatedAcks.splice(0)) {
        const ack: StreamMessage = {
          type: "stream.ack",
          subscriptionId: state.subscriptionId,
          through,
        };
        state.lease.receive(ack, frameBytes(ack));
        state.forwardedAcks++;
      }
    }
  };
  await vi.advanceTimersByTimeAsync(125);
  for (let retry = 0; retry < 8 && socket.bytes === 0; retry++)
    await vi.advanceTimersByTimeAsync(25);
  expect(socket.bytes).toBeGreaterThan(0);
  // Keep the already admitted frame resident until an explicit drain.
  capacity = socket.bytes;
  for (let i = 0; i < 2; i++) {
    native.appendLine("S", `busy-${i}`);
    await vi.advanceTimersByTimeAsync(125);
  }
  expect(socket.admitted).toBe(1);
  drain();
  capacity = 1000;
  let manuallyCharged = 0;
  for (let i = 2; i < 16; i++) {
    native.appendLine("S", `busy-${i}`);
    await vi.advanceTimersByTimeAsync(125);
    drain(false);
    socket.bytes = 0;
    const before = socket.admitted;
    const charged = coordinator.pump();
    expect(charged).toBe(socket.admitted - before);
    manuallyCharged += charged;
  }
  const captures = native.getScreenCalls;
  for (
    let retry = 0;
    retry < 80 && (viewers.first.chunks < 2 || viewers.second.chunks < 2);
    retry++
  ) {
    await vi.advanceTimersByTimeAsync(25);
    drain();
  }
  expect(native.getScreenCalls).toBe(captures);
  expect(socket.max).toBeLessThanOrEqual(capacity);
  expect(admittedAtBytes).toHaveLength(socket.admitted);
  expect(admittedAtBytes.every((bytes) => bytes === 0)).toBe(true);
  expect(manuallyCharged).toBeGreaterThan(0);
  for (const state of Object.values(viewers)) {
    expect(state.chunks).toBeGreaterThanOrEqual(2);
    expect(state.generatedAt.length).toBeGreaterThan(0);
    expect(state.forwardedAcks).toBe(state.generatedAt.length);
    expect(state.displayed?.lines.length).toBe(3);
  }
});

it("streams a vt subscription's seed and output when the backend streams its own bytes", async () => {
  const source = Object.assign(new EventEmitter(), {
    start: vi.fn(async () => {}),
    reseed: vi.fn(async () => {}),
    close: vi.fn(),
  });
  native.capabilities = { ...native.capabilities, vtStream: true };
  native.openVtStream = vi.fn(() => source as unknown as VtSource);
  const conn = connection();
  const lease = coordinator.attach("vt", conn.value);
  lease.receive(
    { type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID, mode: "vt" },
    100,
  );
  expect(native.openVtStream).toHaveBeenCalledWith("S");
  expect(source.start).toHaveBeenCalledOnce();
  expect(lease.viewedSessionId).toBe(SID);

  source.emit("seed", { generation: 1, cols: 80, rows: 24, data: "one" });
  source.emit("bytes", new TextEncoder().encode("!"), 1);
  await vi.advanceTimersByTimeAsync(50);
  expect(conn.chunks.map((chunk) => chunk.meta)).toEqual([
    { kind: "vt-state", generation: 1, cols: 80, rows: 24 },
  ]);
  lease.receive({ type: "stream.ack", subscriptionId: SUB_A, through: 1 }, 100);
  await vi.advanceTimersByTimeAsync(50);
  expect(conn.chunks.at(-1)!.meta).toEqual({ kind: "vt", generation: 1, offset: 0 });

  lease.close();
  expect(source.close).toHaveBeenCalled();
});

it("keeps sending snapshots when a vt subscriber's backend cannot stream bytes", async () => {
  const conn = connection();
  const lease = coordinator.attach("plain", conn.value);
  lease.receive(
    { type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID, mode: "vt" },
    100,
  );
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(conn.chunks[0]?.meta.kind).toBe("snapshot");
});
