import type { SessionInfoLoose } from "@shellbell/protocol";
import { friendlyState } from "./session-label";

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
  const vouched = !reportsStates || !!session.agent?.reportsState;
  // A state with no phase, such as `editing`, keeps the header's word for it; only an agent the
  // terminal can't report on is "state unknown".
  const word =
    phase === "unknown"
      ? (vouched && friendlyState(session.state)) || "state unknown"
      : { waiting: "waiting for you", working: "working", idle: "idle" }[phase];
  return phase !== "unknown" && session.stateSince !== undefined
    ? `${word} · ${age(Math.max(0, now - session.stateSince))}`
    : word;
}

/** What an Agents row shows, worked out once per list rather than in each row's render. */
export interface AgentRow {
  readonly session: SessionInfoLoose;
  readonly label: string;
  readonly tone: "alert" | "active" | "muted";
  /** The terminal or workspace, when another row has the same project and task. */
  readonly place?: string;
  readonly dim: boolean;
  readonly conversation: boolean;
}

export function agentRows(
  sessions: readonly SessionInfoLoose[],
  options: {
    readonly reportsStates: boolean;
    readonly now: number;
    readonly placeOf: (session: SessionInfoLoose) => string | undefined;
    readonly conversation: (session: SessionInfoLoose) => boolean;
  },
): AgentRow[] {
  const work = (s: SessionInfoLoose) => `${s.project ?? s.title}\n${s.agent?.task ?? ""}`;
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(work(s), (counts.get(work(s)) ?? 0) + 1);
  return sessions.map((session) => {
    const phase = agentPhase(session, options.reportsStates);
    return {
      session,
      label: agentStateLabel(session, options.reportsStates, options.now),
      tone: phase === "waiting" ? "alert" : phase === "working" ? "active" : "muted",
      ...((counts.get(work(session)) ?? 0) > 1 ? { place: options.placeOf(session) } : {}),
      dim:
        phase !== "waiting" &&
        session.activeAt !== undefined &&
        options.now - session.activeAt > AGENT_DIM_MS,
      conversation: options.conversation(session),
    };
  });
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
