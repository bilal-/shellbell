import type { SessionInfoLoose } from "@shellbell/protocol";

/** Where an agent is, in the words the Agents list sorts and shows by. */
export type AgentPhase = "waiting" | "working" | "idle" | "unknown";

const PHASES: Record<string, AgentPhase> = {
  blocked: "waiting",
  running: "working",
  finished: "idle",
};
const ORDER: Record<AgentPhase, number> = { waiting: 0, working: 1, idle: 2, unknown: 2 };
/** An agent quiet for this long is dimmed in the list. */
export const AGENT_DIM_MS = 2 * 60 * 60 * 1000;

/**
 * `reportsStates` is whether the computer says which agents report their own state (newer
 * computers). There, an agent whose terminal can't tell shows its state as unknown, so one
 * waiting for permission is never shown as busy. Older computers keep today's words.
 */
export function agentPhase(session: SessionInfoLoose, reportsStates: boolean): AgentPhase {
  if (reportsStates && !session.agent?.reportsState) return "unknown";
  return PHASES[session.state] ?? "unknown";
}

/** "now", "5m", "3h" or "2d": how long ago, for a row's state. */
export function age(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

export function agentStateLabel(
  session: SessionInfoLoose,
  reportsStates: boolean,
  now: number,
): string {
  const phase = agentPhase(session, reportsStates);
  const word = {
    waiting: "waiting for you",
    working: "working",
    idle: "idle",
    unknown: "state unknown",
  }[phase];
  return phase !== "unknown" && session.stateSince !== undefined
    ? `${word} · ${age(Math.max(0, now - session.stateSince))}`
    : word;
}

/**
 * Sessions running an agent: waiting for you first, then working, then the rest by most recent
 * activity. Missing times sort last; ties fall back to project, then session ID, so the order
 * is stable.
 */
export function agentSessions(
  sessions: readonly SessionInfoLoose[],
  reportsStates: boolean,
): SessionInfoLoose[] {
  return sessions
    .filter((session) => session.agent)
    .sort(
      (a, b) =>
        ORDER[agentPhase(a, reportsStates)] - ORDER[agentPhase(b, reportsStates)] ||
        (b.activeAt ?? -1) - (a.activeAt ?? -1) ||
        (a.project ?? a.title).localeCompare(b.project ?? b.title) ||
        a.id.localeCompare(b.id),
    );
}

export function waitingCount(
  sessions: readonly SessionInfoLoose[],
  reportsStates: boolean,
): number {
  return sessions.filter(
    (session) => session.agent && agentPhase(session, reportsStates) === "waiting",
  ).length;
}

/**
 * `ids` in their latest order, but changing order at most every `RESORT_MS`: new rows join in
 * their sorted place and keep it, removed ones leave at once, and a row whose rank changed waits
 * for the next re-sort.
 */
export function settleOrder(shown: readonly string[], ids: readonly string[]): string[] {
  const present = new Set(ids);
  const kept = shown.filter((id) => present.has(id));
  const known = new Set(kept);
  for (const [index, id] of ids.entries()) if (!known.has(id)) kept.splice(index, 0, id);
  return kept;
}
