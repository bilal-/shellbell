import { act, createElement, Fragment } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { MobileConversationSnapshot } from "../src/net/mobile-conversation";

vi.mock("react-native", () => ({
  AccessibilityInfo: undefined,
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
vi.mock("../src/conversation/motion", () => {
  const pass = (name: string) => (props: { children?: import("react").ReactNode }) =>
    createElement(name, props, props.children);
  return {
    BreathingDot: (props: object) => createElement("BreathingDot", props),
    Fade: pass("Fade"),
    RiseIn: pass("RiseIn"),
    Expand: pass("Expand"),
    Resizes: pass("View"),
    CheckIn: pass("CheckIn"),
  };
});
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
    // The rendered reply's name, marker and prose follow the setting, not just chrome.
    const sizes = () =>
      root.container
        .queryAll((node) => node.type === "Text")
        .map((node) => [node.props.style.fontSize, node.props.style.lineHeight]);
    expect(sizes()).toEqual([
      [11, 15],
      [11, 15],
      [11, 15],
    ]);
    await act(async () => useUiStore.getState().setFontSize(16));
    expect(sizes()).toEqual([
      [16, 21],
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

it("copies a reply on a long press, with a copy button only for screen readers", async () => {
  const Clipboard = await import("expo-clipboard");
  const { Row, ScreenReaderContext } = await import("../src/conversation/ConversationRows");
  const row = { kind: "assistant", key: "r", entry: snapshot().entries[0] } as never;
  const root = createRoot();
  const render = (screenReader: boolean) =>
    act(async () =>
      root.render(
        createElement(
          ScreenReaderContext.Provider,
          { value: screenReader },
          createElement(Row, { row, live: false }),
        ),
      ),
    );
  const texts = () =>
    root.container.queryAll((n) => n.type === "Text").map((n) => n.props.children);
  await render(false);
  expect(texts().flat()).not.toContain("[copy]");
  expect(root.container.queryAll((n) => n.props.accessibilityLabel === "Copy reply")).toEqual([]);
  const reply = root.container.queryAll((n) => typeof n.props.onLongPress === "function")[0]!;
  await act(async () => reply.props.onLongPress());
  expect(Clipboard.setStringAsync).toHaveBeenLastCalledWith("Hello");
  // The marker, under the agent's name, confirms the copy in place.
  expect(texts()[1]).toBe("✓");
  // A screen reader can't long-press, so it gets a real, visible button.
  await render(true);
  const button = root.container.queryAll((n) => n.props.accessibilityRole === "button")[0]!;
  expect(button.props.accessibilityLabel).toMatch(/Copy reply|Reply copied/);
  expect(button.props.style).not.toHaveProperty("opacity");
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
    .map((n) => n.children.filter((c) => typeof c === "string").join(""));
  // The tool name sits in its own coloured span; read together, the title is unchanged.
  expect(shown).toContain("Bash");
  expect(shown).toContain(" · python3 - <<'EOF'…");
  expect(shown.join("")).not.toContain("……");
  await act(async () => root.unmount());
});

it("colours each side: the agent's bar on the left, yours on the right in the computer's accent", async () => {
  const root = createRoot();
  await act(async () =>
    root.render(
      createElement(ConversationView, {
        snapshot: snapshot({
          entries: [
            { id: "1".padStart(22, "0"), kind: "user", text: "Run the tests" },
            { id: "2".padStart(22, "0"), kind: "assistant", text: "Running them now." },
          ],
        }),
        onLoadOlder: vi.fn(),
        agent: "claude",
        accent: "#3B82F6",
      }),
    ),
  );
  const byId = (id: string) => root.container.queryAll((n) => n.props.testID === id)[0]!;
  const words = root.container
    .queryAll((n) => n.type === "Text")
    .map((n) => n.children.filter((c) => typeof c === "string").join(""));
  // Colour is never the only signal: each side is named too.
  expect(words).toContain("You");
  expect(words).toContain("Claude");
  expect(byId("agent-reply").props.style).toMatchObject({
    borderLeftWidth: 2,
    borderLeftColor: "#D97757",
  });
  expect(byId("user-message").props.style).toMatchObject({
    borderRightWidth: 2,
    borderRightColor: "#3B82F6",
  });
  // The owner's message sits on the right.
  expect(byId("user-message").parent!.props.style).toMatchObject({ alignItems: "flex-end" });
  expect(
    root.container.queryAll((n) => n.props.accessibilityLabel === "You: Run the tests"),
  ).toHaveLength(1);
  await act(async () => root.unmount());
});

it("groups tool steps in a card with a dot per step, a coloured tool name and a coloured diff", async () => {
  const { Row } = await import("../src/conversation/ConversationRows");
  const { conversationRows } = await import("../src/conversation/conversation-rows");
  const id = (n: number) => String(n).padStart(22, "0");
  const [row] = conversationRows([
    {
      id: id(1),
      kind: "tool-call",
      text: "Edit · src/pager.ts",
      detail: "-  const end = start + size;\n+  const end = start + size - 1;",
    },
    { id: id(2), kind: "tool-result", text: "Edited" },
    { id: id(3), kind: "tool-call", text: "Bash · npm test" },
    { id: id(4), kind: "tool-result", text: "Tool error" },
    { id: id(5), kind: "tool-call", text: "Read · README.md" },
  ]);
  const root = createRoot();
  await act(async () => root.render(createElement(Row, { row: row!, live: true })));
  expect(root.container.queryAll((n) => n.props.testID === "work-card")).toHaveLength(1);
  const header = root.container.queryAll((n) => n.props.accessibilityState?.expanded === false)[0]!;
  await act(async () => header.props.onPress());
  // Done green, failed amber, running breathing in the agent's colour.
  const dots = root.container
    .queryAll((n) => n.type === "View" && n.props.style?.borderRadius === 4)
    .map((n) => n.props.style.backgroundColor);
  expect(dots).toEqual(["#4ADE80", "#F59E0B"]);
  expect(root.container.queryAll((n) => n.type === "BreathingDot")).toHaveLength(1);
  // Words carry the same meaning as colour.
  expect(
    root.container.queryAll((n) => n.props.accessibilityLabel === "Bash · npm test, failed"),
  ).toHaveLength(1);
  const toolName = root.container.queryAll(
    (n) => n.type === "Text" && n.children.join("") === "Edit",
  )[0]!;
  expect(toolName.props.style.color).toBe("#C084FC");
  const edit = root.container.queryAll(
    (n) => n.props.accessibilityLabel === "Edit · src/pager.ts",
  )[0]!;
  await act(async () => edit.props.onPress());
  const diff = root.container.queryAll((n) => n.props.testID === "step-diff")[0]!;
  const lines = diff.queryAll((n) => n.type === "Text");
  expect(lines.map((n) => n.children.join(""))).toEqual([
    "-  const end = start + size;",
    "+  const end = start + size - 1;",
  ]);
  expect(lines[0]!.props.style.backgroundColor).toBe("#F8717129");
  expect(lines[1]!.props.style.backgroundColor).toBe("#4ADE8029");
  await act(async () => root.unmount());
});

it("keeps every agent's and accent's name colour at AA contrast on black", async () => {
  const { AGENT_HARNESSES } = await import("../src/agents/registry");
  const { contrastOnBlack, readableOnBlack } = await import("../src/theme/contrast");
  const { tokens } = await import("../src/theme/tokens");
  for (const color of [
    ...Object.values(AGENT_HARNESSES).map((h) => h.color),
    ...Object.values(tokens.accents),
  ])
    expect(contrastOnBlack(readableOnBlack(color)), color).toBeGreaterThanOrEqual(4.5);
  // Colours that already read well stay exactly as they are.
  expect(readableOnBlack("#D97757")).toBe("#D97757");
});

describe("motion", () => {
  const entry = (n: number, kind: "user" | "assistant" = "assistant") => ({
    id: String(n).padStart(22, "0"),
    kind,
    text: `Message ${n}`,
  });
  const risen = (root: ReturnType<typeof createRoot>) =>
    root.container
      .queryAll((n) => n.type === "RiseIn" && n.props.rise === true)
      .map((n) =>
        n
          .queryAll((t) => t.type === "Text")
          .at(-1)!
          .children.join(""),
      );

  it("raises only rows that arrive live, not the first page or older pages", async () => {
    const root = createRoot();
    const show = (entries: ReturnType<typeof entry>[]) =>
      act(async () =>
        root.render(
          createElement(ConversationView, {
            snapshot: snapshot({ entries }),
            onLoadOlder: vi.fn(),
          }),
        ),
      );
    await show([entry(2), entry(3)]);
    expect(risen(root)).toEqual([]);
    // An older page loads above.
    await show([entry(1), entry(2), entry(3)]);
    expect(risen(root)).toEqual([]);
    // A new reply arrives at the bottom.
    await show([entry(1), entry(2), entry(3), entry(4)]);
    expect(risen(root)).toEqual(["Message 4"]);
    await act(async () => root.unmount());
  });

  it("keeps a row that rose in mounted once its rise is over", async () => {
    vi.useFakeTimers();
    const root = createRoot();
    const show = (entries: ReturnType<typeof entry>[]) =>
      act(async () =>
        root.render(
          createElement(ConversationView, {
            snapshot: snapshot({ entries }),
            onLoadOlder: vi.fn(),
          }),
        ),
      );
    const message = (text: string) =>
      root.container.queryAll((n) => n.type === "Text" && n.children.join("") === text)[0];
    try {
      await show([entry(1)]);
      await show([entry(1), entry(2)]);
      const arrived = message("Message 2");
      expect(arrived).toBeDefined();
      // Re-rendered after the rise: the same row, not a new one that loses its state.
      vi.advanceTimersByTime(1000);
      await show([entry(1), entry(2)]);
      expect(message("Message 2")).toBe(arrived);
    } finally {
      await act(async () => root.unmount());
      vi.useRealTimers();
    }
  });

  it("counts new messages while you're scrolled up", async () => {
    const root = createRoot();
    const show = (entries: ReturnType<typeof entry>[]) =>
      act(async () =>
        root.render(
          createElement(ConversationView, {
            snapshot: snapshot({ entries }),
            onLoadOlder: vi.fn(),
          }),
        ),
      );
    await show([entry(1)]);
    const list = root.container.queryAll((n) => n.type === "FlatList")[0]!;
    const scroll = (y: number) =>
      act(async () =>
        list.props.onScroll({
          nativeEvent: {
            contentOffset: { y },
            contentSize: { height: 5000 },
            layoutMeasurement: { height: 800 },
          },
        }),
      );
    await scroll(400);
    const pill = () =>
      root.container.queryAll((n) => n.props.accessibilityLabel?.includes?.("latest"))[0];
    expect(pill()!.props.accessibilityLabel).toBe("Go to latest message");
    await show([entry(1), entry(2)]);
    await show([entry(1), entry(2), entry(3)]);
    expect(pill()!.props.accessibilityLabel).toBe("2 new messages, go to latest");
    expect(
      pill()!
        .queryAll((n) => n.type === "Text")[0]!
        .children.join(""),
    ).toBe("↓ 2 new");
    await scroll(0);
    expect(pill()).toBeUndefined();
    await act(async () => root.unmount());
  });

  it("shows the terminal's latest lines under the running step until its result lands", async () => {
    const id = (n: number) => String(n).padStart(22, "0");
    const root = createRoot();
    const show = (entries: object[], liveTail: string[] | null) =>
      act(async () =>
        root.render(
          createElement(ConversationView, {
            snapshot: snapshot({ entries: entries as never }),
            onLoadOlder: vi.fn(),
            working: true,
            liveTail,
          }),
        ),
      );
    const call = { id: id(1), kind: "tool-call", text: "Bash · npm test" };
    await show([call], ["PASS a", "PASS b"]);
    const tail = () => root.container.queryAll((n) => n.props.testID === "live-tail")[0];
    expect(tail()!.props.accessibilityLabel).toBe("Latest output: PASS a. PASS b");
    expect(tail()!.props.style).toMatchObject({ opacity: 0.7 });
    await show([call, { id: id(2), kind: "tool-result", text: "Done" }], ["PASS a", "PASS b"]);
    expect(tail()).toBeUndefined();
    // Nothing to show, or hidden during a password prompt: no tail.
    await show([call], null);
    expect(tail()).toBeUndefined();
    await act(async () => root.unmount());
  });
});
