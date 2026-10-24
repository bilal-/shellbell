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
