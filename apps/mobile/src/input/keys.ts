import type { NamedKey } from "@shellbell/protocol";

/**
 * Quick-keys row (spec 10.6). The first six are the keys a phone keyboard lacks most often and
 * stay visible without scrolling; the rest follow. Paste is a separate button, not a `NamedKey`.
 */
export const PRIMARY_KEY_COUNT = 6;
export const QUICK_KEYS: { label: string; key: NamedKey }[] = [
  { label: "^C", key: "ctrl-c" },
  { label: "Esc", key: "esc" },
  { label: "Tab", key: "tab" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "Enter", key: "enter" },
  { label: "←", key: "left" },
  { label: "→", key: "right" },
  { label: "Backspace", key: "backspace" },
  { label: "^D", key: "ctrl-d" },
  { label: "^Z", key: "ctrl-z" },
  { label: "^L", key: "ctrl-l" },
  { label: "^U", key: "ctrl-u" },
  { label: "^R", key: "ctrl-r" },
  { label: "^A", key: "ctrl-a" },
  { label: "^E", key: "ctrl-e" },
];
