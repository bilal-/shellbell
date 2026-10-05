import { type InnerMessageOf, MAX_PAIRINGS, type StreamChunk } from "@shellbell/protocol";
import { expect, it, vi } from "vitest";
import { AgentScreenStream } from "../src/agent-screen-stream.js";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  type HistoryReadRequest,
  type HistoryReadResult,
  SessionGone,
} from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function request(signal = new AbortController().signal): HistoryReadRequest {
  return { capture: Object.freeze({}), reported: 10, before: 10, count: 2, signal };
}

it("keeps one native call admitted for a session until physical settlement after caller abort", async () => {
  const gate = deferred<HistoryReadResult>();
  const read = vi.fn((_id: string, _request: HistoryReadRequest) => gate.promise);
  const member = Object.assign(new FakeBackend("tmux"), { getHistoryPage: read });
  const registry = new BackendRegistry(createLogger({ stdout: false }));
  registry.add(member);
  const controller = new AbortController();
  const first = registry.getHistoryPage("tmux:%1", request(controller.signal));
  const pending = [first];

  try {
    controller.abort();
    const second = registry.getHistoryPage("tmux:%1", request());
    pending.push(second);
    expect(read).toHaveBeenCalledTimes(1);
    await expect(second).resolves.toEqual({ status: "unavailable", reason: "busy" });
  } finally {
    gate.resolve({ status: "reset" });
    await Promise.allSettled(pending);
  }
});

it("bounds unsettled calls across backend prefixes and frees exactly one slot on settlement", async () => {
  const gates = Array.from({ length: MAX_PAIRINGS + 2 }, () => deferred<HistoryReadResult>());
  let nextGate = 0;
  const tmuxRead = vi.fn((_id: string, _request: HistoryReadRequest) => gates[nextGate++]!.promise);
  const herdrRead = vi.fn(
    (_id: string, _request: HistoryReadRequest) => gates[nextGate++]!.promise,
  );
  const registry = new BackendRegistry(createLogger({ stdout: false }));
  registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: tmuxRead }));
  registry.add(Object.assign(new FakeBackend("herdr"), { getHistoryPage: herdrRead }));
  const pending: Promise<HistoryReadResult>[] = [];

  try {
    for (let i = 0; i < MAX_PAIRINGS - 1; i++) {
      pending.push(registry.getHistoryPage(`tmux:${i}`, request()));
    }
    // The same native name under a different backend prefix has a separate permit.
    pending.push(registry.getHistoryPage("herdr:0", request()));
    expect(tmuxRead).toHaveBeenCalledTimes(MAX_PAIRINGS - 1);
    expect(herdrRead).toHaveBeenCalledTimes(1);
    await expect(registry.getHistoryPage("tmux:overflow", request())).resolves.toEqual({
      status: "unavailable",
      reason: "busy",
    });
    expect(tmuxRead).toHaveBeenCalledTimes(MAX_PAIRINGS - 1);

    gates[0]!.resolve({ status: "reset" });
    await pending[0];
    pending.push(registry.getHistoryPage("tmux:replacement", request()));
    expect(tmuxRead).toHaveBeenCalledTimes(MAX_PAIRINGS);
    await expect(registry.getHistoryPage("tmux:overflow", request())).resolves.toEqual({
      status: "unavailable",
      reason: "busy",
    });
    expect(tmuxRead).toHaveBeenCalledTimes(MAX_PAIRINGS);

    gates[MAX_PAIRINGS - 1]!.reject(new Error("native failure"));
    await expect(pending[MAX_PAIRINGS - 1]).rejects.toThrow("native failure");
    pending.push(registry.getHistoryPage("herdr:replacement", request()));
    expect(herdrRead).toHaveBeenCalledTimes(2);
    await expect(registry.getHistoryPage("tmux:overflow", request())).resolves.toEqual({
      status: "unavailable",
      reason: "busy",
    });
  } finally {
    for (const gate of gates) gate.resolve({ status: "reset" });
    await Promise.allSettled(pending);
  }
});

it.each(["remove", "replace", "readd", "close"] as const)(
  "keeps a retired %s call occupied until the old provider settles",
  async (change) => {
    const gate = deferred<HistoryReadResult>();
    const oldRead = vi.fn((_id: string, _request: HistoryReadRequest) => gate.promise);
    const nextRead = vi.fn(async (): Promise<HistoryReadResult> => ({ status: "reset" }));
    const registry = new BackendRegistry(createLogger({ stdout: false }));
    registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: oldRead }));
    const first = registry.getHistoryPage("tmux:%1", request());

    try {
      if (change === "remove" || change === "readd") registry.remove("tmux");
      if (change === "close") await registry.close();
      if (change !== "remove") {
        registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: nextRead }));
      }
      if (change === "remove") {
        await expect(registry.getHistoryPage("tmux:%1", request())).rejects.toBeInstanceOf(
          SessionGone,
        );
        registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: nextRead }));
      }
      await expect(registry.getHistoryPage("tmux:%1", request())).resolves.toEqual({
        status: "unavailable",
        reason: "busy",
      });
      expect(nextRead).not.toHaveBeenCalled();
    } finally {
      gate.resolve({ status: "reset" });
      await Promise.allSettled([first]);
    }

    await expect(registry.getHistoryPage("tmux:%1", request())).resolves.toEqual({
      status: "reset",
    });
    expect(nextRead).toHaveBeenCalledTimes(1);
  },
);

it("releases permits after synchronous throw and rejected provider promises", async () => {
  const registry = new BackendRegistry(createLogger({ stdout: false }));
  const read = vi
    .fn<(_: string, __: HistoryReadRequest) => Promise<HistoryReadResult>>()
    .mockImplementationOnce(() => {
      throw new Error("sync");
    })
    .mockRejectedValueOnce(new Error("async"))
    .mockResolvedValue({ status: "reset" });
  registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: read }));
  await expect(registry.getHistoryPage("tmux:%1", request())).rejects.toThrow("sync");
  await expect(registry.getHistoryPage("tmux:%1", request())).rejects.toThrow("async");
  await expect(registry.getHistoryPage("tmux:%1", request())).resolves.toEqual({ status: "reset" });
  expect(read).toHaveBeenCalledTimes(3);
});

it("preserves preflight precedence while another session holds the aggregate cap", async () => {
  const gates = Array.from({ length: MAX_PAIRINGS }, () => deferred<HistoryReadResult>());
  const read = vi.fn((id: string) => gates[Number(id)]!.promise);
  const registry = new BackendRegistry(createLogger({ stdout: false }));
  registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: read }));
  const pending = gates.map((_gate, i) => registry.getHistoryPage(`tmux:${i}`, request()));

  try {
    await expect(registry.getHistoryPage("bad:1", request())).rejects.toBeInstanceOf(SessionGone);
    await expect(
      registry.getHistoryPage("tmux:new", { ...request(), count: -1 }),
    ).rejects.toBeInstanceOf(RangeError);
    const aborted = new AbortController();
    aborted.abort();
    await expect(registry.getHistoryPage("tmux:new", request(aborted.signal))).resolves.toEqual({
      status: "cancelled",
    });
    registry.add(new FakeBackend("herdr"));
    await expect(registry.getHistoryPage("herdr:new", request())).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported",
    });
    expect(read).toHaveBeenCalledTimes(MAX_PAIRINGS);
  } finally {
    for (const gate of gates) gate.resolve({ status: "reset" });
    await Promise.allSettled(pending);
  }
});

it("lets a replacement screen stream continue live while retired history occupies its session", async () => {
  const gate = deferred<HistoryReadResult>();
  const page: HistoryReadResult = {
    status: "page",
    from: 8,
    to: 10,
    oldestAvailable: 0,
    lines: [{ r: [{ t: "old-1" }] }, { r: [{ t: "old-2" }] }],
  };
  const read = vi
    .fn<(_: string, __: HistoryReadRequest) => Promise<HistoryReadResult>>()
    .mockImplementationOnce(() => gate.promise)
    .mockResolvedValue(page);
  const registry = new BackendRegistry(createLogger({ stdout: false }));
  registry.add(Object.assign(new FakeBackend("tmux"), { getHistoryPage: read }));
  const capture = Object.freeze({ anchor: "screen" });
  const retiredReadDone = deferred<void>();

  function owner(subscriptionId: string) {
    const chunks: StreamChunk[] = [];
    const controls: unknown[] = [];
    const stream = new AgentScreenStream({
      subscriptionId,
      sessionId: "tmux:%1",
      now: () => 0,
      newTransferId: () => "B".repeat(22),
      sendChunk: (chunk) => {
        chunks.push(chunk);
        return true;
      },
      sendControl: (message) => {
        controls.push(message);
        return true;
      },
      requestSnapshot: () => {},
      onClosed: () => {},
      history: {
        read: (id, request) => {
          const pending = registry.getHistoryPage(id, request);
          if (subscriptionId === firstId) pending.finally(() => retiredReadDone.resolve());
          return pending;
        },
        onReady: () => {},
      },
    });
    const snapshot = (gen: number): InnerMessageOf<"screen.snapshot"> => ({
      type: "screen.snapshot",
      sessionId: "tmux:%1",
      gen,
      scrollbackTotal: 10,
      cols: 3,
      rows: 3,
      cursor: { x: 0, y: 2 },
      lines: Array.from({ length: 3 }, () => ({ r: [{ t: "new" }] })),
    });
    expect(
      stream.offer(snapshot(1), {
        generation: 1,
        reported: 10,
        historyRequested: true,
        capture,
      }),
    ).toBe(true);
    expect(stream.sendOne()).toBe(true);
    stream.receive({ type: "stream.ack", subscriptionId, through: 1 }, 128);
    return { stream, chunks, controls, snapshot };
  }

  const firstId = "A".repeat(22);
  const secondId = "F".repeat(22);
  const first = owner(firstId);
  const second = owner(secondId);
  try {
    first.stream.receive(
      {
        type: "stream.history.get",
        subscriptionId: firstId,
        requestId: "C".repeat(22),
        before: 10,
        count: 2,
      },
      128,
    );
    expect(read).toHaveBeenCalledTimes(1);
    first.stream.cancel();
    second.stream.receive(
      {
        type: "stream.history.get",
        subscriptionId: secondId,
        requestId: "D".repeat(22),
        before: 10,
        count: 2,
      },
      128,
    );
    await vi.waitFor(() =>
      expect(second.controls).toMatchObject([
        { type: "stream.error", requestId: "D".repeat(22), code: "history-unavailable" },
      ]),
    );
    expect(read).toHaveBeenCalledTimes(1);

    second.stream.receive({ type: "stream.refresh", subscriptionId: secondId }, 128);
    expect(
      second.stream.offer(second.snapshot(2), {
        generation: 2,
        reported: 10,
        historyRequested: false,
      }),
    ).toBe(true);
    expect(second.stream.sendOne()).toBe(true);
    expect(second.chunks[1]?.meta.kind).toBe("snapshot");
    second.stream.receive({ type: "stream.ack", subscriptionId: secondId, through: 2 }, 128);

    gate.resolve(page);
    await retiredReadDone.promise;
    second.stream.receive(
      {
        type: "stream.history.get",
        subscriptionId: secondId,
        requestId: "E".repeat(22),
        before: 10,
        count: 2,
      },
      128,
    );
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(second.stream.sendOne()).toBe(true));
    expect(second.chunks[2]?.meta.kind).toBe("history");
    expect(first.chunks).toHaveLength(1);
  } finally {
    gate.resolve(page);
    first.stream.cancel();
    second.stream.cancel();
  }
});
