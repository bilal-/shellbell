import { MAX_TERMINAL_MESSAGE_BYTES, type TerminalMouseClick } from "@shellbell/protocol";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Pressable, Text, TextInput, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { StreamDisplayRow } from "../screen/stream-presentation";
import { tokens } from "../theme/tokens";
import { AppIcon } from "../ui/AppIcon";
import { Toast } from "../ui/Toast";
import { TerminalBridge, type TerminalModel } from "./bridge";
import type { TerminalCommand, TerminalControls } from "./controls";
import { terminalHtml } from "./gen/document";
import { terminalWebUrl } from "./links";
import { terminalMouseClick } from "./mouse";

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
}: Props) {
  const web = useRef<WebView>(null);
  const document = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [linkError, setLinkError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [following, setFollowing] = useState(initialAnchor === null);
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef(0);
  const acknowledged = useRef(0);
  const inputSequence = useRef(0);
  const copyRequest = useRef<string | null>(null);
  const [selected, setSelected] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [searchOptions, setSearchOptions] = useState({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  });
  const [searchStatus, setSearchStatus] = useState("Search loaded history");
  const command = useCallback(
    (value: TerminalCommand): boolean => {
      if (!document.current || error) return false;
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
    [error, inputReady],
  );
  useEffect(() => controls?.bind(command), [controls, command]);
  const armWatchdog = useCallback((message: string) => {
    clearTimeout(timeout.current);
    if (AppState.currentState === "active") {
      timeout.current = setTimeout(() => setError(message), 10_000);
    }
  }, []);
  const bridge = useMemo(
    () =>
      new TerminalBridge((frame) => {
        pending.current = frame.revision;
        armWatchdog("Terminal renderer stopped responding");
        web.current?.injectJavaScript(
          `window.shellbellReceive(${JSON.stringify(frame).replace(/</g, "\\u003c")});true;`,
        );
      }),
    [armWatchdog],
  );
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
      rows: rows.map((row) =>
        row.kind === "gap"
          ? { key: row.key, history: false, line: { r: [{ t: `── ${row.label} ──`, fg: 8 }] } }
          : {
              key: row.key,
              line: row.line,
              absoluteRow: row.absoluteRow,
              history: row.liveRowIndex === null,
              liveRow: row.liveRowIndex ?? undefined,
            },
      ),
      cursor: cursor
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
    ],
  );
  useEffect(() => {
    bridge.present(model);
  }, [bridge, model]);
  useEffect(() => () => clearTimeout(timeout.current), []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      clearTimeout(timeout.current);
      if (state !== "active") return;
      if (pending.current) armWatchdog("Terminal renderer stopped responding");
      else if (!document.current) armWatchdog("Terminal renderer did not become ready");
    });
    return () => subscription.remove();
  }, [armWatchdog]);

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
      submit?: unknown;
      selected?: unknown;
      text?: unknown;
      html?: unknown;
      request?: unknown;
      resultIndex?: unknown;
      resultCount?: unknown;
    };
    try {
      message = JSON.parse(nativeEvent.data);
    } catch {
      return;
    }
    if (!message || typeof message.document !== "string" || message.document.length > 80) return;
    if (message.type === "ready") {
      document.current = message.document;
      acknowledged.current = 0;
      inputSequence.current = 0;
      copyRequest.current = null;
      setSelected(false);
      setSelecting(false);
      setSearchOpen(false);
      setError(null);
      if (hardwareKeyboard && inputReady) web.current?.requestFocus();
      bridge.ready(message.document, initialAnchor);
      if (message.renderer === "webgl" || message.renderer === "dom")
        onRenderer?.(message.renderer);
      return;
    }
    if (message.document !== document.current) return;
    if (message.type === "input" || message.type === "paste") {
      if (
        !inputReady ||
        error ||
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
          if (!copied) setLinkError("Could not copy selection");
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
    if (message.type === "search-error") {
      setSearchStatus("Invalid search expression");
      return;
    }
    if (message.type === "mouse") {
      if (
        !mouseMode ||
        !onMouseClick ||
        error ||
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
      return;
    }
    if (message.type === "error") {
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
      {!hideToolbar ? (
        <View
          style={{
            flexDirection: "row",
            flexWrap: "wrap",
            alignItems: "center",
            backgroundColor: tokens.surface,
            minHeight: 48,
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Search terminal history"
            onPress={() => setSearchOpen((value) => !value)}
            style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
          >
            <Text style={{ color: tokens.text }}>Search</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Select terminal text"
            accessibilityState={{ selected: selecting }}
            onPress={() => {
              const enabled = !selecting;
              setSelecting(enabled);
              command({ type: "select", enabled });
            }}
            style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
          >
            <Text style={{ color: selecting ? tokens.accents.emerald : tokens.text }}>Select</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Select all loaded terminal text"
            onPress={() => command({ type: "select-all" })}
            style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
          >
            <Text style={{ color: tokens.text }}>Select all</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy terminal selection"
            disabled={!selected}
            onPress={() => command({ type: "copy", format: "text" })}
            style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
          >
            <Text style={{ color: selected ? tokens.text : tokens.textMuted }}>Copy</Text>
          </Pressable>
          {selected ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Copy terminal selection with formatting"
              onPress={() => command({ type: "copy", format: "html" })}
              style={{ padding: 12, minHeight: 48, justifyContent: "center" }}
            >
              <Text style={{ color: tokens.text }}>Styled copy</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {selecting && !hideToolbar ? (
        <Text
          style={{
            color: tokens.textMuted,
            backgroundColor: tokens.surface,
            padding: 8,
            fontSize: 12,
          }}
        >
          Tap a line, then drag the selection handles. Tap Select again to scroll.
        </Text>
      ) : null}
      {searchOpen ? (
        <View style={{ backgroundColor: tokens.surface, padding: 8, gap: 6 }}>
          <TextInput
            accessibilityLabel="Find in loaded terminal history"
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
                setSearchOpen(false);
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
      {error ? (
        <View style={{ padding: 12, backgroundColor: tokens.surface }}>
          <Text accessibilityRole="alert" style={{ color: tokens.text }}>
            {error}
          </Text>
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              clearTimeout(timeout.current);
              document.current = null;
              pending.current = 0;
              setError(null);
              setReload((value) => value + 1);
            }}
          >
            <Text style={{ color: tokens.accents.emerald, paddingVertical: 12 }}>
              Reload terminal renderer
            </Text>
          </Pressable>
        </View>
      ) : null}
      {!following && !error ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => web.current?.injectJavaScript("window.shellbellJumpToLive();true;")}
          accessibilityLabel="Jump to live"
          style={{
            position: "absolute",
            bottom: 12,
            alignSelf: "center",
            padding: 12,
            borderRadius: 20,
            backgroundColor: tokens.surface2,
          }}
        >
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <AppIcon name="down" size={18} />
            <Text style={{ color: tokens.text }}>Jump to live</Text>
          </View>
        </Pressable>
      ) : null}
    </View>
  );
}
