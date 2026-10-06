// Offline, unmodified xterm.js (MIT). Host snapshots need a cell adapter; xterm owns interaction.
import { TERMINAL16 } from "@shellbell/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { cursorColor, type TerminalRow } from "./adapter";
import type { TerminalFrame } from "./bridge";
import { TERMINAL_BUFFER_LIMIT, TerminalBuffer } from "./buffer";
import type { TerminalCommand } from "./controls";
import { terminalWebUrl } from "./links";
import { TerminalSelection } from "./selection";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (value: string) => void };
    shellbellReceive: (frame: TerminalFrame) => void;
    shellbellCommand: (command: TerminalCommand & { document: string }) => void;
    shellbellJumpToLive: () => void;
  }
}
const container = document.getElementById("container")!;
const surface = document.getElementById("terminal")!;
const documentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const post = (data: object) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify({ document: documentId, ...data }));
const term = new Terminal({
  cols: 80,
  rows: 24,
  scrollback: TERMINAL_BUFFER_LIMIT,
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
    selectionBackground: "#4c566a",
  },
  drawBoldTextInBrightColors: false,
  cursorBlink: false,
  rightClickSelectsWord: true,
  minimumContrastRatio: 4.5,
});
term.loadAddon(new UnicodeGraphemesAddon());
const fit = new FitAddon();
const search = new SearchAddon({ highlightLimit: 500 });
const serialize = new SerializeAddon();
term.loadAddon(fit);
term.loadAddon(search);
term.loadAddon(serialize);
term.open(surface);
const buffer = new TerminalBuffer(term);
let renderer: "dom" | "webgl" = "dom";
let gpu: WebglAddon | null = new WebglAddon();
let gpuLimit = 0;
const fallback = () => {
  gpu?.dispose();
  gpu = null;
  renderer = "dom";
  surface.dataset.renderer = renderer;
  term.refresh(0, term.rows - 1);
  post({ type: "renderer", renderer });
};
gpu.onContextLoss(fallback);
try {
  term.loadAddon(gpu);
  const context = surface
    .querySelector<HTMLCanvasElement>(".xterm-screen canvas:last-child")
    ?.getContext("webgl2");
  if (!context) throw new Error("GPU context unavailable");
  gpuLimit = Math.min(
    context.getParameter(context.MAX_TEXTURE_SIZE),
    context.getParameter(context.MAX_RENDERBUFFER_SIZE),
    ...context.getParameter(context.MAX_VIEWPORT_DIMS),
  );
  renderer = "webgl";
} catch {
  fallback();
}
surface.dataset.renderer = renderer;
term.loadAddon(
  new WebLinksAddon((event, uri) => {
    event.preventDefault();
    const url = terminalWebUrl(uri);
    if (event.isTrusted && url && !frame?.mouse) post({ type: "link", url });
  }),
);

let order: string[] = [];
const rows = new Map<string, TerminalRow>();
let frame: TerminalFrame | null = null;
let revision = 0;
let painting = false;
let following = true;
let navigating = false;
let gesture = false;
let inputSequence = 0;
let viewportToken = "";
let resizeScheduled = false;
let pasted: string | null = null;
const selection = new TerminalSelection(term, surface, () => painting);
function paste(text: string, submit = false) {
  if (!frame?.inputReady) return;
  if (text.length > 59000) {
    post({ type: "input-rejected" });
    return;
  }
  pasted = "";
  term.paste(text);
  const data = pasted;
  pasted = null;
  if (data)
    post(
      frame.hostPaste
        ? { type: "paste", sequence: ++inputSequence, data, submit }
        : { type: "input", sequence: ++inputSequence, data: data + (submit ? "\r" : "") },
    );
}
// Intercept the browser's clipboard gesture without reading it in the background.
surface.addEventListener(
  "paste",
  (event) => {
    const text = event.clipboardData?.getData("text/plain");
    if (text === undefined) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    paste(text);
  },
  true,
);
function viewport() {
  if (painting || navigating || !frame) return;
  const active = term.buffer.active;
  const cellHeight =
    surface.querySelector(".xterm-screen")!.getBoundingClientRect().height / term.rows;
  const top = active.viewportY + Math.floor(container.scrollTop / cellHeight);
  const bottom = Math.min(
    order.length - 1,
    active.viewportY + Math.ceil((container.scrollTop + container.clientHeight) / cellHeight) - 1,
  );
  const topKey = order[top] ?? null;
  const bottomKey = order[bottom] ?? null;
  const anchor = order.slice(top, bottom + 1).find((key) => rows.get(key)?.history) ?? null;
  following =
    active.viewportY === active.baseY && Math.abs(liveScrollTarget() - container.scrollTop) < 2;
  const token = JSON.stringify([topKey, bottomKey, anchor, following]);
  if (token !== viewportToken) {
    viewportToken = token;
    post({ type: "viewport", anchor, following, topKey, bottomKey });
  }
}
function occupiedLiveRows() {
  let count = 1;
  for (const row of rows.values()) {
    if (row.liveRow !== undefined && row.line.r.some((run) => run.t.trim() || run.bg !== undefined))
      count = Math.max(count, row.liveRow + 1);
  }
  const cursor = frame?.cursor ? rows.get(frame.cursor.key)?.liveRow : undefined;
  return Math.max(count, cursor === undefined ? 1 : cursor + 1);
}
function liveScrollTarget() {
  const height = surface.querySelector(".xterm-screen")!.getBoundingClientRect().height / term.rows;
  return Math.max(
    0,
    Math.min(
      container.scrollHeight - container.clientHeight,
      occupiedLiveRows() * height - container.clientHeight,
    ),
  );
}
term.onScroll(() => {
  viewport();
  if (!painting && !navigating && gesture && term.buffer.active.viewportY === 0) {
    gesture = false;
    post({ type: "older" });
  }
});
term.onSelectionChange(() => post({ type: "selection", selected: term.hasSelection() }));
term.onData((data) => {
  if (!frame?.inputReady || !data) return;
  if (pasted !== null) pasted += data;
  else post({ type: "input", sequence: ++inputSequence, data });
});
search.onDidChangeResults((result) => post({ type: "search-result", ...result }));
function searchNow(command: Extract<TerminalCommand, { type: "search" }>) {
  // Search moves the viewport programmatically; an earlier tap is not a history request.
  gesture = false;
  selection.cancelDrag();
  if (!command.text) {
    search.clearDecorations();
    post({ type: "search-result", resultIndex: -1, resultCount: 0 });
    return;
  }
  if (command.text.length > 256) return;
  try {
    if (command.regex) new RegExp(command.text);
    const options = {
      caseSensitive: command.caseSensitive,
      wholeWord: command.wholeWord,
      regex: command.regex,
      decorations: {
        matchBackground: "#554a16",
        matchOverviewRuler: "#d4b54b",
        activeMatchBackground: "#2e745b",
        activeMatchColorOverviewRuler: "#68d9a4",
      },
    };
    const found =
      command.direction === "previous"
        ? search.findPrevious(command.text, options)
        : search.findNext(command.text, options);
    if (!found) post({ type: "search-result", resultIndex: -1, resultCount: 0 });
    viewport();
  } catch {
    post({ type: "search-error" });
  }
}
window.shellbellCommand = (command) => {
  if (command.document !== documentId || !frame) return;
  switch (command.type) {
    case "focus":
      if (frame.inputReady) term.focus();
      return;
    case "blur":
      term.blur();
      return;
    case "paste": {
      paste(command.text, command.submit);
      return;
    }
    case "input":
      if (frame.inputReady && command.data.length <= 59000) term.input(command.data, true);
      return;
    case "select-all":
      selection.cancelDrag();
      term.selectAll();
      return;
    case "select":
      selection.enable(command.enabled);
      return;
    case "copy": {
      if (painting) {
        post({ type: "copy-busy", request: command.request });
        return;
      }
      const text = term.getSelection();
      if (!text) {
        post({ type: "copy-empty", request: command.request });
        return;
      }
      const html =
        command.format === "html"
          ? serialize.serializeAsHTML({ onlySelection: true, includeGlobalBackground: true })
          : undefined;
      if (
        new TextEncoder().encode(text).length > 4_194_304 ||
        (html && new TextEncoder().encode(html).length > 4_194_304)
      ) {
        post({ type: "copy-too-large", request: command.request });
        return;
      }
      post({ type: "copy", text, html, request: command.request });
      return;
    }
    case "search":
      searchNow(command);
      return;
    case "clear-search":
      selection.cancelDrag();
      search.clearDecorations();
      term.clearSelection();
  }
};
function layout() {
  if (!frame || !container.clientWidth) return;
  term.options.fontSize = frame.fontSize;
  surface.style.width = `${container.clientWidth}px`;
  surface.style.height = `${container.clientHeight}px`;
  const proposed = fit.proposeDimensions();
  if (frame.fitWidth && proposed)
    term.options.fontSize = Math.max(5, (frame.fontSize * proposed.cols) / frame.cols);
  const screen = surface.querySelector<HTMLElement>(".xterm-screen");
  const width = screen?.getBoundingClientRect().width ?? container.clientWidth;
  const height = screen?.getBoundingClientRect().height ?? container.clientHeight;
  // xterm owns its scrollbar; this outer pan only accommodates a larger host grid.
  surface.style.width = `${Math.max(container.clientWidth, width)}px`;
  surface.style.height = `${Math.max(1, height)}px`;
  surface.style.marginTop =
    occupiedLiveRows() === term.rows ? `${Math.max(0, container.clientHeight - height)}px` : "0px";
  if (renderer === "webgl" && Math.max(width, height) * window.devicePixelRatio > gpuLimit)
    fallback();
}

function scrollToRow(row: number) {
  gesture = false;
  navigating = true;
  // xterm 6 can retain the old pixel offset after a WebGL font-size change.
  // Clamp to its scroll origin first, then apply the absolute buffer row using
  // public APIs; this also synchronizes xterm's new scrollbar dimensions.
  term.scrollLines(-Number.MAX_SAFE_INTEGER);
  term.scrollLines(Math.max(0, Math.min(row, term.buffer.active.baseY)));
  navigating = false;
}
window.shellbellReceive = async (next) => {
  if (next.document !== documentId || next.revision !== revision + 1 || painting) return;
  if (!Number.isFinite(next.fontSize) || next.fontSize < 5 || next.fontSize > 72) {
    post({ type: "error" });
    return;
  }
  painting = true;
  const oldOrder = order;
  const oldHeight =
    surface.querySelector(".xterm-screen")!.getBoundingClientRect().height / term.rows;
  const oldTop =
    oldOrder[term.buffer.active.viewportY + Math.floor(container.scrollTop / oldHeight)];
  const wasFollowing = following && (oldOrder.length > 0 || !next.initialAnchor);
  const oldCols = term.cols;
  const oldSelection = term.getSelectionPosition();
  const oldText = term.getSelection();
  const selectedKeys = oldSelection
    ? oldOrder.slice(oldSelection.start.y, oldSelection.end.y + (oldSelection.end.x ? 1 : 0))
    : [];
  const oldLines = selectedKeys.map((key) => rows.get(key)?.line);
  for (const row of next.upsert) rows.set(row.key, row);
  if (next.order) {
    order = next.order;
    const keep = new Set(order);
    for (const key of rows.keys()) if (!keep.has(key)) rows.delete(key);
  }
  if (order.some((key) => !rows.has(key))) {
    painting = false;
    post({ type: "error" });
    return;
  }
  frame = next;
  revision = next.revision;
  const liveRows =
    next.liveRows ?? Math.max(1, ...order.map((key) => (rows.get(key)?.liveRow ?? -1) + 1));
  try {
    await buffer.present(
      order.map((key) => rows.get(key)!),
      next.cols,
      liveRows,
    );
    term.options.disableStdin = !next.inputReady;
    term.options.screenReaderMode = next.screenReader === true;
    term.options.cursorBlink = next.cursor?.blinking ?? false;
    if (next.cursor) {
      term.options.theme = {
        ...term.options.theme,
        cursor: cursorColor(next.cursor.accent, next.cursor.inferred),
      };
      const row = rows.get(next.cursor.key)?.liveRow;
      await new Promise<void>((resolve) =>
        term.write(
          row !== undefined
            ? `\x1b[${row + 1};${Math.min(next.cols, Math.max(1, next.cursor!.x + 1))}H\x1b[?25h`
            : "\x1b[?25l",
          resolve,
        ),
      );
    }
    layout();
    if (wasFollowing) {
      scrollToRow(term.buffer.active.baseY);
      container.scrollTop = liveScrollTarget();
    } else {
      const anchor = oldOrder.length ? oldTop : next.initialAnchor;
      const index = anchor ? order.indexOf(anchor) : -1;
      if (index >= 0) {
        scrollToRow(index);
        const cellHeight =
          surface.querySelector(".xterm-screen")!.getBoundingClientRect().height / term.rows;
        container.scrollTop = Math.max(0, index - term.buffer.active.baseY) * cellHeight;
      }
    }
    if (oldSelection && selectedKeys.length) {
      const start = order.indexOf(selectedKeys[0]!);
      const unchanged =
        next.cols === oldCols &&
        start >= 0 &&
        selectedKeys.every(
          (key, index) => order[start + index] === key && rows.get(key)?.line === oldLines[index],
        );
      if (unchanged) {
        term.select(
          oldSelection.start.x,
          start,
          (oldSelection.end.y - oldSelection.start.y) * term.cols +
            oldSelection.end.x -
            oldSelection.start.x,
        );
        if (term.getSelection() === oldText) selection.rebase(start - oldSelection.start.y);
        else {
          selection.cancelDrag();
          term.clearSelection();
        }
      } else {
        selection.cancelDrag();
        term.clearSelection();
      }
    }
    // SearchAddon refreshes its existing match on writes; advancing here would skip a match.
    painting = false;
    selection.refresh();
    viewport();
    post({ type: "ack", revision });
    if (next.hardwareKeyboard && next.inputReady && !oldOrder.length) term.focus();
  } catch {
    painting = false;
    post({ type: "error" });
  }
};
window.shellbellJumpToLive = () => {
  scrollToRow(term.buffer.active.baseY);
  container.scrollTop = liveScrollTarget();
  viewport();
};
let pointer: {
  id: number;
  x: number;
  y: number;
  revision: number;
  time: number;
  viewport: number;
  left: number;
  top: number;
} | null = null;
surface.addEventListener(
  "pointerdown",
  (event) => {
    gesture = true;
    pointer =
      frame?.mouse && !selection.enabled && event.isTrusted && !painting
        ? {
            id: event.pointerId,
            x: event.clientX,
            y: event.clientY,
            revision,
            time: performance.now(),
            viewport: term.buffer.active.viewportY,
            left: container.scrollLeft,
            top: container.scrollTop,
          }
        : null;
  },
  { passive: true },
);
surface.addEventListener(
  "pointermove",
  (event) => {
    if (pointer && Math.hypot(pointer.x - event.clientX, pointer.y - event.clientY) > 8)
      pointer = null;
  },
  { passive: true },
);
surface.addEventListener("pointercancel", () => {
  pointer = null;
});
surface.addEventListener("pointerup", (event) => {
  const start = pointer;
  pointer = null;
  if (
    !start ||
    painting ||
    !frame?.mouse ||
    start.revision !== revision ||
    start.id !== event.pointerId ||
    Math.hypot(start.x - event.clientX, start.y - event.clientY) > 8 ||
    performance.now() - start.time > 550 ||
    start.viewport !== term.buffer.active.viewportY ||
    start.left !== container.scrollLeft ||
    start.top !== container.scrollTop ||
    selection.enabled
  )
    return;
  const screen = surface.querySelector(".xterm-screen")?.getBoundingClientRect();
  if (!screen?.width || !screen.height) return;
  const column = Math.floor(((event.clientX - screen.left) * term.cols) / screen.width);
  const index =
    term.buffer.active.viewportY +
    Math.floor(((event.clientY - screen.top) * term.rows) / screen.height);
  const source = rows.get(order[index] ?? "");
  if (
    !source ||
    source.liveRow === undefined ||
    column < 0 ||
    column >= term.cols ||
    ![0, 1, 2].includes(event.button)
  )
    return;
  term.clearSelection();
  post({
    type: "mouse",
    revision,
    key: source.key,
    column,
    row: source.liveRow,
    button: ["left", "middle", "right"][event.button],
    modifiers: Number(event.shiftKey) + 2 * Number(event.ctrlKey) + 4 * Number(event.altKey),
  });
});
container.addEventListener(
  "scroll",
  () => {
    viewport();
    selection.refresh();
  },
  { passive: true },
);
surface.addEventListener(
  "wheel",
  () => {
    gesture = true;
  },
  { passive: true },
);
surface.addEventListener("contextmenu", (event) => {
  if (frame?.mouse) event.preventDefault();
});
new ResizeObserver(() => {
  if (!resizeScheduled) {
    resizeScheduled = true;
    requestAnimationFrame(() => {
      resizeScheduled = false;
      const wasFollowing = following;
      layout();
      if (wasFollowing) container.scrollTop = liveScrollTarget();
      selection.refresh();
      viewport();
    });
  }
}).observe(container);
document.fonts.ready.then(() => post({ type: "ready", renderer }));
