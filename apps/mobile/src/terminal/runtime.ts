// Offline, unmodified xterm.js (MIT). Host snapshots need a cell adapter; xterm owns interaction.
import { MAX_TERMINAL_MESSAGE_BYTES, TERMINAL16 } from "@shellbell/protocol";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { SerializeAddon } from "@xterm/addon-serialize";
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { cursorColor, type TerminalRow } from "./adapter";
import type { TerminalFrame, TerminalVtMessage } from "./bridge";
import { TERMINAL_BUFFER_LIMIT, TerminalBuffer } from "./buffer";
import type { TerminalCommand } from "./controls";
import { terminalWebUrl } from "./links";
import { TerminalSelection } from "./selection";
import { bindTouchScroll } from "./touchScroll";
import { resetVtTerminal } from "./vt-checkpoint";
import { type HiddenVtTerminal, VtRenderer } from "./vt-renderer";

declare global {
  interface Window {
    ReactNativeWebView?: { postMessage: (value: string) => void };
    shellbellReceive: (frame: TerminalFrame) => void;
    shellbellVt: (message: TerminalVtMessage) => void;
    shellbellCommand: (command: TerminalCommand & { document: string }) => void;
    shellbellJumpToLive: () => void;
  }
}
const container = document.getElementById("container")!;
const surface = document.getElementById("terminal")!;
const documentId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const post = (data: object) =>
  window.ReactNativeWebView?.postMessage(JSON.stringify({ document: documentId, ...data }));
let term = new Terminal({
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
let fit = new FitAddon();
let search = new SearchAddon({ highlightLimit: 500 });
let serialize = new SerializeAddon();
term.loadAddon(fit);
term.loadAddon(search);
term.loadAddon(serialize);
term.open(surface);
/**
 * The phone keyboard only types into native fields: xterm takes input from a hardware keyboard
 * alone. A tap on the screen would otherwise focus xterm's hidden field, raise the soft keyboard
 * and let its autocorrect type straight into the shell.
 */
const keyboardInput = () => frame?.inputReady === true && frame.hardwareKeyboard === true;
let helper = term.textarea;
let buffer = new TerminalBuffer(term);
let renderer: "dom" | "webgl" = "dom";
let gpu: WebglAddon | null = null;
let gpuLimit = 0;
const fallback = () => {
  gpu?.dispose();
  gpu = null;
  renderer = "dom";
  surface.dataset.renderer = renderer;
  term.refresh(0, term.rows - 1);
  post({ type: "renderer", renderer });
};
function initializeGpu() {
  const active = term;
  const addon = new WebglAddon();
  gpu = addon;
  addon.onContextLoss(() => {
    if (gpu === addon && term === active) fallback();
  });
  try {
    term.loadAddon(addon);
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
}
initializeGpu();

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
let activeSearch: Extract<TerminalCommand, { type: "search" }> | null = null;
/**
 * Raw mode: the computer streams the terminal's own bytes and xterm owns the screen, scrolling
 * and modes. Rows, keys and history requests belong to snapshot mode only.
 */
let vtMode = false;
let vtRebuilding = false;
const vtRenderer = new VtRenderer(
  term,
  serialize,
  documentId,
  post,
  () => {
    // Called only after the renderer accepts the reset/capture/restore command.
    vtRebuilding = true;
    selection.cancelDrag();
    term.clearSelection();
    search.clearDecorations();
    post({ type: "search-pending" });
  },
  () => createHiddenTerminal(),
);
let vtStatusScheduled = false;
let lastVtStatus = "";
/** Raw writes xterm has not parsed yet; their replies stay blocked after leaving raw mode. */
let vtWritesPending = 0;
/** Inside a native paste or input command: data xterm emits now is the person's. */
let userInput = 0;
/** xterm reports a key just before the data it typed; replies never come with a key. */
let keyData: string | null = null;
/** The rows a raw terminal uses: through the cursor or the last written row. */
function vtOccupiedRows() {
  const active = term.buffer.active;
  if (active.type === "alternate") return term.rows;
  let last = active.cursorY;
  for (let y = term.rows - 1; y > last; y--) {
    if (
      active
        .getLine(active.baseY + y)
        ?.translateToString(true)
        .trim()
    ) {
      last = y;
      break;
    }
  }
  return last + 1;
}
/**
 * Tells the app what it needs from the screen: full-screen programs, the cursor row, and the
 * visible rows a waiting agent's choices are read from. Sent only when something changed.
 */
function postVtStatus() {
  if (vtStatusScheduled) return;
  vtStatusScheduled = true;
  requestAnimationFrame(() => {
    vtStatusScheduled = false;
    if (!vtMode || !vtRenderer.statusReady) return;
    const active = term.buffer.active;
    const rows = Array.from({ length: Math.min(term.rows, 200) }, (_, y) =>
      (active.getLine(active.baseY + y)?.translateToString(true) ?? "").slice(0, 512),
    );
    const status = {
      type: "vt-status",
      epoch: vtRenderer.renderEpoch,
      historyDropped: vtRenderer.historyDropped,
      historyLimited: vtRenderer.historyLimited,
      historyRows: term.buffer.normal.baseY,
      nativeHistoryValid: vtRenderer.nativeHistoryValid,
      alternate: active.type === "alternate",
      cursorLine: rows[active.cursorY] ?? "",
      cursorY: active.cursorY,
      rows,
    };
    const key = JSON.stringify(status);
    if (key === lastVtStatus) return;
    lastVtStatus = key;
    post(status);
  });
}
const terminalBusy = () => painting || (vtMode && vtRenderer.rebuilding);
let selection = new TerminalSelection(term, surface, terminalBusy);
function paste(text: string, submit = false) {
  if (!frame?.inputReady) return;
  touchScrolling.cancel();
  if (text.length > MAX_TERMINAL_MESSAGE_BYTES) {
    post({ type: "input-rejected" });
    return;
  }
  if (vtMode && frame.hostPaste) {
    post({ type: "paste", sequence: ++inputSequence, data: text, submit });
    return;
  }
  pasted = "";
  userInput++;
  try {
    term.paste(text);
  } finally {
    userInput--;
  }
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
  if (painting || navigating || !frame || (vtMode && vtRenderer.rebuilding)) return;
  const active = term.buffer.active;
  if (vtMode) {
    following =
      active.viewportY === active.baseY && Math.abs(liveScrollTarget() - container.scrollTop) < 2;
    const token = JSON.stringify([following]);
    if (token !== viewportToken) {
      viewportToken = token;
      post({ type: "viewport", anchor: null, following, topKey: null, bottomKey: null });
    }
    return;
  }
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
  if (vtMode) return vtOccupiedRows();
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
function scrolled() {
  viewport();
  if (
    !painting &&
    !navigating &&
    gesture &&
    term.buffer.active.viewportY === 0 &&
    (!vtMode || vtRenderer.nativeHistoryValid)
  ) {
    gesture = false;
    post({ type: "older" });
  }
}
function bindScrolling() {
  return bindTouchScroll(term, surface, container, {
    blocked: () => selection.enabled,
    busy: terminalBusy,
    arm: () => {
      gesture = true;
    },
    scrolled,
    interrupted: () => {
      pointer = null;
      cancelHold();
    },
  });
}
let touchScrolling = bindScrolling();
/**
 * Raw mode: the text a selection held when it was made. Output can redraw those cells while
 * xterm keeps the coordinates, so a write that changes the text drops the selection. Null for no
 * selection and for Select All, which follows the growing buffer on purpose.
 */
let selectionBaseline: string | null = null;
function bindTerminalEvents() {
  const target = term;
  helper = target.textarea;
  const input = helper;
  input?.setAttribute("inputmode", "none");
  input?.addEventListener("focus", () => {
    if (!keyboardInput()) input.blur();
  });
  target.loadAddon(
    new WebLinksAddon((event, uri) => {
      event.preventDefault();
      const url = terminalWebUrl(uri);
      if (target === term && event.isTrusted && url && !frame?.mouse) post({ type: "link", url });
    }),
  );
  target.onKey((event) => {
    if (target === term) {
      touchScrolling.cancel();
      keyData = event.key;
    }
  });
  target.onScroll(() => {
    if (target !== term) return;
    const active = term.buffer.active;
    if (vtMode && vtWritesPending > 0 && active.viewportY === active.baseY) return;
    scrolled();
  });
  target.onSelectionChange(() => {
    if (target !== term) return;
    selectionBaseline = vtMode && term.hasSelection() ? term.getSelection() : null;
    post({ type: "selection", selected: term.hasSelection() });
  });
  target.onData((data) => {
    if (target !== term) return;
    if (!frame?.inputReady || !data) return;
    // xterm answers terminal queries (cursor position, device attributes, colours) and reports
    // mouse and focus through this same event. The real terminal on the computer already
    // answered, so in raw mode only what a person typed or pasted may reach the shell.
    const typed = data === keyData;
    keyData = null;
    if ((vtMode || vtWritesPending > 0) && userInput === 0 && !typed && data.startsWith("\x1b"))
      return;
    if (pasted !== null) pasted += data;
    else post({ type: "input", sequence: ++inputSequence, data });
  });
  search.onDidChangeResults((result) => {
    if (target === term && !vtRebuilding) post({ type: "search-result", ...result });
  });
}
bindTerminalEvents();

/** Build off-screen; the stable outer surface keeps gestures and input on the visible terminal. */
function createHiddenTerminal(): HiddenVtTerminal {
  const mount = document.createElement("div");
  const bounds = surface.getBoundingClientRect();
  Object.assign(mount.style, {
    position: "fixed",
    left: "-100000px",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: `${bounds.width}px`,
    height: `${bounds.height}px`,
  });
  mount.setAttribute("aria-hidden", "true");
  document.body.append(mount);
  let next: Terminal | undefined;
  try {
    next = new Terminal({
      ...term.options,
      cols: term.cols,
      rows: term.rows,
      theme: { ...term.options.theme },
      disableStdin: true,
    });
    const nextFit = new FitAddon();
    const nextSearch = new SearchAddon({ highlightLimit: 500 });
    const nextSerialize = new SerializeAddon();
    next.loadAddon(new UnicodeGraphemesAddon());
    next.loadAddon(nextFit);
    next.loadAddon(nextSearch);
    next.loadAddon(nextSerialize);
    next.open(mount);
    const built = next;
    return {
      term: built,
      serializer: nextSerialize,
      discard() {
        built.dispose();
        mount.remove();
      },
      present(addedRows) {
        const previous = term;
        const previousType = previous.buffer.active.type;
        const viewport = previous.buffer.active.viewportY;
        const selected = previous.getSelectionPosition();
        const selectedText = previous.getSelection();
        const enabled = selection.enabled;
        const focus = document.activeElement === helper;
        const wasFollowing = following;
        navigating = true;
        cancelHold();
        pointer = null;
        gesture = false;
        keyData = null;
        selection.dispose();
        touchScrolling.dispose();
        const previousGpu = gpu;
        gpu = null;
        previousGpu?.dispose();
        term = built;
        fit = nextFit;
        search = nextSearch;
        serialize = nextSerialize;
        mount.removeAttribute("aria-hidden");
        mount.removeAttribute("style");
        Object.assign(mount.style, { width: "100%", height: "100%" });
        surface.replaceChildren(mount);
        previous.dispose();
        buffer = new TerminalBuffer(term);
        selection = new TerminalSelection(term, surface, terminalBusy);
        selection.enable(enabled);
        touchScrolling = bindScrolling();
        bindTerminalEvents();
        term.options.disableStdin = !frame?.inputReady;
        initializeGpu();
        lastLayout = "";
        layout();
        if (activeSearch) searchNow(activeSearch, true);
        if (wasFollowing || previousType !== term.buffer.active.type) term.scrollToBottom();
        else term.scrollToLine(viewport + (previousType === "normal" ? addedRows : 0));
        if (selected && selectedText && previousType === term.buffer.active.type) {
          const delta = previousType === "normal" ? addedRows : 0;
          term.select(
            selected.start.x,
            selected.start.y + delta,
            (selected.end.y - selected.start.y) * term.cols + selected.end.x - selected.start.x,
          );
          if (term.getSelection() !== selectedText) term.clearSelection();
        }
        selectionBaseline = term.hasSelection() ? term.getSelection() : null;
        if (focus && keyboardInput()) term.focus();
        navigating = false;
        post({ type: "renderer", renderer });
        if (!activeSearch) post({ type: "search-reset" });
        postVtStatus();
        viewportToken = "";
        viewportChanged();
      },
    };
  } catch (error) {
    next?.dispose();
    mount.remove();
    throw error;
  }
}

function viewportChanged() {
  viewport();
  selection.refresh();
}
function searchNow(command: Extract<TerminalCommand, { type: "search" }>, incremental = false) {
  activeSearch = command.text ? command : null;
  if (vtMode && vtRenderer.rebuilding) {
    post({ type: "search-pending" });
    return;
  }
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
      incremental,
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
      if (keyboardInput()) term.focus();
      return;
    case "blur":
      term.blur();
      return;
    case "paste": {
      paste(command.text, command.submit);
      return;
    }
    case "input":
      touchScrolling.cancel();
      if (frame.inputReady && command.data.length <= MAX_TERMINAL_MESSAGE_BYTES) {
        userInput++;
        try {
          term.input(command.data, true);
        } finally {
          userInput--;
        }
      }
      return;
    case "select-all":
      touchScrolling.cancel();
      if (terminalBusy()) return;
      selection.cancelDrag();
      term.selectAll();
      selectionBaseline = null;
      return;
    case "select":
      touchScrolling.cancel();
      selection.enable(command.enabled);
      return;
    case "copy": {
      if (terminalBusy() || vtWritesPending > 0) {
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
      touchScrolling.cancel();
      searchNow(command);
      return;
    case "clear-search":
      touchScrolling.cancel();
      activeSearch = null;
      selection.cancelDrag();
      search.clearDecorations();
      term.clearSelection();
  }
};
let lastLayout = "";
let lastViewportGrid = "";
function layout() {
  if (!frame || !container.clientWidth) return;
  const key = JSON.stringify([
    frame.fontSize,
    frame.fitWidth,
    frame.cols,
    term.cols,
    term.rows,
    container.clientWidth,
    container.clientHeight,
  ]);
  if (key === lastLayout) return;
  lastLayout = key;
  term.options.fontSize = frame.fontSize;
  surface.style.width = `${container.clientWidth}px`;
  surface.style.height = `${container.clientHeight}px`;
  const proposed = fit.proposeDimensions();
  if (proposed) {
    const viewport = {
      type: "viewport-grid",
      ...proposed,
      width: container.clientWidth,
      height: container.clientHeight,
      fontSize: frame.fontSize,
    };
    const key = JSON.stringify(viewport);
    if (key !== lastViewportGrid) {
      lastViewportGrid = key;
      post(viewport);
    }
  }
  if (frame.fitWidth && proposed)
    term.options.fontSize = Math.max(5, (frame.fontSize * proposed.cols) / frame.cols);
  const screen = surface.querySelector<HTMLElement>(".xterm-screen");
  const width = screen?.getBoundingClientRect().width ?? container.clientWidth;
  const height = screen?.getBoundingClientRect().height ?? container.clientHeight;
  // Keep xterm's scrollbar beside the last column, including after a history swap.
  const scrollbar = surface.querySelector<HTMLElement>(".scrollbar.vertical");
  const gutter = scrollbar ? Number.parseFloat(getComputedStyle(scrollbar).width) || 0 : 0;
  const surfaceWidth = Math.ceil(width + gutter);
  // The outer pan accommodates larger grids; spare space frames smaller ones.
  surface.style.width = `${surfaceWidth}px`;
  surface.style.height = `${Math.max(1, height)}px`;
  surface.classList.toggle(
    "framed",
    surfaceWidth < container.clientWidth || height < container.clientHeight,
  );
  if (renderer === "webgl" && Math.max(width, height) * window.devicePixelRatio > gpuLimit)
    fallback();
}

function scrollToRow(row: number) {
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
  if (vtMode !== (next.vt === true)) {
    // Switching between raw and snapshot output: neither may build on the other's screen.
    vtMode = false;
    await vtRenderer.reset();
    vtRebuilding = false;
    search.clearDecorations();
    post({ type: "search-reset" });
    await resetVtTerminal(term);
    buffer = new TerminalBuffer(term);
    vtMode = next.vt === true;
    if (vtMode) {
      order = [];
      rows.clear();
      // Snapshots size the scrollback to their own history, which can be none at all; a raw
      // stream's history scrolls in by itself and needs the whole limit.
      term.options.scrollback = TERMINAL_BUFFER_LIMIT;
    }
  }
  frame = next;
  revision = next.revision;
  if (vtMode) {
    try {
      term.options.disableStdin = !next.inputReady;
      if (!keyboardInput() && document.activeElement === helper) helper?.blur();
      term.options.screenReaderMode = next.screenReader === true;
      layout();
      if (wasFollowing) container.scrollTop = liveScrollTarget();
      painting = false;
      viewport();
      post({ type: "ack", revision });
    } catch {
      painting = false;
      post({ type: "error" });
    }
    return;
  }
  // The phone sends 0 live rows until the session reports its screen size.
  const liveRows =
    next.liveRows || Math.max(1, ...order.map((key) => (rows.get(key)?.liveRow ?? -1) + 1));
  try {
    await buffer.present(
      order.map((key) => rows.get(key)!),
      next.cols,
      liveRows,
    );
    term.options.disableStdin = !next.inputReady;
    // Detaching the hardware keyboard, or pausing input, hands the keyboard back to native fields.
    if (!keyboardInput() && document.activeElement === helper) helper?.blur();
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
window.shellbellVt = async (message) => {
  if (message.document !== documentId || !vtMode) return;
  const writesVisible =
    !vtRenderer.buildingHidden &&
    !(message.checkpoint?.kind === "restore" && message.checkpoint.nativePage);
  if (writesVisible) vtWritesPending++;
  try {
    await vtRenderer.receive(message);
  } finally {
    if (writesVisible) vtWritesPending--;
  }
  if (vtMode && vtRenderer.statusReady) {
    if (vtRebuilding) {
      vtRebuilding = false;
      post({ type: "search-reset" });
    }
    if (selectionBaseline !== null && term.getSelection() !== selectionBaseline) {
      selection.cancelDrag();
      term.clearSelection();
    }
    layout();
    if (following) {
      term.scrollToBottom();
      container.scrollTop = liveScrollTarget();
    }
    selection.refresh();
    viewport();
    postVtStatus();
  }
};
window.shellbellJumpToLive = () => {
  touchScrolling.cancel();
  gesture = false;
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
    if (vtMode && vtWritesPending > 0) return;
    viewport();
    selection.refresh();
  },
  { passive: true },
);
surface.addEventListener(
  "wheel",
  () => {
    gesture = true;
    // Read after xterm's wheel handler, before another parser task can finish
    // and auto-follow over the reader's explicit scroll decision.
    queueMicrotask(viewport);
  },
  { passive: true },
);
// A still finger held on the terminal starts touch selection, so no toolbar has to offer it.
const LONG_PRESS_MS = 450;
let hold: { id: number; x: number; y: number; timer: ReturnType<typeof setTimeout> } | null = null;
let held = false;
function cancelHold() {
  if (hold) clearTimeout(hold.timer);
  hold = null;
}
surface.addEventListener(
  "pointerdown",
  (event) => {
    cancelHold();
    held = false;
    if (event.pointerType !== "touch" || selection.enabled || painting) return;
    const point = { clientX: event.clientX, clientY: event.clientY };
    hold = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        hold = null;
        if (selection.enabled || !selection.startAt(point)) return;
        held = true;
        post({ type: "select-start" });
      }, LONG_PRESS_MS),
    };
  },
  { passive: true },
);
surface.addEventListener(
  "pointermove",
  (event) => {
    if (
      hold &&
      event.pointerId === hold.id &&
      Math.hypot(hold.x - event.clientX, hold.y - event.clientY) > 8
    )
      cancelHold();
  },
  { passive: true },
);
for (const type of ["pointerup", "pointercancel"] as const)
  surface.addEventListener(type, cancelHold, { passive: true });
surface.addEventListener("contextmenu", (event) => {
  // The system's own long-press menu would cover the selection that just started.
  if (frame?.mouse || held || selection.enabled) event.preventDefault();
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
