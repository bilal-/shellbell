import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";

/**
 * Herdr validates every key name before writing bytes, so one unknown name fails
 * the whole `pane.send_keys` call. This table contains names checked against Herdr's
 * grammar. `delete`, `home`, `end`, `page-up`, `page-down` and `ctrl-space` are absent;
 * their raw bytes go through `pane.send_text`, which requires no key parsing.
 * The local capture script and fixtures exercise the accepted names.
 */
export const HERDR_KEYS: Partial<Record<NamedKey, string>> = buildHerdrKeys();

function buildHerdrKeys(): Partial<Record<NamedKey, string>> {
  const out: Partial<Record<NamedKey, string>> = {
    enter: "enter",
    tab: "tab",
    "shift-tab": "shift+tab",
    esc: "esc",
    backspace: "backspace",
    up: "up",
    down: "down",
    left: "left",
    right: "right",
  };
  for (const name of Object.keys(NAMED_KEYS) as NamedKey[]) {
    if (/^ctrl-[a-z]$/.test(name)) out[name] = `ctrl+${name.slice(5)}`;
    else if (/^f([1-9]|1[0-2])$/.test(name)) out[name] = name;
  }
  return out;
}

/**
 * Reverse map: the exact byte string the agent hands `sendText` -> a Herdr key name.
 * `\r` (Enter), `\n` (also Enter — herdr has no separate name) and `\t` (Tab) are here on purpose:
 * `pane.send_text` writes literal bytes and does **not** submit, so a line typed on the phone would
 * never be executed if its trailing CR went through as text. They are inserted first, so the
 * `ctrl-m`/`ctrl-j`/`ctrl-i` aliases that share those bytes never claim them.
 */
const BYTES_TO_HERDR = buildByteMap();

function buildByteMap(): Map<string, string> {
  const out = new Map<string, string>([
    ["\r", "enter"],
    ["\n", "enter"],
    ["\t", "tab"],
  ]);
  for (const [name, bytes] of Object.entries(NAMED_KEYS) as [NamedKey, string][]) {
    const herdr = HERDR_KEYS[name];
    if (herdr && !out.has(bytes)) out.set(bytes, herdr);
  }
  return out;
}

export function herdrKeyForBytes(text: string): string | undefined {
  return BYTES_TO_HERDR.get(text);
}
