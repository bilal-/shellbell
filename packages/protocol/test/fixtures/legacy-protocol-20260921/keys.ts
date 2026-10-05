import { z } from "zod";

const LETTERS = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
] as const;
type Letter = (typeof LETTERS)[number];
type CtrlKey = `ctrl-${Letter}`;
const ctrl = Object.fromEntries(
  LETTERS.map((c, i) => [`ctrl-${c}`, String.fromCharCode(i + 1)]),
) as Record<CtrlKey, string>;

export const NAMED_KEYS = {
  enter: "\r",
  tab: "\t",
  "shift-tab": "\x1b[Z",
  esc: "\x1b",
  backspace: "\x7f",
  delete: "\x1b[3~",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  "page-up": "\x1b[5~",
  "page-down": "\x1b[6~",
  "ctrl-space": "\x00",
  ...ctrl,
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f6: "\x1b[17~",
  f7: "\x1b[18~",
  f8: "\x1b[19~",
  f9: "\x1b[20~",
  f10: "\x1b[21~",
  f11: "\x1b[23~",
  f12: "\x1b[24~",
} as const satisfies Record<string, string>;

export type NamedKey = keyof typeof NAMED_KEYS;
export const NamedKeySchema = z.enum(Object.keys(NAMED_KEYS) as [NamedKey, ...NamedKey[]]);

export function bytesForKey(k: NamedKey): string {
  return NAMED_KEYS[k];
}
