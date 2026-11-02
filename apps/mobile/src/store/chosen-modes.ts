import Storage from "expo-sqlite/kv-store";
import { create } from "zustand";
import type { ChatMode } from "../conversation/chat-mode";

const KEY = "shellbell.chosen-modes.v1";
/** Far more sessions than anyone keeps open; the oldest choices go first past it. */
export const CHOSEN_MODES_MAX = 200;

/** A session the computer listed, as far as telling one terminal from another goes. */
export interface ListedSession {
  readonly id: string;
  readonly instance?: string;
}

/** `[computer fingerprint, session ID, terminal instance, mode]`, oldest first. */
type Saved = readonly [string, string, string, ChatMode];

/**
 * The owner's Chat or Terminal pick per session, kept across restarts. Only sessions with a
 * terminal instance are kept here: without one, a reused session ID can't be told from the old
 * session, so the screen keeps that pick only while it is open.
 */
interface ChosenModesState {
  entries: Readonly<Record<string, ChatMode>>;
  hydrated: boolean;
  hydrate: () => void;
  choose: (fp: string, sessionId: string, instance: string, mode: ChatMode) => void;
  /** Forget picks for sessions missing from a computer's complete session list. */
  pruneSessions: (fp: string, sessions: readonly ListedSession[]) => void;
  /** Forget every pick for an unpaired computer. */
  forgetComputer: (fp: string) => void;
}

export function chosenModeKey(fp: string, sessionId: string, instance: string): string {
  return JSON.stringify([fp, sessionId, instance]);
}

function parse(key: string): [string, string, string] | null {
  try {
    const value = JSON.parse(key) as unknown;
    return Array.isArray(value) && value.length === 3 && value.every((v) => typeof v === "string")
      ? (value as [string, string, string])
      : null;
  } catch {
    return null;
  }
}

function read(): Record<string, ChatMode> {
  try {
    const raw = Storage.getItemSync(KEY);
    const saved = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(saved)) return {};
    const entries: Record<string, ChatMode> = {};
    for (const item of saved.slice(-CHOSEN_MODES_MAX)) {
      if (!Array.isArray(item) || item.length !== 4) continue;
      const [fp, sessionId, instance, mode] = item as unknown[];
      if (
        typeof fp === "string" &&
        typeof sessionId === "string" &&
        typeof instance === "string" &&
        (mode === "chat" || mode === "terminal")
      )
        entries[chosenModeKey(fp, sessionId, instance)] = mode;
    }
    return entries;
  } catch {
    return {};
  }
}

function write(entries: Readonly<Record<string, ChatMode>>): void {
  const saved: Saved[] = [];
  for (const [key, mode] of Object.entries(entries)) {
    const parts = parse(key);
    if (parts) saved.push([...parts, mode]);
  }
  try {
    Storage.setItemSync(KEY, JSON.stringify(saved));
  } catch {
    // A pick that can't be saved still holds for this run.
  }
}

export const useChosenModes = create<ChosenModesState>((set, get) => {
  /** Reads storage first, so an early change never overwrites what was saved. */
  const current = () => {
    if (!get().hydrated) get().hydrate();
    return get().entries;
  };
  const replace = (entries: Record<string, ChatMode>) => {
    set({ entries });
    write(entries);
  };
  return {
    entries: {},
    hydrated: false,
    hydrate: () => {
      if (!get().hydrated) set({ entries: read(), hydrated: true });
    },
    choose: (fp, sessionId, instance, mode) => {
      const key = chosenModeKey(fp, sessionId, instance);
      const { [key]: _previous, ...rest } = current();
      // The newest pick goes last, so the oldest are dropped first.
      const kept = Object.entries(rest).slice(-(CHOSEN_MODES_MAX - 1));
      replace({ ...Object.fromEntries(kept), [key]: mode });
    },
    pruneSessions: (fp, sessions) => {
      const listed = new Set(
        sessions.flatMap((s) => (s.instance ? [chosenModeKey(fp, s.id, s.instance)] : [])),
      );
      const entries = current();
      const kept = Object.entries(entries).filter(
        ([key]) => parse(key)?.[0] !== fp || listed.has(key),
      );
      if (kept.length !== Object.keys(entries).length) replace(Object.fromEntries(kept));
    },
    forgetComputer: (fp) => {
      const entries = current();
      const kept = Object.entries(entries).filter(([key]) => parse(key)?.[0] !== fp);
      if (kept.length !== Object.keys(entries).length) replace(Object.fromEntries(kept));
    },
  };
});
