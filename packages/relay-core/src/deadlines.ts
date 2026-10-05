import type { ComputerRecord, PairingWindow } from "./ports/models.js";
import type { SessionRecord } from "./session.js";

export const UNAUTH_TIMEOUT_MS = 10_000;
export const PAIRING_TIMEOUT_MS = 90_000;
export const GC_AFTER_MS = 90 * 24 * 3600 * 1000;
export const ORPHAN_GC_MS = 60_000;

/** Runtime scheduling mechanics do not influence the domain deadline. */
export function nextDeadline(
  now: number,
  sessions: readonly SessionRecord[],
  computer: ComputerRecord | null,
  window: PairingWindow | null,
  notification: number | null,
): number | null {
  const deadlines: number[] = [];
  for (const session of sessions) {
    if (session.state === "unauth") deadlines.push(session.since + UNAUTH_TIMEOUT_MS);
    if (session.state === "pairing") deadlines.push(session.since + PAIRING_TIMEOUT_MS);
  }
  if (window) deadlines.push(window.expiresAt);
  if (computer && !sessions.some((s) => s.state === "agent"))
    deadlines.push(computer.lastSeen + GC_AFTER_MS);
  if (!computer && sessions.length) deadlines.push(now + ORPHAN_GC_MS);
  if (notification !== null) deadlines.push(notification);
  return deadlines.length ? Math.min(...deadlines) : null;
}
