import type { NamedKey } from "@shellbell/protocol";

/** Quick-keys row (spec 10.6). Paste is a separate button, not a `NamedKey`. */
export const QUICK_KEYS: { label: string; key: NamedKey }[] = [
  { label: "Esc", key: "esc" },
  { label: "Tab", key: "tab" },
  { label: "⌫", key: "backspace" },
  { label: "^C", key: "ctrl-c" },
  { label: "^D", key: "ctrl-d" },
  { label: "^Z", key: "ctrl-z" },
  { label: "^L", key: "ctrl-l" },
  { label: "^U", key: "ctrl-u" },
  { label: "↑", key: "up" },
  { label: "↓", key: "down" },
  { label: "←", key: "left" },
  { label: "→", key: "right" },
  { label: "⏎", key: "enter" },
  { label: "^R", key: "ctrl-r" },
  { label: "^A", key: "ctrl-a" },
  { label: "^E", key: "ctrl-e" },
];
