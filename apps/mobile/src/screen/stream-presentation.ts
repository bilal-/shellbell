import type { Line, ScreenSnapshot } from "@shellbell/protocol";
import type { MobileStreamSnapshot } from "../net/mobile-screen-stream";

export type StreamDisplayRow =
  | {
      readonly kind: "line";
      readonly key: string;
      readonly line: Line;
      readonly liveRowIndex: number | null;
      /** Known absolute source position; absence must never imply continuity. */
      readonly absoluteRow?: number;
    }
  | { readonly kind: "gap"; readonly key: string; readonly label: string };

/** A list relayout cannot create another history request; only a new user drag can. */
export class OlderLoadIntent {
  private pending = false;

  beginDrag(): void {
    this.pending = true;
  }

  consume(): boolean {
    const admitted = this.pending;
    this.pending = false;
    return admitted;
  }
}

export function projectStreamRows(
  snapshot: MobileStreamSnapshot,
  fallbackScreen?: Readonly<ScreenSnapshot>,
): readonly StreamDisplayRow[] {
  const rows: StreamDisplayRow[] = [];
  const history = snapshot.history;
  if (history) {
    const entries = [
      ...history.rows.map((row) => ({ kind: "line" as const, position: row.row, row })),
      ...history.gaps.map((gap) => ({ kind: "gap" as const, position: gap.from, gap })),
    ].sort((a, b) => a.position - b.position);
    for (const entry of entries) {
      if (entry.kind === "line") {
        rows.push({
          kind: "line",
          key: entry.row.key,
          line: entry.row.line,
          liveRowIndex: null,
          absoluteRow: entry.row.row,
        });
      } else {
        rows.push({
          kind: "gap",
          key: `gap:${entry.gap.from}:${entry.gap.to}`,
          label: "Earlier history omitted",
        });
      }
    }
  }
  const screen = snapshot.screen ?? fallbackScreen;
  if (screen) {
    if (history && (history.readOnly || history.anchor.before !== screen.scrollbackTotal)) {
      rows.push({
        kind: "gap",
        key: "gap:history-live",
        label: history.readOnly ? "Earlier history detached" : "Recent output omitted",
      });
    } else if (!history && screen.scrollbackTotal > 0) {
      rows.push({ kind: "gap", key: "gap:unloaded", label: "Earlier history not loaded" });
    }
    screen.lines.forEach((line, liveRowIndex) => {
      rows.push({
        kind: "line",
        key: `live:${liveRowIndex}`,
        line,
        liveRowIndex,
        absoluteRow: screen.scrollbackTotal + liveRowIndex,
      });
    });
  }
  return rows;
}
