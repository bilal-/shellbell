import {
  classifyWebLink,
  type LocalOrigin,
  sameLocalPage,
  WEB_HOP_HEADERS,
  type WebHeader,
} from "@shellbell/protocol";
import type { CookieJar } from "./cookie-jar.js";

/** HTTP header bytes are latin1 on both sides; nothing here reinterprets them. */
export const headerText = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");
export const headerBytes = (text: string): Uint8Array =>
  new Uint8Array(Buffer.from(text, "latin1"));

/** Cookies the page's own door sets for itself; they never reach the target. */
const DOOR_COOKIE = /^__sb_/;
const LEAVE_PATH = "/__shellbell/leave?to=";

/** The cookie a page can't read, and the header the target expects it copied into. */
export const ANTI_FORGERY: ReadonlyArray<readonly [cookie: string, header: string]> = [
  ["_xsrf", "X-XSRFToken"],
  ["csrftoken", "X-CSRFToken"],
  ["XSRF-TOKEN", "X-XSRF-TOKEN"],
];

export interface RequestContext {
  method: string;
  path: string;
  headers: readonly WebHeader[];
  upgrade: boolean;
  target: LocalOrigin;
  jar: CookieJar;
  now: number;
}

/** Headers to send to the target, flat as Node's `rawHeaders`. */
export function upstreamRequestHeaders(context: RequestContext): string[] {
  const incoming = context.headers.map(([name, value]) => [name, headerText(value)] as const);
  const get = (name: string) => incoming.find(([n]) => n.toLowerCase() === name)?.[1];
  const connectionTokens = new Set(
    (get("connection") ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  // The door's own address, as the page sees it: the request's Host.
  const doorHost = get("host");
  const doorOrigin = doorHost ? `http://${doorHost}` : null;
  const out: string[] = ["Host", context.target.authority];
  let originMatched = false;
  const phoneCookies: Array<[string, string]> = [];
  for (const [name, value] of incoming) {
    const lower = name.toLowerCase();
    if (lower === "host" || WEB_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    if (lower === "cookie") {
      for (const part of value.split(";")) {
        const eq = part.indexOf("=");
        if (eq < 1) continue;
        const cookieName = part.slice(0, eq).trim();
        if (!DOOR_COOKIE.test(cookieName))
          phoneCookies.push([cookieName, part.slice(eq + 1).trim()]);
      }
      continue;
    }
    if (lower === "origin" && doorOrigin && value === doorOrigin) {
      originMatched = true;
      out.push(name, context.target.origin);
      continue;
    }
    if (
      lower === "referer" &&
      doorOrigin &&
      (value === doorOrigin || value.startsWith(`${doorOrigin}/`))
    ) {
      out.push(name, context.target.origin + value.slice(doorOrigin.length));
      continue;
    }
    out.push(name, value);
  }
  if (context.upgrade && (get("upgrade") ?? "").toLowerCase() === "websocket")
    out.push("Connection", "Upgrade", "Upgrade", "websocket");

  const jarCookies = context.jar.matching(context.path, context.now);
  const jarNames = new Set(jarCookies.map(([name]) => name));
  // The jar wins on a name clash; cookies the page set itself this visit follow (decision 16).
  const cookies = [...jarCookies, ...phoneCookies.filter(([name]) => !jarNames.has(name))];
  if (cookies.length) out.push("Cookie", cookies.map(([n, v]) => `${n}=${v}`).join("; "));

  if (context.method !== "GET" && originMatched) {
    const present = new Set(incoming.map(([name]) => name.toLowerCase()));
    for (const [cookie, header] of ANTI_FORGERY) {
      if (present.has(header.toLowerCase())) continue;
      const value = context.jar.value(cookie, context.path, context.now);
      if (value !== undefined) out.push(header, value);
    }
  }
  return out;
}

export interface ResponseContext {
  rawHeaders: readonly string[];
  requestPath: string;
  target: LocalOrigin;
  /** The address family that answered, for alias checks. */
  family: 4 | 6;
  jar: CookieJar;
  now: number;
}

/**
 * Headers to send to the phone. Cookies go into the jar, never to the phone. A `Location` on this
 * page stays on the door; any other becomes a `/__shellbell/leave` address, so a redirect never
 * carries the door's key to another port and a public site never loads inside Shellbell.
 */
export function phoneResponseHeaders(context: ResponseContext): WebHeader[] {
  const out: WebHeader[] = [];
  const raw = context.rawHeaders;
  const connectionTokens = new Set<string>();
  for (let i = 0; i + 1 < raw.length; i += 2)
    if (raw[i]?.toLowerCase() === "connection")
      for (const token of (raw[i + 1] ?? "").split(","))
        connectionTokens.add(token.trim().toLowerCase());
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const name = raw[i] as string;
    const value = raw[i + 1] as string;
    const lower = name.toLowerCase();
    if (WEB_HOP_HEADERS.has(lower) || connectionTokens.has(lower)) continue;
    if (lower === "strict-transport-security") continue;
    if (lower === "set-cookie") {
      context.jar.store(value, context.requestPath, context.now);
      continue;
    }
    if (lower === "location") {
      out.push([name, headerBytes(rewriteLocation(value, context))]);
      continue;
    }
    out.push([name, headerBytes(value)]);
  }
  return out;
}

export function rewriteLocation(
  location: string,
  context: Pick<ResponseContext, "target" | "family">,
): string {
  // Relative to the page: it already resolves against the door.
  if (location.startsWith("/") && !location.startsWith("//")) return location;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(location) && !location.startsWith("//")) return location;
  const absolute = location.startsWith("//") ? `http:${location}` : location;
  const link = classifyWebLink(absolute);
  if (
    link.kind === "local" &&
    (link.origin.origin === context.target.origin ||
      sameLocalPage(context.target, context.family, link.origin))
  )
    return link.path;
  return LEAVE_PATH + encodeURIComponent(absolute);
}
