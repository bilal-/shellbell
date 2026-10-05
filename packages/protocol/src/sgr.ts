import { type Color, codePoints, type Line, mergeRuns, type Run, trimTrailing } from "./screen.js";
import { cellWidth, stringCells } from "./width.js";

const ESC = "\x1b";
const MAX_CSI = 32;

interface Style {
  fg?: Color;
  bg?: Color;
  b?: boolean;
  i?: boolean;
  u?: boolean;
  s?: boolean;
  f?: boolean;
  inv?: boolean;
}

function toRun(text: string, st: Style): Run {
  const r: Run = { t: text };
  let fg = st.fg;
  let bg = st.bg;
  if (st.inv) {
    const f = fg ?? 15;
    const g = bg ?? 0;
    fg = g;
    bg = f;
  }
  if (fg !== undefined) r.fg = fg;
  if (bg !== undefined) r.bg = bg;
  if (st.b) r.b = true;
  if (st.i) r.i = true;
  if (st.u) r.u = true;
  if (st.s) r.s = true;
  if (st.f) r.f = true;
  const cells = stringCells(text);
  if (cells !== codePoints(text)) r.n = cells;
  return r;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(255, n | 0));
}

/** Parse one "38"/"48" extended color. Returns the color and how many extra groups were consumed. */
function extendedColor(groups: number[][], k: number): { color?: Color; consumed: number } {
  const grp = groups[k] as number[];
  if (grp.length > 1) {
    const mode = grp[1];
    const args = grp.slice(2);
    if (mode === 5 && args.length >= 1) return { color: clamp(args[0] as number), consumed: 0 };
    if (mode === 2) {
      const rgb = args.length >= 4 ? args.slice(1, 4) : args.slice(0, 3);
      if (rgb.length === 3)
        return {
          color: [clamp(rgb[0] as number), clamp(rgb[1] as number), clamp(rgb[2] as number)],
          consumed: 0,
        };
    }
    return { consumed: 0 };
  }
  const mode = groups[k + 1]?.[0];
  if (mode === 5 && groups[k + 2]) return { color: clamp(groups[k + 2]?.[0] ?? 0), consumed: 2 };
  if (mode === 2 && groups[k + 4]) {
    return {
      color: [
        clamp(groups[k + 2]?.[0] ?? 0),
        clamp(groups[k + 3]?.[0] ?? 0),
        clamp(groups[k + 4]?.[0] ?? 0),
      ],
      consumed: 4,
    };
  }
  return { consumed: 0 };
}

function applySgr(st: Style, params: string): Style {
  const s: Style = { ...st };
  const groups = (params === "" ? ["0"] : params.split(";")).map((p) =>
    p.split(":").map((x) => (x === "" ? 0 : Number(x))),
  );
  for (let k = 0; k < groups.length; k++) {
    const n = groups[k]?.[0] ?? 0;
    if (n === 0) {
      for (const key of Object.keys(s) as (keyof Style)[]) delete s[key];
    } else if (n === 1) s.b = true;
    else if (n === 2) s.f = true;
    else if (n === 3) s.i = true;
    else if (n === 4) s.u = true;
    else if (n === 7) s.inv = true;
    else if (n === 9) s.s = true;
    else if (n === 22) {
      delete s.b;
      delete s.f;
    } else if (n === 23) delete s.i;
    else if (n === 24) delete s.u;
    else if (n === 27) delete s.inv;
    else if (n === 29) delete s.s;
    else if (n >= 30 && n <= 37) s.fg = n - 30;
    else if (n === 39) delete s.fg;
    else if (n >= 40 && n <= 47) s.bg = n - 40;
    else if (n === 49) delete s.bg;
    else if (n >= 90 && n <= 97) s.fg = n - 90 + 8;
    else if (n >= 100 && n <= 107) s.bg = n - 100 + 8;
    else if (n === 38 || n === 48) {
      const { color, consumed } = extendedColor(groups, k);
      if (color !== undefined) {
        if (n === 38) s.fg = color;
        else s.bg = color;
      }
      k += consumed;
    }
  }
  return s;
}

/** Convert one row of SGR-styled text (as emitted by `tmux capture-pane -e`) into a Line. */
export function parseSgrLine(text: string): Line {
  const runs: Run[] = [];
  let st: Style = {};
  let buf = "";
  let col = 0;
  const flush = () => {
    if (buf) runs.push(toRun(buf, st));
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const unit = text[i] as string;
    if (unit === ESC) {
      const next = text[i + 1];
      if (next === "[") {
        let j = i + 2;
        let params = "";
        while (j < text.length && j - (i + 2) < MAX_CSI) {
          const c = text.charCodeAt(j);
          if (c >= 0x40 && c <= 0x7e) break;
          params += text[j];
          j++;
        }
        if (j >= text.length || j - (i + 2) >= MAX_CSI) {
          // Malformed CSI: emit ESC literally
          buf += unit;
          i++;
          continue;
        }
        if (text[j] === "m") {
          flush();
          st = applySgr(st, params);
        }
        i = j + 1;
        continue;
      }
      if (next === "]") {
        let j = i + 2;
        while (j < text.length && text[j] !== "\x07" && !(text[j] === ESC && text[j + 1] === "\\"))
          j++;
        i = text[j] === "\x07" ? j + 1 : j + 2;
        continue;
      }
      i += next === undefined ? 1 : 2;
      if (next === "(" || next === ")") i += 1; // ESC ( B — designator has one more char
      continue;
    }
    const code = text.charCodeAt(i);
    if (unit === "\t") {
      const n = 8 - (col % 8);
      buf += " ".repeat(n);
      col += n;
      i++;
      continue;
    }
    if (code < 0x20 || code === 0x7f) {
      i++;
      continue;
    }
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    buf += ch;
    col += cellWidth(cp);
    i += cp > 0xffff ? 2 : 1;
  }
  flush();
  return { r: trimTrailing(mergeRuns(runs)) };
}
