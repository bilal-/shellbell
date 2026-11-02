import type { Cursor, Line } from "@shellbell/protocol";

/**
 * Whether a terminal screen shows an agent waiting for an answer: one numbered menu with a
 * single highlighted choice, or a y/n prompt on the cursor row. A port of the phone's
 * `promptEvidence(blockedPrompt(screen))` (apps/mobile/src/input/agentPrompt.ts), keeping only
 * what decides that; `test/fixtures/agent-prompt-vectors.json` holds screens both must agree on.
 */
export type PromptEvidence = "menu" | "yes-no" | null;

/** Rows read either side of the cursor (or up from the last row of output). */
const WINDOW = 20;
/** Claude Code draws `❯` at the highlighted choice, Codex `›`. A bare `>` is a quote or prompt. */
const OPTION = /^(?:([❯›▶➤▸])\s*)?([1-9])[.)]\s+(\S.*)$/u;
const EDGE_START = /^\s*[│┃║▌▐]/u;
const EDGE_END = /[│┃║▌▐]\s*$/u;
const RULE = /^[\s─━═┄┈╌╭╮╰╯┌┐└┘├┤┬┴┼-]*$/u;
const YES_NO =
  /(?:\[(?:y\/n|n\/y|yes\/no|no\/yes)\]|\((?:y\/n|n\/y|yes\/no|no\/yes)\))\s*[:?]?\s*$/i;

interface Row {
  indent: number;
  text: string;
}

function row(line: Line | undefined): Row {
  const raw = line ? line.r.map((run) => run.t).join("") : "";
  const inner = raw.replace(EDGE_START, "").replace(EDGE_END, "").trimEnd();
  const text = inner.trimStart();
  return { indent: inner.length - text.length, text: RULE.test(text) ? "" : text };
}

/** Numbered lists starting at 1, each with the count of its choices and highlight markers. */
function menus(rows: Row[]): { options: number; markers: number }[] {
  const found: { options: number; markers: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    if (OPTION.exec(rows[i]!.text)?.[2] !== "1") continue;
    const menu = { options: 0, markers: 0 };
    let column = rows[i]!.indent;
    let j = i;
    for (; j < rows.length; j++) {
      const current = rows[j]!;
      const option = OPTION.exec(current.text);
      if (option && option[2] === String(menu.options + 1)) {
        if (option[1]) menu.markers++;
        column = option[1] ? current.indent + 2 : current.indent;
        menu.options++;
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

export function promptEvidence(
  screen: { cursor: Cursor; lines: readonly Line[] } | undefined,
): PromptEvidence {
  if (!screen || screen.lines.length === 0) return null;
  const all = screen.lines.map(row);
  let lastContent = all.length - 1;
  while (lastContent > 0 && !all[lastContent]!.text) lastContent--;
  const cursor = screen.cursor.y >= 0 && screen.cursor.y < all.length ? screen.cursor.y : -1;
  const from = Math.max(0, (cursor >= 0 ? cursor : lastContent) - WINDOW);
  const to = Math.min(all.length - 1, cursor >= 0 ? cursor + WINDOW : lastContent);
  const marked = menus(all.slice(from, to + 1)).filter(
    (menu) => menu.options >= 2 && menu.markers > 0,
  );
  if (marked.length === 1 && marked[0]!.markers === 1) return "menu";
  const current = cursor >= 0 ? all[cursor]?.text : undefined;
  return current && YES_NO.test(current) ? "yes-no" : null;
}
