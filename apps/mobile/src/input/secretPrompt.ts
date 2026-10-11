import type { Line } from "@shellbell/protocol";

/** The terminal screen the prompt helpers read: rows, and where the cursor is. */
export interface PromptScreen {
  cursor: { x: number; y: number };
  lines: readonly Line[];
}

/** `Password:`, `[sudo] password for me:`, `Enter passphrase for key '…':`, `Passcode:`. */
const SECRET_PROMPT = /\bpass(?:word|phrase|code)\b[^:]*:\s*$/i;

export function lineText(line: Line | undefined): string {
  return line ? line.r.map((run) => run.t).join("") : "";
}

/** The cursor row's text, or `null` when the screen or cursor is unknown. */
export function cursorRowText(screen: PromptScreen | undefined): string | null {
  if (!screen || screen.cursor.y < 0) return null;
  const line = screen.lines[screen.cursor.y];
  return line ? lineText(line) : null;
}

/**
 * True when the terminal's cursor row ends with a password-like prompt. Only the live cursor row
 * counts, so a password prompt that already scrolled past does not keep offering secret input.
 */
export function cursorRowAsksForSecret(screen: PromptScreen | undefined): boolean {
  const text = cursorRowText(screen);
  return text !== null && SECRET_PROMPT.test(text);
}
