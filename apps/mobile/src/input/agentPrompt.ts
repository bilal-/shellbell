import { lineText, type PromptScreen } from "./secretPrompt";

/**
 * The agent's name for the command bar: `claude` reads "Claude", `codex` "Codex". A kind that is
 * not a plain word (or says nothing, like `unknown`) gets no name, and the bar says "the agent".
 */
export function agentName(kind: string | undefined): string | null {
  const name = kind?.trim() ?? "";
  if (!/^[a-z][a-z0-9]*(?:[- .][a-z0-9]+)*$/i.test(name) || name.length > 20) return null;
  if (/^(?:unknown|agent|none)$/i.test(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function agentPlaceholder(kind: string | undefined): string {
  return `Message ${agentName(kind) ?? "the agent"}…`;
}

/** One choice of an agent's numbered menu, with its explicit reply key when shown. */
export interface MenuOption {
  digit: string;
  label: string;
  /** A single letter, Enter or Esc. Mode-switch hints such as Shift+Tab are not replies. */
  shortcut?: string;
}

export interface BlockedPrompt {
  /** One line of what the agent asks; `null` when nothing reads as one. */
  question: string | null;
  /** The agent's numbered choices, or `null` when there is no single unambiguous menu. */
  options: MenuOption[] | null;
  /** The current cursor prompt explicitly offers y/n; a question alone is not evidence. */
  yesNo?: "y/n" | "yes/no";
}

/** Rows read either side of the cursor (or up from the last row of output). */
const WINDOW = 20;
export const MENU_LABEL_MAX = 48;
export const QUESTION_MAX = 120;

/** Claude Code draws `❯` at the highlighted choice, Codex `›`. A bare `>` is a quote or prompt. */
const OPTION = /^(?:([❯›▶➤▸])\s*)?([1-9])[.)]\s+(\S.*)$/u;
/** Box edges and side bars that frame a dialog; stripped before a row is read. */
const EDGE_START = /^\s*[│┃║▌▐]/u;
const EDGE_END = /[│┃║▌▐]\s*$/u;
/** A row drawn only with rule and corner characters. */
const RULE = /^[\s─━═┄┈╌╭╮╰╯┌┐└┘├┤┬┴┼-]*$/u;
/** A trailing keyboard hint such as `(esc)`, `(y)` or `(shift+tab)`. */
const KEY_HINT = /\s+\((?:esc|enter|tab|shift\+tab|ctrl\+[a-z]|[a-z])\)$/i;
const REPLY_HINT = /\s+\((esc|enter|[a-z])\)$/i;
const YES_NO =
  /(?:\[(?:y\/n|n\/y|yes\/no|no\/yes)\]|\((?:y\/n|n\/y|yes\/no|no\/yes)\))\s*[:?]?\s*$/i;

interface Row {
  indent: number;
  text: string;
}

function row(raw: string): Row {
  const inner = raw.replace(EDGE_START, "").replace(EDGE_END, "").trimEnd();
  const text = inner.trimStart();
  return { indent: inner.length - text.length, text: RULE.test(text) ? "" : text };
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max
    ? `${chars
        .slice(0, max - 1)
        .join("")
        .trimEnd()}…`
    : flat;
}

interface Menu {
  first: number;
  options: MenuOption[];
  markers: number;
}

/**
 * Numbered lists starting at 1 in `rows`. A choice may wrap or carry a description on deeper
 * indented rows below it; anything else (a blank row, a shallower row, a number out of sequence)
 * ends the list.
 */
function menus(rows: Row[]): Menu[] {
  const found: Menu[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (OPTION.exec(rows[i]!.text)?.[2] !== "1") continue;
    const menu: Menu = { first: i, options: [], markers: 0 };
    let column = rows[i]!.indent;
    let j = i;
    for (; j < rows.length; j++) {
      const current = rows[j]!;
      const option = OPTION.exec(current.text);
      if (option && option[2] === String(menu.options.length + 1)) {
        if (option[1]) menu.markers++;
        // The highlighted row's marker shifts it left of its siblings' numbers.
        column = option[1] ? current.indent + 2 : current.indent;
        const label = option[3]!.replace(KEY_HINT, "");
        const hint = REPLY_HINT.exec(option[3]!)?.[1];
        const shortcut = hint?.length === 1 ? hint : hint?.toLowerCase();
        menu.options.push({
          digit: option[2]!,
          label: clip(label, MENU_LABEL_MAX),
          // Enter confirms the highlighted row, never an unselected option.
          ...(shortcut && (shortcut !== "enter" || option[1]) && { shortcut }),
        });
        continue;
      }
      if (j > i && current.text && !option && current.indent > column) continue;
      break;
    }
    found.push(menu);
    i = j - 1;
  }
  return found;
}

/**
 * What a blocked agent is asking, read from the screen near the cursor. A menu counts only when
 * it is the one numbered list there, runs 1, 2, 3… with at least two choices, and exactly one
 * choice carries the agent's highlight marker; anything less certain returns `options: null` so
 * the strip offers navigation keys instead of guessing replies.
 */
export function blockedPrompt(screen: PromptScreen | undefined): BlockedPrompt {
  if (!screen || screen.lines.length === 0) return { question: null, options: null };
  const all = screen.lines.map((line) => row(lineText(line)));
  let lastContent = all.length - 1;
  while (lastContent > 0 && !all[lastContent]!.text) lastContent--;
  const cursor = screen.cursor.y >= 0 && screen.cursor.y < all.length ? screen.cursor.y : -1;
  const from = Math.max(0, (cursor >= 0 ? cursor : lastContent) - WINDOW);
  const to = Math.min(all.length - 1, cursor >= 0 ? cursor + WINDOW : lastContent);
  const rows = all.slice(from, to + 1);
  const marked = menus(rows).filter((menu) => menu.options.length >= 2 && menu.markers > 0);
  const menu = marked.length === 1 && marked[0]!.markers === 1 ? marked[0]! : null;
  if (menu) return { question: questionAbove(rows, menu.first), options: menu.options };
  // Only the cursor row can offer y/n. A prompt above an empty row may already have been
  // answered with Enter; an older question or unknown cursor must not offer reply buttons.
  const current = cursor >= 0 ? all[cursor]?.text : undefined;
  const yesNo = current && YES_NO.exec(current)?.[0];
  return {
    question: cursorQuestion(all, cursor >= 0 ? cursor : lastContent),
    options: null,
    ...(yesNo ? { yesNo: /yes|no/i.test(yesNo) ? ("yes/no" as const) : ("y/n" as const) } : {}),
  };
}

/** The question over a menu: a nearby row ending in `?`, else the closest row of text. */
function questionAbove(rows: Row[], first: number): string | null {
  let closest: string | null = null;
  for (let i = first - 1; i >= Math.max(0, first - 8); i--) {
    const text = rows[i]!.text;
    if (!text) continue;
    if (OPTION.test(text)) break;
    if (/\?\s*$/.test(text)) return clip(text, QUESTION_MAX);
    closest ??= text;
  }
  return closest === null ? null : clip(closest, QUESTION_MAX);
}

/** The cursor row's text, or the closest row of text just above it. */
function cursorQuestion(rows: Row[], at: number): string | null {
  for (let i = at; i >= Math.max(0, at - 3); i--) {
    const text = rows[i]?.text;
    if (text) return clip(text, QUESTION_MAX);
  }
  return null;
}
