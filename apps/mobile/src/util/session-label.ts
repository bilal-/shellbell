import type { SessionInfoLoose } from "@shellbell/protocol";
import { agentName } from "../input/agentPrompt";
import { statePill } from "./session-state";

type Named = Pick<SessionInfoLoose, "title" | "cwd" | "project" | "agent">;

/**
 * Display names for a session row, header and menu. The computer's optional `project` and
 * `agent` fields come from newer computers; older ones send only `title` and `cwd`, which keep
 * their earlier presentation apart from the shortened home folder.
 *
 * These are live, end-to-end-encrypted values: the task text in particular must stay out of the
 * persisted title cache, notifications and anything shown while the app is locked.
 */
export function sessionTitle(s: Named): string {
  const project = s.project?.trim();
  return project || s.title;
}

export type SessionSubtitle =
  | { kind: "agent"; agent: string; text: string }
  | { kind: "path"; text: string };

export function sessionSubtitle(s: Named): SessionSubtitle | undefined {
  if (s.agent) {
    const task = s.agent.task?.trim();
    return {
      kind: "agent",
      agent: s.agent.kind,
      text: task ? `${s.agent.kind} · ${task}` : s.agent.kind,
    };
  }
  return s.cwd ? { kind: "path", text: abbreviateHome(s.cwd) } : undefined;
}

const FRIENDLY_STATES: Record<string, string | null> = {
  unknown: null,
  running: "working",
  finished: "idle",
  blocked: "waiting for you",
  editing: "editing",
};

/** Everyday words for a session state; an unrecognised state keeps its own word. */
export function friendlyState(state: string): string | null {
  if (Object.hasOwn(FRIENDLY_STATES, state)) return FRIENDLY_STATES[state] ?? null;
  return state.trim() || null;
}

/**
 * The session header's second line: "Codex · idle" for an agent, otherwise the state, or the
 * terminal's name when the state says nothing. The agent's task stays in the list and menu.
 */
export function sessionStatusLine(s: Named & { state: string }, backend: string): string {
  const state = friendlyState(s.state);
  const kind = s.agent?.kind.trim();
  if (kind) {
    const agent = agentName(kind) ?? kind.charAt(0).toUpperCase() + kind.slice(1);
    return state ? `${agent} · ${state}` : agent;
  }
  return state ?? backend;
}

/**
 * The phone does not know the computer's home folder, so this recognises the conventional ones:
 * `/Users/<name>` (macOS), `/home/<name>` (Linux) and `/root`. Shared macOS folders stay whole.
 */
export function abbreviateHome(cwd: string): string {
  const match = /^(?:\/Users\/(?!Shared(?:\/|$))[^/]+|\/home\/[^/]+|\/root)(\/.*)?$/.exec(cwd);
  if (!match) return cwd;
  const rest = (match[1] ?? "").replace(/\/+$/, "");
  return rest ? `~${rest}` : "~";
}

/**
 * A group header: the backend, then the computer's workspace name or the window number, and the
 * desktop apps showing it when the computer reports them.
 */
export function groupLabel(
  backend: string,
  s: Pick<SessionInfoLoose, "windowNumber" | "windowLabel" | "shownIn">,
): { backend: string; name?: string; shownIn?: string } {
  const apps = (s.shownIn ?? []).map((app) => app.trim()).filter(Boolean);
  const shownIn = apps.length > 0 ? { shownIn: `in ${apps.join(" and ")}` } : {};
  const name = s.windowLabel?.trim();
  if (name) return { backend: backend.toUpperCase(), name, ...shownIn };
  return { backend: `${backend} · window ${s.windowNumber}`.toUpperCase(), ...shownIn };
}

export function sessionAccessibilityLabel(
  s: Named,
  o: { backend: string; state?: string; unread?: boolean },
): string {
  const subtitle = sessionSubtitle(s);
  const task = s.agent?.task?.trim();
  return [
    sessionTitle(s),
    ...(subtitle?.kind === "agent" ? [subtitle.agent, task] : [subtitle?.text]),
    o.backend,
    o.state === undefined ? undefined : statePill(o.state)?.label,
    o.unread ? "unread activity" : undefined,
  ]
    .filter(Boolean)
    .join(", ");
}
