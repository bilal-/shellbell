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

/** A screen row as the tail would show it, or `null` for blank rows and the agent's chrome. */
export function tailLine(raw: string): string | null {
  const line = raw.replace(EDGE, "").trim();
  if (!line || chrome(line)) return null;
  return line.length > LINE_MAX ? `${line.slice(0, LINE_MAX - 1)}…` : line;
}

/** Lines of `after` that differ from `before` at the same row: what the terminal just printed. */
export function changedLines(before: readonly string[] | null, after: readonly string[]): string[] {
  if (!before) return [];
  const changed: string[] = [];
  after.forEach((raw, index) => {
    if (raw === before[index]) return;
    const line = tailLine(raw);
    if (line) changed.push(line);
  });
  return changed;
}

/** How long after a secret is sent the screen stays private, while its echo settles. */
export const SECRET_SETTLE_MS = 2000;
/**
 * Lines seen while the screen was private, never shown later; bounded per screen by forgetting
 * the ones seen longest ago, so what was private most recently, such as a secret's echo, stays.
 */
export const PRIVATE_LINES_MAX = 400;

/** The tail after new lines: the latest three, oldest first. Unchanged input keeps its identity. */
export function nextTail(tail: readonly string[], changed: readonly string[]): readonly string[] {
  if (changed.length === 0) return tail;
  const next = [...tail, ...changed].slice(-LIVE_TAIL_LINES);
  return next.length === tail.length && next.every((line, i) => line === tail[i]) ? tail : next;
}

/** What the live tail remembers across screens of one session. */
export interface TailMemory {
  rows: readonly string[] | null;
  tail: readonly string[];
  step: string | null;
  /** Lines seen while the screen was private; none of them is ever shown. */
  unseen: Set<string>;
}

export function newTailMemory(): TailMemory {
  return { rows: null, tail: [], step: null, unseen: new Set() };
}

/**
 * The tail to show under the running step after the screen's latest rows, updating `memory`.
 * While the screen is private nothing is shown and every line on it is remembered, so it can't
 * enter the tail later, even scrolled to another row. A new step starts its own tail.
 */
export function advanceTail(
  memory: TailMemory,
  input: {
    rows: readonly string[] | null;
    private: boolean;
    working: boolean;
    step: string | null;
  },
): readonly string[] {
  if (input.step !== memory.step) {
    memory.step = input.step;
    if (memory.tail.length) memory.tail = [];
  }
  if (!input.working && memory.tail.length) memory.tail = [];
  if (input.rows && input.rows !== memory.rows) {
    if (input.private) {
      for (const raw of input.rows) {
        const line = tailLine(raw);
        if (!line) continue;
        // Newest last: a full memory forgets the line seen longest ago, never the one on screen.
        memory.unseen.delete(line);
        memory.unseen.add(line);
        for (const oldest of memory.unseen) {
          if (memory.unseen.size <= PRIVATE_LINES_MAX) break;
          memory.unseen.delete(oldest);
        }
      }
    } else if (input.working)
      memory.tail = nextTail(
        memory.tail,
        changedLines(memory.rows, input.rows).filter((line) => !memory.unseen.has(line)),
      );
    memory.rows = input.rows;
  }
  if (input.private && memory.tail.length) memory.tail = [];
  return memory.tail;
}
