/** DEL, what a terminal's Backspace key sends. */
export const LIVE_BACKSPACE = "\x7f";
/** Keystrokes typed within one frame or two travel as one encrypted input message. */
export const LIVE_BATCH_MS = 24;
/** The native field is cleared after a pause, and always before it can grow past this. */
export const LIVE_BUFFER_LIMIT = 32;
export const LIVE_IDLE_RESET_MS = 600;
/** A Backspace key event this soon after a deleting text change describes the same press. */
export const LIVE_BACKSPACE_ECHO_MS = 50;
const LIVE_BATCH_LIMIT = 4096;

/**
 * Terminal bytes for one edit of the Live keys field. The field holds only recent keystrokes, so
 * every edit is read against what was already sent: removed characters become DEL presses and new
 * characters are typed. Enter in the field is Return, as on a terminal.
 */
export function liveKeysDiff(previous: string, next: string): string {
  const before = Array.from(previous);
  const after = Array.from(next);
  let same = 0;
  while (same < before.length && same < after.length && before[same] === after[same]) same++;
  const removed = before.length - same;
  const typed = after.slice(same).join("").replace(/\r?\n/g, "\r");
  return LIVE_BACKSPACE.repeat(removed) + typed;
}

export interface BatchTimers {
  set: (run: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

const realTimers: BatchTimers = {
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * Coalesces Live keys into one terminal message per short window. Anything else that reaches the
 * terminal (a quick key, a chip, a sent command) must call `flush()` first so the host receives
 * keystrokes in the order they were pressed.
 */
export class TerminalBatcher {
  private pending = "";
  private timer: unknown = null;
  constructor(
    private send: (data: string) => boolean,
    private readonly delayMs = LIVE_BATCH_MS,
    private readonly timers: BatchTimers = realTimers,
  ) {}
  setSender(send: (data: string) => boolean): void {
    this.send = send;
  }
  push(data: string): void {
    if (!data) return;
    this.pending += data;
    if (this.pending.length >= LIVE_BATCH_LIMIT) {
      this.flush();
      return;
    }
    if (this.timer === null) this.timer = this.timers.set(() => this.flush(), this.delayMs);
  }
  flush(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
    const data = this.pending;
    this.pending = "";
    if (data) this.send(data);
  }
}
