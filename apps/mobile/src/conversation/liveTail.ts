/** How many of the terminal's latest changed lines show under a running step. */
export const LIVE_TAIL_LINES = 3;
const LINE_MAX = 160;

/** Box edges an agent draws around its input, and rows drawn only with rules. */
const EDGE = /^[│┃║▌▐]\s?|\s?[│┃║▌▐]$/gu;
const RULE = /^[\s─━═┄┈╌╭╮╰╯┌┐└┘├┤┬┴┼-]*$/u;

/**
 * Whether a screen row is the agent's own chrome rather than output: its input box, prompt,
 * hints, or its status line (which changes every second and has its own bar).
 */
function chrome(line: string): boolean {
  return (
    RULE.test(line) ||
    /^[>›❯]\s*$/u.test(line) ||
    /^[>›❯]\s/u.test(line) ||
    /esc to (?:interrupt|cancel)/i.test(line) ||
    /^\?\s+for shortcuts/i.test(line)
  );
}

/** Lines of `after` that differ from `before` at the same row: what the terminal just printed. */
export function changedLines(before: readonly string[] | null, after: readonly string[]): string[] {
  if (!before) return [];
  const changed: string[] = [];
  after.forEach((raw, index) => {
    if (raw === before[index]) return;
    const line = raw.replace(EDGE, "").trim();
    if (!line || chrome(line)) return;
    changed.push(line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line);
  });
  return changed;
}

/** The tail after new lines: the latest three, oldest first. Unchanged input keeps its identity. */
export function nextTail(tail: readonly string[], changed: readonly string[]): readonly string[] {
  if (changed.length === 0) return tail;
  const next = [...tail, ...changed].slice(-LIVE_TAIL_LINES);
  return next.length === tail.length && next.every((line, i) => line === tail[i]) ? tail : next;
}
