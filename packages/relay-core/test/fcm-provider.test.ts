import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { classifyFcmError, type FcmCredentials, sendFcm } from "../src/notifications/fcm.js";
import type { PushIntent } from "../src/notifications/models.js";
import { claimJob, newJob, sendCompleted } from "../src/notifications/policy.js";

const now = 1_800_000_000_000;
const intent: PushIntent = {
  destination: { provider: "fcm", token: "private-device-token" },
  route: { computerFp: "computer", sessionId: "session", kind: "prompt" },
  genericTitle: "Shellbell",
  genericBody: "Ready",
  group: "group",
  expiresAtSeconds: now / 1000 + 120,
};
let pem: string;
let publicKey: CryptoKey;
let privateKey: CryptoKey;
beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  publicKey = keys.publicKey;
  privateKey = keys.privateKey;
  const label = "PRIVATE KEY";
  pem = `-----BEGIN ${label}-----\n${Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString("base64")}\n-----END ${label}-----`;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const credentials = (): FcmCredentials => ({
  projectId: "test-project",
  clientEmail: "sender@example.test",
  privateKey: pem,
});
const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers });
const typed = (errorCode: string) => ({
  "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
  errorCode,
});

it.each(["oauth", "message"])(
  "preserves server backoff for malformed %s response",
  async (stage) => {
    const fetcher: typeof fetch = async (url) => {
      if (stage === "message" && String(url).includes("oauth2")) return oauth();
      return new Response("not json", { status: 503, headers: { "retry-after": "120" } });
    };
    expect(await sendFcm(intent, credentials(), fetcher, () => now)).toEqual({
      status: "retryable",
      code: "http-server",
      retryAfterMs: 120000,
    });
  },
);

it.each([
  [200, null, "retryable", "invalid-response"],
  [400, null, "retryable", "invalid-response"],
  [400, "", "rejected", "http-permanent"],
  [400, new Uint8Array([0xff]), "rejected", "http-permanent"],
] as const)(
  "retains FCM missing-body and decoding semantics for HTTP %s",
  async (status, body, outcome, code) => {
    const fetcher: typeof fetch = async (url) =>
      String(url).includes("oauth2") ? oauth() : new Response(body, { status });
    expect(await sendFcm(intent, credentials(), fetcher, () => now)).toEqual({
      status: outcome,
      code,
    });
  },
);
const oauth = () =>
  json({ access_token: "private-access-token", token_type: "Bearer", expires_in: 3600 });
const accepted = () => json({ name: "projects/test-project/messages/123" });
const fake = (response: () => Response) =>
  vi.fn<typeof fetch>(async (url) => (String(url).includes("oauth2") ? oauth() : response()));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  ["oauth", 400],
  ["message", 400],
  ["message", 200],
] as const)(
  "bounds complete %s HTTP %s body before decoding an invalid prefix",
  async (stage, status) => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0xff]));
        controller.enqueue(new Uint8Array(131072));
        controller.close();
      },
    });
    const fetcher: typeof fetch = async (url) =>
      stage === "message" && String(url).includes("oauth2")
        ? oauth()
        : new Response(body, { status });
    expect(await sendFcm(intent, credentials(), fetcher, () => now)).toEqual({
      status: "retryable",
      code: "response-too-large",
    });
    expect(body.locked).toBe(false);
  },
);

it.each([
  ["oauth", 400],
  ["message", 400],
  ["message", 200],
] as const)("times out stalled %s HTTP %s body after an invalid prefix", async (stage, status) => {
  vi.useFakeTimers();
  const started = deferred<void>();
  let prefixSent = false;
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!prefixSent) {
          prefixSent = true;
          controller.enqueue(new Uint8Array([0xff]));
          started.resolve();
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const fetcher: typeof fetch = async (url) =>
    stage === "message" && String(url).includes("oauth2")
      ? oauth()
      : new Response(body, { status });
  const pending = sendFcm(intent, credentials(), fetcher, () => now);
  await started.promise;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: "retryable", code: "timeout" });
  expect(cancelled).toBe(true);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

async function completeCryptoBeforeConcurrentSends() {
  // Resolve real crypto work before launching the sends so thread-pool scheduling
  // cannot hide duplicate exchanges behind the first OAuth-start notification.
  const fingerprint = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(pem));
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode("concurrency fixture"),
  );
  vi.spyOn(crypto.subtle, "digest").mockResolvedValue(fingerprint);
  vi.spyOn(crypto.subtle, "importKey").mockResolvedValue(privateKey);
  vi.spyOn(crypto.subtle, "sign").mockResolvedValue(signature);
}

it("coalesces concurrent OAuth refresh while sending every notification", async () => {
  await completeCryptoBeforeConcurrentSends();
  const creds = credentials();
  const started = deferred<void>();
  const response = deferred<Response>();
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("oauth2")) {
      started.resolve();
      return response.promise;
    }
    return accepted();
  });
  const sends = Array.from({ length: 8 }, () => sendFcm(intent, creds, fetcher, () => now));
  await started.promise;
  try {
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(1);
  } finally {
    response.resolve(oauth());
    await Promise.all(sends);
  }
  expect(await Promise.all(sends)).toEqual(
    Array.from({ length: 8 }, () => ({ status: "accepted" })),
  );
  const messages = fetcher.mock.calls.filter(([url]) => String(url).endsWith("messages:send"));
  expect(messages).toHaveLength(8);
  expect(new Set(messages.map(([, options]) => options)).size).toBe(8);
});

it("keeps the newer cached bearer when an old refresh finishes after credential rotation", async () => {
  const creds = { ...credentials() };
  const oldStarted = deferred<void>();
  const newStarted = deferred<void>();
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  let exchanges = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("oauth2")) {
      if (++exchanges === 1) {
        oldStarted.resolve();
        return oldResponse.promise;
      }
      newStarted.resolve();
      return newResponse.promise;
    }
    return String(url).includes("rotated-project")
      ? json({ name: "projects/rotated-project/messages/456" })
      : accepted();
  });
  const oldSend = sendFcm(intent, creds, fetcher, () => now);
  await oldStarted.promise;
  creds.projectId = "rotated-project";
  creds.clientEmail = "rotated@example.test";
  // A different PEM representation is a distinct private-key fingerprint.
  creds.privateKey = `${pem}\n`;
  const newSend = sendFcm(intent, creds, fetcher, () => now);
  await newStarted.promise;
  newResponse.resolve(
    json({ access_token: "rotated-access-token", token_type: "Bearer", expires_in: 3600 }),
  );
  expect(await newSend).toEqual({ status: "accepted" });
  oldResponse.resolve(oauth());
  expect(await oldSend).toEqual({ status: "accepted" });
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({ status: "accepted" });
  expect(exchanges).toBe(2);
  const oauthCalls = fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"));
  expect(
    oauthCalls.map(([, options]) => {
      const jwt = new URLSearchParams(String(options?.body)).get("assertion")!;
      return JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()).iss;
    }),
  ).toEqual(["sender@example.test", "rotated@example.test"]);
  const messages = fetcher.mock.calls.filter(([url]) => String(url).endsWith("messages:send"));
  expect(
    messages.map(([url, options]) => [
      String(url),
      new Headers(options?.headers).get("authorization"),
    ]),
  ).toEqual([
    [
      "https://fcm.googleapis.com/v1/projects/rotated-project/messages:send",
      "Bearer rotated-access-token",
    ],
    [
      "https://fcm.googleapis.com/v1/projects/test-project/messages:send",
      "Bearer private-access-token",
    ],
    [
      "https://fcm.googleapis.com/v1/projects/rotated-project/messages:send",
      "Bearer rotated-access-token",
    ],
  ]);
});

it("shares malformed OAuth failure and starts one fresh exchange on recovery", async () => {
  await completeCryptoBeforeConcurrentSends();
  const creds = credentials();
  const started = deferred<void>();
  const response = deferred<Response>();
  const oauthCalls: RequestInit[] = [];
  const fetcher = vi.fn<typeof fetch>(async (url, options) => {
    if (String(url).includes("oauth2")) {
      oauthCalls.push(options!);
      started.resolve();
      return response.promise;
    }
    return accepted();
  });
  const first = sendFcm(intent, creds, fetcher, () => now);
  const second = sendFcm(intent, creds, fetcher, () => now);
  await started.promise;
  response.resolve(new Response("{invalid-json"));
  expect(await Promise.all([first, second])).toEqual([
    { status: "retryable", code: "invalid-response" },
    { status: "retryable", code: "invalid-response" },
  ]);
  expect(oauthCalls).toHaveLength(1);
  const recoveryFetcher = fake(accepted);
  expect(await sendFcm(intent, creds, recoveryFetcher, () => now)).toEqual({ status: "accepted" });
  expect(recoveryFetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(
    1,
  );
});

it("keeps a rotated refresh pending when the older refresh fails", async () => {
  await completeCryptoBeforeConcurrentSends();
  const creds = { ...credentials() };
  const oldStarted = deferred<void>();
  const newStarted = deferred<void>();
  const oldResponse = deferred<Response>();
  const newResponse = deferred<Response>();
  let exchanges = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("oauth2")) {
      if (++exchanges === 1) {
        oldStarted.resolve();
        return oldResponse.promise;
      }
      newStarted.resolve();
      return newResponse.promise.then((response) => response.clone());
    }
    return accepted();
  });
  const oldSend = sendFcm(intent, creds, fetcher, () => now);
  await oldStarted.promise;
  creds.clientEmail = "rotated@example.test";
  const newSend = sendFcm(intent, creds, fetcher, () => now);
  await newStarted.promise;
  oldResponse.resolve(new Response("{invalid-json"));
  expect(await oldSend).toEqual({ status: "retryable", code: "invalid-response" });
  const joiningSend = sendFcm(intent, creds, fetcher, () => now);
  await vi.waitFor(() => expect(crypto.subtle.digest).toHaveBeenCalledTimes(3));
  newResponse.resolve(oauth());
  expect(await Promise.all([newSend, joiningSend])).toEqual([
    { status: "accepted" },
    { status: "accepted" },
  ]);
  expect(exchanges).toBe(2);
});

it("signs the scoped OAuth JWT and sends the exact authorized HTTP v1 request", async () => {
  const fetcher = fake(accepted);
  expect(await sendFcm(intent, credentials(), fetcher, () => now)).toEqual({ status: "accepted" });
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://oauth2.googleapis.com/token");
  const form = new URLSearchParams(String(options?.body));
  expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
  const jwt = form.get("assertion")!.split(".");
  expect(JSON.parse(Buffer.from(jwt[0]!, "base64url").toString())).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  expect(JSON.parse(Buffer.from(jwt[1]!, "base64url").toString())).toEqual({
    iss: "sender@example.test",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: now / 1000,
    exp: now / 1000 + 3600,
  });
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      publicKey,
      Buffer.from(jwt[2]!, "base64url"),
      new TextEncoder().encode(`${jwt[0]}.${jwt[1]}`),
    ),
  ).toBe(true);
  const [sendUrl, sendOptions] = fetcher.mock.calls[1]!;
  expect(sendUrl).toBe("https://fcm.googleapis.com/v1/projects/test-project/messages:send");
  expect(new Headers(sendOptions?.headers).get("authorization")).toBe(
    "Bearer private-access-token",
  );
  expect(JSON.parse(String(sendOptions?.body)).message.token).toBe(intent.destination.token);
  expect(sendOptions?.redirect).toBe("manual");
});
it("reuses tokens until the refresh margin and isolates credentials", async () => {
  const creds = credentials();
  const fetcher = fake(accepted);
  await sendFcm(intent, creds, fetcher, () => now);
  await sendFcm(intent, creds, fetcher, () => now + 3000);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(1);
  await sendFcm(intent, creds, fetcher, () => now + 3_550_000);
  await sendFcm(intent, credentials(), fetcher, () => now);
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(3);
});
it.each([
  [404, "NOT_FOUND", [typed("UNREGISTERED")], "unregistered"],
  [400, "INVALID_ARGUMENT", [typed("INVALID_ARGUMENT")], "unregistered"],
  [400, "INVALID_ARGUMENT", [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }], "rejected"],
  [400, "INVALID_ARGUMENT", [], "rejected"],
  [
    400,
    "INVALID_ARGUMENT",
    [typed("INVALID_ARGUMENT"), { "@type": "type.googleapis.com/google.rpc.BadRequest" }],
    "rejected",
  ],
  [401, "UNAUTHENTICATED", [], "rejected"],
  [403, "PERMISSION_DENIED", [typed("SENDER_ID_MISMATCH")], "rejected"],
  [500, "INTERNAL", [], "retryable"],
  [503, "UNAVAILABLE", [], "retryable"],
] as const)(
  "classifies HTTP %s %s without leaking provider text",
  async (http, status, details, expected) => {
    const result = await sendFcm(
      intent,
      credentials(),
      fake(() => json({ error: { status, details, message: "private-device-token" } }, http)),
      () => now,
    );
    expect(result.status).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("private");
  },
);
it("does not disable a token for an untyped payload-invalid argument", () => {
  expect(
    classifyFcmError({
      status: "INVALID_ARGUMENT",
      details: [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }],
    }),
  ).toEqual({ status: "rejected", code: "invalid-payload" });
});
it.each([
  ["120", 120000],
  ["999999", 3600000],
  [new Date(now + 90000).toUTCString(), 90000],
  ["nonsense", 60000],
])("bounds Retry-After %s", async (header, expected) => {
  const result = await sendFcm(
    intent,
    credentials(),
    fake(() => json({ error: { status: "QUOTA_EXCEEDED" } }, 429, { "retry-after": header })),
    () => now,
  );
  expect(result).toEqual({
    status: "retryable",
    code: "http-rate-limit",
    retryAfterMs: expected,
  });
});

it.each([null, "nonsense", "0", "5", "59", "60", "90", "120"])(
  "schedules FCM quota retries with a one-minute floor and freshness limit: %s",
  async (header) => {
    const outcome = await sendFcm(
      intent,
      credentials(),
      fake(() =>
        json(
          { error: { status: "QUOTA_EXCEEDED" } },
          429,
          header === null ? {} : { "retry-after": header },
        ),
      ),
      () => now,
    );
    const delay = header === "90" ? 90000 : header === "120" ? 120000 : 60000;
    expect(outcome).toEqual({ status: "retryable", code: "http-rate-limit", retryAfterMs: delay });
    const job = claimJob(
      newJob(
        "job",
        "phone",
        "generation",
        { type: "notify", sessionId: "session", kind: "idle" },
        now,
        undefined,
      ),
      "claim",
      now,
    )!;
    const completion = sendCompleted(job, outcome, now);
    expect(completion.job?.dueAt ?? null).toBe(delay === 120000 ? null : now + delay);
    expect(sendCompleted(job, outcome, now + 60000).job).toBeNull();
  },
);

it.each(
  [429, 503].flatMap((status) =>
    (["null", "declared-oversized", "stream-oversized", "stalled", "rejecting"] as const).map(
      (bodyKind) => [status, bodyKind] as const,
    ),
  ),
)("preserves HTTP %s and Retry-After through a %s body", async (status, bodyKind) => {
  const creds = credentials();
  await sendFcm(intent, creds, fake(accepted), () => now);
  vi.useFakeTimers();
  let cancelled = false;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const body =
    bodyKind === "null"
      ? null
      : new ReadableStream<Uint8Array>({
          pull(controller) {
            if (bodyKind === "stream-oversized") controller.enqueue(new Uint8Array(131073));
            if (bodyKind === "rejecting") controller.error(new Error("private-provider-error"));
          },
          cancel() {
            cancelled = true;
            // A transport's cancellation must not extend the request deadline.
            return new Promise<void>(() => {});
          },
        });
  const pending = sendFcm(
    intent,
    creds,
    async () => {
      started();
      return new Response(body, {
        status,
        headers: {
          "retry-after": "120",
          ...(bodyKind === "declared-oversized" ? { "content-length": "131073" } : {}),
        },
      });
    },
    () => now,
  );
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending, bodyKind).toEqual({
    status: "retryable",
    code: status === 429 ? "http-rate-limit" : "http-server",
    retryAfterMs: 120000,
  });
  if (body && bodyKind !== "rejecting") expect(cancelled, bodyKind).toBe(true);
  expect(body?.locked ?? false, bodyKind).toBe(false);
  expect(vi.getTimerCount(), bodyKind).toBe(0);
});
it.each([
  () => new Response("not json"),
  () => new Response("x".repeat(131073)),
  () => json({}),
  () => json({ name: "" }),
])("rejects malformed and oversized provider responses safely", async (response) => {
  expect((await sendFcm(intent, credentials(), fake(response), () => now)).status).toBe(
    "retryable",
  );
});
it("bounds a stalled response body as well as fetch even if abort is ignored", async () => {
  const creds = credentials();
  const fetcher = fake(accepted);
  await sendFcm(intent, creds, fetcher, () => now);
  vi.useFakeTimers();
  for (const fetchImpl of [
    vi.fn<typeof fetch>(() => new Promise(() => {})),
    fake(() => new Response(new ReadableStream({ start() {} }))),
  ]) {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const pending = sendFcm(
      intent,
      creds,
      (url, init) => {
        started();
        return fetchImpl(url, init);
      },
      () => now,
    );
    await ready;
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toEqual({ status: "retryable", code: "timeout" });
  }
});
it("sanitizes OAuth failures and invalid local keys without sending", async () => {
  const fetcher = vi.fn<typeof fetch>(async () =>
    json({ error: "invalid_grant", error_description: pem }, 400),
  );
  expect(await sendFcm(intent, credentials(), fetcher, () => now)).toEqual({
    status: "rejected",
    code: "invalid-credentials",
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(
    await sendFcm(intent, { ...credentials(), privateKey: "private-secret" }, fetcher, () => now),
  ).toEqual({ status: "rejected", code: "invalid-credentials" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("does not disclose thrown network exceptions", async () => {
  expect(
    await sendFcm(
      intent,
      credentials(),
      async () => {
        throw new Error(pem);
      },
      () => now,
    ),
  ).toEqual({ status: "retryable", code: "network" });
});
it("invalidates a rejected bearer token before the next send", async () => {
  const creds = credentials();
  let sends = 0;
  const fetcher = fake(() =>
    ++sends === 1 ? json({ error: { status: "UNAUTHENTICATED" } }, 401) : accepted(),
  );
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({
    status: "rejected",
    code: "invalid-credentials",
  });
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({ status: "accepted" });
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(2);
});
it("bounds a stalled OAuth exchange", async () => {
  vi.useFakeTimers();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const fetcher = vi.fn<typeof fetch>(() => {
    started();
    return new Promise(() => {});
  });
  const pending = sendFcm(intent, credentials(), fetcher, () => now);
  await ready;
  await vi.advanceTimersByTimeAsync(5000);
  expect(await pending).toEqual({ status: "retryable", code: "timeout" });
});
it.each([
  () => json({ access_token: "secret", token_type: "Bearer", expires_in: -1 }),
  () => json({ access_token: "secret\r\nInjected: yes", token_type: "Bearer", expires_in: 3600 }),
  () => new Response("x".repeat(131073)),
])("never sends when OAuth response is invalid or oversized", async (response) => {
  const fetcher = vi.fn<typeof fetch>(async () => response());
  expect((await sendFcm(intent, credentials(), fetcher, () => now)).status).toBe("retryable");
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("preserves transient status and retry hints for non-JSON error bodies", async () => {
  expect(
    await sendFcm(
      intent,
      credentials(),
      fake(() => new Response("unavailable", { status: 503, headers: { "retry-after": "15" } })),
      () => now,
    ),
  ).toEqual({ status: "retryable", code: "http-server", retryAfterMs: 15000 });
});
it("does not reuse a cached bearer token after credential rotation", async () => {
  const creds = { ...credentials() };
  const fetcher = fake(accepted);
  await sendFcm(intent, creds, fetcher, () => now);
  creds.privateKey = "invalid-rotated-key";
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({
    status: "rejected",
    code: "invalid-credentials",
  });
  expect(fetcher).toHaveBeenCalledTimes(2);
});
it("keeps pending OAuth exchanges bound to their credential snapshot during rotation", async () => {
  const creds = { ...credentials() };
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let resolveOAuth!: (response: Response) => void;
  const pendingOAuth = new Promise<Response>((resolve) => {
    resolveOAuth = resolve;
  });
  let exchanges = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("oauth2")) {
      if (++exchanges === 1) {
        started();
        return pendingOAuth;
      }
      return json({ access_token: "rotated-access-token", token_type: "Bearer", expires_in: 3600 });
    }
    return String(url).includes("rotated-project")
      ? json({ name: "projects/rotated-project/messages/456" })
      : accepted();
  });
  const pending = sendFcm(intent, creds, fetcher, () => now);
  await ready;
  creds.clientEmail = "rotated@example.test";
  creds.projectId = "rotated-project";
  resolveOAuth(oauth());
  expect(await pending).toEqual({ status: "accepted" });
  expect(fetcher.mock.calls[1]![0]).toBe(
    "https://fcm.googleapis.com/v1/projects/test-project/messages:send",
  );
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({ status: "accepted" });
  const exchangesSent = fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"));
  expect(exchangesSent).toHaveLength(2);
  const assertion = new URLSearchParams(String(exchangesSent[1]![1]?.body)).get("assertion")!;
  expect(JSON.parse(Buffer.from(assertion.split(".")[1]!, "base64url").toString()).iss).toBe(
    "rotated@example.test",
  );
  const [sendUrl, options] = fetcher.mock.calls.at(-1)!;
  expect(sendUrl).toBe("https://fcm.googleapis.com/v1/projects/rotated-project/messages:send");
  expect(new Headers(options?.headers).get("authorization")).toBe("Bearer rotated-access-token");
});
it("does not replace or invalidate the rotated cache when an older attempt finishes", async () => {
  const creds = { ...credentials() };
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let resolveOAuth!: (response: Response) => void;
  const deferred = new Promise<Response>((resolve) => {
    resolveOAuth = resolve;
  });
  let exchanges = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("oauth2")) {
      if (++exchanges === 1) {
        started();
        return deferred;
      }
      return oauth();
    }
    return String(url).includes("rotated-project")
      ? json({ name: "projects/rotated-project/messages/456" })
      : json({ error: { status: "UNAUTHENTICATED" } }, 401);
  });
  const oldAttempt = sendFcm(intent, creds, fetcher, () => now);
  await ready;
  creds.clientEmail = "rotated@example.test";
  creds.projectId = "rotated-project";
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({ status: "accepted" });
  resolveOAuth(oauth());
  expect(await oldAttempt).toEqual({ status: "rejected", code: "invalid-credentials" });
  expect(await sendFcm(intent, creds, fetcher, () => now)).toEqual({ status: "accepted" });
  expect(fetcher.mock.calls.filter(([url]) => String(url).includes("oauth2"))).toHaveLength(2);
});
