import type { BackendDescriptor, SessionInfoLoose } from "@shellbell/protocol";
import { chatNoneText } from "../conversation/chat-status";
import { agentName } from "../input/agentPrompt";
import { backendLabel } from "./backends";
import { abbreviateHome, friendlyState } from "./session-label";

/** A kind of session the list can be filtered to: where it runs, or what runs in it. */
export interface SessionType {
  readonly kind: "terminal" | "agent" | "shell";
  readonly value: string;
  readonly label: string;
}

/** Shells a terminal title can name outright, such as `zsh` or a login `-bash`. */
const SHELL = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|csh|nu|pwsh|elvish|xonsh)$/;

/** The shell a session's title names, when it names nothing else. */
export function sessionShell(session: Pick<SessionInfoLoose, "title" | "agent">): string | null {
  if (session.agent) return null;
  return SHELL.exec(session.title.trim())?.[1] ?? null;
}

/** Where a session runs (Herdr, tmux, iTerm2) and what runs in it (an agent or a shell). */
export function sessionTypes(
  session: SessionInfoLoose,
  catalog?: readonly BackendDescriptor[],
): { terminal: SessionType; runs: SessionType | null } {
  const terminal: SessionType = {
    kind: "terminal",
    value: session.backend,
    label: backendLabel(session.backend, catalog),
  };
  const kind = session.agent?.kind;
  if (kind) {
    const label = agentName(kind);
    return {
      terminal,
      runs: label ? { kind: "agent", value: kind.trim().toLowerCase(), label } : null,
    };
  }
  const shell = sessionShell(session);
  return { terminal, runs: shell ? { kind: "shell", value: shell, label: shell } : null };
}

export function sameType(a: SessionType | null, b: SessionType | null): boolean {
  return a?.kind === b?.kind && a?.value === b?.value;
}

/** Whether a session is of the filter's type; no filter shows everything. */
export function matchesFilter(
  session: SessionInfoLoose,
  filter: SessionType | null,
  catalog?: readonly BackendDescriptor[],
): boolean {
  if (!filter) return true;
  const types = sessionTypes(session, catalog);
  return filter.kind === "terminal"
    ? sameType(types.terminal, filter)
    : sameType(types.runs, filter);
}

/**
 * The types the filter row offers: terminal apps when the list has more than one, and agents or
 * shells when it has more than one of those. Empty when filtering wouldn't change anything.
 */
export function filterOptions(
  sessions: readonly SessionInfoLoose[],
  catalog?: readonly BackendDescriptor[],
): SessionType[] {
  const terminals = new Map<string, SessionType>();
  const runs = new Map<string, SessionType>();
  for (const session of sessions) {
    const types = sessionTypes(session, catalog);
    terminals.set(types.terminal.value, types.terminal);
    if (types.runs) runs.set(`${types.runs.kind}:${types.runs.value}`, types.runs);
  }
  // "What runs" splits the list only if some sessions differ: two kinds, or one kind and rows
  // the type can't name.
  const unnamed = sessions.some((session) => !sessionTypes(session, catalog).runs);
  return [
    ...(terminals.size > 1 ? terminals.values() : []),
    ...(runs.size > 1 || (runs.size === 1 && unnamed) ? runs.values() : []),
  ];
}

const CHAT_STATE: Record<string, string> = {
  finding: "Looking for the chat",
  found: "Found",
  none: "None",
};

/** The details sheet's lines, from fields the session list already carries. Empty ones are left out. */
export function sessionDetails(
  session: SessionInfoLoose,
  catalog?: readonly BackendDescriptor[],
): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null | undefined) => {
    if (value) lines.push({ label, value });
  };
  const shell = sessionShell(session);
  add("Shell", shell);
  add("Folder", session.cwd ? abbreviateHome(session.cwd) : null);
  const terminal = backendLabel(session.backend, catalog);
  add(
    "Terminal app",
    session.shownIn?.length ? `${terminal} · in ${session.shownIn.join(", ")}` : terminal,
  );
  add(
    "Window, tab and pane",
    [
      session.windowLabel ?? `Window ${session.windowNumber}`,
      `tab ${session.tabIndex + 1}`,
      `pane ${session.paneIndex + 1}`,
    ].join(" · "),
  );
  add(session.backend === "tmux" ? "tmux server" : "Terminal instance", session.instance);
  if (session.agent) {
    const name = agentName(session.agent.kind) ?? session.agent.kind;
    const state = friendlyState(session.state) ?? session.state;
    add("Agent", [name, state, session.agent.task].filter(Boolean).join(" · "));
  } else add("State", friendlyState(session.state) ?? session.state);
  if (session.chat) {
    const state = CHAT_STATE[session.chat.state] ?? session.chat.state;
    add(
      "Chat",
      session.chat.state === "none"
        ? `${state} · ${chatNoneText(session.chat.reason, session.chat.agent ?? session.agent?.kind)}`
        : state,
    );
  }
  return lines;
}
