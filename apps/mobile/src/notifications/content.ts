/**
 * Builds the enriched notification that replaces the relay's generic one (spec 2026-09-20 §2/§4).
 * Pure: the caller supplies the title lookup, so this is testable without storage or Expo.
 */
export interface RingPayload {
  computerFp: string;
  sessionId: string;
  kind: string;
  // Structurally assignable to `expo-notifications`' `NotificationContentInput.data`
  // (`Record<string, unknown>`) so `buildScheduleInput` (ring.ts) needs no cast at the Expo
  // boundary.
  [key: string]: unknown;
}

export interface SessionLabel {
  title: string;
  backend: string;
}

export type TitleLookup = (fp: string, sessionId: string) => SessionLabel | undefined;

/** Mirrors `pushBody()` in apps/relay/src/push.ts so the replacement reads as a refinement. */
function bodyFor(kind: string): string {
  switch (kind) {
    case "prompt":
      return "A command finished";
    case "idle":
      return "A session went quiet — waiting for you?";
    case "blocked":
      return "An agent is waiting for you";
    default:
      return "A session needs attention";
  }
}

const BACKEND_LABEL: Record<string, string> = {
  iterm2: "iTerm2",
  tmux: "tmux",
  herdr: "Herdr",
};

/**
 * Spec §6: never render a raw session id — it is opaque and means nothing to a human. Fall back to
 * the backend label, then to a generic word.
 */
function titleFor(label: SessionLabel | undefined): string {
  if (label?.title) return label.title;
  const backend = label?.backend;
  if (backend && BACKEND_LABEL[backend]) return BACKEND_LABEL[backend] as string;
  return "Session";
}

/** One definition of the identifier, shared by the presenter and the dismisser. */
export function notificationIdFor(fp: string, sessionId: string): string {
  return `${fp}:${sessionId}`;
}

export interface RingNotification {
  identifier: string;
  title: string;
  body: string;
  /**
   * Spec §6: tapping the notification must still open the session. `data` carries the same
   * `{computerFp, sessionId, kind}` the relay's generic notification carried, so the existing
   * `resolveTarget` (`routing.ts`) tap path keeps working unchanged (review C1).
   */
  data: RingPayload;
}

export function buildRingNotification(payload: RingPayload, lookup: TitleLookup): RingNotification {
  return {
    identifier: notificationIdFor(payload.computerFp, payload.sessionId),
    title: titleFor(lookup(payload.computerFp, payload.sessionId)),
    body: bodyFor(payload.kind),
    data: payload,
  };
}
