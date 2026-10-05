import { sidToRoute } from "../util/routes";

/** Spec 9.1 / 6.2: a fingerprint is 26 lowercase base32 characters. */
export const FP_RE = /^[a-z2-7]{26}$/;

/** A session id encoded for the router (`sidToRoute`), i.e. unpadded base64url. */
const SID_ROUTE_RE = /^[A-Za-z0-9_-]{1,512}$/;

/** Where a ring or a deep link wants to land. `sessionRoute` is already router-encoded. */
export interface NavTarget {
  computerFp: string;
  sessionRoute: string | null;
}

/**
 * Spec 11.1: a push is a *hint*. Nothing in it is trusted beyond routing, and the computer it
 * names must already be paired on this phone or the tap is ignored entirely.
 */
export function resolveTarget(data: unknown, pairedFps: readonly string[]): NavTarget | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Record<string, unknown>;
  const fp = typeof d.computerFp === "string" ? d.computerFp : null;
  if (fp === null || !FP_RE.test(fp) || !pairedFps.includes(fp)) return null;
  const sid = typeof d.sessionId === "string" && d.sessionId.length > 0 ? d.sessionId : null;
  return { computerFp: fp, sessionRoute: sid === null ? null : sidToRoute(sid) };
}

/**
 * `shellbell://c/<fp>` or `shellbell://c/<fp>/s/<sid-route>` (the session segment is already
 * base64url — it comes straight out of a route, not out of a push payload). Same trust rule as
 * `resolveTarget`: an unpaired or malformed fingerprint yields `null`.
 */
export function parseDeepLink(url: string, pairedFps: readonly string[]): NavTarget | null {
  const m = /^shellbell:\/\/c\/([^/?#]+)(?:\/s\/([^/?#]+))?\/?(?:[?#].*)?$/.exec(url);
  if (m === null) return null;
  const fp = m[1];
  if (fp === undefined || !FP_RE.test(fp) || !pairedFps.includes(fp)) return null;
  const route = m[2] ?? null;
  if (route !== null && !SID_ROUTE_RE.test(route)) return null;
  return { computerFp: fp, sessionRoute: route };
}

/**
 * Foreground copy (spec 10.8). Deliberately mirrors the relay's generic push bodies (9.2) but may
 * name the session, because nothing leaves the device. `exit` and unknown kinds return `null`:
 * the session screen already renders "Session ended." and nothing should buzz for it (8.8).
 */
export function foregroundToast(sessionTitle: string, kind: string): string | null {
  switch (kind) {
    case "prompt":
      return `${sessionTitle}: command finished`;
    case "idle":
      return `${sessionTitle}: went quiet — waiting?`;
    case "blocked":
      return `${sessionTitle}: an agent is waiting for you`;
    default:
      return null;
  }
}

/** The pure half of the tap handler: parse + validate + route. Injected with live paired fps. */
export function createTapHandler(
  open: (t: NavTarget) => void,
  pairedFps: () => readonly string[],
): (data: unknown) => void {
  return (data) => {
    const target = resolveTarget(data, pairedFps());
    if (target !== null) open(target);
  };
}
