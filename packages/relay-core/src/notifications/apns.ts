import { buildApnsPayload } from "./apns-payload.js";
import type { PushIntent } from "./models.js";
import { decodePrivateKeyPem } from "./private-key.js";
import type { SendOutcome } from "./provider.js";
import { ProviderResponseError, readProviderResponse } from "./provider-response.js";

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  /** PKCS#8 PEM (.p8), supplied only by the composition root. */
  readonly privateKey: string;
  readonly topic: string;
}
type CachedToken = { token: string; issuedAt: number; fingerprint: string };
const tokens = new WeakMap<ApnsCredentials, CachedToken>();
const signing = new WeakMap<
  ApnsCredentials,
  { fingerprint: string; issuedAt: number; promise: Promise<CachedToken> }
>();
const reject = (code: Extract<SendOutcome, { status: "rejected" }>["code"]): SendOutcome => ({
  status: "rejected",
  code,
});
const retry = (code: Extract<SendOutcome, { status: "retryable" }>["code"]): SendOutcome => ({
  status: "retryable",
  code,
});
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

export function buildApnsUrl(
  environment: PushIntent["destination"]["environment"],
  token: string,
): string {
  if (environment !== "development" && environment !== "production")
    throw new Error("Explicit APNs environment required");
  if (!/^[a-fA-F0-9]{1,512}$/.test(token)) throw new Error("Invalid APNs device token");
  return `https://${environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com"}/3/device/${token}`;
}

/** BadDeviceToken may indicate an environment mismatch; only Unregistered is revocation evidence. */
export function classifyApnsResponse(status: number, reason?: string): SendOutcome {
  if (status === 200) return { status: "accepted" };
  if (status === 410 && reason === "Unregistered") return { status: "unregistered" };
  if (status === 400 && reason === "BadDeviceToken") return reject("invalid-device-token");
  if (
    status === 401 ||
    status === 403 ||
    ["DeviceTokenNotForTopic", "BadTopic", "MissingTopic", "TopicDisallowed"].includes(reason ?? "")
  )
    return reject("invalid-credentials");
  if (status === 429) return retry("http-rate-limit");
  if (status >= 500) return retry("http-server");
  if (status === 413 || ["BadPayload", "PayloadEmpty", "PayloadTooLarge"].includes(reason ?? ""))
    return reject("invalid-payload");
  return reject("http-permanent");
}

function validCredentials(config: ApnsCredentials, now: number): boolean {
  return (
    /^[A-Z0-9]{10}$/.test(config.teamId) &&
    /^[A-Z0-9]{10}$/.test(config.keyId) &&
    /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(config.topic) &&
    config.topic.length <= 255 &&
    config.privateKey.length <= 16384 &&
    Number.isFinite(now) &&
    now >= 0
  );
}

async function sign(config: ApnsCredentials, now: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    decodePrivateKeyPem(config.privateKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
  const input = `${encode({ alg: "ES256", kid: config.keyId })}.${encode({ iss: config.teamId, iat: Math.floor(now / 1000) })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    key,
    new TextEncoder().encode(input),
  );
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

/** APNs keeps its status, reason, and retry-delay policy at the provider boundary. */
async function request(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<SendOutcome> {
  let retryAfterMs: number | undefined;
  const withRetryDelay = (outcome: SendOutcome): SendOutcome => {
    if (outcome.status === "retryable" && retryAfterMs !== undefined)
      return { ...outcome, retryAfterMs: Math.max(outcome.retryAfterMs ?? 0, retryAfterMs) };
    return outcome;
  };
  try {
    const response = await readProviderResponse(url, init, fetchImpl, 16384, (head) => {
      // Success has no required body; cancel it without waiting for untrusted content.
      if (head.status === 200) return false;
      // Capture date-based hints when headers arrive, before a slow body consumes time.
      const header = head.retryAfter;
      if (header !== null && header.length <= 128) {
        const delay = /^\d+$/.test(header) ? Number(header) * 1000 : Date.parse(header) - now();
        if (Number.isFinite(delay) && delay >= 0) retryAfterMs = Math.min(delay, 3_600_000);
      }
      if (head.status >= 500) retryAfterMs = Math.max(retryAfterMs ?? 0, 900_000);
      return true;
    });
    if (response.head.status === 200) return { status: "accepted" };
    let reason: string | undefined;
    try {
      const parsed: unknown = JSON.parse(response.text);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "reason" in parsed &&
        typeof parsed.reason === "string" &&
        parsed.reason.length <= 128
      )
        reason = parsed.reason;
    } catch {
      /* HTTP throttling/server failures remain retryable without a JSON reason. */
    }
    if (!reason && response.head.status !== 429 && response.head.status < 500)
      return withRetryDelay(retry("invalid-response"));
    const outcome = classifyApnsResponse(response.head.status, reason);
    if (outcome.status === "retryable") {
      if (reason === "TooManyProviderTokenUpdates")
        outcome.retryAfterMs = Math.max(outcome.retryAfterMs ?? 0, 1_200_000);
    }
    return withRetryDelay(outcome);
  } catch (error) {
    return withRetryDelay(retry(error instanceof ProviderResponseError ? error.code : "network"));
  }
}

export async function sendApns(
  intent: PushIntent,
  credentials: ApnsCredentials,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<SendOutcome> {
  // Snapshot all fields before the first await: a composition root may rotate in place.
  const snapshot: ApnsCredentials = {
    teamId: credentials.teamId,
    keyId: credentials.keyId,
    privateKey: credentials.privateKey,
    topic: credentials.topic,
  };
  let url: string;
  let payload: ReturnType<typeof buildApnsPayload>;
  try {
    url = buildApnsUrl(intent.destination.environment, intent.destination.token);
    payload = buildApnsPayload(intent);
  } catch {
    return reject("invalid-payload");
  }
  const issuedAt = now();
  if (!validCredentials(snapshot, issuedAt)) return reject("invalid-credentials");
  let cached: CachedToken;
  try {
    const fingerprint = base64url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(snapshot))),
      ),
    );
    const existing = tokens.get(credentials);
    if (
      existing &&
      existing.fingerprint === fingerprint &&
      existing.issuedAt <= issuedAt &&
      issuedAt - existing.issuedAt < 55 * 60000
    )
      cached = existing;
    else {
      let pending = signing.get(credentials);
      if (
        !pending ||
        pending.fingerprint !== fingerprint ||
        pending.issuedAt > issuedAt ||
        issuedAt - pending.issuedAt >= 55 * 60000
      ) {
        pending = {
          fingerprint,
          issuedAt,
          promise: sign(snapshot, issuedAt).then((token) => ({ token, issuedAt, fingerprint })),
        };
        signing.set(credentials, pending);
      }
      try {
        cached = await pending.promise;
      } finally {
        if (signing.get(credentials) === pending) signing.delete(credentials);
      }
      if (
        credentials.teamId === snapshot.teamId &&
        credentials.keyId === snapshot.keyId &&
        credentials.privateKey === snapshot.privateKey &&
        credentials.topic === snapshot.topic
      )
        tokens.set(credentials, cached);
    }
  } catch {
    return reject("invalid-credentials");
  }
  const outcome = await request(
    url,
    {
      headers: {
        ...payload.headers,
        "apns-topic": snapshot.topic,
        authorization: `bearer ${cached.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload.body),
    },
    fetchImpl,
    now,
  );
  if (
    outcome.status === "rejected" &&
    outcome.code === "invalid-credentials" &&
    tokens.get(credentials) === cached
  )
    tokens.delete(credentials);
  return outcome;
}
