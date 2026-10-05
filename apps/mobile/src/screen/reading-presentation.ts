import type { Run } from "@shellbell/protocol";
import type { StreamDisplayRow } from "./stream-presentation";

export type ReadingDisplayRow =
  | Extract<StreamDisplayRow, { kind: "gap" }>
  | {
      readonly kind: "paragraph";
      readonly key: string;
      readonly runs: readonly Run[];
      readonly sourceKeys: readonly string[];
      readonly historyKey: string | null;
      readonly overflow: boolean;
    };

export function projectReadingRows(
  rows: readonly StreamDisplayRow[],
  boundaryKey: string | null,
): readonly ReadingDisplayRow[] {
  const result: ReadingDisplayRow[] = [];
  let paragraph:
    | {
        kind: "paragraph";
        key: string;
        runs: Run[];
        sourceKeys: string[];
        historyKey: string | null;
        overflow: boolean;
      }
    | undefined;
  let previous: Extract<StreamDisplayRow, { kind: "line" }> | undefined;
  let units = 0;
  for (const row of rows) {
    if (row.kind === "gap") {
      result.push(row);
      paragraph = undefined;
      previous = undefined;
      continue;
    }
    const rowUnits = row.line.r.reduce((total, run) => total + run.t.length, 0);
    const overflow = rowUnits > 8192 || row.line.r.length > 256;
    const joins =
      paragraph !== undefined &&
      !paragraph.overflow &&
      !overflow &&
      previous?.line.w === true &&
      consecutive(previous.absoluteRow, row.absoluteRow) &&
      row.key !== boundaryKey &&
      paragraph.sourceKeys.length < 64 &&
      units + rowUnits <= 8192 &&
      paragraph.runs.length + row.line.r.length <= 256;
    if (!joins || !paragraph) {
      paragraph = {
        kind: "paragraph",
        key: row.key,
        runs: [],
        sourceKeys: [],
        historyKey: null,
        overflow,
      };
      result.push(paragraph);
      units = 0;
    }
    // Keep source text/styles untouched, including graphemes spanning styled runs.
    // A single oversized row is retained for the renderer's explicit grid fallback.
    for (const run of row.line.r) paragraph.runs.push(run);
    paragraph.sourceKeys.push(row.key);
    if (paragraph.historyKey === null && row.liveRowIndex === null) paragraph.historyKey = row.key;
    units += rowUnits;
    previous = row;
  }
  return result;
}

function consecutive(before: number | undefined, after: number | undefined): boolean {
  return (
    typeof before === "number" &&
    typeof after === "number" &&
    Number.isSafeInteger(before) &&
    Number.isSafeInteger(after) &&
    before >= 0 &&
    after >= 0 &&
    before + 1 === after
  );
}
