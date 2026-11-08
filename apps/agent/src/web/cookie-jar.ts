/**
 * Every page cookie lives here, in memory, per (phone, cookie host); the phone never holds one.
 * A subset of RFC 6265 for loopback pages: host-only cookies (a `Domain` attribute never widens
 * them, so `alice.localhost` and `bob.localhost` stay apart), paths, `Max-Age` and `Expires`.
 * `Secure` cookies are kept, as browsers treat localhost as secure.
 */

export const COOKIE_LIMITS = {
  perHost: 180,
  cookieBytes: 4096,
  /** A local address's jar is dropped after this long unused. */
  idleMs: 24 * 60 * 60 * 1000,
} as const;

interface Cookie {
  name: string;
  value: string;
  path: string;
  /** Milliseconds since the epoch, or null for a cookie that lasts the visit's jar. */
  expires: number | null;
  created: number;
}

export class CookieJar {
  private cookies: Cookie[] = [];
  lastUsed: number;

  constructor(now: number) {
    this.lastUsed = now;
  }

  /** Stores one `Set-Cookie` header value received for a request to `requestPath`. */
  store(header: string, requestPath: string, now: number): void {
    this.lastUsed = now;
    if (header.length > COOKIE_LIMITS.cookieBytes) return;
    const [pair = "", ...attributes] = header.split(";");
    const eq = pair.indexOf("=");
    if (eq < 1) return; // a nameless cookie isn't worth the ambiguity
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name || /[\s;,=]/.test(name)) return;
    let path: string | null = null;
    let expires: number | null = null;
    let maxAgeSeen = false;
    for (const attribute of attributes) {
      const at = attribute.indexOf("=");
      const key = (at === -1 ? attribute : attribute.slice(0, at)).trim().toLowerCase();
      const raw = at === -1 ? "" : attribute.slice(at + 1).trim();
      if (key === "max-age" && /^-?\d+$/.test(raw)) {
        const seconds = Number(raw);
        expires = seconds <= 0 ? 0 : now + seconds * 1000;
        maxAgeSeen = true;
      } else if (key === "expires" && !maxAgeSeen) {
        const time = Date.parse(raw);
        if (!Number.isNaN(time)) expires = time;
      } else if (key === "path" && raw.startsWith("/")) path = raw;
    }
    if (name.startsWith("__Host-") && path !== "/") return;
    const cookiePath = path ?? defaultPath(requestPath);
    const index = this.cookies.findIndex((c) => c.name === name && c.path === cookiePath);
    const existing = index === -1 ? undefined : this.cookies[index];
    if (existing) this.cookies.splice(index, 1);
    if (expires !== null && expires <= now) return; // deletion
    this.cookies.push({
      name,
      value,
      path: cookiePath,
      expires,
      created: existing?.created ?? now,
    });
    if (this.cookies.length > COOKIE_LIMITS.perHost) {
      this.cookies.sort((a, b) => a.created - b.created);
      this.cookies.splice(0, this.cookies.length - COOKIE_LIMITS.perHost);
    }
  }

  /** The cookies for a request, longest path first, then oldest first (RFC 6265 5.4). */
  matching(requestPath: string, now: number): Array<[string, string]> {
    this.lastUsed = now;
    this.cookies = this.cookies.filter((c) => c.expires === null || c.expires > now);
    const path = requestPath.split("?")[0] ?? "/";
    return this.cookies
      .filter((c) => pathMatches(path, c.path))
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created)
      .map((c) => [c.name, c.value]);
  }

  /** A cookie's value by name, for the anti-forgery headers. */
  value(name: string, requestPath: string, now: number): string | undefined {
    return this.matching(requestPath, now).find(([n]) => n === name)?.[1];
  }

  get size(): number {
    return this.cookies.length;
  }
}

function defaultPath(requestPath: string): string {
  const path = requestPath.split("?")[0] ?? "/";
  if (!path.startsWith("/")) return "/";
  const last = path.lastIndexOf("/");
  return last <= 0 ? "/" : path.slice(0, last);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

/** All jars, per phone and cookie host. Dropped when the phone is unpaired. */
export class CookieJars {
  private readonly phones = new Map<string, Map<string, CookieJar>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The jar for a cookie host (the host name without its port). */
  jar(phoneFp: string, cookieHost: string): CookieJar {
    this.sweep();
    let hosts = this.phones.get(phoneFp);
    if (!hosts) {
      hosts = new Map();
      this.phones.set(phoneFp, hosts);
    }
    let jar = hosts.get(cookieHost);
    if (!jar) {
      jar = new CookieJar(this.now());
      hosts.set(cookieHost, jar);
    }
    return jar;
  }

  /** Retire only this registered server instance, preserving other pages on the same host. */
  dropScope(scope: string): void {
    for (const hosts of this.phones.values()) hosts.delete(scope);
  }
  dropPhone(phoneFp: string): void {
    this.phones.delete(phoneFp);
  }

  /** Keeps only these phones' jars, as pairings change. */
  retain(phoneFps: ReadonlySet<string>): void {
    for (const fp of [...this.phones.keys()]) if (!phoneFps.has(fp)) this.phones.delete(fp);
  }

  private sweep(): void {
    const cutoff = this.now() - COOKIE_LIMITS.idleMs;
    for (const [fp, hosts] of this.phones) {
      for (const [host, jar] of hosts) if (jar.lastUsed < cutoff) hosts.delete(host);
      if (hosts.size === 0) this.phones.delete(fp);
    }
  }
}
