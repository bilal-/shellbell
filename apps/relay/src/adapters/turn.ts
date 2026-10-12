import { IceServerSchema } from "@shellbell/protocol";
import type { IceServerIssue, IceServerProvider } from "@shellbell/relay-core";

const HOUR = 60 * 60 * 1000;
/** Short enough that an unpaired phone's credential soon stops working. */
const TTL_MS = 24 * HOUR;
/** Devices refresh with 8 hours left; issuing with at least 16 keeps every device ahead. */
const REUSE_WHILE_MS = 16 * HOUR;
const REQUEST_TIMEOUT_MS = 3000;
/** After a failed request, sign-ins skip Cloudflare for this long instead of each waiting. */
const RETRY_AFTER_MS = 60_000;
const KEY = "turn-credentials";
/** UDP first, then TCP and TLS on 443 for networks that only allow web traffic. */
const PREFERRED = [
  /^turn:[^?]+:3478\?transport=udp$/,
  /^turn:[^?]+:3478\?transport=tcp$/,
  /^turns:[^?]+:443\?transport=tcp$/,
];

const Reply = IceServerSchema.array().max(4);

interface Stored {
  servers: IceServerIssue["iceServers"];
  expiresAt: number;
  retryAt: number;
}
type Kv = Pick<SyncKvStorage, "get" | "put">;

/**
 * Short-lived Cloudflare TURN credentials for one computer's devices. They and the failure
 * backoff live in the object's storage, because hibernation discards memory while signed-in
 * sockets stay connected. The key's API token stays in this Worker; devices only ever
 * receive expiring credentials.
 */
export function createCloudflareTurnProvider(
  env: { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string },
  runtime: { fetch?: typeof fetch; now?: () => number; kv?: Kv } = {},
): IceServerProvider | undefined {
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) return undefined;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? Date.now;
  let memory: Stored | undefined;
  const load = () => runtime.kv?.get<Stored>(KEY) ?? memory;
  const save = (value: Stored) => {
    memory = value;
    runtime.kv?.put(KEY, value);
  };
  const issue = (stored: Stored | undefined, at: number): IceServerIssue | null =>
    stored && stored.expiresAt > at
      ? { iceServers: stored.servers, expiresInMs: stored.expiresAt - at }
      : null;
  return async () => {
    const at = now();
    const cached = load();
    if (cached && (cached.expiresAt - at >= REUSE_WHILE_MS || at < cached.retryAt))
      return issue(cached, at);
    try {
      const response = await fetcher(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ ttl: TTL_MS / 1000 }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );
      if (!response.ok) throw new Error(`TURN credentials ${response.status}`);
      const reply = (await response.json()) as { iceServers?: unknown } | null;
      const servers = Reply.parse(reply?.iceServers)
        .filter((server) => server.username && server.credential)
        .map((server) => ({
          ...server,
          urls: PREFERRED.flatMap((pattern) => server.urls.filter((url) => pattern.test(url))),
        }))
        .filter((server) => server.urls.length > 0);
      if (servers.length === 0) throw new Error("TURN credentials without TURN servers");
      const fresh = { servers, expiresAt: at + TTL_MS, retryAt: 0 };
      save(fresh);
      return issue(fresh, at);
    } catch (error) {
      // Report the failure class only; never the key, token or credentials.
      console.error("relay turn unavailable", error instanceof Error ? error.name : "unknown");
      const kept = cached ?? { servers: [], expiresAt: 0, retryAt: 0 };
      save({ ...kept, retryAt: at + RETRY_AFTER_MS });
      return issue(kept, at);
    }
  };
}
