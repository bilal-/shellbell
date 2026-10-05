import { afterEach, expect, it, vi } from "vitest";
import {
  ProviderResponseError,
  readProviderResponse,
} from "../src/notifications/provider-response.js";

const url = "https://provider.example.test/private-device-token";
const init = { headers: { authorization: "Bearer private-token" }, body: "private-payload" };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());

it("bounds fetch that ignores abort and cancels its eventual response", async () => {
  vi.useFakeTimers();
  const started = deferred<void>();
  const response = deferred<Response>();
  const cancelled = deferred<void>();
  let signal: AbortSignal | undefined;
  const result = readProviderResponse(
    url,
    init,
    async (_url, options) => {
      signal = options?.signal ?? undefined;
      started.resolve();
      return response.promise;
    },
    8,
  ).catch((error: unknown) => error);
  await started.promise;
  await vi.advanceTimersByTimeAsync(5000);
  const error = await result;
  expect(error).toBeInstanceOf(ProviderResponseError);
  expect(error).toMatchObject({ code: "timeout", message: "timeout" });
  expect((error as ProviderResponseError).head).toBeUndefined();
  expect(signal?.aborted).toBe(true);
  response.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled.resolve();
        },
      }),
    ),
  );
  await cancelled.promise;
  expect(vi.getTimerCount()).toBe(0);
});

it("uses one deadline across headers and stalled body, retaining only response head", async () => {
  vi.useFakeTimers();
  const fetchStarted = deferred<void>();
  const response = deferred<Response>();
  const readStarted = deferred<void>();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        readStarted.resolve();
      },
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    },
    { highWaterMark: 0 },
  );
  const result = readProviderResponse(
    url,
    init,
    async () => {
      fetchStarted.resolve();
      return response.promise;
    },
    8,
  ).catch((error: unknown) => error);
  await fetchStarted.promise;
  await vi.advanceTimersByTimeAsync(3000);
  response.resolve(
    new Response(body, {
      status: 429,
      headers: { "retry-after": "120", "private-header": "secret" },
    }),
  );
  await readStarted.promise;
  await vi.advanceTimersByTimeAsync(2000);
  const error = await result;
  expect(error).toBeInstanceOf(ProviderResponseError);
  expect(error).toMatchObject({ code: "timeout", head: { status: 429, retryAfter: "120" } });
  expect(Object.keys((error as ProviderResponseError).head!)).toEqual(["status", "retryAfter"]);
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it.each([
  ["invalid UTF-8", new Uint8Array([0xff]), {}, "invalid-response"],
  ["incomplete UTF-8", new Uint8Array([0xc3]), {}, "invalid-response"],
  [
    "declared oversized body",
    new Uint8Array([65]),
    { "content-length": "9" },
    "response-too-large",
  ],
  ["oversized stream without length", new Uint8Array(9), {}, "response-too-large"],
] as const)(
  "rejects %s without disclosing provider content",
  async (_name, bytes, headers, code) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
    const error = await readProviderResponse(
      url,
      init,
      async () =>
        new Response(body, {
          status: 503,
          headers: { ...headers, "retry-after": "90" },
        }),
      8,
    ).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error).toMatchObject({ code, message: code, head: { status: 503, retryAfter: "90" } });
    expect(body.locked).toBe(false);
  },
);

it("counts bytes while decoding split UTF-8 and enforces POST/manual redirect", async () => {
  let options: RequestInit | undefined;
  let signal: AbortSignal | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xc3]));
      controller.enqueue(new Uint8Array([0xa9]));
      controller.close();
    },
  });
  expect(
    await readProviderResponse(
      url,
      { ...init, method: "GET", redirect: "follow" },
      async (_url, request) => {
        options = request;
        signal = request?.signal ?? undefined;
        return new Response(body);
      },
      2,
    ),
  ).toEqual({ head: { status: 200, retryAfter: null }, text: "é", hasBody: true });
  expect(options?.method).toBe("POST");
  expect(options?.redirect).toBe("manual");
  expect(signal?.aborted).toBe(true);
  expect(body.locked).toBe(false);
});

it("sanitizes thrown fetch and body-read errors", async () => {
  for (const fetcher of [
    async () => {
      throw new Error("private-network-secret");
    },
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error("private-body-secret"));
          },
        }),
        { status: 400 },
      ),
  ]) {
    const error = await readProviderResponse(url, init, fetcher, 8).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ProviderResponseError);
    expect(error).toMatchObject({ code: "network", message: "network" });
    expect(String(error)).not.toContain("private");
  }
});

it("allows the caller to skip a body and cancels it without waiting", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  expect(
    await readProviderResponse(
      url,
      init,
      async () => new Response(body),
      8,
      (head) => head.status !== 200,
    ),
  ).toEqual({ head: { status: 200, retryAfter: null }, text: "", hasBody: true });
  expect(cancelled).toBe(true);
});

it("distinguishes a missing body from an empty body for caller policy", async () => {
  expect(await readProviderResponse(url, init, async () => new Response(null), 8)).toEqual({
    head: { status: 200, retryAfter: null },
    text: "",
    hasBody: false,
  });
  expect(await readProviderResponse(url, init, async () => new Response(""), 8)).toEqual({
    head: { status: 200, retryAfter: null },
    text: "",
    hasBody: true,
  });
});
