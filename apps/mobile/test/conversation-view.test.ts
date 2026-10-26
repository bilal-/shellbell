import { act, createElement, Fragment } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import type { MobileConversationSnapshot } from "../src/net/mobile-conversation";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  // Renders its rows, like the real list, beneath whatever providers wrap it.
  FlatList: (props: {
    data: { key: string }[];
    renderItem: (info: { item: unknown; index: number }) => unknown;
  }) =>
    createElement(
      "FlatList",
      props,
      props.data.map((item, index) =>
        createElement(Fragment, { key: item.key }, props.renderItem({ item, index }) as never),
      ),
    ),
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-linking", () => ({ openURL: vi.fn(async () => true) }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { getItemSync: () => null, setItemSync() {} },
}));

const { ConversationView } = await import("../src/conversation/ConversationView");

const snapshot = (overrides: Partial<MobileConversationSnapshot> = {}) =>
  ({
    state: "ready",
    entries: [{ id: "1".padStart(22, "0"), kind: "assistant", text: "Hello" }],
    history: "unloaded",
    historyStatus: "idle",
    canRequestOlder: true,
    caughtUp: true,
    notice: null,
    reason: null,
    ...overrides,
  }) as MobileConversationSnapshot;

it("loads earlier messages when the first page doesn't fill the screen", async () => {
  const onLoadOlder = vi.fn();
  const root = createRoot();
  await act(async () =>
    root.render(createElement(ConversationView, { snapshot: snapshot(), onLoadOlder })),
  );
  const list = root.container.queryAll((node) => node.type === "FlatList")[0]!;
  // No scroll happens on a short page, so only the list's own size reports can tell.
  await act(async () => {
    list.props.onLayout({ nativeEvent: { layout: { height: 1600 } } });
    list.props.onContentSizeChange(1080, 400);
  });
  expect(onLoadOlder).toHaveBeenCalledTimes(1);
  // A long page with the owner at the newest rows doesn't load.
  onLoadOlder.mockClear();
  await act(async () =>
    root.render(
      createElement(ConversationView, {
        snapshot: snapshot({ historyStatus: "loading" }),
        onLoadOlder,
      }),
    ),
  );
  await act(async () => list.props.onContentSizeChange(1080, 9000));
  await act(async () =>
    root.render(createElement(ConversationView, { snapshot: snapshot(), onLoadOlder })),
  );
  expect(onLoadOlder).not.toHaveBeenCalled();
  await act(async () => root.unmount());
});

it("re-renders only the rows a new entry changes", async () => {
  const { conversationRows } = await import("../src/conversation/conversation-rows");
  const { sameRow } = await import("../src/conversation/ConversationRows");
  const e = (n: number, kind: "user" | "assistant" | "tool-call" | "tool-result", text: string) =>
    Object.freeze({ id: String(n).padStart(22, "0"), kind, text });
  const entries = [
    e(1, "user", "Fix it"),
    e(2, "assistant", "Looking"),
    e(3, "tool-call", "Bash · make"),
  ];
  const before = conversationRows(entries);
  const after = conversationRows([...entries, e(4, "tool-result", "Tool result")]);
  // Rows are rebuilt, but the message rows are unchanged and the work row gained its result.
  expect(after.map((row, i) => sameRow(before[i]!, row))).toEqual([true, true, false]);
  expect(conversationRows(entries).every((row, i) => sameRow(before[i]!, row))).toBe(true);
});

it("shows every call still waiting in the newest work as running", async () => {
  const call = (n: number, text: string) => ({
    id: String(n).padStart(22, "0"),
    kind: "tool-call" as const,
    text,
    detail: "args",
  });
  const root = createRoot();
  await act(async () =>
    root.render(
      createElement(ConversationView, {
        snapshot: snapshot({ entries: [call(1, "Read · a"), call(2, "Read · b")] }),
        onLoadOlder: vi.fn(),
        working: true,
      }),
    ),
  );
  const list = root.container.queryAll((node) => node.type === "FlatList")[0]!;
  const rows = list.props.data as { key: string }[];
  const item = list.props.renderItem({ item: rows[0], index: 0 });
  const row = createRoot();
  await act(async () => row.render(item));
  const open = row.container.queryAll((n) => n.props.accessibilityState?.expanded === false)[0]!;
  await act(async () => open.props.onPress());
  const labels = row.container
    .queryAll((n) => typeof n.props.accessibilityLabel === "string")
    .map((n) => n.props.accessibilityLabel as string)
    .filter((label) => label.startsWith("Read ·"));
  expect(labels).toEqual(["Read · a, running", "Read · b, running"]);
  // Rows keep a comfortable tap height even though their text is terminal-sized.
  const heights = row.container
    .queryAll((n) => n.props.accessibilityState !== undefined && n.props.onPress)
    .map((n) => n.props.style.minHeight);
  expect(heights).toEqual([40, 32, 32]);
  await act(async () => {
    row.unmount();
    root.unmount();
  });
});

it("uses Terminal's font size and row height, and follows changes to it", async () => {
  const { useUiStore } = await import("../src/store/computers");
  const { conversationType } = await import("../src/conversation/ConversationRows");
  const before = useUiStore.getState().fontSize;
  const root = createRoot();
  try {
    useUiStore.getState().setFontSize(11);
    await act(async () =>
      root.render(createElement(ConversationView, { snapshot: snapshot(), onLoadOlder: vi.fn() })),
    );
    // The rendered reply's own marker and prose follow the setting, not just chrome.
    const sizes = () =>
      root.container
        .queryAll((node) => node.type === "Text")
        .map((node) => [node.props.style.fontSize, node.props.style.lineHeight]);
    expect(sizes()).toEqual([
      [11, 15],
      [11, 15],
    ]);
    await act(async () => useUiStore.getState().setFontSize(16));
    expect(sizes()).toEqual([
      [16, 21],
      [16, 21],
    ]);
    // Prose and marker columns share the size: one marker is two terminal cells wide.
    expect(conversationType(16)).toMatchObject({ lineHeight: 21, gutter: 20 });
  } finally {
    await act(async () => root.unmount());
    useUiStore.getState().setFontSize(before);
  }
});

it("copies a reply on a long press and from a screen reader button, without a copy row", async () => {
  const Clipboard = await import("expo-clipboard");
  const root = createRoot();
  await act(async () =>
    root.render(createElement(ConversationView, { snapshot: snapshot(), onLoadOlder: vi.fn() })),
  );
  const texts = () => root.container.queryAll((n) => n.type === "Text").map((n) => n.props.children);
  expect(texts().flat()).not.toContain("[copy]");
  const reply = root.container.queryAll((n) => typeof n.props.onLongPress === "function")[0]!;
  await act(async () => reply.props.onLongPress());
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("Hello");
  // The marker confirms the copy in place.
  expect(texts()[0]).toBe("✓");
  const button = root.container.queryAll((n) => n.props.accessibilityLabel === "Reply copied")[0]!;
  expect(button.props.style).toMatchObject({ opacity: 0 });
  await act(async () => root.unmount());
});

it("doesn't add a second ellipsis to a running step the computer already shortened", async () => {
  const root = createRoot();
  await act(async () =>
    root.render(
      createElement(ConversationView, {
        snapshot: snapshot({
          entries: [
            { id: "1".padStart(22, "0"), kind: "tool-call", text: "Bash · python3 - <<'EOF'…" },
          ],
        }),
        onLoadOlder: vi.fn(),
        working: true,
      }),
    ),
  );
  const shown = root.container
    .queryAll((n) => n.type === "Text")
    .map((n) => [n.props.children].flat().filter((c) => typeof c === "string").join(""));
  expect(shown).toContain("Bash · python3 - <<'EOF'…");
  expect(shown.join("")).not.toContain("……");
  await act(async () => root.unmount());
});
