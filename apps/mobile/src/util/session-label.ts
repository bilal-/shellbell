import type { SessionInfoLoose } from "@shellbell/protocol";
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

/** A group header: the backend, then the computer's workspace name or the window number. */
export function groupLabel(
  backend: string,
  s: Pick<SessionInfoLoose, "windowNumber" | "windowLabel">,
): { backend: string; name?: string } {
  const name = s.windowLabel?.trim();
  if (name) return { backend: backend.toUpperCase(), name };
  return { backend: `${backend} · window ${s.windowNumber}`.toUpperCase() };
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
