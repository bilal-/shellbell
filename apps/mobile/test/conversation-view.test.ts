import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import type { MobileConversationSnapshot } from "../src/net/mobile-conversation";

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  FlatList: "FlatList",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-linking", () => ({ openURL: vi.fn(async () => true) }));

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
