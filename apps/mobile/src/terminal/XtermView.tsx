import { MAX_TERMINAL_MESSAGE_BYTES, type TerminalMouseClick } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Pressable, Text, TextInput, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { StreamDisplayRow } from "../screen/stream-presentation";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
import { JumpToLiveButton } from "../ui/JumpToLiveButton";
import { Toast } from "../ui/Toast";
import type { TerminalRow } from "./adapter";
import { TerminalBridge, type TerminalModel, TerminalVtBridge, type VtSource } from "./bridge";
import type { TerminalCommand, TerminalControls } from "./controls";
import { terminalHtml } from "./gen/document";
import { terminalWebUrl } from "./links";
import { terminalMouseClick } from "./mouse";
import type { VtPendingOperation } from "./vt-bridge";
import type { VtRenderError } from "./vt-wire";

/** What the terminal tells the app about a raw stream's screen. `cursorY` is -1 when unknown. */
export interface VtStatus {
  alternate: boolean;
  cursorLine: string;
  cursorY: number;
  rows: string[];
  historyDropped?: boolean;
  historyLimited?: boolean;
}

interface Props {
  rows: readonly StreamDisplayRow[];
  cols: number;
  fontSize: number;
  fitWidth: boolean;
  cursor: { x: number; y: number; accent: string; blinking: boolean; inferred?: boolean } | null;
  initialAnchor: string | null;
  onViewport: (
    anchor: string | null,
    following: boolean,
    topKey: string | null,
    bottomKey: string | null,
  ) => void;
  onLoadOlder: () => void;
  onRenderer?: (renderer: "webgl" | "dom") => void;
  mouseMode?: boolean;
  liveRows?: number;
  onMouseClick?: (click: TerminalMouseClick) => void;
  controls?: TerminalControls;
  inputReady?: boolean;
  hardwareKeyboard?: boolean;
  screenReader?: boolean;
  hideToolbar?: boolean;
  onInput?: (data: string) => boolean;
  onPaste?: (text: string, submit: boolean) => boolean;
  /** The screen owns these: the session menu opens search, and its header shows selection. */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  selecting?: boolean;
  onSelectingChange?: (selecting: boolean) => void;
  onSelectionChange?: (selected: boolean) => void;
  onCopied?: () => void;
  /** Raw mode: the terminal's own bytes since its latest starting point; `rows` are ignored. */
  vt?: { log: VtSource; length: number } | null;
  /** What raw mode's screen shows that the app needs: a full-screen program, the cursor row. */
  onVtStatus?: (status: VtStatus) => void;
  onVtError?: (source: VtSource, reason: VtRenderError) => void;
}

// The buffer detects unchanged history by line identity, and a fresh gap line on
// every render would rebuild the whole buffer instead of repainting the live grid.
const gapLines = new Map<string, TerminalRow["line"]>();
function gapLine(label: string): TerminalRow["line"] {
  let line = gapLines.get(label);
  if (!line) {
    line = { r: [{ t: `── ${label} ──`, fg: 8 }] };
    gapLines.set(label, line);
  }
  return line;
}

/** Offline xterm.js (MIT). Keys stay native; explicit live-cell clicks are validated here. */
export function XtermView({
  rows,
  cols,
  fontSize,
  fitWidth,
  cursor,
  initialAnchor,
  onViewport,
  onLoadOlder,
  onRenderer,
  mouseMode = false,
  liveRows = 0,
  onMouseClick,
  controls,
  inputReady = false,
  hardwareKeyboard = false,
  screenReader = false,
  hideToolbar = false,
  onInput,
  onPaste,
  searchOpen = false,
  onSearchOpenChange,
  selecting = false,
  onSelectingChange,
  onSelectionChange,
  onCopied,
  vt = null,
  onVtStatus,
  onVtError,
}: Props) {
  const web = useRef<WebView>(null);
  const document = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vtError, setVtError] = useState<string | null>(null);
  const displayError = error ?? vtError;
  const [linkError, setLinkError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const reportVtError = useRef<(source: VtSource, reason: VtRenderError) => void>(() => {});
  reportVtError.current = (source, reason) => {
    if (source !== vt?.log) return;
    onVtError?.(source, reason);
    setVtError(
      reason === "checkpoint-missing"
        ? "Terminal history needs a fresh starting point"
        : "Terminal renderer could not display this update",
    );
  };
  const reportVtReady = useRef<(source: VtSource) => void>(() => {});
  reportVtReady.current = (source) => {
    if (source === vt?.log) setVtError(null);
  };
  const [following, setFollowing] = useState(initialAnchor === null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const vtTimeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(0);
  const acknowledged = useRef(0);
  const inputSequence = useRef(0);
  const copyRequest = useRef<string | null>(null);
  const [selected, setSelected] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [searchStatus, setSearchStatus] = useState("Search loaded history");
  const command = useCallback(
    (value: TerminalCommand): boolean => {
      if (!document.current || displayError) return false;
      if (["focus", "input", "paste"].includes(value.type) && !inputReady) return false;
      if (value.type === "focus") web.current?.requestFocus();
      if (value.type === "copy") {
        copyRequest.current = `${Date.now()}:${Math.random()}`;
        value = { ...value, request: copyRequest.current };
      }
      web.current?.injectJavaScript(
        `window.shellbellCommand(${JSON.stringify({ ...value, document: document.current }).replace(/</g, "\\u003c")});true;`,
      );
      return true;
    },
    [displayError, inputReady],
  );
  useEffect(() => controls?.bind(command), [controls, command]);
  const latestCommand = useRef(command);
  latestCommand.current = command;
  // xterm keeps touch selection inside the WebView; the screen decides when it is on.
  useEffect(() => {
    latestCommand.current({ type: "select", enabled: selecting });
  }, [selecting]);
  const armWatchdog = useCallback((message: string) => {
    clearTimeout(timeout.current);
    if (AppState.currentState === "active") {
      timeout.current = setTimeout(() => setError(message), 10_000);
    }
  }, []);
  const armVtWatchdog = useCallback((bridge: TerminalVtBridge, operation: VtPendingOperation) => {
    clearTimeout(vtTimeout.current);
    if (AppState.currentState === "active")
      vtTimeout.current = setTimeout(() => bridge.timeout(operation), 10_000);
  }, []);
  const vtBridge = useMemo(() => {
    const instance: TerminalVtBridge = new TerminalVtBridge(
      (message) => {
        armVtWatchdog(instance, {
          document: message.document,
          sequence: message.sequence,
          epoch: message.epoch!,
        });
        web.current?.injectJavaScript(`window.shellbellVt(${JSON.stringify(message)});true;`);
      },
      (source, reason) => {
        clearTimeout(vtTimeout.current);
        reportVtError.current(source, reason);
      },
      (source) => reportVtReady.current(source),
    );
    return instance;
  }, [armVtWatchdog]);
  /** The document whose raw mode has been confirmed; raw bytes go only there. */
  const vtDocument = useRef<string | null>(null);
  const bridge = useMemo(
    () =>
      new TerminalBridge((frame) => {
        // Coalesced-away snapshot models never changed the WebView's parser.
        // Detach only when a snapshot frame is actually sent to that document.
        if (!frame.vt) {
          vtDocument.current = null;
          clearTimeout(vtTimeout.current);
          vtBridge.detach();
        }
        pending.current = frame.revision;
        armWatchdog("Terminal renderer stopped responding");
        web.current?.injectJavaScript(
          `window.shellbellReceive(${JSON.stringify(frame).replace(/</g, "\\u003c")});true;`,
        );
      }),
    [armWatchdog, vtBridge],
  );
  const raw = vt !== null;
  const hostPaste = Boolean(onPaste);
  const model = useMemo<TerminalModel>(
    () => ({
      cols,
      fontSize,
      fitWidth,
      mouse: mouseMode,
      liveRows,
      inputReady,
      hostPaste,
      hardwareKeyboard,
      screenReader,
      vt: raw,
      rows: (raw ? [] : rows).map((row) =>
        row.kind === "gap"
          ? { key: row.key, history: false, line: gapLine(row.label) }
          : {
              key: row.key,
              line: row.line,
              absoluteRow: row.absoluteRow,
              history: row.liveRowIndex === null,
              liveRow: row.liveRowIndex ?? undefined,
            },
      ),
      cursor:
        cursor && !raw
          ? {
              key:
                rows.find((row) => row.kind === "line" && row.liveRowIndex === cursor.y)?.key ?? "",
              ...cursor,
            }
          : null,
    }),
    [
      rows,
      cols,
      fontSize,
      fitWidth,
      cursor,
      mouseMode,
      liveRows,
      inputReady,
      hardwareKeyboard,
      screenReader,
      hostPaste,
      raw,
    ],
  );
  useEffect(() => {
    bridge.present(model);
  }, [bridge, model]);
  useEffect(() => {
    // The log grows in place; each change arrives as a new `vt` object.
    vtBridge.present(vt?.log ?? null);
  }, [vtBridge, vt]);
  useEffect(
    () => () => {
      clearTimeout(timeout.current);
      clearTimeout(vtTimeout.current);
    },
    [],
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      clearTimeout(timeout.current);
      clearTimeout(vtTimeout.current);
      if (state !== "active") return;
      const rawPending = vtBridge.pendingOperation;
      if (rawPending) armVtWatchdog(vtBridge, rawPending);
      if (pending.current) armWatchdog("Terminal renderer stopped responding");
      else if (!document.current) armWatchdog("Terminal renderer did not become ready");
    });
    return () => subscription.remove();
  }, [armWatchdog, armVtWatchdog, vtBridge]);

  const handleMessage = useRef<(event: WebViewMessageEvent) => void>(() => {});
  handleMessage.current = ({ nativeEvent }) => {
    if (nativeEvent.data.length > 16_800_000) return;
    let message: {
      type?: string;
      document?: string;
      revision?: number;
      anchor?: string | null;
      following?: boolean;
      topKey?: string | null;
      bottomKey?: string | null;
      url?: unknown;
      renderer?: unknown;
      key?: unknown;
      column?: unknown;
      row?: unknown;
      button?: unknown;
      modifiers?: unknown;
      data?: unknown;
      sequence?: unknown;
      epoch?: unknown;
      reason?: unknown;
      submit?: unknown;
      rows?: unknown;
      cursorY?: unknown;
      selected?: unknown;
      text?: unknown;
      html?: unknown;
      request?: unknown;
      resultIndex?: unknown;
      resultCount?: unknown;
      alternate?: unknown;
      cursorLine?: unknown;
      historyDropped?: unknown;
      historyLimited?: unknown;
    };
    try {
      message = JSON.parse(nativeEvent.data);
    } catch {
      return;
    }
    if (!message || typeof message.document !== "string" || message.document.length > 80) return;
    if (message.type === "ready") {
      clearTimeout(vtTimeout.current);
      document.current = message.document;
      vtDocument.current = null;
      acknowledged.current = 0;
      inputSequence.current = 0;
      copyRequest.current = null;
      setSelected(false);
      onSelectionChange?.(false);
      onSelectingChange?.(false);
      onSearchOpenChange?.(false);
      setError(null);
      setVtError(null);
      if (hardwareKeyboard && inputReady) web.current?.requestFocus();
      bridge.ready(message.document, initialAnchor);
      if (message.renderer === "webgl" || message.renderer === "dom")
        onRenderer?.(message.renderer);
      return;
    }
    if (message.document !== document.current) return;
    if (vtBridge.receiveHistory(message)) return;
    if (message.type === "input" || message.type === "paste") {
      if (
        !inputReady ||
        displayError ||
        typeof message.data !== "string" ||
        message.data.length > MAX_TERMINAL_MESSAGE_BYTES ||
        typeof message.sequence !== "number" ||
        !Number.isSafeInteger(message.sequence) ||
        message.sequence <= inputSequence.current
      )
        return;
      inputSequence.current = message.sequence;
      if (
        (message.type === "paste"
          ? onPaste?.(message.data, message.submit === true)
          : onInput?.(message.data)) === false
      )
        setLinkError("Input was not sent. Check the connection or use a smaller paste.");
      return;
    }
    if (message.type === "input-rejected") {
      setLinkError("Input was not sent. Use a smaller paste.");
      return;
    }
    if (message.type === "selection" && typeof message.selected === "boolean") {
      setSelected(message.selected);
      onSelectionChange?.(message.selected);
      return;
    }
    if (message.type === "select-start") {
      onSelectingChange?.(true);
      return;
    }
    if (
      message.type === "copy" &&
      message.request === copyRequest.current &&
      copyRequest.current !== null &&
      typeof message.text === "string" &&
      message.text.length <= 4_194_304
    ) {
      copyRequest.current = null;
      const html =
        typeof message.html === "string" && message.html.length <= 4_194_304
          ? message.html
          : undefined;
      void Clipboard.setStringAsync(
        html ?? message.text,
        html ? { inputFormat: Clipboard.StringFormat.HTML } : undefined,
      ).then(
        (copied) => {
          if (!copied) {
            setLinkError("Could not copy selection");
            return;
          }
          setLinkError("Copied");
          onCopied?.();
        },
        () => setLinkError("Could not copy selection"),
      );
      return;
    }
    if (
      ["copy-empty", "copy-too-large", "copy-busy"].includes(message.type ?? "") &&
      message.request === copyRequest.current &&
      copyRequest.current !== null
    ) {
      copyRequest.current = null;
      setLinkError(
        message.type === "copy-empty"
          ? "Select terminal text first"
          : message.type === "copy-busy"
            ? "Terminal is updating. Try copying again."
            : "Selection is too large to copy",
      );
      return;
    }
    if (
      message.type === "search-result" &&
      typeof message.resultIndex === "number" &&
      typeof message.resultCount === "number" &&
      Number.isSafeInteger(message.resultIndex) &&
      Number.isSafeInteger(message.resultCount)
    ) {
      setSearchStatus(
        message.resultCount
          ? `${message.resultIndex + 1} of ${message.resultCount} in loaded history`
          : "No matches in loaded history",
      );
      return;
    }
    if (message.type === "search-pending" || message.type === "search-reset") {
      setSearchStatus(
        message.type === "search-pending"
          ? "Terminal is updating. Search again when ready."
          : "History changed. Search again.",
      );
      return;
    }
    if (message.type === "search-error") {
      setSearchStatus("Invalid search expression");
      return;
    }
    if (message.type === "mouse") {
      if (
        !mouseMode ||
        !onMouseClick ||
        displayError ||
        pending.current !== 0 ||
        acknowledged.current === 0 ||
        message.revision !== acknowledged.current ||
        !bridge.isPresented(model)
      )
        return;
      const click = terminalMouseClick(message, rows, cols, liveRows);
      if (click) onMouseClick(click);
      return;
    }
    if (message.type === "renderer") {
      if (message.renderer === "webgl" || message.renderer === "dom")
        onRenderer?.(message.renderer);
      return;
    }
    if (message.type === "link") {
      if (mouseMode) return;
      const url = terminalWebUrl(message.url);
      if (url) {
        void Linking.openURL(url).catch(() => setLinkError("Could not open this web link"));
      }
      return;
    }
    if (message.type === "ack" && message.revision === pending.current) {
      clearTimeout(timeout.current);
      pending.current = 0;
      acknowledged.current = message.revision;
      setError((current) => (current === "Terminal renderer stopped responding" ? null : current));
      bridge.acknowledge(message.document, message.revision);
      if (!model.vt && bridge.isPresented(model)) setVtError(null);
      // Raw bytes may follow only once the WebView has switched to raw mode.
      if (model.vt && bridge.isPresented(model) && vtDocument.current !== message.document) {
        vtDocument.current = message.document;
        vtBridge.ready(message.document);
      }
      return;
    }
    if (message.type === "vt-ack" && typeof message.sequence === "number") {
      const operation = vtBridge.pendingOperation;
      if (
        operation?.document === message.document &&
        operation.sequence === message.sequence &&
        operation.epoch === message.epoch
      )
        clearTimeout(vtTimeout.current);
      vtBridge.acknowledge(message.document, message.sequence, message.epoch);
      return;
    }
    if (message.type === "vt-error") {
      vtBridge.reject(message.document, message.sequence, message.epoch, message.reason);
      return;
    }
    if (
      message.type === "vt-status" &&
      vtBridge.acceptsStatus(message.document, message.epoch) &&
      typeof message.alternate === "boolean" &&
      typeof message.cursorLine === "string"
    ) {
      const rows = Array.isArray(message.rows)
        ? message.rows
            .slice(0, 200)
            .map((row: unknown) => (typeof row === "string" ? row.slice(0, 512) : ""))
        : [];
      const cursorY =
        typeof message.cursorY === "number" &&
        Number.isSafeInteger(message.cursorY) &&
        message.cursorY >= 0 &&
        message.cursorY < rows.length
          ? message.cursorY
          : -1;
      onVtStatus?.({
        alternate: message.alternate,
        cursorLine: message.cursorLine.slice(0, 512),
        cursorY,
        rows,
        ...(typeof message.historyDropped === "boolean"
          ? { historyDropped: message.historyDropped }
          : {}),
        ...(typeof message.historyLimited === "boolean"
          ? { historyLimited: message.historyLimited }
          : {}),
      });
      return;
    }
    if (message.type === "error") {
      clearTimeout(timeout.current);
      setError("Terminal renderer could not display this update");
      return;
    }
    if (message.type === "older") {
      onLoadOlder();
      return;
    }
    if (
      message.type === "viewport" &&
      typeof message.following === "boolean" &&
      (message.anchor === null ||
        (typeof message.anchor === "string" && rows.some((row) => row.key === message.anchor)))
    ) {
      setFollowing(message.following);
      const topKey =
        typeof message.topKey === "string" && rows.some((row) => row.key === message.topKey)
          ? message.topKey
          : (message.anchor ?? null);
      const topIndex = rows.findIndex((row) => row.key === topKey);
      const bottomIndex = rows.findIndex((row) => row.key === message.bottomKey);
      const bottomKey = topIndex >= 0 && bottomIndex >= topIndex ? rows[bottomIndex]!.key : null;
      onViewport(message.anchor ?? null, message.following, topKey, bottomKey);
    }
  };
  // The 4 MB offline document is immutable. Frame updates go through the bridge,
  // never through repeated Fabric prop reconciliation of the embedded font/JS.
  // Event dispatch reads fresh callbacks/rows without rebuilding the native view.
  const surface = useMemo(
    () => (
      <WebView
        key={reload}
        ref={web}
        source={{ html: terminalHtml, baseUrl: "about:blank" }}
        style={{ flex: 1, backgroundColor: tokens.bg }}
        originWhitelist={["*"]}
        onShouldStartLoadWithRequest={(request) => request.url === "about:blank"}
        onOpenWindow={() => {}}
        setSupportMultipleWindows={false}
        allowFileAccess={false}
        allowFileAccessFromFileURLs={false}
        allowUniversalAccessFromFileURLs={false}
        mixedContentMode="never"
        sharedCookiesEnabled={false}
        thirdPartyCookiesEnabled={false}
        cacheEnabled={false}
        textZoom={100}
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView
        automaticallyAdjustContentInsets={false}
        onContentProcessDidTerminate={() => setError("Terminal renderer was stopped by the system")}
        onRenderProcessGone={() => setError("Terminal renderer was stopped by the system")}
        onError={() => setError("Terminal renderer could not load")}
        onLoadEnd={() => {
          if (!document.current) {
            armWatchdog("Terminal renderer did not become ready");
          }
        }}
        onMessage={(event) => handleMessage.current(event)}
      />
    ),
    [reload, armWatchdog],
  );
  return (
    <View style={{ flex: 1, minHeight: 0 }}>
      {selecting && !hideToolbar ? (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 8,
            backgroundColor: tokens.surface,
            borderBottomColor: tokens.border,
            borderBottomWidth: 1,
            paddingLeft: 12,
            minHeight: 40,
          }}
        >
          <Text style={{ color: tokens.textMuted, fontSize: 12, flex: 1 }}>
            Tap a line, then drag the handles. Tap Done to scroll again.
          </Text>
          {selected ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy terminal selection with formatting"
              onPress={() => command({ type: "copy", format: "html" })}
              style={{ paddingHorizontal: 12, minHeight: 40, justifyContent: "center" }}
            >
              <Text style={{ color: tokens.text, fontSize: 13 }}>Copy styled</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {searchOpen ? (
        <View style={{ backgroundColor: tokens.surface, padding: 8, gap: 6 }}>
          <TextInput
            accessibilityLabel="Find in loaded terminal history"
            autoFocus
            value={query}
            maxLength={256}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder="Find in loaded history"
            placeholderTextColor={tokens.textMuted}
            style={{ color: tokens.text, padding: 10, backgroundColor: tokens.bg, borderRadius: 8 }}
            onChangeText={(text) => {
              setQuery(text);
              command({ type: "search", text, direction: "next", ...searchOptions });
            }}
          />
          <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center" }}>
            {(["caseSensitive", "wholeWord"] as const).map((name) => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityLabel={
                  {
                    caseSensitive: "Match case",
                    wholeWord: "Whole word",
                    regex: "Regular expression",
                  }[name]
                }
                accessibilityState={{ selected: searchOptions[name] }}
                onPress={() => {
                  const next = { ...searchOptions, [name]: !searchOptions[name] };
                  setSearchOptions(next);
                  command({ type: "search", text: query, direction: "next", ...next });
                }}
                style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
              >
                <Text
                  style={{ color: searchOptions[name] ? tokens.accents.emerald : tokens.textMuted }}
                >
                  {{ caseSensitive: "Aa", wholeWord: "Word", regex: ".*" }[name]}
                </Text>
              </Pressable>
            ))}
            {(["previous", "next"] as const).map((direction) => (
              <Pressable
                key={direction}
                accessibilityRole="button"
                accessibilityLabel={
                  direction === "next" ? "Next search match" : "Previous search match"
                }
                onPress={() =>
                  command({ type: "search", text: query, direction, ...searchOptions })
                }
                style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
              >
                <AppIcon name={direction === "next" ? "down" : "up"} />
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Close terminal search"
              onPress={() => {
                onSearchOpenChange?.(false);
                command({ type: "clear-search" });
              }}
              style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
            >
              <Text style={{ color: tokens.text }}>Done</Text>
            </Pressable>
          </View>
          <Text accessibilityLiveRegion="polite" style={{ color: tokens.textMuted, fontSize: 12 }}>
            {searchStatus}
          </Text>
        </View>
      ) : null}
      {surface}
      {linkError ? <Toast text={linkError} onDone={() => setLinkError(null)} /> : null}
      {displayError ? (
        <View style={{ padding: 12, backgroundColor: tokens.surface }}>
          <Text accessibilityRole="alert" style={{ color: tokens.text }}>
            {displayError}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              clearTimeout(timeout.current);
              clearTimeout(vtTimeout.current);
              document.current = null;
              vtDocument.current = null;
              bridge.detach();
              vtBridge.detach();
              pending.current = 0;
              setError(null);
              setVtError(null);
              setReload((value) => value + 1);
            }}
          >
            <Text style={{ color: tokens.accents.emerald, paddingVertical: 12 }}>
              Reload terminal renderer
            </Text>
          </Pressable>
        </View>
      ) : null}
      {!following && !displayError ? (
        <JumpToLiveButton
          onPress={() => web.current?.injectJavaScript("window.shellbellJumpToLive();true;")}
        />
      ) : null}
    </View>
  );
}
