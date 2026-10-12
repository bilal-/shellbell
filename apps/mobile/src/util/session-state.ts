export type StateTone = "muted" | "active" | "alert";

export interface StatePill {
  label: string;
  tone: StateTone;
}

const KNOWN: Record<string, StatePill | null> = {
  unknown: null,
  editing: { label: "editing", tone: "muted" },
  running: { label: "running", tone: "active" },
  finished: { label: "finished", tone: "muted" },
  // spec 8.13/10.6: an agent is waiting for a human. First-class, not a flavour of `running`.
  blocked: { label: "blocked", tone: "alert" },
};

/** `null` means "render no pill". An unrecognised state renders its raw string, muted. */
export function statePill(state: string): StatePill | null {
  if (state in KNOWN) return KNOWN[state] ?? null;
  return { label: state, tone: "muted" };
}

/** The cursor blinks only while the session is doing something (spec 10.5). */
export function cursorBlinks(state: string): boolean {
  return state === "running" || state === "editing" || state === "blocked";
}

/** Reply chips are for "the terminal is waiting on you" (spec 10.6). */
export function wantsReply(state: string, lastEventKind: string | undefined): boolean {
  return (
    state === "running" ||
    state === "blocked" ||
    lastEventKind === "idle" ||
    lastEventKind === "blocked"
  );
}

/**
 * A session is "ended" once the app has already rendered it (a cached `view` exists) but its id
 * has dropped out of the computer's `sessions` list. Until a view has ever arrived, an empty or
 * missing entry just means the app is still connecting — not that the session ended.
 */
export function sessionEnded(
  sessions: { id: string }[],
  sid: string,
  view: unknown | undefined,
): boolean {
  return view !== undefined && !sessions.some((s) => s.id === sid);
}
