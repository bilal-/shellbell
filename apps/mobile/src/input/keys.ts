import type { NamedKey } from "@shellbell/protocol";

/**
 * One button in the quick-keys row (spec 10.6): a named terminal key, or a single character typed
 * as is (a coding agent's numbered choice). Paste is a separate button, not a key.
 */
export type QuickKey = { label: string } & (
  | { key: NamedKey; text?: undefined }
  | { text: string; key?: undefined }
);

const key = (label: string, name: NamedKey): QuickKey => ({ label, key: name });
const digit = (text: string): QuickKey => ({ label: text, text });

/** Keys behind the primary ones, in the same order for every session. */
const REST: QuickKey[] = [
  key("←", "left"),
  key("→", "right"),
  key("Backspace", "backspace"),
  key("^D", "ctrl-d"),
  key("^Z", "ctrl-z"),
  key("^L", "ctrl-l"),
  key("^U", "ctrl-u"),
  key("^R", "ctrl-r"),
  key("^A", "ctrl-a"),
  key("^E", "ctrl-e"),
];

/** A shell: the keys a phone keyboard lacks most often stay visible without scrolling. */
export const SHELL_PRIMARY_KEYS: QuickKey[] = [
  key("^C", "ctrl-c"),
  key("Tab", "tab"),
  key("↑", "up"),
  key("↓", "down"),
  key("Esc", "esc"),
  key("Enter", "enter"),
];
export const SHELL_KEYS: QuickKey[] = [
  ...SHELL_PRIMARY_KEYS,
  ...REST.slice(0, 3),
  key("⇧Tab", "shift-tab"),
  ...REST.slice(3),
];

/**
 * A coding agent (Claude Code, Codex): Esc interrupts, the arrows and Enter drive its menus,
 * Shift-Tab switches its mode and the digits pick a numbered choice. ^C stays in reach.
 */
export const AGENT_PRIMARY_KEYS: QuickKey[] = [
  key("Esc", "esc"),
  key("↑", "up"),
  key("↓", "down"),
  key("Enter", "enter"),
  key("⇧Tab", "shift-tab"),
  digit("1"),
  digit("2"),
  digit("3"),
  key("^C", "ctrl-c"),
];
export const AGENT_KEYS: QuickKey[] = [...AGENT_PRIMARY_KEYS, key("Tab", "tab"), ...REST];

/** The keys that stop or back out of what is running get a warning tint. */
export const WARNING_KEYS: ReadonlySet<NamedKey> = new Set(["esc", "ctrl-c"]);

export function quickKeys(agent: boolean): { keys: QuickKey[]; primary: number } {
  return agent
    ? { keys: AGENT_KEYS, primary: AGENT_PRIMARY_KEYS.length }
    : { keys: SHELL_KEYS, primary: SHELL_PRIMARY_KEYS.length };
}
