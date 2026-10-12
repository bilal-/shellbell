import { IceServerSchema } from "@shellbell/protocol";
import type { IceServerIssue, IceServerProvider } from "@shellbell/relay-core";

const HOUR = 60 * 60 * 1000;
/** Short enough that an unpaired phone's credential soon stops working. */
const TTL_MS = 24 * HOUR;
/** Devices refresh with 8 hours left; issuing with at least 16 keeps every device ahead. */
const REUSE_WHILE_MS = 16 * HOUR;
const REQUEST_TIMEOUT_MS = 3000;
/** UDP first, then TCP and TLS on 443 for networks that only allow web traffic. */
const PREFERRED = [
  /^turn:[^?]+:3478\?transport=udp$/,
  /^turn:[^?]+:3478\?transport=tcp$/,
  /^turns:[^?]+:443\?transport=tcp$/,
];

const Reply = IceServerSchema.array().max(4);

/**
 * Short-lived Cloudflare TURN credentials for one computer's devices, cached in memory.
 * The key's API token stays in this Worker; devices only ever receive expiring credentials.
 */
export function createCloudflareTurnProvider(
  env: { TURN_KEY_ID?: string; TURN_KEY_API_TOKEN?: string },
  runtime: { fetch?: typeof fetch; now?: () => number } = {},
): IceServerProvider | undefined {
  const keyId = env.TURN_KEY_ID;
  const token = env.TURN_KEY_API_TOKEN;
  if (!keyId || !token) return undefined;
  const fetcher = runtime.fetch ?? fetch;
  const now = runtime.now ?? Date.now;
  let cached: { servers: IceServerIssue["iceServers"]; expiresAt: number } | null = null;
  const issue = (at: number): IceServerIssue | null =>
    cached && cached.expiresAt > at
      ? { iceServers: cached.servers, expiresInMs: cached.expiresAt - at }
      : null;
  return async () => {
    const at = now();
    if (cached && cached.expiresAt - at >= REUSE_WHILE_MS) return issue(at);
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
      cached = { servers, expiresAt: at + TTL_MS };
    } catch (error) {
      // Report the failure class only; never the key, token or credentials.
      console.error("relay turn unavailable", error instanceof Error ? error.name : "unknown");
    }
    return issue(at);
  };
}
