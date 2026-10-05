import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { probeRelayHealth } from "../src/doctor-relay.js";

const blockedGlobalFetch = vi.hoisted(() =>
  vi.fn(async () => {
    throw new Error("BLOCKED_GLOBAL_FETCH");
  }),
);
vi.stubGlobal("fetch", blockedGlobalFetch);
afterEach(() => {
  expect(blockedGlobalFetch).not.toHaveBeenCalled();
  blockedGlobalFetch.mockClear();
});
afterAll(() => vi.unstubAllGlobals());

describe("bounded relay health probe", () => {
  it("releases a successful response reader, aborts its signal, and clears its deadline", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("ok"));
          controller.close();
        },
      });
      const response = new Response(body);
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
        signal = options?.signal ?? undefined;
        expect(signal?.aborted).toBe(false);
        return response;
      }) as unknown as typeof fetch;

      expect(await probeRelayHealth("wss://example.test/private", fetchImpl)).toBe(true);
      expect(response.body?.locked).toBe(false);
      expect(signal?.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("targets only sanitized origin healthz and refuses invalid URLs", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok")) as unknown as typeof fetch;
    expect(
      await probeRelayHealth(
        "wss://user:secret@example.test/private?token=sentinel#fragment",
        fetchImpl,
      ),
    ).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://example.test/healthz",
      expect.objectContaining({ redirect: "manual", signal: expect.any(AbortSignal) }),
    );
    expect(await probeRelayHealth("file:///tmp/private", fetchImpl)).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([302, 204, 500])("rejects HTTP %s", async (status) => {
    const fetchImpl = vi.fn(
      async () => new Response(status === 204 ? null : "ok", { status }),
    ) as unknown as typeof fetch;
    expect(await probeRelayHealth("ws://example.test", fetchImpl)).toBe(false);
  });

  it("rejects incorrect and overlong response bodies and cancels streams", async () => {
    let cancelled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(5000));
      },
      cancel() {
        cancelled++;
      },
    });
    const fetchImpl = vi.fn(async () => new Response(stream)) as unknown as typeof fetch;
    expect(await probeRelayHealth("https://example.test", fetchImpl)).toBe(false);
    expect(cancelled).toBe(1);
    expect(
      await probeRelayHealth(
        "https://example.test",
        vi.fn(async () => new Response("not ok")) as unknown as typeof fetch,
      ),
    ).toBe(false);
  });

  it("aborts a hung fetch at five seconds and never leaves a timer", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = vi.fn(
        (_url: string | URL | Request, options?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      ) as unknown as typeof fetch;
      const pending = probeRelayHealth("https://example.test", fetchImpl);
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBe(false);
      expect(aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a stalled response body at the same deadline", async () => {
    vi.useFakeTimers();
    try {
      let cancelled = 0;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled++;
        },
      });
      const fetchImpl = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
      const pending = probeRelayHealth("wss://example.test", fetchImpl);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe(false);
      expect(cancelled).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not wait indefinitely for a response stream that ignores cancellation", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new Uint8Array(5_000));
        },
        cancel() {
          return new Promise<void>(() => {});
        },
      });
      const fetchImpl = vi.fn(async () => new Response(body)) as unknown as typeof fetch;
      const result = Promise.race([
        probeRelayHealth("https://example.test", fetchImpl),
        new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 100)),
      ]);
      await vi.advanceTimersByTimeAsync(100);
      expect(await result).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
