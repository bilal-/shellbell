import { NAMED_KEYS, type NamedKey } from "@shellbell/protocol";

const FIXED: Partial<Record<NamedKey, string>> = {
  enter: "Enter",
  tab: "Tab",
  "shift-tab": "BTab",
  esc: "Escape",
  backspace: "BSpace",
  delete: "DC",
  up: "Up",
  down: "Down",
  right: "Right",
  left: "Left",
  home: "Home",
  end: "End",
  "page-up": "PPage",
  "page-down": "NPage",
  "ctrl-space": "C-Space",
};

/** "Input": the tmux key names accepted by `send-keys -t %N <Name>`. */
export function tmuxKeyName(k: NamedKey): string {
  const fixed = FIXED[k];
  if (fixed) return fixed;
  if (k.startsWith("ctrl-")) return `C-${k.slice(5)}`;
  if (/^f([1-9]|1[0-2])$/.test(k)) return k.toUpperCase();
  throw new Error(`no tmux key for ${k}`);
}

/**
 * Reverse map: the exact byte string `agent.ts` hands `sendText` -> a tmux key name.
 * `\r`, `\n` and `\t` are inserted FIRST on purpose: `NAMED_KEYS` aliases those exact bytes as
 * `ctrl-m`/`ctrl-j`/`ctrl-i`, and a map built by iteration order alone would let the alias win --
 * a phone's Enter would go out as `C-m`. Same construction as `herdr/keys.ts`'s `BYTES_TO_HERDR`.
 */
const BYTES_TO_TMUX = buildByteMap();

function buildByteMap(): Map<string, string> {
  const out = new Map<string, string>([
    ["\r", "Enter"],
    ["\n", "Enter"],
    ["\t", "Tab"],
  ]);
  for (const [name, bytes] of Object.entries(NAMED_KEYS) as [NamedKey, string][]) {
    if (!out.has(bytes)) out.set(bytes, tmuxKeyName(name));
  }
  return out;
}

export function tmuxKeyForBytes(text: string): string | undefined {
  return text ? BYTES_TO_TMUX.get(text) : undefined;
}
