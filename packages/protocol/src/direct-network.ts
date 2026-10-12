/** Address discovery only; terminal traffic never travels through this STUN service. */
export const DIRECT_STUN_URL = "stun:stun.cloudflare.com:3478";

/**
 * A WebRTC ICE server. TURN servers only forward the already DTLS- and Noise-encrypted data
 * channel, so a TURN fallback does not change what the devices protect end to end.
 */
export interface DirectIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

/** Each extra TURN URL adds candidates; three stay well inside the 32 per side. */
const MAX_TURN_URLS = 3;
/** Refresh credentials this long before they expire, so a new attempt never uses stale ones. */
export const ICE_REFRESH_BEFORE_MS = 8 * 60 * 60 * 1000;
const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

const isTurn = (url: string) => /^turns?:/.test(url);
// Browsers and mobile WebRTC stacks cannot reach TURN on port 53; it only delays gathering.
const usable = (url: string) => !/:53(\?|$)/.test(url);

/** STUN first, then the relay's TURN servers that have credentials. */
export function directIceServers(relay: readonly DirectIceServer[] = []): DirectIceServer[] {
  const servers: DirectIceServer[] = [{ urls: [DIRECT_STUN_URL] }];
  let budget = MAX_TURN_URLS;
  for (const server of relay) {
    if (!server.username || !server.credential) continue;
    const urls = server.urls.filter((url) => isTurn(url) && usable(url)).slice(0, budget);
    if (urls.length === 0) continue;
    budget -= urls.length;
    servers.push({ urls, username: server.username, credential: server.credential });
    if (budget === 0) break;
  }
  return servers;
}

/** The TURN servers a relay issued, with their expiry on this device's clock. */
export class IceServerCache {
  private relay: DirectIceServer[] = [];
  private expiresAt = 0;
  private advertised = false;
  private lastRefresh = Number.NEGATIVE_INFINITY;

  /** True once this relay has issued TURN servers, so it understands `ice-refresh`. */
  get supported(): boolean {
    return this.advertised;
  }

  update(servers: readonly DirectIceServer[], expiresInMs: number, now: number): void {
    this.relay = servers.map((server) => ({ ...server, urls: [...server.urls] }));
    this.expiresAt = now + expiresInMs;
    this.advertised = true;
  }

  servers(now: number): DirectIceServer[] {
    return directIceServers(now < this.expiresAt ? this.relay : []);
  }

  needsRefresh(now: number): boolean {
    return this.advertised && this.expiresAt - now <= ICE_REFRESH_BEFORE_MS;
  }

  /** Whether to send `ice-refresh` now; at most once per interval. */
  takeRefresh(now: number): boolean {
    if (!this.advertised || now - this.lastRefresh < REFRESH_INTERVAL_MS) return false;
    this.lastRefresh = now;
    return true;
  }
}
