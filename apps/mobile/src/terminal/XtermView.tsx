import type { TerminalMouseClick } from "@shellbell/protocol";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Linking, Pressable, Text, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import type { StreamDisplayRow } from "../screen/stream-presentation";
import { tokens } from "../theme/tokens";
import { Toast } from "../ui/Toast";
import { TerminalBridge, type TerminalModel } from "./bridge";
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
  const model = useMemo<TerminalModel>(
    () => ({
      cols,
      fontSize,
      fitWidth,
      mouse: mouseMode,
      initialAnchor,
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
    [rows, cols, fontSize, fitWidth, initialAnchor, cursor, mouseMode],
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
    if (nativeEvent.data.length > 2048) return;
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
      setError(null);
      bridge.ready(message.document);
      if (message.renderer === "webgl" || message.renderer === "dom")
        onRenderer?.(message.renderer);
      return;
    }
    if (message.document !== document.current) return;
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
          style={{
            position: "absolute",
            bottom: 12,
            alignSelf: "center",
            padding: 12,
            borderRadius: 20,
            backgroundColor: tokens.surface2,
          }}
        >
          <Text style={{ color: tokens.text }}>↓ Jump to live</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
