/** Snapshot text is data, never executable terminal control sequences.
 * Shared by native Reading mode and browser xterm; no browser/Intl dependencies.
 */
export function safeText(text: string): string {
  // iTerm snapshots include NUL padding for otherwise blank terminal cells.
  const padded = text.replaceAll("\u0000", " ");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal command introducers in snapshot text
  return padded.replace(/[\u0001-\u001f\u007f-\u009f]/gu, "�");
}
