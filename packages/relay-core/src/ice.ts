import type { CtrlMessageOf } from "@shellbell/protocol";
import type { TransitionContext } from "./computer.js";
import type { SessionRecord } from "./session.js";

/** TURN servers an operator's relay issues; credentials expire after `expiresInMs`. */
export interface IceServerIssue {
  iceServers: NonNullable<CtrlMessageOf<"auth-ok">["iceServers"]>;
  expiresInMs: number;
}
/** Returns null when TURN is not configured or temporarily unavailable. */
export type IceServerProvider = () => Promise<IceServerIssue | null>;

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;
/**
 * Longest a sign-in or refresh waits for a provider. Issuing runs inside the computer's
 * transition queue, so an unanswered provider would otherwise hold every later sign-in and
 * the unauthenticated-socket timeout behind it.
 */
export const TURN_ISSUE_TIMEOUT_MS = 5000;

/** A failing or slow provider only removes the TURN fallback; sign-in must not depend on it. */
export async function issueIceServers(c: TransitionContext): Promise<IceServerIssue | null> {
  if (!c.iceServers) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), TURN_ISSUE_TIMEOUT_MS);
  });
  try {
    const issue = await Promise.race([c.iceServers(), expired]);
    if (issue !== "expired") return issue;
    c.runtime.report("provider-failure");
    return null;
  } catch {
    c.runtime.report("provider-failure");
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** No servers, expiring now: a device keeps knowing the relay offers TURN, but has none to use. */
export const NO_ICE_SERVERS: IceServerIssue = { iceServers: [], expiresInMs: 0 };

/**
 * Whether this signed-in device may receive TURN servers. A computer that turned TURN off gets
 * none, and neither do its phones while it is signed in.
 */
export function turnWithheld(c: TransitionContext, session: SessionRecord): boolean {
  if (session.state === "agent") return session.turnOff === true;
  return session.state === "phone" && c.agent()?.turnOff === true;
}

/** Answer a signed-in device's refresh; extra requests within the interval are ignored. */
export async function refreshIceServers(
  c: TransitionContext,
  session: SessionRecord,
): Promise<void> {
  const now = c.runtime.now();
  const last = c.iceRefreshes.get(session.connId);
  if (last !== undefined && now - last < REFRESH_INTERVAL_MS) return;
  c.iceRefreshes.set(session.connId, now);
  const issue = turnWithheld(c, session) ? NO_ICE_SERVERS : await issueIceServers(c);
  if (!issue || !c.current(session)) return;
  // The computer may have turned TURN off while this request waited.
  if (turnWithheld(c, session) && issue !== NO_ICE_SERVERS) return;
  c.send(session, {
    type: "ice-servers",
    iceServers: issue.iceServers,
    iceExpiresInMs: issue.expiresInMs,
  });
}
