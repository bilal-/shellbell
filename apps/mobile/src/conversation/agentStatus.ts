/**
 * The agent's own status line, read from the terminal screen the phone already receives while
 * Chat is showing. Readers are deliberately narrow: a line counts only when it has the agent's
 * shape and its "esc to interrupt" hint or a running timer, and anything unsure reads as nothing.
 * Screen text is read here and shown on this phone only; it is never sent anywhere.
 */

export interface AgentStatus {
  /** What the agent says it is doing, such as `Cogitating…` or `Working`. */
  readonly label: string;
  /** The agent's own elapsed time, when its line shows one. */
  readonly seconds: number | null;
  /** The rest of its line worth showing, such as `↑ 1.2k tokens`. */
  readonly detail: string | null;
}

/** How far up from the bottom of the screen a status line may sit (Claude's box and hints). */
const ROWS = 15;
const LABEL_MAX = 48;
const DETAIL_MAX = 48;

/** `12s`, `1m 5s`, `2h 3m 4s`. */
const DURATION = /^(?:(\d{1,3})h\s*)?(?:(\d{1,3})m\s*)?(\d{1,3})s$/;
const INTERRUPT = /^esc to (?:interrupt|cancel)$/i;

function seconds(text: string): number | null {
  const match = DURATION.exec(text.trim());
  if (!match) return null;
  return Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3]);
}

/**
 * The bracketed part of a status line: its timer, the interrupt hint and anything else. `null`
 * unless it carries the hint or a timer, which is what makes it a status rather than prose.
 */
function inner(parts: string[]): { seconds: number | null; detail: string | null } | null {
  let time: number | null = null;
  let hint = false;
  const rest: string[] = [];
  for (const raw of parts) {
    const part = raw.trim();
    if (!part) continue;
    if (INTERRUPT.test(part)) hint = true;
    else if (time === null && seconds(part) !== null) time = seconds(part);
    else rest.push(part);
  }
  if (!hint && time === null) return null;
  const detail = rest.join(" · ");
  return {
    seconds: time,
    detail: detail && detail.length <= DETAIL_MAX ? detail : null,
  };
}

/** Claude Code: `✻ Cogitating… (12s · ↑ 1.2k tokens · esc to interrupt)`. */
const CLAUDE = /^[·✢✳✶✻✽*]\s+(\S[^()]{0,60}?…)\s*\(([^()]*)\)\s*$/u;

function readClaude(line: string): AgentStatus | null {
  const match = CLAUDE.exec(line);
  if (!match) return null;
  const parts = inner(match[2]!.split("·"));
  return parts && match[1]!.length <= LABEL_MAX ? { label: match[1]!, ...parts } : null;
}

/** Codex: `• Working (8s • esc to interrupt)`, and older `Working (34s, esc to interrupt)`. */
const CODEX = /^(?:[•◦·]\s+)?([A-Z][A-Za-z]+(?: [a-z]+){0,3})\s*\(([^()]*)\)\s*$/;

function readCodex(line: string): AgentStatus | null {
  const match = CODEX.exec(line);
  if (!match) return null;
  const parts = inner(match[2]!.split(/[•,]/));
  // Codex always prints its interrupt hint; a bare word and timer could be anything.
  return parts && /esc to interrupt/i.test(match[2]!) ? { label: match[1]!, ...parts } : null;
}

const READERS: Readonly<Record<string, (line: string) => AgentStatus | null>> = {
  claude: readClaude,
  codex: readCodex,
};

/** The agent's status line near the bottom of the screen, or `null` when none reads as one. */
export function readAgentStatus(
  kind: string | undefined,
  rows: readonly string[],
): AgentStatus | null {
  const key = kind?.trim().toLowerCase() ?? "";
  const read = Object.hasOwn(READERS, key) ? READERS[key] : undefined;
  if (!read) return null;
  for (let i = rows.length - 1, seen = 0; i >= 0 && seen < ROWS; i--, seen++) {
    const line = rows[i]!.trim();
    if (!line) continue;
    const status = read(line);
    if (status) return status;
  }
  return null;
}

/** `12s`, `1m 05s`, `1h 02m`: short enough for the bar, steady enough not to jitter. */
export function formatElapsed(total: number): string {
  const s = Math.max(0, Math.floor(total));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
