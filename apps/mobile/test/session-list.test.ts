import { act, createElement, type ReactNode } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import Computer from "../app/c/[fp]/index";
import { useConnectionsStore } from "../src/store/connections";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ left: 0, right: 0, bottom: 34 }),
}));
const actions = vi.hoisted(() => ({ push: vi.fn(), connect: vi.fn(), focused: true }));
vi.mock("../src/net/manager", () => ({
  connectionManager: { get: () => ({ connect: actions.connect }) },
}));
vi.mock("../src/net/unpair-computer", () => ({ unpairComputer: vi.fn() }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useLocalSearchParams: () => ({ fp: "computer" }),
    useRouter: () => ({ push: actions.push }),
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = actions.focused;
      useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
  };
});
vi.mock("react-native", () => ({ View: "View", Text: "Text", Pressable: "Pressable" }));
vi.mock("react-native-reanimated", () => ({
  default: { View: "AnimatedView" },
  Easing: { out: () => {}, ease: () => {} },
  LinearTransition: { duration: () => ({ easing: () => ({}) }) },
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: ({
    data,
    renderItem,
    contentContainerStyle,
  }: {
    data: unknown[];
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
    contentContainerStyle?: object;
  }) =>
    createElement(
      "FlashList",
      { contentContainerStyle },
      ...data.map((item, index) => renderItem({ item, index })),
    ),
}));
vi.mock("../src/store/computers", () => ({
  useComputersStore: (selector: (state: unknown) => unknown) =>
    selector({ computers: [{ fp: "computer", name: "Fixture", accent: "emerald" }] }),
}));
vi.mock("../src/store/network", () => ({
  useNetworkStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshot: { type: "WIFI", internet: "online", disconnected: false } }),
}));
vi.mock("../src/ui/NewSessionSheet", () => ({
  NewSessionSheet: (props: object) => createElement("NewSessionSheet", props),
}));
vi.mock("../src/ui/TransportStatus", () => ({ TransportStatus: () => null }));
vi.mock("../src/ui/EmptyState", () => ({
  EmptyState: (props: object) => createElement("EmptyState", props),
}));
vi.mock("../src/ui/StatusOverlay", () => ({
  StatusOverlay: (props: object) => createElement("StatusOverlay", props),
}));
vi.mock("../src/ui/Pill", () => ({ Pill: (props: object) => createElement("Pill", props) }));

it.each(["relay", "superseded"] as const)(
  "retries %s without sending the user to pairing",
  async (error) => {
    actions.push.mockClear();
    actions.connect.mockClear();
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("computer", () => ({ status: "error", error }));
    const root = createRoot();
    try {
      await act(async () => root.render(createElement(Computer)));
      const empty = root.container.queryAll((node) => node.type === "EmptyState")[0]!;
      expect(empty.props.action.label).toBe("Retry");
      await act(async () => empty.props.action.onPress());
      expect(actions.connect).toHaveBeenCalledExactlyOnceWith();
      expect(actions.push).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  },
);

it("uses the advertised adapter label in headers and pills, including catalog-only updates", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [
      {
        id: "example:one",
        backend: "example",
        title: "Work",
        cols: 80,
        rows: 24,
        windowId: "example:window",
        windowNumber: 1,
        tabId: "example:tab",
        tabIndex: 0,
        paneIndex: 0,
        isFocusedOnMac: false,
        state: "unknown",
      },
      // A second backend, so the rows show which terminal each session is in.
      {
        id: "tmux:two",
        backend: "tmux",
        title: "Notes",
        cols: 80,
        rows: 24,
        windowId: "tmux:window",
        windowNumber: 1,
        tabId: "tmux:tab",
        tabIndex: 0,
        paneIndex: 0,
        isFocusedOnMac: false,
        state: "unknown",
      },
    ],
    hello: {
      backendCatalog: [
        { name: "example", label: "Example Terminal", connected: true, launchable: false },
      ],
    } as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    const header = () =>
      root.container
        .queryAll((node) => node.type === "Text")
        .map((node) => node.props.children)
        .filter((value) => typeof value === "string");
    const pills = () =>
      root.container.queryAll((node) => node.type === "Pill").map((node) => node.props.text);
    expect(header()).toContain("EXAMPLE TERMINAL · WINDOW 1");
    expect(pills()).toContain("Example Terminal");
    await act(async () =>
      useConnectionsStore.getState().patch("computer", (current) => ({
        hello: {
          ...current.hello,
          backendCatalog: current.hello?.backendCatalog?.map((entry) => ({
            ...entry,
            label: "Renamed Terminal",
          })),
        } as never,
      })),
    );
    expect(header()).toContain("RENAMED TERMINAL · WINDOW 1");
    expect(pills()).toContain("Renamed Terminal");
  } finally {
    await act(async () => root.unmount());
  }
});

it("closes the new session sheet when the session list loses focus", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({ status: "online", sessions: [] }));
  const root = createRoot();
  const render = () => act(async () => root.render(createElement(Computer)));
  const sheet = () => root.container.queryAll((node) => node.type === "NewSessionSheet")[0]!;
  try {
    await render();
    const empty = root.container.queryAll((node) => node.type === "EmptyState")[0]!;
    await act(async () => empty.props.action.onPress());
    expect(sheet().props.visible).toBe(true);
    // A notification tap can push a session over the list while the sheet is open.
    actions.focused = false;
    await render();
    expect(sheet().props.visible).toBe(false);
    actions.focused = true;
    await render();
    expect(sheet().props.visible).toBe(false);
  } finally {
    actions.focused = true;
    await act(async () => root.unmount());
  }
});

const session = (id: string, extra: Record<string, unknown>) => ({
  id,
  backend: id.split(":")[0],
  title: "claude",
  cols: 80,
  rows: 24,
  windowId: `${id.split(":")[0]}:w1`,
  windowNumber: 1,
  tabId: "t",
  tabIndex: 0,
  paneIndex: 0,
  isFocusedOnMac: false,
  state: "running",
  ...extra,
});

it("names rows by project with the agent's task, else a home-relative folder", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [
      session("herdr:a", {
        cwd: "/Users/example/code/shellbell",
        project: "shellbell",
        windowLabel: "shellbell",
        agent: { kind: "claude", task: "Relay security for mobile and laptop" },
      }),
      session("tmux:b", { title: "main:0.0", cwd: "/Users/example/code/notes", project: "notes" }),
      session("tmux:c", { title: "zsh", cwd: "/Users/example/legacy" }),
    ] as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    const texts = (node: { queryAll: typeof root.container.queryAll }) =>
      node
        .queryAll((n) => n.type === "Text")
        .flatMap((n) => n.children)
        .filter((c): c is string => typeof c === "string");
    const rows = root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityHint === "Open terminal",
    );
    expect(rows.map((row) => texts(row).slice(0, 2))).toEqual([
      ["shellbell", "claude · Relay security for mobile and laptop"],
      ["notes", "~/code/notes"],
      ["zsh", "~/legacy"],
    ]);
    // Long names truncate on one line rather than wrapping the row.
    for (const row of rows) {
      const [title, subtitle] = row.queryAll((n) => n.type === "Text");
      expect(title?.props.numberOfLines).toBe(1);
      expect(subtitle?.props.numberOfLines).toBe(1);
    }
    expect(rows[0]!.queryAll((n) => n.type === "SymbolView")).toHaveLength(1);
    expect(rows[1]!.queryAll((n) => n.type === "SymbolView")).toHaveLength(0);
    expect(rows.map((row) => row.props.accessibilityLabel)).toEqual([
      "shellbell, claude, Relay security for mobile and laptop, Herdr, running",
      "notes, ~/code/notes, tmux, running",
      "zsh, ~/legacy, tmux, running",
    ]);
    expect(JSON.stringify(texts(root.container))).not.toContain("/Users/example");
    expect(texts(root.container)).toEqual(expect.arrayContaining(["TMUX · WINDOW 1"]));
  } finally {
    await act(async () => root.unmount());
  }
});

it("drops a group heading that only repeats its one row's title", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [
      // One session whose heading repeats its title: no heading.
      session("herdr:a", { project: "shellbell", windowLabel: "shellbell", windowId: "herdr:w1" }),
      // One session under a different label: heading kept.
      session("herdr:b", { project: "notes", windowLabel: "writing", windowId: "herdr:w2" }),
      // Two sessions under the same label as one title: heading kept.
      session("herdr:c", { project: "books", windowLabel: "books", windowId: "herdr:w3" }),
      session("herdr:d", { project: "books", windowLabel: "books", windowId: "herdr:w3" }),
      // A window-number heading never matches a title.
      session("tmux:e", { project: "zsh" }),
      // A repeated title still heads its row when it names the app showing it.
      session("herdr:f", {
        project: "web",
        windowLabel: "web",
        windowId: "herdr:w4",
        shownIn: ["Ghostty"],
      }),
    ] as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    type Node = { children: readonly (Node | string)[] };
    const flat = (node: Node): string =>
      node.children.map((c) => (typeof c === "string" ? c : flat(c))).join("");
    const headings = root.container
      .queryAll((n) => n.type === "Text" && n.props.style?.letterSpacing === 1)
      .map((n) => flat(n as unknown as Node));
    expect(headings).toEqual([
      "HERDR · writing",
      "HERDR · books",
      "TMUX · WINDOW 1",
      "HERDR · web · in Ghostty",
    ]);
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows the backend pill only when the list mixes backends", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  const pills = (root: ReturnType<typeof createRoot>) =>
    root.container.queryAll((node) => node.type === "Pill").map((node) => node.props.text);
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [
      session("herdr:a", { project: "one", windowId: "herdr:w1" }),
      session("herdr:b", { project: "two", windowId: "herdr:w2" }),
    ] as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    expect(pills(root)).toEqual(["running", "running"]);
    const rows = root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityHint === "Open terminal",
    );
    // The spoken label still names the terminal.
    expect(rows[0]!.props.accessibilityLabel).toContain("Herdr");
    await act(async () =>
      useConnectionsStore.getState().patch("computer", (current) => ({
        sessions: [...current.sessions, session("tmux:c", { project: "three" })] as never,
      })),
    );
    expect(pills(root)).toEqual(["Herdr", "running", "Herdr", "running", "tmux", "running"]);
  } finally {
    await act(async () => root.unmount());
  }
});

it("leaves room below the last row for the floating new session button", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [session("herdr:a", { project: "one" })] as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    const list = root.container.queryAll((node) => node.type === "FlashList")[0]!;
    const fab = root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === "New session",
    )[0]!;
    const { bottom, height } = fab.props.style as { bottom: number; height: number };
    // Above the button's top edge plus the bottom safe-area inset (34 in this mock).
    expect(list.props.contentContainerStyle.paddingBottom).toBeGreaterThanOrEqual(
      bottom + height + 34 + 8,
    );
  } finally {
    await act(async () => root.unmount());
  }
});

it("dims a paused list without a floating pill that repeats the banner", async () => {
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "waiting-direct",
    sessions: [session("herdr:a", { project: "one" })] as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    const overlays = root.container.queryAll((node) => node.type === "StatusOverlay");
    expect(overlays).toHaveLength(1);
    expect(overlays[0]!.props.text).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
  }
});
