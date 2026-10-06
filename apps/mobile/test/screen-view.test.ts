import {
  act,
  type ComponentProps,
  createElement,
  forwardRef,
  type ReactNode,
  useImperativeHandle,
} from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";
import { MobileScreenStream, type MobileStreamSnapshot } from "../src/net/mobile-screen-stream";
import type { ScreenView as ScreenViewType } from "../src/screen/ScreenView";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;
vi.mock("react-native", () => ({
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  useWindowDimensions: () => ({ width: 390, height: 800 }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: ReactNode }) => children,
  useSafeAreaInsets: () => ({ top: 24, bottom: 16, left: 0, right: 0 }),
}));
const clipboard = vi.hoisted(() => ({ setStringAsync: vi.fn(async (_text: string) => true) }));
vi.mock("expo-clipboard", () => clipboard);
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
vi.mock("../src/store/computers", () => ({
  useUiStore: (select: (value: object) => unknown) =>
    select({ fontSize: 12, fitWidth: false, setFontSize() {}, commitFontSize() {} }),
}));
vi.mock("../src/terminal/XtermView", () => ({
  XtermView: (props: object) => createElement("XtermView", props),
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: forwardRef(function List(
    props: { data: Array<{ key: string }>; renderItem: (value: { item: unknown }) => ReactNode },
    ref,
  ) {
    useImperativeHandle(ref, () => ({ scrollToEnd() {} }));
    return createElement(
      "FlashList",
      props,
      props.data.map((item) => createElement("Row", { key: item.key }, props.renderItem({ item }))),
    );
  }),
}));
const screen = {
  cols: 80,
  rows: 1,
  cursor: { x: 4, y: 0 },
  lines: [{ r: [{ t: "live output" }] }],
  scrollbackTotal: 10,
  gen: 1,
};
function stream(
  historyStatus: MobileStreamSnapshot["historyStatus"] = "ready",
): MobileStreamSnapshot {
  return {
    status: "live",
    historyStatus,
    screen,
    history: {
      anchor: { subscriptionId: "old", generation: 1, before: 10 },
      nextBefore: 9,
      readOnly: false,
      rows: [{ key: "old:9", row: 9, line: { r: [{ t: "earlier " }], w: true } }],
      gaps: [],
      encodedBytes: 20,
    },
  };
}
async function mount(extra: Partial<ComponentProps<typeof ScreenViewType>> = {}) {
  const { ScreenView } = await import("../src/screen/ScreenView");
  const root = createRoot();
  const load = vi.fn();
  const protect = vi.fn();
  const retry = vi.fn();
  const refresh = vi.fn();
  let props: ComponentProps<typeof ScreenViewType> = {
    stream: stream(),
    accent: "#0f0",
    blinking: false,
    inferredCursor: false,
    onLoadOlder: load,
    onProtectHistory: protect,
    onRetryOutput: retry,
    onRefreshHistory: refresh,
    ...extra,
  };
  const render = async (next: Partial<typeof props> = {}) => {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(ScreenView, props)));
  };
  await render();
  const find = (type: string) => root.container.queryAll((node) => node.type === type)[0]!;
  const words = () =>
    root.container
      .queryAll((node) => node.type === "Text")
      .flatMap((node) => node.children)
      .join(" ");
  const button = (label: string) =>
    root.container.queryAll((node) => node.props.accessibilityLabel === label)[0]!;
  return {
    root,
    render,
    find,
    words,
    button,
    load,
    protect,
    retry,
    refresh,
    close: async () => {
      await act(async () => root.unmount());
    },
  };
}
describe("mounted ScreenView with xterm terminal and prose reading", () => {
  it("resolves the current source span when a visible Reading paragraph grows", async () => {
    const m = await mount({ readingMode: true });
    try {
      const paragraph = m.find("FlashList").props.data[0];
      await act(async () =>
        m.find("FlashList").props.onViewableItemsChanged({ viewableItems: [{ item: paragraph }] }),
      );
      await m.render({
        stream: {
          ...stream(),
          screen: {
            ...screen,
            rows: 2,
            lines: [{ r: [{ t: "live output" }], w: true }, { r: [{ t: "continued" }] }],
          },
        },
      });
      await act(async () => m.button("Select text").props.onPress());
      const selected = m.root.container.queryAll(
        (node) => node.type === "Text" && node.props.selectable,
      )[0]!;
      expect(selected.children.join("")).toBe("earlier \nlive output\ncontinued");
    } finally {
      await m.close();
    }
  });
  it("reports a declined clipboard write without claiming success", async () => {
    clipboard.setStringAsync.mockResolvedValueOnce(false);
    const m = await mount({ readingMode: true });
    try {
      await act(async () =>
        m.find("FlashList").props.onViewableItemsChanged({
          viewableItems: [{ item: m.find("FlashList").props.data.at(-1) }],
        }),
      );
      await act(async () => m.button("Select text").props.onPress());
      await act(async () => m.button("Copy snapshot").props.onPress());
      expect(m.words()).toContain("Could not copy. Try again.");
      expect(m.words()).not.toContain("Copied");
    } finally {
      await m.close();
    }
  });
  it("keeps selection available when a resize retains the same visible paragraph", async () => {
    const m = await mount({ readingMode: true });
    try {
      const paragraph = m.find("FlashList").props.data[0];
      await act(async () =>
        m.find("FlashList").props.onViewableItemsChanged({ viewableItems: [{ item: paragraph }] }),
      );
      await act(async () =>
        m.find("View").props.onLayout({ nativeEvent: { layout: { width: 700, height: 300 } } }),
      );
      expect(m.button("Select text").props.disabled).toBe(false);
    } finally {
      await m.close();
    }
  });
  it("reports a clipboard failure without claiming success", async () => {
    clipboard.setStringAsync.mockRejectedValueOnce(new Error("unavailable"));
    const m = await mount({ readingMode: true });
    try {
      await act(async () =>
        m.find("FlashList").props.onViewableItemsChanged({
          viewableItems: [{ item: m.find("FlashList").props.data.at(-1) }],
        }),
      );
      await act(async () => m.button("Select text").props.onPress());
      await act(async () => m.button("Copy snapshot").props.onPress());
      expect(m.words()).toContain("Could not copy. Try again.");
      expect(m.words()).not.toContain("Copied");
    } finally {
      await m.close();
    }
  });
  it("selects only visible output, freezes the snapshot, and copies only on request", async () => {
    clipboard.setStringAsync.mockClear();
    const sample = stream();
    const m = await mount({
      readingMode: true,
      stream: {
        ...sample,
        history: {
          ...sample.history!,
          rows: [{ ...sample.history!.rows[0]!, line: { r: [{ t: "earlier" }] } }],
        },
      },
    });
    try {
      expect(m.button("Select text")).toBeDefined();
      expect(m.button("Select text").props.disabled).toBe(true);
      await act(async () =>
        m.find("FlashList").props.onViewableItemsChanged({
          viewableItems: [{ item: m.find("FlashList").props.data.at(-1) }],
        }),
      );
      await act(async () => m.button("Select text").props.onPress());
      const selected = () =>
        m.root.container.queryAll((node) => node.type === "Text" && node.props.selectable)[0]!;
      expect(selected().children.join("")).toBe("live output");
      expect(clipboard.setStringAsync).not.toHaveBeenCalled();
      await m.render({
        stream: { ...stream(), screen: { ...screen, lines: [{ r: [{ t: "changed" }] }] } },
      });
      expect(selected().children.join("")).toBe("live output");
      await act(async () => m.button("Copy snapshot").props.onPress());
      expect(clipboard.setStringAsync).toHaveBeenCalledExactlyOnceWith("live output");
      await act(async () => m.button("Close selection").props.onPress());
      expect(m.root.container.queryAll((node) => node.type === "Modal")).toHaveLength(0);
      expect(m.load).not.toHaveBeenCalled();
    } finally {
      await m.close();
    }
  });

  it("requires a fresh visible range after switching to Reading", async () => {
    const m = await mount();
    try {
      await act(async () => m.find("XtermView").props.onViewport("old:9", false, "old:9", "old:9"));
      await m.render({ readingMode: true });
      expect(m.button("Select text")).toBeDefined();
      expect(m.button("Select text").props.disabled).toBe(true);
      const paragraph = m.find("FlashList").props.data[0];
      await act(async () =>
        m.find("FlashList").props.onViewableItemsChanged({ viewableItems: [{ item: paragraph }] }),
      );
      await act(async () => m.button("Select text").props.onPress());
      const selected = m.root.container.queryAll(
        (node) => node.type === "Text" && node.props.selectable,
      )[0]!;
      expect(selected.children.join("")).toBe("earlier \nlive output");
      await act(async () => m.find("Modal").props.onRequestClose());
      await m.render({ readingMode: false });
      expect(m.find("XtermView").props.initialAnchor).toBe("old:9");
    } finally {
      await m.close();
    }
  });
  it("passes source cells and cursor without resizing remote columns to phone width", async () => {
    const m = await mount();
    try {
      expect(m.find("XtermView").props.cols).toBe(80);
      expect(
        m.find("XtermView").props.rows.map((r: { absoluteRow?: number }) => r.absoluteRow),
      ).toEqual([9, 10]);
      expect(m.find("XtermView").props.cursor).toMatchObject({ x: 4, y: 0 });
      await act(async () =>
        m.find("View").props.onLayout({ nativeEvent: { layout: { width: 700, height: 300 } } }),
      );
      expect(m.find("XtermView").props.cols).toBe(80);
      expect(m.load).not.toHaveBeenCalled();
    } finally {
      await m.close();
    }
  });
  it("retains the source reading anchor across prose mode and history prepend", async () => {
    const m = await mount();
    try {
      await act(async () => m.find("XtermView").props.onViewport("old:9", false));
      expect(m.protect).toHaveBeenCalledWith("old:9");
      await m.render({ readingMode: true });
      expect(m.find("FlashList").props.data[0].sourceKeys).toEqual(["old:9", "live:0"]);
      expect(m.find("FlashList").props.initialScrollIndex).toBe(0);
      expect(
        m.find("FlashList").props.maintainVisibleContentPosition.startRenderingFromBottom,
      ).toBe(false);
      const previous = stream();
      const next = {
        ...previous,
        history: {
          ...previous.history!,
          rows: [
            { key: "old:8", row: 8, line: { r: [{ t: "before" }] } },
            ...previous.history!.rows,
          ],
        },
      };
      await m.render({ stream: next });
      await m.render({ readingMode: false });
      expect(m.find("XtermView").props.initialAnchor).toBe("old:9");
      expect(m.load).not.toHaveBeenCalled();
    } finally {
      await m.close();
    }
  });
  it.each(["width", "height"])(
    "invalidates an armed prose history gesture after %s changes",
    async (dimension) => {
      const m = await mount({ readingMode: true });
      try {
        await act(async () => m.find("FlashList").props.onScrollBeginDrag());
        await act(async () =>
          m.find("View").props.onLayout({
            nativeEvent: {
              layout: {
                width: dimension === "width" ? 700 : 390,
                height: dimension === "height" ? 300 : 700,
              },
            },
          }),
        );
        await act(async () => m.find("FlashList").props.onStartReached());
        expect(m.load).not.toHaveBeenCalled();
        await act(async () => {
          m.find("FlashList").props.onScrollBeginDrag();
          m.find("FlashList").props.onStartReached();
          m.find("FlashList").props.onStartReached();
        });
        expect(m.load).toHaveBeenCalledOnce();
      } finally {
        await m.close();
      }
    },
  );
  it("ignores empty and gap-only prose visibility notifications", async () => {
    const m = await mount({ readingMode: true });
    try {
      await act(async () => {
        m.find("FlashList").props.onViewableItemsChanged({ viewableItems: [] });
        m.find("FlashList").props.onViewableItemsChanged({
          viewableItems: [{ item: { kind: "gap" } }],
        });
      });
      expect(m.protect).not.toHaveBeenCalled();
      expect(m.load).not.toHaveBeenCalled();
    } finally {
      await m.close();
    }
  });
  it("retains omitted-history markers between history and current output", async () => {
    const value = { ...stream(), screen: { ...screen, scrollbackTotal: 20 } };
    const m = await mount({ stream: value });
    try {
      expect(m.find("XtermView").props.rows.map((r: { kind: string }) => r.kind)).toEqual([
        "line",
        "gap",
        "line",
      ]);
    } finally {
      await m.close();
    }
  });
  it.each(["loading", "ready"] as const)(
    "gates deliberate history requests when status is %s",
    async (status) => {
      const m = await mount({ stream: stream(status) });
      try {
        await act(async () => m.find("XtermView").props.onLoadOlder());
        expect(m.load).toHaveBeenCalledTimes(status === "ready" ? 1 : 0);
      } finally {
        await m.close();
      }
    },
  );
  it("retains the last complete screen while a replacement stream loads", async () => {
    const m = await mount({
      stream: { status: "loading", historyStatus: "waiting" },
      fallbackScreen: screen,
    });
    try {
      expect(m.find("XtermView").props.rows.at(-1).line.r[0].t).toBe("live output");
      expect(m.words()).toContain("Updating output");
    } finally {
      await m.close();
    }
  });
  it("offers bounded retry after a real receiver timeout", async () => {
    let now = 0;
    const receiver = new MobileScreenStream({
      subscriptionId: "S".repeat(22),
      sessionId: "tmux:a",
      now: () => now,
      sendControl: () => true,
    });
    receiver.start();
    now = 5001;
    receiver.tick();
    const m = await mount({ stream: receiver.snapshot });
    try {
      expect(m.words()).toContain("Output stopped: delivery stalled");
      await act(async () => m.button("Retry output").props.onPress());
      expect(m.retry).toHaveBeenCalledOnce();
    } finally {
      await m.close();
    }
  });
  it.each(["screen-too-large", "unsupported"] as const)(
    "retains complete output and marks it stale after %s",
    async (error) => {
      const m = await mount({ stream: { ...stream(), status: "closed", error } });
      try {
        expect(m.find("XtermView").props.rows.at(-1).line.r[0].t).toBe("live output");
        expect(m.words()).toContain("Output stopped");
        await act(async () => m.button("Retry output").props.onPress());
        expect(m.retry).toHaveBeenCalledOnce();
        await m.render({ stream: stream() });
        expect(m.words()).not.toContain("Output stopped");
      } finally {
        await m.close();
      }
    },
  );
  it.each(["reset", "unavailable"] as const)(
    "keeps live output live when only history is %s",
    async (status) => {
      const m = await mount({ stream: stream(status) });
      try {
        expect(m.words()).not.toContain("Output stopped");
        expect(m.find("XtermView").props.rows.at(-1).line.r[0].t).toBe("live output");
      } finally {
        await m.close();
      }
    },
  );
  it.each([
    ["ready", "Load older"],
    ["oversized", "Skip line"],
    ["truncated", "Refresh history"],
  ] as const)("keeps press/focus feedback on %s history actions", async (status, label) => {
    const skip = vi.fn();
    const m = await mount({ stream: stream(status), onSkipOversized: skip });
    try {
      const idle = m.button(label).props.style({ pressed: false }).backgroundColor;
      expect(m.button(label).props.style({ pressed: true }).backgroundColor).not.toBe(idle);
      await act(async () => m.button(label).props.onFocus());
      expect(m.button(label).props.style({ pressed: false }).backgroundColor).not.toBe(idle);
      await act(async () => m.button(label).props.onPress());
      expect(
        status === "ready" ? m.load : status === "oversized" ? skip : m.refresh,
      ).toHaveBeenCalledOnce();
    } finally {
      await m.close();
    }
  });
});
