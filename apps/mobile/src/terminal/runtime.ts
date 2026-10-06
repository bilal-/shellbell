// Shellbell adapter around unmodified xterm.js (MIT). See THIRD_PARTY_NOTICES.md.
import { TERMINAL16 } from "@shellbell/protocol";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { cursorColor, paintViewport, type TerminalRow } from "./adapter";
import type { TerminalFrame } from "./bridge";
import { terminalWebUrl } from "./links";
import { terminalCellAtPoint } from "./mouse";
import { anchoredOffset, liveEndIndex, liveOffset, livePadding } from "./viewport";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (value: string) => void };
    shellbellReceive: (frame: TerminalFrame) => void;
    shellbellJumpToLive: () => void;
  }
}

const scroller = document.getElementById("scroll")!;
const spacer = document.getElementById("spacer")!;
const surface = document.getElementById("terminal")!;
const documentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const post = (data: object) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify({ document: documentId, ...data }));
const term = new Terminal({
  cols: 80,
  rows: 2,
  scrollback: 0,
  scrollOnEraseInDisplay: false,
  disableStdin: true,
  allowProposedApi: true,
  fontFamily: "ShellbellMono, monospace",
  fontSize: 14,
  theme: {
    background: "#000000",
    foreground: "#E8E8ED",
    black: TERMINAL16[0],
    red: TERMINAL16[1],
    green: TERMINAL16[2],
    yellow: TERMINAL16[3],
    blue: TERMINAL16[4],
    magenta: TERMINAL16[5],
    cyan: TERMINAL16[6],
    white: TERMINAL16[7],
    brightBlack: TERMINAL16[8],
    brightRed: TERMINAL16[9],
    brightGreen: TERMINAL16[10],
    brightYellow: TERMINAL16[11],
    brightBlue: TERMINAL16[12],
    brightMagenta: TERMINAL16[13],
    brightCyan: TERMINAL16[14],
    brightWhite: TERMINAL16[15],
  },
  // Bold weight and indexed brightness are separate source attributes.
  drawBoldTextInBrightColors: false,
  cursorBlink: false,
});
term.loadAddon(new UnicodeGraphemesAddon());
term.open(surface);
// Optional acceleration. Disposing this upstream addon restores xterm's DOM
// renderer without replacing its buffer, source geometry or selection.
surface.dataset.renderer = "dom";
const gpu = new WebglAddon();
let gpuLimit = 0;
const fallback = () => {
  gpu.dispose();
  surface.dataset.renderer = "dom";
  post({ type: "renderer", renderer: "dom" });
  term.refresh(0, term.rows - 1);
};
gpu.onContextLoss(fallback);
try {
  term.loadAddon(gpu);
  const canvas = surface.querySelector<HTMLCanvasElement>(".xterm-screen canvas:last-child");
  const context = canvas?.getContext("webgl2");
  if (!context) throw new Error("GPU renderer has no context");
  gpuLimit = Math.min(
    context.getParameter(context.MAX_TEXTURE_SIZE),
    context.getParameter(context.MAX_RENDERBUFFER_SIZE),
    ...context.getParameter(context.MAX_VIEWPORT_DIMS),
  );
  surface.dataset.renderer = "webgl";
} catch {
  fallback();
}
term.loadAddon(
  new WebLinksAddon((event, uri) => {
    event.preventDefault();
    const url = terminalWebUrl(uri);
    if (event.isTrusted && url && !frame?.mouse) post({ type: "link", url });
  }),
);
// Shellbell's outer viewport owns scrolling; xterm has no independent scrollback.
term.attachCustomWheelEventHandler(() => false);
// Native InputBar alone owns input. xterm must never summon a second IME.
if (term.textarea) {
  term.textarea.readOnly = true;
  term.textarea.tabIndex = -1;
  term.textarea.setAttribute("inputmode", "none");
}

let order: string[] = [];
const data = new Map<string, TerminalRow>();
let frame: TerminalFrame | null = null;
let revision = 0;
let cellHeight = 1;
let endIndex = -1;
let paddingTop = 0;
let following = true;
let gesture = false;
let painting = false;
let scheduled = false;
let needsPaint = false;
let lastAnchor: string | null = null;
let lastTopKey: string | null = null;
let lastBottomKey: string | null = null;
let lastFollowing: boolean | null = null;
let paintedRows: TerminalRow[] = [];
let paintedCols = 0;
let paintedRevision = 0;
let pointer: {
  id: number;
  x: number;
  y: number;
  at: number;
  revision: number;
  scrollTop: number;
  scrollLeft: number;
} | null = null;

scroller.addEventListener(
  "pointerdown",
  (event) => {
    pointer =
      frame?.mouse &&
      event.isTrusted &&
      event.isPrimary &&
      !painting &&
      !needsPaint &&
      paintedRevision === revision
        ? {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            at: performance.now(),
            revision,
            scrollTop: scroller.scrollTop,
            scrollLeft: scroller.scrollLeft,
          }
        : null;
  },
  { passive: true },
);
scroller.addEventListener("pointercancel", () => {
  pointer = null;
});
scroller.addEventListener(
  "pointermove",
  (event) => {
    if (
      pointer &&
      (event.pointerId !== pointer.id ||
        Math.hypot(event.clientX - pointer.x, event.clientY - pointer.y) > 8)
    )
      pointer = null;
  },
  { passive: true },
);
scroller.addEventListener("pointerup", (event) => {
  const start = pointer;
  pointer = null;
  if (
    !start ||
    !frame?.mouse ||
    event.pointerId !== start.id ||
    painting ||
    needsPaint ||
    paintedRevision !== revision ||
    start.revision !== revision ||
    performance.now() - start.at > 550 ||
    Math.hypot(event.clientX - start.x, event.clientY - start.y) > 8 ||
    scroller.scrollTop !== start.scrollTop ||
    scroller.scrollLeft !== start.scrollLeft
  )
    return;
  const box = surface.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!box) return;
  const cell = terminalCellAtPoint(
    paintedRows,
    paintedCols,
    box,
    term.rows,
    event.clientX,
    event.clientY,
  );
  if (!cell || ![0, 1, 2].includes(event.button)) return;
  term.clearSelection();
  post({
    type: "mouse",
    revision: paintedRevision,
    ...cell,
    button: ["left", "middle", "right"][event.button],
    modifiers: Number(event.shiftKey) + 2 * Number(event.ctrlKey) + 4 * Number(event.altKey),
  });
});
surface.addEventListener("contextmenu", (event) => {
  if (frame?.mouse) event.preventDefault();
});

function liveTop() {
  return liveOffset(order.length, endIndex, cellHeight, scroller.clientHeight);
}

function metrics() {
  // Read actual upstream DOM geometry, never guess fontSize * 0.6.
  const box = surface.querySelector(".xterm-screen")?.getBoundingClientRect();
  return {
    height: Math.max(1, (box?.height ?? term.rows) / term.rows),
    width: Math.max(1, (box?.width ?? term.cols) / term.cols),
  };
}

function positionViewport(before = order, offset = scroller.scrollTop, oldHeight = cellHeight) {
  const oldPadding = paddingTop;
  paddingTop = livePadding(order.length, endIndex, cellHeight, scroller.clientHeight);
  spacer.style.height = `${Math.max(scroller.clientHeight, paddingTop + order.length * cellHeight)}px`;
  if (following) {
    gesture = false;
    scroller.scrollTop = liveTop();
  } else if (before !== order || oldHeight !== cellHeight || oldPadding !== paddingTop) {
    scroller.scrollTop =
      paddingTop +
      anchoredOffset(before, order, Math.max(0, offset - oldPadding), oldHeight, cellHeight);
  }
  schedule();
}

function layout(before = order) {
  if (!frame || !scroller.clientHeight) return;
  // Bound the backing canvas before changing font/columns. A large source
  // terminal may exceed mobile GPU limits even though its rows are virtualized.
  const backingDimension =
    Math.max(
      frame.cols * frame.fontSize,
      term.rows * frame.fontSize * 1.5,
      scroller.clientHeight + 2 * frame.fontSize,
    ) * window.devicePixelRatio;
  if (surface.dataset.renderer === "webgl" && backingDimension > gpuLimit) fallback();
  gesture = false;
  const offset = scroller.scrollTop;
  const oldHeight = cellHeight;
  term.options.fontSize = frame.fontSize;
  term.resize(frame.cols, term.rows);
  let measured = metrics();
  if (frame.fitWidth) {
    term.options.fontSize = Math.max(
      5,
      (frame.fontSize * scroller.clientWidth) / (measured.width * frame.cols),
    );
    measured = metrics();
  }
  cellHeight = measured.height;
  surface.dataset.cellHeight = String(cellHeight);
  term.resize(frame.cols, Math.max(2, Math.ceil(scroller.clientHeight / cellHeight) + 1));
  const width = metrics().width * frame.cols;
  spacer.style.width = `${Math.max(scroller.clientWidth, width)}px`;
  surface.style.width = `${width}px`;
  positionViewport(before, offset, oldHeight);
}

function schedule() {
  needsPaint = true;
  if (scheduled || painting) return;
  scheduled = true;
  requestAnimationFrame(paint);
}

function paint() {
  scheduled = false;
  if (!frame || painting) return;
  needsPaint = false;
  painting = true;
  const start = Math.max(0, Math.floor((scroller.scrollTop - paddingTop) / cellHeight));
  const rows = order.slice(start, start + term.rows).map((key) => data.get(key)!);
  // xterm paints one overscan row. Selection includes only intersecting source rows.
  const bottomIndex =
    Math.ceil((scroller.scrollTop + scroller.clientHeight - paddingTop) / cellHeight) - 1;
  const bottomKey = order[Math.min(order.length - 1, bottomIndex)] ?? null;
  surface.style.top = `${paddingTop + start * cellHeight}px`;
  // Repainting a snapshot must not discard a user's copy selection just because
  // unrelated output arrived. Restore only the same retained source rows/text;
  // never silently copy different text at the old screen coordinates.
  const selection = term.getSelectionPosition();
  const selectedText = term.getSelection();
  const selectedRows = selection ? paintedRows.slice(selection.start.y, selection.end.y + 1) : [];
  const selectionStart = rows.findIndex((row) => row.key === selectedRows[0]?.key);
  const restoreSelection =
    selection &&
    selectedText &&
    paintedCols === frame.cols &&
    selectionStart >= 0 &&
    selectedRows.length === selection.end.y - selection.start.y + 1 &&
    selectedRows.every((row, i) => rows[selectionStart + i]?.key === row.key);
  // ED(2) deliberately preserves the selection model. Clear coordinates that
  // can no longer be tied to the same source rows before replacing their text.
  if (selection && !restoreSelection) term.clearSelection();
  const cursor = frame.cursor;
  const cursorRow = cursor ? rows.findIndex((row) => row.key === cursor.key) : -1;
  term.options.cursorBlink = cursor?.blinking ?? false;
  if (cursor)
    term.options.theme = {
      ...term.options.theme,
      cursor: cursorColor(cursor.accent, cursor.inferred),
    };
  const position =
    cursorRow >= 0 && cursor && cursor.x >= 0 && cursor.x < frame.cols
      ? `\x1b[${cursorRow + 1};${cursor.x + 1}H\x1b[?25h`
      : "";
  const renderingRevision = revision;
  // paintViewport's ED(2) clears cells AND stale wrap flags with
  // scrollOnEraseInDisplay=false. A full terminal reset also clears the DOM
  // before its asynchronous repaint, exposing blank frames on slower WebViews.
  term.write(paintViewport(rows, frame.cols) + position, () => {
    painting = false;
    paintedRows = rows;
    paintedCols = term.cols;
    paintedRevision = renderingRevision;
    if (restoreSelection && selection) {
      term.select(
        selection.start.x,
        selectionStart,
        (selection.end.y - selection.start.y) * term.cols + selection.end.x - selection.start.x,
      );
      if (term.getSelection() !== selectedText) term.clearSelection();
    }
    const anchor = rows.find((row) => row.history)?.key ?? null;
    const topKey = rows[0]?.key ?? null;
    if (
      anchor !== lastAnchor ||
      following !== lastFollowing ||
      topKey !== lastTopKey ||
      bottomKey !== lastBottomKey
    ) {
      lastAnchor = anchor;
      lastTopKey = topKey;
      lastBottomKey = bottomKey;
      lastFollowing = following;
      post({ type: "viewport", anchor, topKey, bottomKey, following });
    }
    post({ type: "ack", revision: paintedRevision });
    if (needsPaint) schedule();
  });
}

window.shellbellReceive = (next) => {
  if (next.document !== documentId || next.revision !== revision + 1) return;
  if (
    !Number.isInteger(next.cols) ||
    next.cols < 1 ||
    next.cols > 4096 ||
    !Number.isFinite(next.fontSize) ||
    next.fontSize < 5 ||
    next.fontSize > 72
  ) {
    post({ type: "error", message: "Unsupported terminal geometry" });
    return;
  }
  const before = order;
  for (const row of next.upsert) data.set(row.key, row);
  if (next.order) {
    order = next.order;
    const keep = new Set(order);
    for (const key of data.keys()) if (!keep.has(key)) data.delete(key);
  }
  if (order.some((key) => !data.has(key))) {
    post({ type: "error", message: "Incomplete terminal update" });
    return;
  }
  const initial = !frame;
  const relayout =
    !frame ||
    frame.cols !== next.cols ||
    frame.fontSize !== next.fontSize ||
    frame.fitWidth !== next.fitWidth ||
    before !== order;
  frame = next;
  revision = next.revision;
  endIndex = liveEndIndex(order, data, next.cursor?.key ?? null);
  if (relayout) layout(before);
  else positionViewport();
  if (initial && next.initialAnchor && order.includes(next.initialAnchor)) {
    following = false;
    scroller.scrollTop = paddingTop + order.indexOf(next.initialAnchor) * cellHeight;
  }
};

window.shellbellJumpToLive = () => {
  gesture = false;
  following = true;
  scroller.scrollTop = liveTop();
  schedule();
};
scroller.addEventListener(
  "touchstart",
  () => {
    gesture = true;
  },
  { passive: true },
);
scroller.addEventListener(
  "touchmove",
  () => {
    gesture = true;
  },
  { passive: true },
);
scroller.addEventListener(
  "touchcancel",
  () => {
    gesture = false;
  },
  { passive: true },
);
scroller.addEventListener(
  "scrollend",
  () => {
    gesture = false;
  },
  { passive: true },
);
scroller.addEventListener(
  "wheel",
  () => {
    gesture = true;
  },
  { passive: true },
);
scroller.addEventListener(
  "scroll",
  () => {
    if (gesture) {
      following = Math.abs(scroller.scrollTop - liveTop()) < cellHeight;
      if (scroller.scrollTop <= cellHeight) {
        gesture = false;
        post({ type: "older" });
      }
    }
    schedule();
  },
  { passive: true },
);
new ResizeObserver(() => {
  gesture = false;
  layout();
}).observe(scroller);
document.fonts.ready.then(() => {
  layout();
  post({ type: "ready", renderer: surface.dataset.renderer });
});
