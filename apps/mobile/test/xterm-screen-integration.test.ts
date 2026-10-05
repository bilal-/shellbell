import { act, createElement, forwardRef, useImperativeHandle } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import type { TerminalFrame } from "../src/terminal/bridge";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
const scripts = vi.hoisted(() => [] as string[]);
const nativeRenders = vi.hoisted(() => ({ count: 0 }));
const openURL = vi.hoisted(() => vi.fn(async (_url: string) => {}));
const appState = vi.hoisted(() => ({ currentState: "active", listener: (_state: string) => {} }));
vi.mock("react-native", () => ({
  Linking: { openURL },
  Modal: "Modal",
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      appState.listener = listener;
      return {
        remove() {
          appState.listener = () => {};
        },
      };
    },
  },
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  useWindowDimensions: () => ({ width: 390, height: 800 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn() }));

it("opens only validated web links from the current document", async () => {
  const { XtermView } = await import("../src/terminal/XtermView");
  const root = createRoot();
  openURL.mockClear();
  try {
    await act(async () =>
      root.render(
        createElement(XtermView, {
          rows: [],
          cols: 80,
          fontSize: 14,
          fitWidth: false,
          cursor: null,
          initialAnchor: null,
          onViewport() {},
          onLoadOlder() {},
        }),
      ),
    );
    const web = root.container.queryAll((node) => node.type === "WebView")[0]!;
    const message = async (payload: object) =>
      act(async () => {
        web.props.onMessage({ nativeEvent: { data: JSON.stringify(payload) } });
      });
    await message({ type: "link", document: "doc", url: "https://example.com" });
    expect(openURL).not.toHaveBeenCalled();
    await message({ type: "ready", document: "doc" });
    for (const url of [
      "intent://other-app",
      "file:///private",
      "https://user:secret@example.com",
    ]) {
      await message({ type: "link", document: "doc", url });
    }
    await message({ type: "link", document: "stale-doc", url: "https://example.com" });
    expect(openURL).not.toHaveBeenCalled();
    await message({ type: "link", document: "doc", url: "https://example.com/docs" });
    expect(openURL).toHaveBeenCalledExactlyOnceWith("https://example.com/docs");
    openURL.mockRejectedValueOnce(new Error("No browser"));
    await message({ type: "link", document: "doc", url: "https://example.com/docs" });
    expect(
      root.container.queryAll(
        (node) => node.type === "Text" && node.props.children === "Could not open this web link",
      ),
    ).toHaveLength(1);
    expect(
      root.container.queryAll((node) => node.props.accessibilityRole === "alert"),
    ).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
  }
});

it("reports validated visible bounds rather than trusting arbitrary WebView keys", async () => {
  const { XtermView } = await import("../src/terminal/XtermView");
  const root = createRoot();
  const onViewport = vi.fn();
  try {
    await act(async () =>
      root.render(
        createElement(XtermView, {
          rows: ["a", "b"].map((key) => ({
            kind: "line" as const,
            key,
            line: { r: [{ t: key }] },
            liveRowIndex: 0,
          })),
          cols: 80,
          fontSize: 14,
          fitWidth: false,
          cursor: null,
          initialAnchor: null,
          onViewport,
          onLoadOlder() {},
        }),
      ),
    );
    const web = root.container.queryAll((node) => node.type === "WebView")[0]!;
    const message = (value: object) =>
      act(async () => web.props.onMessage({ nativeEvent: { data: JSON.stringify(value) } }));
    await message({ type: "ready", document: "doc" });
    await message({
      type: "viewport",
      document: "doc",
      anchor: null,
      following: true,
      topKey: "a",
      bottomKey: "b",
    });
    expect(onViewport).toHaveBeenLastCalledWith(null, true, "a", "b");
    await message({
      type: "viewport",
      document: "doc",
      anchor: null,
      following: true,
      topKey: "a",
      bottomKey: "unknown",
    });
    expect(onViewport).toHaveBeenLastCalledWith(null, true, "a", null);
  } finally {
    await act(async () => root.unmount());
  }
});
it.each([false, true])("recovers a late renderer ACK (background=%s)", async (background) => {
  vi.useFakeTimers();
  appState.currentState = "active";
  const { XtermView } = await import("../src/terminal/XtermView");
  const root = createRoot();
  try {
    await act(async () =>
      root.render(
        createElement(XtermView, {
          rows: [],
          cols: 80,
          fontSize: 14,
          fitWidth: false,
          cursor: null,
          initialAnchor: null,
          onViewport() {},
          onLoadOlder() {},
        }),
      ),
    );
    const web = root.container.queryAll((node) => node.type === "WebView")[0]!;
    const message = (data: object) =>
      act(async () => web.props.onMessage({ nativeEvent: { data: JSON.stringify(data) } }));
    await message({ type: "ready", document: "doc" });
    if (background)
      await act(async () => {
        appState.currentState = "background";
        appState.listener("background");
      });
    await act(async () => vi.advanceTimersByTime(11_000));
    const alerts = () =>
      root.container.queryAll((node) => node.props.accessibilityRole === "alert");
    expect(alerts()).toHaveLength(background ? 0 : 1);
    if (background)
      await act(async () => {
        appState.currentState = "active";
        appState.listener("active");
      });
    await message({ type: "ack", document: "doc", revision: 1 });
    expect(alerts()).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    appState.currentState = "active";
    vi.useRealTimers();
  }
});
vi.mock("react-native-webview", () => ({
  WebView: forwardRef(function Boundary(props, ref) {
    nativeRenders.count++;
    useImperativeHandle(ref, () => ({
      injectJavaScript: (script: string) => scripts.push(script),
    }));
    return createElement("WebView", props);
  }),
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureDetector: ({ children }: { children: unknown }) => children,
  Gesture: {
    Pinch: () => {
      const chain = {
        enabled: () => chain,
        onStart: () => chain,
        onUpdate: () => chain,
        onEnd: () => chain,
        runOnJS: () => chain,
      };
      return chain;
    },
  },
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: forwardRef(function List(props, ref) {
    useImperativeHandle(ref, () => ({ scrollToEnd() {} }));
    return createElement("FlashList", props);
  }),
}));
vi.mock("../src/store/computers", () => ({
  useUiStore: (select: (state: object) => unknown) =>
    select({ fontSize: 14, fitWidth: false, setFontSize() {}, commitFontSize() {} }),
}));
it("delivers the actual live viewport to offline xterm without creating another terminal input path", async () => {
  const { ScreenView } = await import("../src/screen/ScreenView");
  const root = createRoot();
  scripts.length = 0;
  await act(async () =>
    root.render(
      createElement(ScreenView, {
        stream: {
          status: "live",
          historyStatus: "waiting",
          screen: {
            cols: 80,
            rows: 1,
            lines: [{ r: [{ t: "hello" }] }],
            cursor: { x: 5, y: 0 },
            scrollbackTotal: 0,
            gen: 1,
          },
        },
        accent: "#00ff00",
        blinking: false,
        inferredCursor: false,
        onLoadOlder() {},
      }),
    ),
  );
  try {
    const web = root.container.queryAll((node) => node.type === "WebView")[0];
    expect(web).toBeDefined();
    await act(async () =>
      web!.props.onMessage({
        nativeEvent: { data: JSON.stringify({ type: "ready", document: "test-doc" }) },
      }),
    );
    const payload = scripts[0]!.slice("window.shellbellReceive(".length, -");true;".length);
    const frame = JSON.parse(payload) as TerminalFrame;
    expect(frame.upsert[0]?.line.r[0]?.t).toBe("hello");
    expect(frame.cursor).toMatchObject({ key: "live:0", x: 5 });
    expect(web!.props.onShouldStartLoadWithRequest({ url: "https://evil.example" })).toBe(false);
    expect(web!.props.onShouldStartLoadWithRequest({ url: "file:///private/key" })).toBe(false);
    expect(web!.props.allowFileAccess).toBe(false);
  } finally {
    await act(async () => root.unmount());
  }
});
it("streams changed rows without repeatedly reconciling the multi-megabyte native document", async () => {
  const { XtermView } = await import("../src/terminal/XtermView");
  const root = createRoot();
  const props = {
    cols: 80,
    fontSize: 14,
    fitWidth: false,
    cursor: null,
    initialAnchor: null,
    onViewport() {},
    onLoadOlder() {},
  };
  nativeRenders.count = 0;
  try {
    await act(async () => root.render(createElement(XtermView, { ...props, rows: [] })));
    const initial = nativeRenders.count;
    await act(async () =>
      root.render(
        createElement(XtermView, {
          ...props,
          rows: [{ kind: "line", key: "live:0", line: { r: [{ t: "update" }] }, liveRowIndex: 0 }],
        }),
      ),
    );
    expect(nativeRenders.count).toBe(initial);
  } finally {
    await act(async () => root.unmount());
  }
});
