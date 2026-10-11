import type { Line } from "@shellbell/protocol";

/** `Password:`, `[sudo] password for me:`, `Enter passphrase for key '…':`, `Passcode:`. */
const SECRET_PROMPT = /\bpass(?:word|phrase|code)\b[^:]*:\s*$/i;

/**
 * True when the terminal's cursor row ends with a password-like prompt. Only the live cursor row
 * counts, so a password prompt that already scrolled past does not keep offering secret input.
 */
export function cursorRowAsksForSecret(
  screen: { cursor: { x: number; y: number }; lines: readonly Line[] } | undefined,
): boolean {
  if (!screen || screen.cursor.y < 0) return false;
  const line = screen.lines[screen.cursor.y];
  if (!line) return false;
  return SECRET_PROMPT.test(line.r.map((run) => run.t).join(""));
}
