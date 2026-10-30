import { act, createElement, type ReactNode } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";
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
    ListFooterComponent,
  }: {
    data: unknown[];
    renderItem: (input: { item: unknown; index: number }) => ReactNode;
    contentContainerStyle?: object;
    ListFooterComponent?: ReactNode;
  }) =>
    createElement(
      "FlashList",
      { contentContainerStyle },
      ...data.map((item, index) => renderItem({ item, index })),
      ListFooterComponent ?? null,
    ),
}));
const ui = vi.hoisted(() => {
  const state = {
    sessionViews: { computer: "terminals" } as Record<string, string>,
    setSessionView: (fp: string, view: string) => {
      state.sessionViews = { ...state.sessionViews, [fp]: view };
    },
  };
  return state;
});
vi.mock("../src/store/computers", () => ({
  useComputersStore: (selector: (state: unknown) => unknown) =>
    selector({ computers: [{ fp: "computer", name: "Fixture", accent: "emerald" }] }),
  useUiStore: Object.assign((selector: (state: unknown) => unknown) => selector(ui), {
    getState: () => ui,
  }),
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
    // The agent's mark is drawn text too; it isn't part of the row's name.
    expect(
      rows.map((row) =>
        texts(row)
          .filter((text) => text !== "C")
          .slice(0, 2),
      ),
    ).toEqual([
      ["shellbell", "Claude · Relay security for mobile and laptop"],
      ["notes", "~/code/notes"],
      ["zsh", "~/legacy"],
    ]);
    // Long names truncate on one line rather than wrapping the row.
    for (const row of rows) {
      const [title, subtitle] = row.queryAll(
        (n) => n.type === "Text" && n.children.join("") !== "C",
      );
      expect(title?.props.numberOfLines).toBe(1);
      expect(subtitle?.props.numberOfLines).toBe(1);
    }
    // A known agent shows its own mark; a plain folder row shows none.
    const mark = (row: (typeof rows)[number]) =>
      row.queryAll((n) => n.type === "Text" && n.children.join("") === "C");
    expect(mark(rows[0]!)).toHaveLength(1);
    expect(mark(rows[1]!)).toHaveLength(0);
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

it("says when a terminal needs a step on the computer, and nothing when it does not", async () => {
  const texts = (root: ReturnType<typeof createRoot>) =>
    root.container
      .queryAll((node) => node.type === "Text")
      .flatMap((node) => node.props.children)
      .filter((child): child is string => typeof child === "string");
  const render = async (terminalSetup: unknown[]) => {
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("computer", () => ({
      status: "online",
      hello: { terminalSetup } as never,
      sessions: [session("tmux:a", { project: "one" })] as never,
    }));
    const root = createRoot();
    await act(async () => root.render(createElement(Computer)));
    return root;
  };
  const blocked = await render([
    { name: "iterm2", connected: false, issue: "automation-denied" },
    { name: "tmux", connected: true },
    { name: "herdr", connected: false, issue: "not-installed" },
  ]);
  try {
    expect(texts(blocked)).toContain("iTerm2 needs one more step on your Mac.");
    // A missing Herdr is not a problem to report; only the footer names what the phone can show.
    expect(
      texts(blocked)
        .filter((text) => !text.startsWith("Missing a terminal?"))
        .join(" "),
    ).not.toContain("Herdr");
  } finally {
    await act(async () => blocked.unmount());
  }
  const quiet = await render([{ name: "iterm2", connected: false, issue: "not-running" }]);
  try {
    expect(texts(quiet).join(" ")).not.toContain("needs one more step");
  } finally {
    await act(async () => quiet.unmount());
  }
});

it("lists agents waiting for you first, says when a state is unknown, and switches views", async () => {
  ui.sessionViews = {};
  const now = Date.now();
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessionsComplete: true,
    sessions: [
      session("herdr:busy", {
        project: "api",
        state: "running",
        agent: { kind: "codex", task: "Tests", reportsState: true },
        stateSince: now - 5 * 60_000,
      }),
      session("tmux:plain", { title: "zsh", project: "notes" }),
      session("tmux:guess", { project: "web", state: "running", agent: { kind: "claude" } }),
      session("herdr:wait", {
        project: "app",
        state: "blocked",
        agent: { kind: "claude", task: "Fix it", reportsState: true },
        stateSince: now - 2 * 60_000,
      }),
    ] as never,
  }));
  const root = createRoot();
  await act(async () => root.render(createElement(Computer)));
  try {
    const rows = () =>
      root.container.queryAll(
        (n) => n.type === "Pressable" && typeof n.props.accessibilityHint === "string",
      );
    // With agents running and no choice yet, Agents opens first: agents only, waiting first.
    expect(rows().map((row) => row.props.accessibilityLabel.split(", ")[0])).toEqual([
      "app",
      "api",
      "web",
    ]);
    const pills = root.container
      .queryAll((n) => n.type === "Pill")
      .map((pill) => pill.props.text as string);
    // tmux can't say what an agent is doing, so it isn't shown as working.
    expect(pills).toEqual(["waiting for you · 2m", "working · 5m", "state unknown"]);
    const tabs = root.container.queryAll((n) => n.props.accessibilityRole === "tab");
    expect(tabs.map((tab) => tab.props.accessibilityLabel)).toEqual([
      "Agents, 1 waiting for you",
      "Terminals",
    ]);
    // Agents has no new-session button; Terminals lists every session and has one.
    expect(root.container.queryAll((n) => n.props.accessibilityLabel === "New session")).toEqual(
      [],
    );
    await act(async () => tabs[1]!.props.onPress());
    expect(ui.sessionViews.computer).toBe("terminals");
    await act(async () => root.render(createElement(Computer)));
    expect(rows()).toHaveLength(4);
    expect(
      root.container.queryAll((n) => n.props.accessibilityLabel === "New session"),
    ).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    ui.sessionViews = { computer: "terminals" };
  }
});

it("explains an empty Agents list, or that it can't see every session", async () => {
  ui.sessionViews = { computer: "agents" };
  const root = createRoot();
  try {
    for (const complete of [true, false]) {
      useConnectionsStore.setState({ byComputer: {} });
      useConnectionsStore.getState().patch("computer", () => ({
        status: "online",
        sessionsComplete: complete,
        sessions: [session("tmux:plain", { title: "zsh" })] as never,
      }));
      await act(async () => root.render(createElement(Computer)));
      const empty = root.container.queryAll((n) => n.type === "EmptyState")[0]!;
      if (complete) {
        expect(empty.props.text).toContain("No agents running");
        await act(async () => empty.props.action.onPress());
        expect(ui.sessionViews.computer).toBe("terminals");
        const sheet = root.container.queryAll((n) => n.type === "NewSessionSheet")[0]!;
        expect(sheet.props.visible).toBe(true);
        ui.sessionViews = { computer: "agents" };
      } else {
        expect(empty.props.text).toContain("Can’t see all sessions");
        expect(empty.props.action).toBeUndefined();
      }
    }
  } finally {
    await act(async () => root.unmount());
    ui.sessionViews = { computer: "terminals" };
  }
});

it("advances an agent's time in its state while the list stays open", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T10:00:00Z"));
  ui.sessionViews = { computer: "agents" };
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessionsComplete: true,
    sessions: [
      session("herdr:wait", {
        project: "app",
        state: "blocked",
        agent: { kind: "claude", reportsState: true },
        stateSince: Date.now() - 60_000,
      }),
    ] as never,
  }));
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(Computer)));
    const pill = () =>
      root.container.queryAll((n) => n.type === "Pill").map((p) => p.props.text as string);
    expect(pill()).toEqual(["waiting for you · 1m"]);
    // Nothing new from the computer, yet the age moves on.
    await act(async () => vi.advanceTimersByTime(3 * 60_000));
    expect(pill()).toEqual(["waiting for you · 4m"]);
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
    ui.sessionViews = { computer: "terminals" };
  }
});

describe("which terminals the phone can show", () => {
  const absent = (name: string) => ({ name, connected: false, issue: "not-installed" as const });
  const render = async (patch: Record<string, unknown>) => {
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("computer", () => ({ status: "online", ...patch }));
    const root = createRoot();
    await act(async () => root.render(createElement(Computer)));
    return root;
  };

  it("names the terminals a Mac's phone can show when nothing is listed", async () => {
    const root = await render({
      sessions: [],
      hello: { terminalSetup: [{ name: "iterm2", connected: true }, absent("tmux")] } as never,
    });
    try {
      const empty = root.container.queryAll((node) => node.type === "EmptyState")[0]!;
      expect(empty.props.text).toBe(
        "No terminal sessions yet. Your phone shows iTerm2 tabs and terminals running inside tmux or Herdr. Other apps' tabs, such as Terminal or Ghostty, appear only when tmux or Herdr runs inside them.",
      );
      expect(empty.props.action.label).toBe("New session");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("names only tmux for a Linux computer, and leaves a Mac with nothing usable to its notice", async () => {
    let root = await render({ sessions: [], hello: { terminalSetup: [absent("tmux")] } as never });
    try {
      expect(root.container.queryAll((node) => node.type === "EmptyState")[0]!.props.text).toBe(
        "No terminal sessions yet. Your phone shows terminals running inside tmux. Start tmux in a terminal on your computer to see it here.",
      );
    } finally {
      await act(async () => root.unmount());
    }
    root = await render({
      sessions: [],
      hello: { terminalSetup: [absent("iterm2"), absent("tmux"), absent("herdr")] } as never,
    });
    try {
      expect(root.container.queryAll((node) => node.type === "EmptyState")[0]!.props.text).toBe(
        "No terminal sessions yet.",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("says below the list where a missing terminal would come from", async () => {
    const root = await render({ sessions: [session("tmux:%1", {})] as never });
    try {
      const list = root.container.queryAll((node) => node.type === "FlashList")[0]!;
      const texts = list
        .queryAll((node) => node.type === "Text")
        .map((node) => node.children.join(""));
      expect(texts.at(-1)).toMatch(/^Missing a terminal\? Your phone shows iTerm2 tabs/);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
