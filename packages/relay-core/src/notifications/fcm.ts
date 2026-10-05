import { buildFcmPayload } from "./fcm-payload.js";
import type { PushIntent } from "./models.js";
import { decodePrivateKeyPem } from "./private-key.js";
import type { SendOutcome } from "./provider.js";
import { ProviderResponseError, readProviderResponse } from "./provider-response.js";

export interface FcmCredentials {
  readonly projectId: string;
  readonly clientEmail: string;
  /** PKCS#8 PEM, supplied only by the composition root. */
  readonly privateKey: string;
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const MAX_RESPONSE_BYTES = 128 * 1024;
const tokens = new WeakMap<
  FcmCredentials,
  { token: string; expiresAt: number; email: string; keyFingerprint: string; project: string }
>();
type Bearer = { token: string; expiresAt: number };
type PendingRefresh = {
  project: string;
  email: string;
  keyFingerprint: string;
  promise: Promise<Bearer | SendOutcome>;
};
const refreshing = new WeakMap<FcmCredentials, PendingRefresh>();
type Failure = Extract<SendOutcome, { status: "retryable" | "rejected" }>;
class ProviderFailure extends Error {
  constructor(readonly outcome: Failure) {
    super(outcome.code);
  }
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const reject = (code: Extract<SendOutcome, { status: "rejected" }>["code"]): SendOutcome => ({
  status: "rejected",
  code,
});

/** Typed FcmError distinguishes invalid registration from google.rpc.BadRequest. */
export function classifyFcmError(error: unknown): SendOutcome {
  if (!record(error)) return reject("http-permanent");
  const details = Array.isArray(error.details) ? error.details.filter(record) : [];
  const codes = details
    .filter((d) => d["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError")
    .map((d) => d.errorCode);
  if (codes.includes("UNREGISTERED")) return { status: "unregistered" };
  if (error.status === "INVALID_ARGUMENT") {
    if (
      codes.includes("INVALID_ARGUMENT") &&
      !details.some((d) => d["@type"] === "type.googleapis.com/google.rpc.BadRequest")
    )
      return { status: "unregistered" };
    return reject("invalid-payload");
  }
  if (
    ["UNAUTHENTICATED", "PERMISSION_DENIED"].includes(String(error.status)) ||
    codes.includes("SENDER_ID_MISMATCH") ||
    codes.includes("THIRD_PARTY_AUTH_ERROR")
  )
    return reject("invalid-credentials");
  return reject("http-permanent");
}

function retryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.length > 128) return undefined;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 3_600_000) : undefined;
}

/** FCM retains HTTP/backoff and JSON policy around the shared transport lifecycle. */
async function request(
  url: string,
  init: RequestInit,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<{ status: number; data: unknown; retryAfter: string | null }> {
  let transientFailure: Failure | undefined;
  try {
    const response = await readProviderResponse(
      url,
      init,
      fetchImpl,
      MAX_RESPONSE_BYTES,
      (head) => {
        const outcome = httpOutcome(head.status, head.retryAfter, now());
        if (outcome?.status === "retryable") transientFailure = outcome;
        return true;
      },
      "after-body",
    );
    const { head } = response;
    if (!response.hasBody)
      throw new ProviderFailure(
        transientFailure ?? { status: "retryable", code: "invalid-response" },
      );
    let data: unknown;
    try {
      data = JSON.parse(response.text);
    } catch {
      if (head.status >= 200 && head.status < 300)
        throw new ProviderFailure({ status: "retryable", code: "invalid-response" });
      data = null;
    }
    return { status: head.status, data, retryAfter: head.retryAfter };
  } catch (error) {
    if (transientFailure) throw new ProviderFailure(transientFailure);
    if (error instanceof ProviderFailure) throw error;
    if (error instanceof ProviderResponseError) {
      // As before, an undecodable non-success body still allows HTTP classification.
      if (
        error.code === "invalid-response" &&
        error.head &&
        (error.head.status < 200 || error.head.status >= 300)
      )
        return { status: error.head.status, data: null, retryAfter: error.head.retryAfter };
      throw new ProviderFailure({ status: "retryable", code: error.code });
    }
    throw new ProviderFailure({ status: "retryable", code: "network" });
  }
}

function httpOutcome(status: number, header: string | null, now: number): SendOutcome | undefined {
  if (status === 429 || status >= 500) {
    const hint = retryAfter(header, now);
    // FCM QUOTA_EXCEEDED requires at least a one-minute initial retry delay.
    const delay = status === 429 ? Math.max(hint ?? 0, 60_000) : hint;
    return {
      status: "retryable",
      code: status === 429 ? "http-rate-limit" : "http-server",
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    };
  }
  if (status === 401 || status === 403) return reject("invalid-credentials");
  return undefined;
}

function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
async function assertion(credentials: FcmCredentials, now: number): Promise<string> {
  try {
    if (
      credentials.privateKey.length > 16384 ||
      credentials.clientEmail.length > 320 ||
      !credentials.clientEmail.includes("@") ||
      !/^[a-z][a-z0-9-]{0,62}$/.test(credentials.projectId) ||
      !Number.isFinite(now)
    )
      throw new Error();
    const key = await crypto.subtle.importKey(
      "pkcs8",
      decodePrivateKeyPem(credentials.privateKey),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const encode = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
    const iat = Math.floor(now / 1000);
    const input = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({ iss: credentials.clientEmail, scope: "https://www.googleapis.com/auth/firebase.messaging", aud: TOKEN_URL, iat, exp: iat + 3600 })}`;
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      key,
      new TextEncoder().encode(input),
    );
    return `${input}.${base64url(new Uint8Array(signature))}`;
  } catch {
    throw new ProviderFailure({ status: "rejected", code: "invalid-credentials" });
  }
}

async function refreshToken(
  snapshot: FcmCredentials,
  fetchImpl: typeof fetch,
  now: () => number,
): Promise<Bearer | SendOutcome> {
  try {
    const jwt = await assertion(snapshot, now());
    const started = now();
    const response = await request(
      TOKEN_URL,
      {
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: jwt,
        }).toString(),
      },
      fetchImpl,
      now,
    );
    const failure = httpOutcome(response.status, response.retryAfter, now());
    if (failure) return failure;
    if (response.status < 200 || response.status >= 300) return reject("invalid-credentials");
    const data = response.data;
    if (
      !record(data) ||
      typeof data.access_token !== "string" ||
      !/^[\x21-\x7e]{1,8192}$/.test(data.access_token) ||
      data.token_type !== "Bearer" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0
    )
      return { status: "retryable", code: "invalid-response" };
    return {
      token: data.access_token,
      expiresAt: started + Math.min(data.expires_in, 3600) * 1000,
    };
  } catch (error) {
    return error instanceof ProviderFailure
      ? error.outcome
      : { status: "retryable", code: "network" };
  }
}

export async function sendFcm(
  intent: PushIntent,
  credentials: FcmCredentials,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<SendOutcome> {
  try {
    // One attempt authenticates and sends using the same configuration, even if
    // the composition root rotates the original object during network I/O.
    const snapshot: FcmCredentials = {
      projectId: credentials.projectId,
      clientEmail: credentials.clientEmail,
      privateKey: credentials.privateKey,
    };
    let payload: string;
    try {
      payload = JSON.stringify(buildFcmPayload(intent, now()));
    } catch {
      return reject("invalid-payload");
    }
    // Detect in-place rotation without retaining an old private key in the cache value.
    if (snapshot.privateKey.length > 16384) return reject("invalid-credentials");
    const keyFingerprint = base64url(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(snapshot.privateKey)),
      ),
    );
    const cachedSnapshot = tokens.get(credentials);
    let cached: Bearer | undefined = cachedSnapshot;
    if (
      !cached ||
      cached.expiresAt <= now() + 60000 ||
      cachedSnapshot?.email !== snapshot.clientEmail ||
      cachedSnapshot?.keyFingerprint !== keyFingerprint ||
      cachedSnapshot?.project !== snapshot.projectId
    ) {
      let pending = refreshing.get(credentials);
      if (
        !pending ||
        pending.email !== snapshot.clientEmail ||
        pending.keyFingerprint !== keyFingerprint ||
        pending.project !== snapshot.projectId
      ) {
        const entry: PendingRefresh = {
          email: snapshot.clientEmail,
          keyFingerprint,
          project: snapshot.projectId,
          promise: refreshToken(snapshot, fetchImpl, now)
            .then((result) => {
              if (!("token" in result)) return result;
              const refreshed = {
                ...result,
                email: snapshot.clientEmail,
                keyFingerprint,
                project: snapshot.projectId,
              };
              if (
                refreshing.get(credentials) === entry &&
                credentials.clientEmail === snapshot.clientEmail &&
                credentials.privateKey === snapshot.privateKey &&
                credentials.projectId === snapshot.projectId
              )
                tokens.set(credentials, refreshed);
              return refreshed;
            })
            .finally(() => {
              if (refreshing.get(credentials) === entry) refreshing.delete(credentials);
            }),
        };
        refreshing.set(credentials, entry);
        pending = entry;
      }
      const result = await pending.promise;
      if (!("token" in result)) return result;
      cached = result;
    }
    const response = await request(
      `https://fcm.googleapis.com/v1/projects/${snapshot.projectId}/messages:send`,
      {
        headers: { "content-type": "application/json", authorization: `Bearer ${cached.token}` },
        body: payload,
      },
      fetchImpl,
      now,
    );
    if (response.status === 401 && tokens.get(credentials) === cached) tokens.delete(credentials);
    const failure = httpOutcome(response.status, response.retryAfter, now());
    if (failure) return failure;
    if (response.status < 200 || response.status >= 300)
      return classifyFcmError(record(response.data) ? response.data.error : undefined);
    if (
      !record(response.data) ||
      typeof response.data.name !== "string" ||
      response.data.name.length > 1024 ||
      !response.data.name.startsWith(`projects/${snapshot.projectId}/messages/`) ||
      response.data.name.endsWith("/")
    )
      return { status: "retryable", code: "invalid-response" };
    return { status: "accepted" };
  } catch (error) {
    return error instanceof ProviderFailure
      ? error.outcome
      : { status: "retryable", code: "network" };
  }
}
