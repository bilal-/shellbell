import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8 } from "./bytes.js";
import { STREAM_LIMITS } from "./stream-wire.js";

export const NATIVE_HISTORY_SEED_ROWS = 2000;
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal control characters.
const terminalControls = /[\x00-\x1f\x7f-\x9f]/;

/**
 * Proof of the ordered physical text rows in one native seed, not a row-identity token.
 * The renderer must also have exactly this many normal history rows at the same width.
 * Coordinates are usable only while the computer's independent native capture stays valid.
 * Styles and unknown native wrap flags do not establish or change physical row coordinates.
 */
export function nativeHistoryProof(cols: number, rows: readonly string[]): string | null {
  if (
    !Number.isSafeInteger(cols) ||
    cols < 1 ||
    cols > STREAM_LIMITS.cols ||
    rows.length > NATIVE_HISTORY_SEED_ROWS
  )
    return null;
  const digest = sha256.create();
  digest.update(utf8(`shellbell-native-history-v1\n${cols}\n${rows.length}\n`));
  let bytes = 0;
  for (const row of rows) {
    // A capture containing terminal controls cannot certify physical text cells.
    if (
      typeof row !== "string" ||
      row.length > STREAM_LIMITS.screenBytes ||
      terminalControls.test(row)
    )
      return null;
    const text = utf8(`${JSON.stringify(row.replace(/ +$/, ""))}\n`);
    bytes += text.byteLength;
    if (bytes > STREAM_LIMITS.screenBytes) return null;
    digest.update(text);
  }
  return bytesToHex(digest.digest());
}
