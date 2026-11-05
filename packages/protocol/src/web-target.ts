/**
 * Which addresses Shellbell opens itself: plain `http` on a loopback name of the paired computer.
 * Parsed by hand because React Native's `URL` doesn't implement `hostname` or `port`.
 */

export type LocalHost =
  | { kind: "ipv4" } // 127.0.0.1
  | { kind: "ipv6" } // [::1]
  | { kind: "name"; name: string }; // localhost or *.localhost

export interface LocalOrigin {
  /** `http://<authority>`, lower-cased, with the port only when it was written. */
  origin: string;
  /** The authority as written, such as `localhost:5173`; the `Host` header the target sees. */
  authority: string;
  host: LocalHost;
  port: number;
}

export type WebLink =
  | { kind: "local"; origin: LocalOrigin; path: string }
  | { kind: "secure-local" }
  | { kind: "public" }
  | { kind: "refused" };

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function parseHost(raw: string): LocalHost | "public" | null {
  const host = raw.toLowerCase();
  if (host === "127.0.0.1") return { kind: "ipv4" };
  if (host === "[::1]") return { kind: "ipv6" };
  // A server that says it listens on every address is reachable as localhost.
  if (host === "localhost" || host === "0.0.0.0" || host === "[::]")
    return { kind: "name", name: "localhost" };
  if (host.endsWith(".localhost")) {
    const labels = host.slice(0, -".localhost".length).split(".");
    return labels.every((label) => LABEL.test(label)) ? { kind: "name", name: host } : null;
  }
  if (host.length === 0 || /[\s<>"{}|\\^`]/.test(host)) return null;
  return "public";
}

function hostText(host: LocalHost): string {
  if (host.kind === "ipv4") return "127.0.0.1";
  if (host.kind === "ipv6") return "[::1]";
  return host.name;
}

interface Split {
  scheme: string;
  userinfo: boolean;
  host: string;
  port: string | null;
  rest: string;
}

function split(url: string): Split | null {
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/([^/?#]*)(.*)$/s.exec(url.trim());
  if (!match) return null;
  const [, scheme, authority, rest] = match as unknown as [string, string, string, string];
  const at = authority.lastIndexOf("@");
  const hostPort = at === -1 ? authority : authority.slice(at + 1);
  const bracket = /^(\[[^\]]*\])(?::(\d*))?$/.exec(hostPort);
  const plain = /^([^:[\]]*)(?::(\d*))?$/.exec(hostPort);
  const parts = bracket ?? plain;
  if (!parts) return null;
  return {
    scheme: scheme.toLowerCase(),
    userinfo: at !== -1,
    host: parts[1] ?? "",
    port: parts[2] === undefined || parts[2] === "" ? null : parts[2],
    rest,
  };
}

function localOrigin(host: LocalHost, port: string | null): LocalOrigin | null {
  const number = port === null ? 80 : Number(port);
  if (!Number.isInteger(number) || number < 1 || number > 65_535) return null;
  const authority = port === null ? hostText(host) : `${hostText(host)}:${number}`;
  return { origin: `http://${authority}`, authority, host, port: number };
}

/** Parses an origin the phone sends in `web.open`. Null for anything that isn't local `http`. */
export function parseLocalOrigin(origin: string): LocalOrigin | null {
  const parts = split(origin);
  if (parts?.scheme !== "http" || parts.userinfo || parts.rest !== "") return null;
  const host = parseHost(parts.host);
  if (host === null || host === "public") return null;
  return localOrigin(host, parts.port);
}

/** Classifies a link the person tapped, or a page navigation. */
export function classifyWebLink(url: string): WebLink {
  const parts = split(url);
  if (!parts) return { kind: "refused" };
  if (parts.scheme !== "http" && parts.scheme !== "https") return { kind: "refused" };
  const host = parseHost(parts.host);
  if (host === null) return { kind: "refused" };
  if (host === "public") return { kind: "public" };
  // `http://localhost@example.com` reads as local to a person but isn't to a browser.
  if (parts.userinfo) return { kind: "refused" };
  if (parts.scheme === "https") return { kind: "secure-local" };
  const origin = localOrigin(host, parts.port);
  if (!origin) return { kind: "refused" };
  const path = parts.rest.split("#")[0] ?? "";
  return { kind: "local", origin, path: path.startsWith("/") ? path : `/${path}` };
}

/** Where to connect, in order. Numeric addresses keep their family; names try IPv4 then IPv6. */
export function connectAddresses(host: LocalHost): Array<{ address: string; family: 4 | 6 }> {
  if (host.kind === "ipv4") return [{ address: "127.0.0.1", family: 4 }];
  if (host.kind === "ipv6") return [{ address: "::1", family: 6 }];
  return [
    { address: "127.0.0.1", family: 4 },
    { address: "::1", family: 6 },
  ];
}

/**
 * Whether `other` is this page under another name (3.4 aliases): the same port, the same address
 * family as the one that answered, and for `*.localhost` the same name.
 */
export function sameLocalPage(page: LocalOrigin, family: 4 | 6, other: LocalOrigin): boolean {
  if (page.port !== other.port) return false;
  const a = page.host;
  const b = other.host;
  if (a.kind === "name" && a.name !== "localhost") return b.kind === "name" && b.name === a.name;
  if (b.kind === "name") return b.name === "localhost";
  return b.kind === (family === 4 ? "ipv4" : "ipv6");
}
