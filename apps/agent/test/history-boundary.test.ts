import { type Line, STREAM_LIMITS } from "@shellbell/protocol";
import { describe, expect, it, vi } from "vitest";
import { BackendRegistry } from "../src/backends/registry.js";
import {
  type HistoryReadRequest,
  type HistoryReadResult,
  type Screen,
  SessionGone,
} from "../src/backends/types.js";
import { createLogger } from "../src/log.js";
import { FakeBackend } from "./fakes/fake-backend.js";

type PagedFakeBackend = FakeBackend & {
  getHistoryPage?: (id: string, request: HistoryReadRequest) => Promise<HistoryReadResult>;
};

const log = createLogger({ stdout: false });
const line = (text: string): Line => ({ r: [{ t: text }] });
const request = (overrides: Partial<HistoryReadRequest> = {}): HistoryReadRequest => ({
  capture: Object.freeze({}),
  reported: 10,
  before: 10,
  count: 2,
  signal: new AbortController().signal,
  ...overrides,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const member = new FakeBackend("tmux");
  member.addSession("%1", {});
  const registry = new BackendRegistry(log);
  registry.add(member);
  return { member: member as PagedFakeBackend, registry };
}

describe("BackendRegistry bounded history boundary", () => {
  it("routes a page once with the exact capture and signal identities", async () => {
    const { member, registry } = setup();
    const capture = Object.freeze({ source: "acknowledged" });
    const controller = new AbortController();
    const read = vi.fn(
      async (id: string, received: HistoryReadRequest): Promise<HistoryReadResult> => {
        expect(id).toBe("%1:child");
        expect(received.capture).toBe(capture);
        expect(received.signal).toBe(controller.signal);
        return { status: "page", from: 8, to: 10, oldestAvailable: 0, lines: [line("a")] };
      },
    );
    member.getHistoryPage = read;

    await expect(
      registry.getHistoryPage("tmux:%1:child", request({ capture, signal: controller.signal })),
    ).resolves.toEqual({
      status: "page",
      from: 8,
      to: 10,
      oldestAvailable: 0,
      lines: [line("a")],
    });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("returns every provider result unchanged", async () => {
    const results: HistoryReadResult[] = [
      { status: "page", from: 8, to: 10, oldestAvailable: 1, lines: [line("page")] },
      { status: "boundary", reason: "end", oldestAvailable: 0 },
      { status: "boundary", reason: "truncated", oldestAvailable: 4 },
      { status: "unavailable", reason: "unanchored" },
      { status: "unavailable", reason: "busy" },
      { status: "unavailable", reason: "changed" },
      { status: "unavailable", reason: "fetch-window" },
      { status: "unavailable", reason: "unsupported" },
      { status: "reset" },
      { status: "cancelled" },
    ];
    const { member, registry } = setup();
    let index = 0;
    member.getHistoryPage = async () => results[index++] as HistoryReadResult;

    for (const result of results) {
      await expect(registry.getHistoryPage("tmux:%1", request())).resolves.toBe(result);
    }
  });

  it("preserves a producer screen capture identity", async () => {
    const { member, registry } = setup();
    const capture = Object.freeze({ source: "screen" });
    member.getScreen = async (): Promise<Screen> => ({
      cols: 1,
      rows: 1,
      cursor: { x: 0, y: 0 },
      lines: [line("x")],
      scrollbackTotal: 0,
      historyCapture: capture,
    });

    expect((await registry.getScreen("tmux:%1")).historyCapture).toBe(capture);
  });

  it("forwards requested screen options but keeps a legacy screen call unary", async () => {
    const { member, registry } = setup();
    const getScreen = vi.spyOn(member, "getScreen");
    await registry.getScreen("tmux:%1");
    expect(getScreen).toHaveBeenLastCalledWith("%1");
    const options = { history: true } as const;
    await registry.getScreen("tmux:%1", options);
    expect(getScreen).toHaveBeenLastCalledWith("%1", options);
  });

  it("does not use legacy history when explicit paging is unsupported", async () => {
    const { member, registry } = setup();
    const legacy = vi.spyOn(member, "getHistory");

    await expect(registry.getHistoryPage("tmux:%1", request())).resolves.toEqual({
      status: "unavailable",
      reason: "unsupported",
    });
    expect(legacy).not.toHaveBeenCalled();
  });

  it("rejects invalid requests before provider work", async () => {
    const { member, registry } = setup();
    const read = vi.fn(async (): Promise<HistoryReadResult> => ({ status: "reset" }));
    member.getHistoryPage = read;
    const invalid = [
      request({ reported: -1 }),
      request({ reported: 1.5 }),
      request({ reported: Number.NaN }),
      request({ reported: Number.MAX_SAFE_INTEGER + 1 }),
      request({ before: -1 }),
      request({ before: 1.5 }),
      request({ before: Number.NaN }),
      request({ before: Number.MAX_SAFE_INTEGER + 1 }),
      request({ before: 11 }),
      request({ count: 0 }),
      request({ count: -1 }),
      request({ count: 1.5 }),
      request({ count: Number.NaN }),
      request({ count: Number.MAX_SAFE_INTEGER + 1 }),
      request({ count: STREAM_LIMITS.historyLines + 1 }),
      request({ capture: null as unknown as object }),
      request({ capture: undefined as unknown as object }),
    ];

    for (const bad of invalid) {
      await expect(registry.getHistoryPage("tmux:%1", bad)).rejects.toBeInstanceOf(RangeError);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("accepts the maximum page count", async () => {
    const { member, registry } = setup();
    const read = vi.fn(async (): Promise<HistoryReadResult> => ({ status: "reset" }));
    member.getHistoryPage = read;

    await expect(
      registry.getHistoryPage("tmux:%1", request({ count: STREAM_LIMITS.historyLines })),
    ).resolves.toEqual({ status: "reset" });
    expect(read).toHaveBeenCalledOnce();
  });

  it("rejects unknown prefixes and missing members asynchronously", async () => {
    const { registry } = setup();
    const unknown = registry.getHistoryPage("kitty:1", request());
    const missing = new BackendRegistry(log).getHistoryPage("tmux:%1", request());

    await expect(unknown).rejects.toBeInstanceOf(SessionGone);
    await expect(missing).rejects.toBeInstanceOf(SessionGone);
  });

  it("does no provider work for a pre-aborted request", async () => {
    const { member, registry } = setup();
    const read = vi.fn(async (): Promise<HistoryReadResult> => ({ status: "reset" }));
    member.getHistoryPage = read;
    const controller = new AbortController();
    controller.abort();

    await expect(
      registry.getHistoryPage("tmux:%1", request({ signal: controller.signal })),
    ).resolves.toEqual({
      status: "cancelled",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["success", "failure"] as const)(
    "returns cancelled after an in-flight %s",
    async (outcome) => {
      const { member, registry } = setup();
      const gate = deferred<HistoryReadResult>();
      member.getHistoryPage = async () => gate.promise;
      const controller = new AbortController();
      const pending = registry.getHistoryPage("tmux:%1", request({ signal: controller.signal }));
      controller.abort();
      if (outcome === "success") gate.resolve({ status: "reset" });
      else gate.reject(new Error("provider failed"));

      await expect(pending).resolves.toEqual({ status: "cancelled" });
    },
  );

  it.each(["remove", "replace", "readd"] as const)(
    "returns reset when membership is changed by %s during a successful read",
    async (change) => {
      const { member, registry } = setup();
      const gate = deferred<HistoryReadResult>();
      member.getHistoryPage = async () => gate.promise;
      const pending = registry.getHistoryPage("tmux:%1", request());
      if (change === "remove") registry.remove("tmux");
      if (change === "replace") registry.add(new FakeBackend("tmux"));
      if (change === "readd") {
        registry.remove("tmux");
        registry.add(member);
      }
      gate.resolve({
        status: "page",
        from: 8,
        to: 10,
        oldestAvailable: 0,
        lines: [line("provider page 1"), line("provider page 2")],
      });

      await expect(pending).resolves.toEqual({ status: "reset" });
    },
  );

  it.each(["remove", "replace", "readd"] as const)(
    "returns reset when membership is changed by %s during a failed read",
    async (change) => {
      const { member, registry } = setup();
      const gate = deferred<HistoryReadResult>();
      member.getHistoryPage = async () => gate.promise;
      const pending = registry.getHistoryPage("tmux:%1", request());
      if (change === "remove") registry.remove("tmux");
      if (change === "replace") registry.add(new FakeBackend("tmux"));
      if (change === "readd") {
        registry.remove("tmux");
        registry.add(member);
      }
      gate.reject(new Error("provider failed"));

      await expect(pending).resolves.toEqual({ status: "reset" });
    },
  );

  it("preserves a provider error while membership is unchanged", async () => {
    const { member, registry } = setup();
    member.getHistoryPage = async () => {
      throw new Error("provider failed");
    };

    await expect(registry.getHistoryPage("tmux:%1", request())).rejects.toThrow("provider failed");
  });

  it("lets cancellation win over membership replacement after settlement", async () => {
    const { member, registry } = setup();
    const gate = deferred<HistoryReadResult>();
    member.getHistoryPage = async () => gate.promise;
    const controller = new AbortController();
    const pending = registry.getHistoryPage("tmux:%1", request({ signal: controller.signal }));
    gate.resolve({ status: "page", from: 8, to: 10, oldestAvailable: 0, lines: [line("a")] });
    registry.add(new FakeBackend("tmux"));
    controller.abort();

    await expect(pending).resolves.toEqual({ status: "cancelled" });
  });

  it("keeps legacy history routing intact", async () => {
    const { member, registry } = setup();
    member.appendLine("%1", "next");

    await expect(registry.getHistory("tmux:%1", 1, 1)).resolves.toEqual({
      lines: [line("")],
      oldestAvailable: 0,
    });
  });
});
