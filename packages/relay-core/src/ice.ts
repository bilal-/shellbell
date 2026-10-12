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

/** A failing provider only removes the TURN fallback; sign-in must not depend on it. */
export async function issueIceServers(c: TransitionContext): Promise<IceServerIssue | null> {
  if (!c.iceServers) return null;
  try {
    return await c.iceServers();
  } catch {
    c.runtime.report("provider-failure");
    return null;
  }
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
  const issue = await issueIceServers(c);
  if (!issue || !c.current(session)) return;
  c.send(session, {
    type: "ice-servers",
    iceServers: issue.iceServers,
    iceExpiresInMs: issue.expiresInMs,
  });
}
