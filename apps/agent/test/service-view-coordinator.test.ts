import {
  applyStreamScreen,
  decodeStreamScreen,
  derivePairKey,
  type Envelope,
  encodeEnvelope,
  fingerprint,
  generateIdentity,
  type InnerMessage,
  type InnerMessageOf,
  MAX_PAIRINGS,
  randomBytes,
  STREAM_LIMITS,
  type StreamChunk,
  type StreamMessage,
  StreamReceiver,
} from "@shellbell/protocol";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AgentScreenStream } from "../src/agent-screen-stream.js";
import { BackendRegistry } from "../src/backends/registry.js";
import { createLogger } from "../src/log.js";
import { PhoneLink } from "../src/phone-link.js";
import {
  type ServiceViewConnection,
  ServiceViewCoordinator,
  type ServiceViewLease,
} from "../src/service-view-coordinator.js";
import { FakeBackend } from "./fakes/fake-backend.js";
import { FakePhone } from "./fakes/fake-phone.js";

const log = createLogger({ stdout: false });
const SID = "iterm2:S";
const SUB_A = "AAAAAAAAAAAAAAAAAAAAAA";
const SUB_B = "BBBBBBBBBBBBBBBBBBBBBB";
const SUB_C = "CCCCCCCCCCCCCCCCCCCCCC";

let native: FakeBackend;
let registry: BackendRegistry;
let coordinator: ServiceViewCoordinator;
let transfer = 0;

function connection(mode: "legacy" | "bounded") {
  const legacy: InnerMessageOf<"screen.snapshot" | "screen.diff" | "history">[] = [];
  const chunks: StreamChunk[] = [];
  const controls: StreamMessage[] = [];
  const value: ServiceViewConnection = {
    mode,
    sendLegacy: (message) => {
      legacy.push(message);
      return true;
    },
    sendChunk: (message) => {
      chunks.push(message);
      return true;
    },
    sendControl: (message) => {
      controls.push(message);
      return true;
    },
  };
  return { value, legacy, chunks, controls };
}

function encryptedConnection(mode: "legacy" | "bounded", admit: (env: Envelope) => boolean) {
  const mac = generateIdentity();
  const mobile = generateIdentity();
  const computerFp = fingerprint(mac.ed25519.pub);
  const phoneFp = fingerprint(mobile.ed25519.pub);
  const code = randomBytes(16);
  const phone = new FakePhone(
    mobile,
    computerFp,
    derivePairKey(mobile.x25519.priv, mac.x25519.pub, code, computerFp, phoneFp),
  );
  const delivered: Envelope[] = [];
  const ordinary: Envelope[] = [];
  const sendBulk = (env: Envelope) => {
    if (!admit(env)) return false;
    delivered.push(env);
    return true;
  };
  const link = new PhoneLink({
    phoneFp,
    connId: mode,
    name: mode,
    kPair: derivePairKey(mac.x25519.priv, mobile.x25519.pub, code, computerFp, phoneFp),
    computerFp,
    send: (env) => {
      ordinary.push(env);
      return true;
    },
    sendBounded: sendBulk,
    sendLegacyBulk: sendBulk,
    log,
  });
  link.handleEnvelope(phone.hello());
  phone.acceptHello(ordinary[0] as Envelope);
  const value: ServiceViewConnection = {
    mode,
    sendLegacy: (message) => link.sendLegacyBulk(message),
    sendChunk: (message) => link.sendBounded(message),
    sendControl: (message) => link.send(message),
  };
  return { value, link, phone, delivered, ordinary };
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
  const first = connection("legacy");
  const replacement = connection("legacy");
  const old = coordinator.attach("same", first.value);
  expect(old.setLegacyView(SID)).toBe(true);
  const current = coordinator.attach("same", replacement.value);
  expect(old.setLegacyView(SID)).toBe(false);
  expect(current.setLegacyView(SID)).toBe(true);
  old.close();
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(first.legacy).toHaveLength(0);
  expect(replacement.legacy.some((message) => message.type === "screen.snapshot")).toBe(true);
});

it("bounds distinct connections and rejects invalid replacements before mutation", async () => {
  const current = connection("legacy");
  const lease = coordinator.attach("owner", current.value);
  expect(() =>
    coordinator.attach("owner", { ...current.value, mode: "wrong" as "legacy" }),
  ).toThrow(TypeError);
  expect(lease.setLegacyView(SID)).toBe(true);
  for (let i = 1; i < MAX_PAIRINGS; i++)
    coordinator.attach(`phone-${i}`, connection("legacy").value);
  expect(() => coordinator.attach("excess", connection("legacy").value)).toThrow(RangeError);
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(current.legacy.length).toBeGreaterThan(0);
});

it.each(["watched cleanup", "connection getter"] as const)(
  "does not exceed the connection cap when a distinct lease attaches during %s",
  async (reentry) => {
    native.addSession("U", { lines: ["newer"] });
    const previous = connection("legacy");
    const old = coordinator.attach("same", previous.value);
    expect(old.setLegacyView(SID)).toBe(true);
    const peers = Array.from({ length: MAX_PAIRINGS - 1 }, (_, i) =>
      coordinator.attach(`peer-${i}`, connection("legacy").value),
    );
    let newer!: ServiceViewLease;
    let reentered = false;
    const attachNewer = () => {
      if (reentered) return;
      reentered = true;
      newer = coordinator.attach("newer", connection("legacy").value);
      expect(newer.setLegacyView("iterm2:U")).toBe(true);
    };
    if (reentry === "watched cleanup") {
      const original = native.setWatched.bind(native);
      vi.spyOn(native, "setWatched").mockImplementation((ids) => {
        original(ids);
        if (ids.length === 0) attachNewer();
      });
    }
    const outer = connection("legacy");
    const outerConnection: ServiceViewConnection =
      reentry === "connection getter"
        ? {
            ...outer.value,
            get sendLegacy() {
              attachNewer();
              return outer.value.sendLegacy;
            },
          }
        : outer.value;
    expect(() => coordinator.attach("same", outerConnection)).toThrow(
      new RangeError("Too many service view connections"),
    );
    expect(reentered).toBe(true);
    expect(old.setLegacyView(SID)).toBe(false);
    expect(newer.forceLegacySnapshot("iterm2:U")).toBe(true);
    expect(peers[0]?.setLegacyView(null)).toBe(true);
    expect(() => coordinator.attach("overflow", connection("legacy").value)).toThrow(RangeError);
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
    expect(previous.legacy).toHaveLength(0);
    expect(outer.legacy).toHaveLength(0);

    newer.close();
    const replacement = connection("legacy");
    const recovered = coordinator.attach("same", replacement.value);
    expect(recovered.setLegacyView(SID)).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(replacement.legacy.some((message) => message.type === "screen.snapshot")).toBe(true);
  },
);

it("keeps bounded mode from using legacy fallback and rejects a changed SID for the same subscription", async () => {
  const bounded = connection("bounded");
  const lease = coordinator.attach("new", bounded.value);
  expect(lease.setLegacyView(SID)).toBe(false);
  await expect(
    lease.requestLegacyHistory({
      type: "history.get",
      reqId: "q",
      sessionId: SID,
      before: 1,
      count: 1,
    }),
  ).resolves.toMatchObject({ ok: false, error: "unsupported" });
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 200);
  await vi.advanceTimersByTimeAsync(150);
  coordinator.pump();
  expect(bounded.chunks.length).toBeGreaterThan(0);
  lease.receive(
    { type: "stream.subscribe", subscriptionId: SUB_A, sessionId: "iterm2:other" },
    200,
  );
  expect(bounded.controls).toContainEqual({
    type: "stream.error",
    subscriptionId: SUB_A,
    code: "invalid-transfer",
  });
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_B, sessionId: SID }, 200);
  expect(bounded.legacy).toHaveLength(0);
});

it("fairly admits sealed legacy screen/history and bounded chunks from one shared budget", async () => {
  for (let i = 0; i < 5; i++) native.appendLine("S", `history-${i}`);
  const nativeScreen = native.getScreen.bind(native);
  vi.spyOn(native, "getScreen").mockImplementation(async (id) => {
    const screen = await nativeScreen(id);
    if (screen.lines[0]?.r[0]) {
      screen.lines[0] = { r: [{ ...screen.lines[0].r[0], fg: [255, 170, 0] }] };
    }
    return screen;
  });
  let socketOpen = true;
  const old = encryptedConnection("legacy", () => socketOpen);
  const newer = encryptedConnection("bounded", () => socketOpen);
  const oldLease = coordinator.attach("old", old.value);
  const newLease = coordinator.attach("new", newer.value);
  oldLease.setLegacyView(SID);
  const subscribe: StreamMessage = {
    type: "stream.subscribe",
    subscriptionId: SUB_A,
    sessionId: SID,
  };
  newLease.receive(subscribe, encodeEnvelope(newer.phone.seal(subscribe)).byteLength);
  const historyAck = oldLease.requestLegacyHistory({
    type: "history.get",
    reqId: "history-1",
    sessionId: SID,
    before: 5,
    count: 2,
  });
  await vi.advanceTimersByTimeAsync(150);
  let screenCount = 0;
  let historyCount = 0;
  const legacyFrameBytes: number[] = [];
  for (const env of old.delivered.splice(0)) {
    legacyFrameBytes.push(encodeEnvelope(env).byteLength);
    const message = old.phone.open(env);
    if (message.type === "history") historyCount++;
    if (message.type === "screen.snapshot" || message.type === "screen.diff") screenCount++;
  }
  expect(screenCount).toBeGreaterThan(0);
  expect(historyCount).toBe(1);
  expect(legacyFrameBytes).toHaveLength(2);
  await expect(historyAck).resolves.toMatchObject({ ok: true });
  let displayed: InnerMessageOf<"screen.snapshot"> | undefined;
  const pendingAcks: number[] = [];
  const boundedFrameBytes: number[] = [];
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
    while (newer.delivered.length > 0) {
      for (const env of newer.delivered.splice(0)) {
        const bytes = encodeEnvelope(env).byteLength;
        boundedFrameBytes.push(bytes);
        const message: InnerMessage = newer.phone.open(env);
        if (message.type === "stream.chunk") {
          expect(receiver.receive(message, bytes)).toBe("accepted");
          const ack: StreamMessage = {
            type: "stream.ack",
            subscriptionId: SUB_A,
            through: message.sequence,
          };
          newLease.receive(ack, encodeEnvelope(newer.phone.seal(ack)).byteLength);
        }
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
  expect(boundedFrameBytes).toHaveLength(2);
  expect(Math.max(...boundedFrameBytes)).toBeLessThanOrEqual(32768);
  socketOpen = false;
  expect(old.link.send({ type: "sessions", list: [] })).toBe(true);
  expect(old.phone.open(old.ordinary.at(-1) as Envelope)).toMatchObject({ type: "sessions" });
});

it("retries quiet prepared screen and history after socket drain without another capture", async () => {
  native.appendLine("S", "past");
  let writable = false;
  const old = encryptedConnection("legacy", () => writable);
  const lease = coordinator.attach("old", old.value);
  lease.setLegacyView(SID);
  const ack = lease.requestLegacyHistory({
    type: "history.get",
    reqId: "quiet",
    sessionId: SID,
    before: 1,
    count: 1,
  });
  await vi.advanceTimersByTimeAsync(125);
  expect(old.delivered).toHaveLength(0);
  const captures = native.getScreenCalls;
  writable = true;
  await vi.advanceTimersByTimeAsync(25);
  expect(native.getScreenCalls).toBe(captures);
  expect(old.delivered.map((env) => old.phone.open(env).type).sort()).toEqual([
    "history",
    "screen.snapshot",
  ]);
  await expect(ack).resolves.toEqual({ type: "ack", reqId: "quiet", ok: true });
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
      const next = coordinator.attach("same", connection("legacy").value);
      expect(next.setLegacyView(sid)).toBe(true);
    },
  });
  coordinator.start();
  const old = coordinator.attach("same", connection("legacy").value);
  old.setLegacyView(SID);
  native.emit({ type: "session-removed", sessionId: "S" });
  expect(observed).toEqual([SID]);
  expect(old.setLegacyView(SID)).toBe(false);
  await vi.advanceTimersByTimeAsync(125);
  expect(native.getScreenCalls).toBeGreaterThan(0);
});

it("keeps history-only work scheduled and cancels its owner on view replacement", async () => {
  let finish!: (value: { lines: { r: { t: string }[] }[]; oldestAvailable: number }) => void;
  const read = new Promise<{ lines: { r: { t: string }[] }[]; oldestAvailable: number }>(
    (resolve) => {
      finish = resolve;
    },
  );
  vi.spyOn(native, "getHistory").mockImplementation(() => read);
  const legacy = connection("legacy");
  const lease = coordinator.attach("old", legacy.value);
  const pending = lease.requestLegacyHistory({
    type: "history.get",
    reqId: "history-only",
    sessionId: SID,
    before: 1,
    count: 1,
  });
  expect(vi.getTimerCount()).toBe(2); // tracker capture interval and one coordinator wakeup
  expect(native.getScreenCalls).toBe(0);
  lease.setLegacyView(SID);
  await expect(pending).resolves.toMatchObject({ ok: false, error: "cancelled" });
  finish({ lines: [{ r: [{ t: "obsolete" }] }], oldestAvailable: 0 });
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(125);
  expect(legacy.legacy.every((message) => message.type !== "history")).toBe(true);
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
  const old = connection("legacy");
  const lease = coordinator.attach("owner", old.value);
  lease.setLegacyView(SID);
  expect(() => coordinator.setIntervalMs(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  await vi.advanceTimersByTimeAsync(125);
  expect(old.legacy).toHaveLength(1);
});

it("retains unsettled native history permits across stop/start and ID reuse", async () => {
  let finish!: (value: { lines: { r: { t: string }[] }[]; oldestAvailable: number }) => void;
  const read = new Promise<{ lines: { r: { t: string }[] }[]; oldestAvailable: number }>(
    (resolve) => {
      finish = resolve;
    },
  );
  const nativeRead = vi.spyOn(native, "getHistory").mockImplementation(() => read);
  const first = coordinator.attach("same", connection("legacy").value);
  const pending = first.requestLegacyHistory({
    type: "history.get",
    reqId: "old",
    sessionId: SID,
    before: 1,
    count: 1,
  });
  coordinator.stop();
  await expect(pending).resolves.toMatchObject({ ok: false, error: "cancelled" });
  coordinator.start();
  const second = coordinator.attach("same", connection("legacy").value);
  const blocked = await second.requestLegacyHistory({
    type: "history.get",
    reqId: "blocked",
    sessionId: SID,
    before: 1,
    count: 1,
  });
  expect(blocked).toMatchObject({ ok: false, error: "busy" });
  expect(nativeRead).toHaveBeenCalledTimes(1);
  finish({ lines: [], oldestAvailable: 0 });
  await vi.advanceTimersByTimeAsync(0);
  const recovered = second.requestLegacyHistory({
    type: "history.get",
    reqId: "recovered",
    sessionId: SID,
    before: 1,
    count: 1,
  });
  expect(nativeRead).toHaveBeenCalledTimes(2);
  second.close();
  await expect(recovered).resolves.toMatchObject({ ok: false, error: "cancelled" });
});

it("closes only the current bounded view on malformed bytes or a vanished session", async () => {
  const bounded = connection("bounded");
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

it("charges an uncertain legacy send and continues serving a healthy lease", async () => {
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
  const bad = connection("legacy");
  bad.value.sendLegacy = () => {
    admitted.push("uncertain");
    throw new Error("private transport error");
  };
  const good = connection("legacy");
  const old = coordinator.attach("bad", bad.value);
  const healthy = coordinator.attach("healthy", good.value);
  old.setLegacyView(SID);
  healthy.setLegacyView(SID);
  await vi.advanceTimersByTimeAsync(125);
  expect(admitted).toEqual(["uncertain"]);
  expect(old.setLegacyView(SID)).toBe(false);
  expect(good.legacy.some((message) => message.type === "screen.snapshot")).toBe(true);
  expect(errors).toEqual(["producer"]);
});

it("keeps a replacement after a reentrant admitted send and refuses old cleanup", async () => {
  const first = connection("legacy");
  const next = connection("legacy");
  let old!: ReturnType<ServiceViewCoordinator["attach"]>;
  let replacement!: ReturnType<ServiceViewCoordinator["attach"]>;
  first.value.sendLegacy = () => {
    replacement = coordinator.attach("same", next.value);
    replacement.setLegacyView(SID);
    old.close();
    return true;
  };
  old = coordinator.attach("same", first.value);
  old.setLegacyView(SID);
  await vi.advanceTimersByTimeAsync(125);
  expect(old.setLegacyView(SID)).toBe(false);
  await vi.advanceTimersByTimeAsync(125);
  expect(next.legacy.some((message) => message.type === "screen.snapshot")).toBe(true);
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
  coordinator.attach("one", connection("legacy").value).setLegacyView(SID);
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
  const sealed = encryptedConnection("bounded", () => true);
  const lease = coordinator.attach("new", sealed.value);
  const subscribe = (subscriptionId: string): StreamMessage => ({
    type: "stream.subscribe",
    subscriptionId,
    sessionId: SID,
  });
  const receive = (message: StreamMessage) =>
    lease.receive(message, encodeEnvelope(sealed.phone.seal(message)).byteLength);
  const acknowledgeSnapshot = () => {
    const chunks = sealed.delivered
      .splice(0)
      .map((env) => sealed.phone.open(env))
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
    sealed.delivered
      .map((env) => sealed.phone.open(env))
      .some((message) => message.type === "stream.chunk" && message.subscriptionId === SUB_A),
  ).toBe(false);
});

it("expires a history-only read without native capture or another event", async () => {
  let settle!: (value: { lines: []; oldestAvailable: number }) => void;
  vi.spyOn(native, "getHistory").mockImplementation(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  const lease = coordinator.attach("old", connection("legacy").value);
  const pending = lease.requestLegacyHistory({
    type: "history.get",
    reqId: "deadline",
    sessionId: SID,
    before: 1,
    count: 1,
  });
  await vi.advanceTimersByTimeAsync(15_000);
  await expect(pending).resolves.toMatchObject({ ok: false, error: "history-unavailable" });
  expect(native.getScreenCalls).toBe(0);
  expect(vi.getTimerCount()).toBe(1); // only the existing tracker interval
  settle({ lines: [], oldestAvailable: 0 });
  await vi.advanceTimersByTimeAsync(0);
});

it("expires a refused bounded transfer while native capture stays quiet", async () => {
  const bounded = connection("bounded");
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
  const first = coordinator.attach("same", connection("legacy").value);
  first.setLegacyView(SID);
  const replacement = connection("legacy");
  let restarted = false;
  const nativeSetWatched = native.setWatched.bind(native);
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    nativeSetWatched(ids);
    if (ids.length === 0 && !restarted) {
      restarted = true;
      coordinator.start();
      coordinator.attach("same", replacement.value).setLegacyView(SID);
    }
  });
  coordinator.stop();
  expect(restarted).toBe(true);
  expect(first.setLegacyView(SID)).toBe(false);
  await vi.advanceTimersByTimeAsync(125);
  expect(replacement.legacy.some((message) => message.type === "screen.snapshot")).toBe(true);
});

it("clears the coordinator wakeup immediately when the last bounded view closes", () => {
  const lease = coordinator.attach("new", connection("bounded").value);
  lease.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  expect(vi.getTimerCount()).toBe(2);
  lease.receive({ type: "stream.cancel", subscriptionId: SUB_A }, 100);
  expect(vi.getTimerCount()).toBe(1);
});

it("contains malformed current controls whose schema access throws", () => {
  const bounded = connection("bounded");
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
  const attached = connection("legacy");
  const lease = coordinator.attach("old", attached.value);
  attached.value.sendLegacy = () => false;
  attached.value.mode = "bounded";
  expect(lease.setLegacyView(SID)).toBe(true);
  await vi.advanceTimersByTimeAsync(125);
  expect(attached.legacy.some((message) => message.type === "screen.snapshot")).toBe(true);
});

it("binds a subscribe to its validated SID despite a later hostile getter", async () => {
  const bounded = connection("bounded");
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

it("does not install an outer legacy view after cleanup reentrantly installs a newer same-lease view", async () => {
  native.addSession("T", { lines: ["outer"] });
  native.addSession("U", { lines: ["inner"] });
  const lease = coordinator.attach("same", connection("legacy").value);
  lease.setLegacyView(SID);
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      expect(lease.setLegacyView("iterm2:U")).toBe(true);
    }
  });
  expect(lease.setLegacyView("iterm2:T")).toBe(false);
  expect(native.watched.at(-1)).toEqual(["U"]);
  await vi.advanceTimersByTimeAsync(125);
  expect(native.getScreenCalls).toBe(1);
});

it("does not overwrite a reentrant attachment replacing the same connection ID", async () => {
  native.addSession("U", { lines: ["inner"] });
  const old = coordinator.attach("same", connection("legacy").value);
  old.setLegacyView(SID);
  const inner = connection("legacy");
  const outer = connection("legacy");
  let innerLease!: ReturnType<ServiceViewCoordinator["attach"]>;
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      innerLease = coordinator.attach("same", inner.value);
      innerLease.setLegacyView("iterm2:U");
    }
  });
  const obsolete = coordinator.attach("same", outer.value);
  expect(obsolete.setLegacyView(SID)).toBe(false);
  expect(innerLease.forceLegacySnapshot("iterm2:U")).toBe(true);
  expect(native.watched.at(-1)).toEqual(["U"]);
});

it("releases in-progress attachment tokens when a callback getter throws", () => {
  const base = connection("legacy").value;
  for (let i = 0; i < MAX_PAIRINGS * 2; i++) {
    const hostile = {
      ...base,
      get sendLegacy() {
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
  const old = coordinator.attach("same", connection("legacy").value);
  old.setLegacyView(SID);
  let newLease!: ReturnType<ServiceViewCoordinator["attach"]>;
  const original = native.setWatched.bind(native);
  let reentered = false;
  vi.spyOn(native, "setWatched").mockImplementation((ids) => {
    original(ids);
    if (!reentered && ids.length === 0) {
      reentered = true;
      coordinator.stop();
      coordinator.start();
      newLease = coordinator.attach("same", connection("legacy").value);
      newLease.setLegacyView("iterm2:U");
    }
  });
  expect(old.setLegacyView("iterm2:T")).toBe(false);
  expect(newLease.forceLegacySnapshot("iterm2:U")).toBe(true);
  expect(native.watched.at(-1)).toEqual(["U"]);
});

it("does not install an outer bounded subscription after cleanup creates a newer one", async () => {
  native.addSession("T", { lines: ["outer"] });
  native.addSession("U", { lines: ["inner"] });
  const bounded = connection("bounded");
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
  const old = coordinator.attach("same", connection("bounded").value);
  old.receive({ type: "stream.subscribe", subscriptionId: SUB_A, sessionId: SID }, 100);
  const replacement = connection("bounded");
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
  const bounded = connection("bounded");
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
  const bounded = connection("bounded");
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
    const bounded = connection("bounded");
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
  const bounded = connection("bounded");
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

it("fairly drains a shared encoded-byte socket with receiver-generated 4/500 ACKs", async () => {
  for (let i = 0; i < 5; i++) native.appendLine("S", `past-${i}`);
  type Buffered = { owner: "old" | "new"; env: Envelope; bytes: number };
  const socket: { bytes: number; max: number; admitted: number; queue: Buffered[] } = {
    bytes: 0,
    max: 0,
    admitted: 0,
    queue: [],
  };
  let capacity = 1000;
  const admittedAtBytes: number[] = [];
  const admit = (owner: Buffered["owner"], env: Envelope) => {
    const bytes = encodeEnvelope(env).byteLength;
    expect(bytes).toBeLessThanOrEqual(500);
    if (socket.bytes !== 0 || socket.bytes + bytes > capacity) return false;
    admittedAtBytes.push(socket.bytes);
    socket.bytes += bytes;
    socket.max = Math.max(socket.max, socket.bytes);
    socket.admitted++;
    socket.queue.push({ owner, env, bytes });
    return true;
  };
  const old = encryptedConnection("legacy", (env) => admit("old", env));
  const newer = encryptedConnection("bounded", (env) => admit("new", env));
  const oldLease = coordinator.attach("old", old.value);
  const newLease = coordinator.attach("new", newer.value);
  oldLease.setLegacyView(SID);
  const subscribe: StreamMessage = {
    type: "stream.subscribe",
    subscriptionId: SUB_A,
    sessionId: SID,
  };
  newLease.receive(subscribe, encodeEnvelope(newer.phone.seal(subscribe)).byteLength);
  let displayed: InnerMessageOf<"screen.snapshot"> | undefined;
  let receivedSinceAck = 0;
  let firstPendingAt = 0;
  const generatedAcks: number[] = [];
  const generatedAt: number[] = [];
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
      expect(
        receivedSinceAck === STREAM_LIMITS.unacked ||
          Date.now() - firstPendingAt >= STREAM_LIMITS.ackDelayMs,
      ).toBe(true);
      generatedAcks.push(through);
      generatedAt.push(Date.now());
      receivedSinceAck = 0;
      return true;
    },
  });
  let oldScreens = 0;
  let oldPages = 0;
  let newChunks = 0;
  let forwardedAcks = 0;
  const drain = () => {
    const frames = socket.queue.splice(0);
    socket.bytes = 0;
    for (const { owner, env, bytes } of frames) {
      if (owner === "old") {
        expect(old.delivered.shift()).toBe(env);
        const message = old.phone.open(env);
        if (message.type === "history") oldPages++;
        if (message.type === "screen.snapshot" || message.type === "screen.diff") oldScreens++;
      } else {
        expect(newer.delivered.shift()).toBe(env);
        const message = newer.phone.open(env);
        if (message.type === "stream.chunk") {
          if (receivedSinceAck === 0) firstPendingAt = Date.now();
          receivedSinceAck++;
          expect(receiver.receive(message, bytes)).toBe("accepted");
          newChunks++;
        }
      }
    }
    receiver.tick();
    for (const through of generatedAcks.splice(0)) {
      const ack: StreamMessage = { type: "stream.ack", subscriptionId: SUB_A, through };
      newLease.receive(ack, encodeEnvelope(newer.phone.seal(ack)).byteLength);
      forwardedAcks++;
    }
  };
  await vi.advanceTimersByTimeAsync(125);
  for (let retry = 0; retry < 8 && socket.bytes === 0; retry++)
    await vi.advanceTimersByTimeAsync(25);
  expect(socket.bytes).toBeGreaterThan(0);
  // Keep the already admitted encrypted frame resident until an explicit drain.
  capacity = socket.bytes;
  const historyAck = oldLease.requestLegacyHistory({
    type: "history.get",
    reqId: "contended",
    sessionId: SID,
    before: 5,
    count: 2,
  });
  let historySettled = false;
  void historyAck.then(() => {
    historySettled = true;
  });
  for (let i = 0; i < 2; i++) {
    native.appendLine("S", `busy-${i}`);
    await vi.advanceTimersByTimeAsync(125);
  }
  expect(historySettled).toBe(false);
  expect(socket.bytes).toBeGreaterThan(0);
  drain();
  capacity = 1000;
  let manuallyCharged = 0;
  for (let i = 2; i < 16; i++) {
    native.appendLine("S", `busy-${i}`);
    await vi.advanceTimersByTimeAsync(125);
    drain();
    const before = socket.admitted;
    const charged = coordinator.pump();
    expect(charged).toBe(socket.admitted - before);
    manuallyCharged += charged;
  }
  const captures = native.getScreenCalls;
  for (let retry = 0; retry < 80 && (oldPages === 0 || newChunks < 2); retry++) {
    await vi.advanceTimersByTimeAsync(25);
    drain();
  }
  expect(native.getScreenCalls).toBe(captures);
  expect(socket.max).toBeLessThanOrEqual(capacity);
  expect(admittedAtBytes).toHaveLength(socket.admitted);
  expect(admittedAtBytes.every((bytes) => bytes === 0)).toBe(true);
  expect(manuallyCharged).toBeGreaterThan(0);
  expect(oldScreens).toBeGreaterThan(1);
  expect(oldPages).toBe(1);
  expect(newChunks).toBeGreaterThanOrEqual(2);
  expect(generatedAt.length).toBeGreaterThan(0);
  expect(forwardedAcks).toBe(generatedAt.length);
  expect(displayed?.lines.length).toBe(3);
  await expect(historyAck).resolves.toMatchObject({ ok: true });
});
