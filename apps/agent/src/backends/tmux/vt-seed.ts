import { VT_CONTINUATION_PREAMBLE } from "@shellbell/protocol";

/**
 * Rebuilds a tmux pane's terminal state as bytes, so a fresh xterm can continue from a
 * `TmuxControl.checkpoint` with the pane's own output. Writing `buildSeed`'s result and then the
 * pane bytes that follow the checkpoint gives the same screen as an xterm fed every byte from
 * the start, apart from state tmux does not export: the current pen, character sets, the saved
 * cursor of the active screen, a pending wrap at the right margin, and tabs written under
 * different tab stops.
 */

/** tmux formats `buildSeed` reads, in reply order. */
const STATE = [
  "history_size",
  "pane_width",
  "pane_height",
  "cursor_x",
  "cursor_y",
  "scroll_region_upper",
  "scroll_region_lower",
  "origin_flag",
  "wrap_flag",
  "insert_flag",
  "cursor_flag",
  "keypad_cursor_flag",
  "keypad_flag",
  "alternate_on",
  "alternate_saved_x",
  "alternate_saved_y",
  "pane_tabs",
  "cursor_shape",
  "cursor_blinking",
] as const;

type State = Record<(typeof STATE)[number], string>;

/**
 * One tmux command list for `TmuxControl.checkpoint`. tmux parses no pane output between its
 * commands, so the replies describe one moment. `-J` rejoins wrapped lines, which the receiving
 * xterm wraps again at the same width. `historyLines` keeps only the newest history lines.
 */
export function seedCommands(pane: string, historyLines?: number): string[] {
  if (!/^%\d+$/.test(pane)) throw new Error("invalid tmux pane id");
  // At least one line: `-S -0 -E -1` would capture the first visible row as history.
  if (historyLines !== undefined && !(Number.isSafeInteger(historyLines) && historyLines >= 1)) {
    throw new Error("invalid history line count");
  }
  const start = historyLines === undefined ? "-" : `-${historyLines}`;
  return [
    `display -p -t ${pane} '${STATE.map((name) => `#{${name}}`).join("\t")}'`,
    `capture-pane -p -e -J -S ${start} -E -1 -t ${pane}`,
    `capture-pane -p -e -J -t ${pane}`,
    `capture-pane -p -e -J -a -q -t ${pane}`,
    `capture-pane -p -P -t ${pane}`,
  ];
}

const CURSOR_SHAPES: Record<string, number> = { block: 2, underline: 4, bar: 6 };

/** A pane's size and the bytes that recreate it in an xterm of that size. */
export interface Seed {
  cols: number;
  rows: number;
  data: string;
}

/**
 * Joins captured rows. tmux carries attributes from one captured row into the next, but a line
 * feed at the bottom of xterm.js fills the new row with the current background, so the background
 * is cleared for each line feed and set again after it.
 */
function joinRows(rows: readonly string[]): string {
  let background = "";
  let out = "";
  rows.forEach((row, i) => {
    if (i > 0) out += background ? `\x1b[49m\r\n${background}` : "\r\n";
    out += row;
    // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR sequences start with ESC.
    for (const [, params = ""] of row.matchAll(/\x1b\[([\d;:]*)m/g)) {
      background = afterSgr(background, params);
    }
  });
  return out;
}

/** The SGR that sets the background after `params`, or "" for the default background. */
function afterSgr(background: string, params: string): string {
  const parts = params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!.split(":")[0]!;
    const n = code === "" ? 0 : Number(code);
    if (n === 0 || n === 49) background = "";
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) background = `\x1b[${n}m`;
    else if (n === 48 && parts[i]!.includes(":")) background = `\x1b[${parts[i]}m`;
    else if (n === 48 && parts[i + 1] === "5") {
      background = `\x1b[${parts.slice(i, i + 3).join(";")}m`;
      i += 2;
    } else if (n === 48 && parts[i + 1] === "2") {
      background = `\x1b[${parts.slice(i, i + 5).join(";")}m`;
      i += 4;
    } else if ((n === 38 || n === 58) && parts[i + 1] === "5") i += 2;
    else if ((n === 38 || n === 58) && parts[i + 1] === "2") i += 4;
  }
  return background;
}

/** The pane described by `seedCommands`' replies. */
export function buildSeed(
  replies: string[][],
  continuation: boolean | "prependable" = false,
): Seed {
  const [stateLine = [], history = [], visible = [], saved = [], pending = []] = replies;
  const values = (stateLine[0] ?? "").split("\t");
  if (values.length !== STATE.length) throw new Error("unexpected tmux pane state");
  const state = Object.fromEntries(STATE.map((name, i) => [name, values[i]!])) as State;
  const number = (name: (typeof STATE)[number]) => {
    if (!/^\d{1,6}$/.test(state[name])) throw new Error(`unexpected tmux ${name}`);
    return Number(state[name]);
  };
  const alternate = state.alternate_on === "1";
  const height = number("pane_height");

  // Reset and set the tab stops first: tmux captures a tab as a tab character, which lands
  // where the original did as long as the stops have not changed since it was written.
  let seed = continuation ? `${VT_CONTINUATION_PREAMBLE}\x1b[3g` : "\x1bc\x1b[3g";
  const stops = state.pane_tabs.split(",").filter(Boolean);
  if (!stops.every((stop) => /^\d{1,6}$/.test(stop))) throw new Error("unexpected tmux pane_tabs");
  for (const stop of stops) {
    seed += `\x1b[1;${Number(stop) + 1}H\x1bH`;
  }
  // The normal screen's history and grid. The grid is the saved one while the alternate screen
  // is on; tmux keeps the history with the normal screen either way.
  seed += "\x1b[H";
  // With no history tmux clamps `-E -1` to the first visible row, so `history_size` decides.
  const normal = [
    ...(continuation !== true && number("history_size") > 0 ? history : []),
    ...(alternate ? saved : visible),
  ];
  seed += joinRows(normal);
  if (alternate) {
    // 1049 saves the cursor as it switches, so the normal screen's cursor goes first.
    seed += `\x1b[0m\x1b[${number("alternate_saved_y") + 1};${number("alternate_saved_x") + 1}H`;
    seed += `\x1b[?1049h${joinRows(visible.slice(0, height))}`;
  }
  seed += "\x1b[0m";

  // Modes; origin mode last, since it moves the cursor home.
  const upper = number("scroll_region_upper");
  seed += `\x1b[${upper + 1};${number("scroll_region_lower") + 1}r`;
  if (state.wrap_flag === "0") seed += "\x1b[?7l";
  if (state.insert_flag === "1") seed += "\x1b[4h";
  if (state.keypad_cursor_flag === "1") seed += "\x1b[?1h";
  if (state.keypad_flag === "1") seed += "\x1b=";
  if (state.cursor_flag === "0") seed += "\x1b[?25l";
  const shape = CURSOR_SHAPES[state.cursor_shape];
  if (shape !== undefined) seed += `\x1b[${shape - (state.cursor_blinking === "1" ? 1 : 0)} q`;
  const origin = state.origin_flag === "1";
  if (origin) seed += "\x1b[?6h";
  const row = number("cursor_y") - (origin ? upper : 0);
  seed += `\x1b[${row + 1};${number("cursor_x") + 1}H`;
  // An escape sequence the pane's program had only partly written when tmux answered.
  return { cols: number("pane_width"), rows: height, data: seed + pending.join("\n") };
}
