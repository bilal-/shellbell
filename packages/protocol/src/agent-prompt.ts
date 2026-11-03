import type { Line } from "./screen.js";

/**
 * Reading an agent's prompt off its terminal screen: whether it waits for an answer (a single
 * highlighted numbered menu, or a y/n prompt on the cursor row), and what it asks. The phone
 * shows it; the computer refuses input from Chat while it says the agent waits. One reader for
 * both, so they can't disagree about the same screen.
 */

/** The rows of a terminal screen and where its cursor is. */
export interface PromptScreen {
  cursor: { x: number; y: number };
  lines: readonly Line[];
}

function lineText(line: Line | undefined): string {
  return line ? line.r.map((run) => run.t).join("") : "";
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
  /**
   * The agent's own folder-trust prompt, recognised by its words, a highlighted choice and its
   * confirm hint: the short question to show. Not evidence of waiting by itself.
   */
  trust?: string;
}

/**
 * Folder-trust questions the agents ask before they start, in the words they use, and the short
 * form shown on the phone. Their long question rows wrap and don't end in `?`, so they are
 * matched by wording rather than by the general question rule.
 */
const TRUST_QUESTIONS: readonly [RegExp, string][] = [
  // Claude Code 2.1: "Quick safety check: Is this a project you created or one you trust?"
  [/\bIs this a project you (?:created or one you )?trust\?/i, "Is this a project you trust?"],
  // Codex 0.166: "Trust this folder? Codex can read, edit, and run files here…"
  [/\bTrust this folder\?/i, "Trust this folder?"],
  // Earlier Claude Code: "Do you trust the files in this folder?"
  [/\bDo you trust the files in this folder\?/i, "Do you trust the files in this folder?"],
];
/** A highlighted choice row, numbered or not. */
const MARKED = /^[❯›▶➤▸]\s*\S/u;
/** The hint under a trust prompt's choices. */
const CONFIRM_HINT = /\b(?:enter to confirm|enter continue|press enter to (?:confirm|continue))\b/i;

/** The short trust question when `rows` show an agent's folder-trust prompt, else `null`. */
function trustQuestion(rows: Row[]): string | null {
  if (!rows.some((r) => MARKED.test(r.text)) || !rows.some((r) => CONFIRM_HINT.test(r.text)))
    return null;
  const words = rows.map((r) => r.text).join(" ");
  for (const [pattern, short] of TRUST_QUESTIONS) if (pattern.test(words)) return short;
  return null;
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
/** A row agents draw with only rule and corner characters, around their input or dialogs. */
export function isTerminalRule(text: string): boolean {
  return RULE.test(text);
}
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
  return { indent: inner.length - text.length, text: isTerminalRule(text) ? "" : text };
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
  const trust = trustQuestion(rows);
  if (menu)
    return {
      question: trust ?? questionAbove(rows, menu.first),
      options: menu.options,
      ...(trust ? { trust } : {}),
    };
  // Only the cursor row can offer y/n. A prompt above an empty row may already have been
  // answered with Enter; an older question or unknown cursor must not offer reply buttons.
  const current = cursor >= 0 ? all[cursor]?.text : undefined;
  const yesNo = current && YES_NO.exec(current)?.[0];
  return {
    question: cursorQuestion(all, cursor >= 0 ? cursor : lastContent),
    options: null,
    ...(yesNo ? { yesNo: /yes|no/i.test(yesNo) ? ("yes/no" as const) : ("y/n" as const) } : {}),
    ...(trust ? { trust } : {}),
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

/** What on screen shows the agent waits for an answer: a menu, a y/n prompt, or nothing. */
export type PromptEvidence = "menu" | "yes-no" | null;

/** The kind of evidence a read prompt carries, apart from the words it read. */
export function promptEvidence(prompt: BlockedPrompt): PromptEvidence {
  if (prompt.options) return "menu";
  if (prompt.yesNo) return "yes-no";
  return null;
}

/**
 * The question, only where the screen proves it: the y/n prompt's own row, or a row ending in `?`
 * over a menu. A nearby line of text alone is not shown as the agent's question.
 */
export function provenQuestion(prompt: BlockedPrompt): string | null {
  // An agent's own trust prompt is recognised by its words, so its short question is proven.
  if (prompt.trust) return prompt.trust;
  const evidence = promptEvidence(prompt);
  if (!prompt.question || !evidence) return null;
  if (evidence === "yes-no") return prompt.question;
  return /\?\s*$/.test(prompt.question) ? prompt.question : null;
}
