/**
 * Spec 10.6: a paste never carries a trailing newline into the terminal as literal text -- a
 * single trailing `\n`/`\r\n` is stripped and replaced by an explicit Enter key (M6), so pasting
 * a full shell command still runs it.
 */
export function preparePaste(clipboard: string): { text: string; sendEnter: boolean } {
  const m = /\r?\n$/.exec(clipboard);
  if (!m) return { text: clipboard, sendEnter: false };
  return { text: clipboard.slice(0, -m[0].length), sendEnter: true };
}
