import {
  type Color,
  type Cursor,
  codePoints,
  emptyLine,
  type Line,
  mergeRuns,
  type Run,
  trimTrailing,
} from "@shellbell/protocol";
import type { Screen } from "../types.js";
import {
  type CellStyle,
  type GetBufferResponse,
  type LineContents,
  LineContents_Continuation,
} from "./gen/iterm2_pb.js";

interface Style {
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  f?: boolean;
  invisible?: boolean;
}

function normalize(st: CellStyle | undefined): Style {
  if (!st) return {};
  let fg: Color | undefined;
  let bg: Color | undefined;
  if (st.fgColor.case === "fgStandard") fg = st.fgColor.value;
  else if (st.fgColor.case === "fgRgb")
    fg = [st.fgColor.value.red ?? 0, st.fgColor.value.green ?? 0, st.fgColor.value.blue ?? 0];
  if (st.bgColor.case === "bgStandard") bg = st.bgColor.value;
  else if (st.bgColor.case === "bgRgb")
    bg = [st.bgColor.value.red ?? 0, st.bgColor.value.green ?? 0, st.bgColor.value.blue ?? 0];
  if (st.inverse) {
    const f = fg ?? 15;
    const g = bg ?? 0;
    fg = g;
    bg = f;
  }
  const out: Style = {};
  if (fg !== undefined) out.fg = fg;
  if (bg !== undefined) out.bg = bg;
  if (st.bold) out.b = true;
  if (st.italic) out.i = true;
  if (st.underline) out.u = true;
  if (st.strikethrough) out.s = true;
  if (st.faint) out.f = true;
  if (st.invisible) out.invisible = true;
  return out;
}

function styleKey(s: Style): string {
  return `${JSON.stringify(s.fg ?? null)}|${JSON.stringify(s.bg ?? null)}|${s.b ? 1 : 0}${s.i ? 1 : 0}${s.u ? 1 : 0}${s.s ? 1 : 0}${s.f ? 1 : 0}${s.invisible ? 1 : 0}`;
}

export function lineContentsToLine(lc: LineContents): Line {
  const cps = Array.from(lc.text ?? "");
  // `repeats` has no proto default, so protobuf-es materialises 0 when it is unset -- `|| 1`, not
  // `?? 1`, is what turns that into "one cell". `num_code_points` DOES carry [default = 1], so it
  // is already 1 when unset, and an explicit 0 legitimately means "uninitialized cell".
  const cellCp: number[] = [];
  for (const c of lc.codePointsPerCell)
    for (let k = 0; k < (c.repeats || 1); k++) cellCp.push(c.numCodePoints);
  if (cellCp.length === 0) for (let k = 0; k < cps.length; k++) cellCp.push(1);
  const cellStyle: (CellStyle | undefined)[] = [];
  for (const s of lc.style) for (let k = 0; k < (s.repeats || 1); k++) cellStyle.push(s);

  const runs: Run[] = [];
  let cur: { style: Style; key: string; text: string; cells: number } | null = null;
  let ti = 0;
  for (let k = 0; k < cellCp.length; k++) {
    const n = cellCp[k] as number;
    let cellText: string;
    if (n === 0) cellText = " ";
    else {
      cellText = cps.slice(ti, ti + n).join("");
      ti += n;
    }
    const st = normalize(cellStyle[k]);
    if (st.invisible) cellText = " ".repeat(Math.max(1, codePoints(cellText)));
    const key = styleKey(st);
    if (cur && cur.key === key) {
      cur.text += cellText;
      cur.cells += 1;
    } else {
      if (cur) runs.push(toRun(cur));
      cur = { style: st, key, text: cellText, cells: 1 };
    }
  }
  if (cur) runs.push(toRun(cur));
  const soft = lc.continuation === LineContents_Continuation.SOFT_EOL;
  const merged = mergeRuns(runs);
  // A trailing blank on a soft row can separate words from the continuation.
  // Hard-EOL padding remains expendable; confirmed soft-row text must survive.
  const line: Line = { r: soft ? merged : trimTrailing(merged) };
  // protobuf-es v2 strips the enum-name prefix: proto CONTINUATION_SOFT_EOL -> TS SOFT_EOL.
  if (soft) line.w = true;
  return line;
}

function toRun(c: { style: Style; text: string; cells: number }): Run {
  const r: Run = { t: c.text };
  if (c.style.fg !== undefined) r.fg = c.style.fg;
  if (c.style.bg !== undefined) r.bg = c.style.bg;
  if (c.style.b) r.b = true;
  if (c.style.i) r.i = true;
  if (c.style.u) r.u = true;
  if (c.style.s) r.s = true;
  if (c.style.f) r.f = true;
  if (c.cells !== codePoints(c.text)) r.n = c.cells;
  return r;
}

export function bufferToScreen(resp: GetBufferResponse, rows: number, cols: number): Screen {
  const first = Number(resp.windowedCoordRange?.coordRange?.start?.y ?? 0n);
  const lines = resp.contents.map(lineContentsToLine);
  while (lines.length < rows) lines.push(emptyLine());
  if (lines.length > rows) lines.length = rows;
  const cy = resp.cursor ? Number(resp.cursor.y ?? 0n) - first : -1;
  const cursor: Cursor = { x: resp.cursor?.x ?? 0, y: Math.max(-1, Math.min(rows - 1, cy)) };
  return { cols, rows, cursor, lines, scrollbackTotal: first };
}
