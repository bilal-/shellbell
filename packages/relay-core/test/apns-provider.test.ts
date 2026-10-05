import { afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  type ApnsCredentials,
  buildApnsUrl,
  classifyApnsResponse,
  sendApns,
} from "../src/notifications/apns.js";
import { buildApnsPayload } from "../src/notifications/apns-payload.js";
import type { PushIntent } from "../src/notifications/models.js";

const time = 1_800_000_000_000;
const intent: PushIntent = {
  destination: { provider: "apns", token: "abcdef012345", environment: "development" },
  route: { computerFp: "computer", sessionId: "session", kind: "prompt" },
  genericTitle: "Shellbell",
  genericBody: "Ready",
  group: "group",
  expiresAtSeconds: time / 1000 + 120,
};
let pem: string;
let publicKey: CryptoKey;
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  publicKey = keys.publicKey;
  const label = "PRIVATE KEY";
  pem = `-----BEGIN ${label}-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64")}\n-----END ${label}-----`;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const credentials = (): ApnsCredentials => ({
  teamId: "TEAM123456",
  keyId: "KEY1234567",
  privateKey: pem,
  topic: "dev.shellbell.mobile",
});
const ok = () => new Response(null, { status: 200 });
const response = (status: number, reason: string, headers = {}) =>
  new Response(JSON.stringify({ reason }), { status, headers });
const token = (options?: RequestInit) =>
  new Headers(options?.headers).get("authorization")!.slice(7);

it("rejects an invalid APNs prefix before a later oversized chunk", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0xff]));
      controller.enqueue(new Uint8Array(16384));
      controller.close();
    },
  });
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => new Response(body, { status: 400 }),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "invalid-response" });
});

it("accepts HTTP 200 without waiting for a stalled body and cancels it", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  });
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => new Response(body),
      () => time,
    ),
  ).toEqual({ status: "accepted" });
  expect(cancelled).toBe(true);
});

it.each([
  [429, "http-rate-limit", 120000],
  [503, "http-server", 900000],
] as const)(
  "classifies bodyless APNs HTTP %s using its status",
  async (status, code, retryAfterMs) => {
    expect(
      await sendApns(
        intent,
        credentials(),
        async () =>
          new Response(null, {
            status,
            headers: { "retry-after": "120" },
          }),
        () => time,
      ),
    ).toEqual({ status: "retryable", code, retryAfterMs });
  },
);

it.each([
  [429, "oops", "http-rate-limit", 120000],
  [503, "oops", "http-server", 900000],
  [503, new Uint8Array([0xff]), "invalid-response", 900000],
] as const)(
  "preserves APNs body semantics and retry delay for HTTP %s",
  async (status, body, code, retryAfterMs) => {
    expect(
      await sendApns(
        intent,
        credentials(),
        async () =>
          new Response(body, {
            status,
            headers: { "retry-after": "120" },
          }),
        () => time,
      ),
    ).toEqual({ status: "retryable", code, retryAfterMs });
  },
);

it("retains throttled backoff when reading the APNs body times out", async () => {
  const config = credentials();
  await sendApns(
    intent,
    config,
    async () => ok(),
    () => time,
  );
  vi.useFakeTimers();
  let readStarted!: () => void;
  const ready = new Promise<void>((resolve) => {
    readStarted = resolve;
  });
  const body = new ReadableStream<Uint8Array>(
    {
      pull() {
        readStarted();
      },
    },
    { highWaterMark: 0 },
  );
  const pending = sendApns(
    intent,
    config,
    async () =>
      new Response(body, {
        status: 429,
        headers: { "retry-after": "120" },
      }),
    () => time,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: "retryable", code: "timeout", retryAfterMs: 120000 });
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("shares one token across concurrent sends with the same credentials", async () => {
  const config = credentials();
  const fetcher = vi.fn<typeof fetch>(async () => ok());
  await Promise.all(Array.from({ length: 8 }, () => sendApns(intent, config, fetcher, () => time)));
  expect(new Set(fetcher.mock.calls.map((call) => token(call[1]))).size).toBe(1);
});

it("selects only explicit APNs environments", () => {
  expect(buildApnsUrl("development", "abc")).toBe(
    "https://api.sandbox.push.apple.com/3/device/abc",
  );
  expect(buildApnsUrl("production", "abc")).toBe("https://api.push.apple.com/3/device/abc");
  expect(() => buildApnsUrl(undefined, "abc")).toThrow();
  expect(() => buildApnsUrl("production", "../other")).toThrow();
});
it("signs a verifiable ES256 JWT and sends payload headers/topic to the selected host", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => ok());
  expect(await sendApns(intent, credentials(), fetcher, () => time)).toEqual({
    status: "accepted",
  });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe(buildApnsUrl("development", intent.destination.token));
  expect(options?.redirect).toBe("manual");
  expect(options?.method).toBe("POST");
  const payload = buildApnsPayload(intent);
  const headers = new Headers(options?.headers);
  for (const [name, value] of Object.entries(payload.headers))
    expect(headers.get(name)).toBe(value);
  expect(headers.get("apns-topic")).toBe("dev.shellbell.mobile");
  expect(JSON.parse(String(options?.body))).toEqual(payload.body);
  const jwt = token(options).split(".");
  expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: "KEY1234567",
  });
  expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString())).toEqual({
    iss: "TEAM123456",
    iat: time / 1000,
  });
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      Buffer.from(jwt[2]!, "base64url"),
      new TextEncoder().encode(jwt.slice(0, 2).join(".")),
    ),
  ).toBe(true);
});
it.each([
  [200, undefined, { status: "accepted" }],
  [410, "Unregistered", { status: "unregistered" }],
  [400, "BadDeviceToken", { status: "rejected", code: "invalid-device-token" }],
  [403, "ExpiredProviderToken", { status: "rejected", code: "invalid-credentials" }],
  [403, "InvalidProviderToken", { status: "rejected", code: "invalid-credentials" }],
  [400, "DeviceTokenNotForTopic", { status: "rejected", code: "invalid-credentials" }],
  [413, "PayloadTooLarge", { status: "rejected", code: "invalid-payload" }],
  [429, "TooManyRequests", { status: "retryable", code: "http-rate-limit" }],
  [500, "InternalServerError", { status: "retryable", code: "http-server" }],
  [503, "ServiceUnavailable", { status: "retryable", code: "http-server" }],
  [410, "Other", { status: "rejected", code: "http-permanent" }],
] as const)(
  "classifies %s %s without confusing device and provider credentials",
  (status, reason, outcome) => {
    expect(classifyApnsResponse(status, reason)).toEqual(outcome);
  },
);
it("reuses JWTs, refreshes before an hour, and invalidates expired provider tokens", async () => {
  const config = credentials();
  const fetcher = vi.fn<typeof fetch>(async () => ok());
  await sendApns(intent, config, fetcher, () => time);
  await sendApns(intent, config, fetcher, () => time + 1000);
  expect(token(fetcher.mock.calls[1]![1])).toBe(token(fetcher.mock.calls[0]![1]));
  await sendApns(intent, config, fetcher, () => time + 55 * 60000);
  expect(token(fetcher.mock.calls[2]![1])).not.toBe(token(fetcher.mock.calls[0]![1]));
  fetcher.mockImplementationOnce(async () => response(403, "ExpiredProviderToken"));
  expect(await sendApns(intent, config, fetcher, () => time + 55 * 60000)).toEqual({
    status: "rejected",
    code: "invalid-credentials",
  });
  await sendApns(intent, config, fetcher, () => time + 55 * 60000 + 1000);
  expect(token(fetcher.mock.calls[4]![1])).not.toBe(token(fetcher.mock.calls[2]![1]));
});
it("snapshots credentials before signing and never caches a rotated configuration", async () => {
  const config = credentials();
  const fetcher = vi.fn<typeof fetch>(async () => ok());
  const first = sendApns(intent, config, fetcher, () => time);
  Object.assign(config, { teamId: "NEW1234567", keyId: "NEWKEY1234", topic: "dev.new.mobile" });
  await first;
  await sendApns(intent, config, fetcher, () => time);
  const firstHeaders = new Headers(fetcher.mock.calls[0]![1]?.headers);
  expect(firstHeaders.get("apns-topic")).toBe("dev.shellbell.mobile");
  expect(
    JSON.parse(Buffer.from(token(fetcher.mock.calls[0]![1]).split(".")[1]!, "base64url").toString())
      .iss,
  ).toBe("TEAM123456");
  expect(
    JSON.parse(Buffer.from(token(fetcher.mock.calls[1]![1]).split(".")[1]!, "base64url").toString())
      .iss,
  ).toBe("NEW1234567");
});
it.each(["120", "999999", new Date(time + 45000).toUTCString()])(
  "bounds Retry-After %s",
  async (value) => {
    const result = await sendApns(
      intent,
      credentials(),
      async () => response(429, "TooManyRequests", { "retry-after": value }),
      () => time,
    );
    expect(result).toEqual({
      status: "retryable",
      code: "http-rate-limit",
      retryAfterMs: value === "999999" ? 3600000 : value === "120" ? 120000 : 45000,
    });
  },
);
it("rejects invalid credentials/environment before sending", async () => {
  const fetcher = vi.fn<typeof fetch>();
  expect(
    await sendApns(intent, { ...credentials(), privateKey: "invalid" }, fetcher, () => time),
  ).toEqual({ status: "rejected", code: "invalid-credentials" });
  expect(
    await sendApns(
      { ...intent, destination: { ...intent.destination, environment: undefined } },
      credentials(),
      fetcher,
      () => time,
    ),
  ).toEqual({ status: "rejected", code: "invalid-payload" });
  expect(fetcher).not.toHaveBeenCalled();
});
it("bounds and validates error response bodies", async () => {
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => new Response("not json", { status: 400 }),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "invalid-response" });
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => new Response("x".repeat(17000), { status: 400 }),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "response-too-large" });
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => new Response("oops", { status: 503 }),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "http-server", retryAfterMs: 900000 });
});
it.each([true, false])(
  "preserves the server retry floor for oversized bodies (declared: %s)",
  async (declared) => {
    expect(
      await sendApns(
        intent,
        credentials(),
        async () =>
          new Response("x".repeat(17000), {
            status: 503,
            headers: declared ? { "content-length": "17000" } : {},
          }),
        () => time,
      ),
    ).toEqual({ status: "retryable", code: "response-too-large", retryAfterMs: 900000 });
  },
);
it("preserves bounded Retry-After when a throttled response contains invalid UTF-8", async () => {
  expect(
    await sendApns(
      intent,
      credentials(),
      async () =>
        new Response(new Uint8Array([0xff]), {
          status: 429,
          headers: { "retry-after": "999999" },
        }),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "invalid-response", retryAfterMs: 3600000 });
});
it("preserves the server retry floor when an error body stalls", async () => {
  const config = credentials();
  await sendApns(
    intent,
    config,
    async () => ok(),
    () => time,
  );
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const stream = new ReadableStream<Uint8Array>();
  const pending = sendApns(
    intent,
    config,
    async () => {
      started();
      return new Response(stream, { status: 503 });
    },
    () => time,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: "retryable", code: "timeout", retryAfterMs: 900000 });
});
it("applies Apple's retry minimum for server failures and excessive token updates", async () => {
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => response(500, "InternalServerError", { "retry-after": "1" }),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "http-server", retryAfterMs: 900000 });
  expect(
    await sendApns(
      intent,
      credentials(),
      async () => response(429, "TooManyProviderTokenUpdates"),
      () => time,
    ),
  ).toEqual({ status: "retryable", code: "http-rate-limit", retryAfterMs: 1200000 });
});
it("does not evict rotated credentials when an earlier request fails", async () => {
  const config = credentials();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let finish!: (response: Response) => void;
  const first = sendApns(
    intent,
    config,
    async () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
    () => time,
  );
  await ready;
  Object.assign(config, { keyId: "NEWKEY1234" });
  const fetcher = vi.fn<typeof fetch>(async () => ok());
  await sendApns(intent, config, fetcher, () => time + 1000);
  finish(response(403, "InvalidProviderToken"));
  await first;
  await sendApns(intent, config, fetcher, () => time + 2000);
  expect(token(fetcher.mock.calls[0]![1])).toBe(token(fetcher.mock.calls[1]![1]));
});
it("times out stalled response bodies and cancels their stream", async () => {
  const config = credentials();
  await sendApns(
    intent,
    config,
    async () => ok(),
    () => time,
  );
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ cancel });
  const pending = sendApns(
    intent,
    config,
    async () => {
      started();
      return new Response(stream, { status: 400 });
    },
    () => time,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: "retryable", code: "timeout" });
  expect(cancel).toHaveBeenCalled();
});
it("enforces a five-second deadline even when fetch ignores abort", async () => {
  const config = credentials();
  await sendApns(
    intent,
    config,
    async () => ok(),
    () => time,
  );
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let signal: AbortSignal | null | undefined;
  const pending = sendApns(
    intent,
    config,
    async (_url, options) => {
      signal = options?.signal;
      started();
      return new Promise(() => {});
    },
    () => time,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: "retryable", code: "timeout" });
  expect(signal?.aborted).toBe(true);
});
