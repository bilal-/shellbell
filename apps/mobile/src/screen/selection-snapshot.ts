import { safeText } from "./display-text";
import type { StreamDisplayRow } from "./stream-presentation";

export interface SelectionSnapshot {
  readonly text: string;
  readonly truncated: boolean;
}

/** Local visible-source snapshot only; never asks the service for more history. */
export function selectionSnapshot(
  rows: readonly StreamDisplayRow[],
  top: string | null,
  bottom: string | null,
): SelectionSnapshot | null {
  const start = rows.findIndex((row) => row.key === top);
  const end = rows.findIndex((row) => row.key === bottom);
  if (start < 0 || end < start) return null;
  let text = "";
  let bytes = 0;
  const last = Math.min(end, start + 127);
  for (let index = start; index <= last; index++) {
    const row = rows[index]!;
    // At most the byte cap plus one UTF-16 unit of lookahead. This joins split
    // surrogate pairs across style runs without allocating an oversized source row.
    let raw = row.kind === "gap" ? `[${row.label}]` : "";
    if (row.kind === "line") {
      for (const run of row.line.r) {
        raw += run.t.slice(0, 32769 - raw.length);
        if (raw.length === 32769) break;
      }
    }
    if (index > start) {
      if (bytes === 32 * 1024) return { text, truncated: true };
      text += "\n";
      bytes++;
    }
    for (const character of raw) {
      const shown = safeText(character);
      const point = shown.codePointAt(0)!;
      const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
      if (bytes + size > 32 * 1024) return { text, truncated: true };
      text += shown;
      bytes += size;
    }
  }
  return { text, truncated: last < end };
}
