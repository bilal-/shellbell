import { safeText } from "../screen/display-text";
import type { TerminalRow } from "./adapter";

/** Live includes content below the cursor, such as a TUI's bottom status rows.
 * History and gap labels cannot establish the live screen's extent.
 */
export function liveEndIndex(
  order: readonly string[],
  data: ReadonlyMap<string, TerminalRow>,
  cursorKey: string | null,
): number {
  const cursorIndex = cursorKey === null ? -1 : order.indexOf(cursorKey);
  for (let index = order.length - 1; index > cursorIndex; index--) {
    const row = data.get(order[index]!);
    if (
      row &&
      !row.history &&
      row.absoluteRow !== undefined &&
      row.line.r.some(
        (run) =>
          (run.n ?? run.t.length) > 0 &&
          (run.bg !== undefined || run.u || run.s || safeText(run.t).trim().length > 0),
      )
    )
      return index;
  }
  return cursorIndex;
}

export function liveOffset(
  rowCount: number,
  endIndex: number,
  cellHeight: number,
  paneHeight: number,
): number {
  const bottom = Math.max(0, rowCount * cellHeight - paneHeight);
  return endIndex < 0
    ? bottom
    : Math.min(bottom, Math.max(0, (endIndex + 1) * cellHeight - paneHeight));
}

/** If the occupied source grid fits, keep its bottom row at the pane bottom.
 * A shell prompt above blank trailing rows keeps its natural top position.
 */
export function livePadding(
  rowCount: number,
  endIndex: number,
  cellHeight: number,
  paneHeight: number,
): number {
  return rowCount > 0 && endIndex === rowCount - 1
    ? Math.max(0, paneHeight - rowCount * cellHeight)
    : 0;
}

/** Keep source identity, not screen pixels, when history or measured cells change. */
export function anchoredOffset(
  before: readonly string[],
  after: readonly string[],
  offset: number,
  oldHeight: number,
  newHeight: number,
): number {
  const index = Math.max(0, Math.floor(offset / oldHeight));
  const key = before[index];
  const next = key === undefined ? -1 : after.indexOf(key);
  if (next >= 0) return (next + (offset % oldHeight) / oldHeight) * newHeight;
  for (let i = index + 1; i < before.length; i++) {
    const retained = after.indexOf(before[i]!);
    if (retained >= 0) return retained * newHeight;
  }
  return 0;
}
