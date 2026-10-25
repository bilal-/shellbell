import { CONVERSATION_FEATURE } from "@shellbell/protocol";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";
import { sidToRoute } from "../src/util/routes";
import { keyboardLayout } from "./helpers/keyboard-layout";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

vi.mock("expo-router", async () => {
  const { createContext, createElement, useContext, useEffect } = await import("react");
  const FocusContext = createContext({ focused: false, params: { fp: "", sid: "" } });
  return {
    __FocusContext: FocusContext,
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const { focused } = useContext(FocusContext);
      useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
    useLocalSearchParams: () => useContext(FocusContext).params,
    useRouter: () => ({ back: () => {} }),
    Stack: {
      Screen: (props: {
        options?: {
          headerLeft?: () => import("react").ReactNode;
          headerTitle?: unknown;
          headerRight?: () => import("react").ReactNode;
        };
      }) => {
        const title = props.options?.headerTitle;
        return createElement(
          "StackScreen",
          props,
          props.options?.headerLeft?.(),
          typeof title === "function" ? title({ children: "" }) : null,
          props.options?.headerRight?.(),
        );
      },
    },
  };
});
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("expo-linking", () => ({ openURL: vi.fn(async () => true) }));
vi.mock("expo-keep-awake", () => ({ useKeepAwake: () => {} }));
vi.mock("../src/input/useHardwareKeyboard", () => ({ useHardwareKeyboard: () => false }));
vi.mock("../src/input/useScreenReader", () => ({ useScreenReader: () => false }));
vi.mock("../src/notifications", () => ({ dismissComputerNotifications: vi.fn(async () => {}) }));
vi.mock("../src/net/manager", () => ({
  connectionManager: { claimView: vi.fn(), get: vi.fn() },
}));
vi.mock("../src/screen/ScreenView", () => ({
  ScreenView: (props: object) => createElement("ScreenView", props),
}));
vi.mock("../src/store/computers", () => ({
  useComputersStore: (selector: (state: unknown) => unknown) =>
    selector({
      computers: [{ fp: "f1", name: "Mac", accent: "emerald" }],
    }),
  useUiStore: (selector: (state: { fontSize: number }) => unknown) => selector({ fontSize: 12 }),
}));
vi.mock("../src/input/InputBar", () => ({
  InputBar: (props: object) => createElement("InputBar", props),
}));
vi.mock("../src/ui/EmptyState", () => ({
  EmptyState: (props: object) => createElement("EmptyState", props),
}));
vi.mock("../src/ui/StatusOverlay", () => ({
  StatusOverlay: (props: object) => createElement("StatusOverlay", props),
}));

type Root = ReturnType<typeof createRoot>;
const headerTitleButton = (root: Root) =>
  root.container.queryAll(
    (node) =>
      node.type === "NativePressable" &&
      node.props.accessibilityHint === "Shows connection details",
  )[0];
/** The header title's visible lines, read the way a person sees them. */
function headerWords(root: Root): string[] {
  const title = headerTitleButton(root);
  if (!title) return [];
  return title
    .queryAll((node) => node.type === "NativeText")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""));
}
const directTransport = {
  route: "direct" as const,
  ready: true,
  phase: "direct" as const,
  retryPending: false,
  lastFailure: null,
};

async function mountSession(id = "tmux:a") {
  const { default: Session } = await import("../app/c/[fp]/s/[sid]");
  const { __FocusContext } = (await import("expo-router")) as unknown as {
    __FocusContext: import("react").Context<{
      focused: boolean;
      params: { fp: string; sid: string };
    }>;
  };
  const root = createRoot();
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          __FocusContext.Provider,
          { value: { focused: true, params: { fp: "f1", sid: sidToRoute(id) } } },
          createElement(Session),
        ),
      ),
    );
  await render();
  const button = (label: string) =>
    root.container.queryAll(
      (n) => n.type === "NativePressable" && n.props.accessibilityLabel === label,
    )[0];
  const screen = () => root.container.queryAll((n) => n.type === "ScreenView")[0];
  return { root, render, button, screen, close: () => act(async () => root.unmount()) };
}

async function seedSession(patch: object = {}) {
  const { connectionManager } = await import("../src/net/manager");
  const { useConnectionsStore } = await import("../src/store/connections");
  const lease = {
    revision: () => ({}),
    conversationRevision: () => ({}),
    setConversation: vi.fn(),
    requestOlderConversation: vi.fn(),
    refreshConversation: vi.fn(),
    release: vi.fn(),
    setRawStream: vi.fn(),
  };
  vi.mocked(connectionManager.claimView)
    .mockReset()
    .mockReturnValue(lease as never);
  vi.mocked(connectionManager.get)
    .mockReset()
    .mockReturnValue({ online: false } as never);
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("f1", () => ({
    status: "online",
    agentOnline: true,
    transport: directTransport,
    sessions: [
      {
        id: "tmux:a",
        title: "codex",
        project: "webBooks",
        agent: { kind: "codex", task: "Verify enrichments" },
        backend: "tmux",
        state: "finished",
      },
    ] as never,
    hello: {
      backends: [{ name: "tmux", capabilities: { terminalInput: true } }],
    } as never,
    boundedView: {
      sessionId: "tmux:a",
      snapshot: {
        status: "live",
        historyStatus: "ready",
        screen: {
          cols: 1,
          rows: 1,
          cursor: { x: 0, y: 0 },
          lines: [{ r: [{ t: "x" }] }],
          scrollbackTotal: 0,
          gen: 1,
        },
      },
    },
    ...patch,
  }));
  return { store: useConnectionsStore };
}

describe("lean session header", () => {
  const conversationReady = {
    sessionId: "tmux:a",
    subscriptionId: "subscription",
    snapshot: {
      state: "ready",
      entries: [{ id: "entry", kind: "assistant", text: "Reply" }],
      history: "unloaded",
      historyStatus: "idle",
      canRequestOlder: true,
      caughtUp: true,
      notice: null,
      reason: null,
    },
  };
  const conversationHello = {
    features: [CONVERSATION_FEATURE],
    conversationEnabled: true,
    backends: [{ name: "tmux", capabilities: { terminalInput: true } }],
  };

  it("opens a Codex session straight into Conversation while it loads, then the terminal if slow", async () => {
    vi.useFakeTimers();
    try {
      const { store } = await seedSession({
        hello: conversationHello,
        conversationView: {
          ...conversationReady,
          snapshot: { ...conversationReady.snapshot, state: "checking", entries: [] },
        },
      });
      const m = await mountSession();
      try {
        const views = () =>
          m.root.container.queryAll((n) => n.props.testID === "conversation-view");
        expect(views()).toHaveLength(1);
        const flat = m.root.container.queryAll((n) => n.type === "FlatList")[0]!;
        expect(flat.props.data).toEqual([]);
        expect(flat.props.ListEmptyComponent.props.children).toBe("Opening the conversation…");
        const layer = m.root.container.queryAll((n) => n.props.testID === "terminal-layer")[0]!;
        expect(layer.props.style).toMatchObject({ opacity: 0 });
        const checking = () =>
          act(async () => {
            store.getState().patch("f1", () => ({
              conversationView: {
                ...conversationReady,
                snapshot: { ...conversationReady.snapshot, state: "checking", entries: [] },
              } as never,
            }));
          });
        const ready = () =>
          act(async () => {
            store.getState().patch("f1", () => ({ conversationView: conversationReady as never }));
          });
        const wait = (ms: number) =>
          act(async () => {
            vi.advanceTimersByTime(ms);
          });
        await wait(5000);
        // Once the conversation is ready it simply fills in, past the first wait's deadline.
        await ready();
        await wait(5000);
        expect(views()).toHaveLength(1);
        // Checking again, say after a reconnect, gets a fresh wait.
        await checking();
        await wait(7000);
        expect(views()).toHaveLength(1);
        // A conversation that never resolves gives way to the terminal.
        await wait(1000);
        expect(views()).toHaveLength(0);
        // Choosing Conversation again waits once more.
        act(() => m.button("Session actions")?.props.onPress?.());
        act(() => m.button("Conversation")?.props.onPress?.());
        expect(views()).toHaveLength(1);
        await wait(8000);
        expect(views()).toHaveLength(0);
        // A conversation that opens late still shows, and its next check waits afresh.
        await ready();
        expect(views()).toHaveLength(1);
        await checking();
        expect(views()).toHaveLength(1);
      } finally {
        await m.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the terminal at once when the computer says the conversation is unavailable", async () => {
    await seedSession({
      hello: conversationHello,
      conversationView: {
        ...conversationReady,
        snapshot: { ...conversationReady.snapshot, state: "unavailable", reason: "unbound" },
      },
    });
    const m = await mountSession();
    try {
      expect(m.root.container.queryAll((n) => n.props.testID === "conversation-view")).toHaveLength(
        0,
      );
    } finally {
      await m.close();
    }
  });

  it("keeps the terminal and composer mounted beneath Conversation and gives it independent status", async () => {
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
    });
    const m = await mountSession();
    const { connectionManager } = await import("../src/net/manager");
    const lease = vi.mocked(connectionManager.claimView).mock.results[0]!.value;
    try {
      expect(m.screen()).toBeDefined();
      expect(m.screen()?.props.inputReady).toBe(false);
      const layer = m.root.container.queryAll((n) => n.props.testID === "terminal-layer")[0]!;
      expect(layer.props).toMatchObject({
        pointerEvents: "none",
        accessibilityElementsHidden: true,
        style: { opacity: 0 },
      });
      expect(m.root.container.queryAll((n) => n.type === "InputBar")).toHaveLength(1);
      expect(
        m.root.container.queryAll((n) => n.type === "InputBar")[0]?.props.terminalControls,
      ).toBeUndefined();
      expect(m.root.container.queryAll((n) => n.props.testID === "conversation-view")).toHaveLength(
        1,
      );
      const flat = m.root.container.queryAll((n) => n.type === "FlatList")[0]!;
      act(() => (flat.props.onEndReached as () => void)());
      expect(lease.requestOlderConversation).toHaveBeenCalledOnce();
      await act(async () => {
        store.getState().patch("f1", (c) => ({
          boundedView: {
            ...c.boundedView!,
            snapshot: {
              ...c.boundedView!.snapshot,
              output: { state: "paused", reason: "source" } as never,
            },
          },
        }));
      });
      expect(headerWords(m.root).join(" ")).toContain("Conversation");
      expect(headerWords(m.root).join(" ")).not.toContain("Paused");
      act(() => m.button("Session actions")?.props.onPress?.());
      act(() => m.button("Terminal")?.props.onPress?.());
      expect(lease.setConversation).toHaveBeenLastCalledWith(false);
      expect(m.root.container.queryAll((n) => n.props.testID === "conversation-view")).toHaveLength(
        0,
      );
      expect(m.screen()).toBeDefined();
      expect(m.root.container.queryAll((n) => n.type === "InputBar")).toHaveLength(1);
    } finally {
      await m.close();
    }
  });

  it("falls back to Terminal on opt-out without cancelling the clear acknowledgement owner", async () => {
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
    });
    const m = await mountSession();
    const { connectionManager } = await import("../src/net/manager");
    const lease = vi.mocked(connectionManager.claimView).mock.results[0]!.value;
    try {
      await act(async () => {
        store.getState().patch("f1", () => ({
          hello: { ...conversationHello, conversationEnabled: false } as never,
        }));
      });
      expect(m.root.container.queryAll((n) => n.props.testID === "conversation-view")).toHaveLength(
        0,
      );
      expect(
        m.root.container.queryAll((n) => n.props.testID === "terminal-layer")[0]?.props
          .pointerEvents,
      ).toBe("auto");
      expect(lease.setConversation).not.toHaveBeenCalledWith(false);
      expect(lease.release).not.toHaveBeenCalled();
    } finally {
      await m.close();
    }
  });
  it("names the project with a friendly status line and a quiet direct dot", async () => {
    await seedSession();
    const m = await mountSession();
    try {
      expect(headerWords(m.root)).toEqual(["webBooks", "Codex · idle"]);
      const title = headerTitleButton(m.root)!;
      expect(title.props.accessibilityRole).toBe("button");
      expect(title.props.accessibilityLabel).toBe("webBooks, Codex · idle, connection: Direct");
      const dot = title.queryAll((node) => node.props.testID === "connection-dot")[0]!;
      expect(dot.props.style).toMatchObject({ width: 8, height: 8, backgroundColor: "#10B981" });
      // The task stays in the list and the menu; the old "Read" text control is gone.
      expect(
        JSON.stringify(
          m.root.container.queryAll((n) => n.type === "NativeText").map((n) => n.children),
        ),
      ).not.toContain("Verify enrichments");
      expect(m.button("Switch to reading view")).toBeUndefined();
    } finally {
      await m.close();
    }
  });

  it("colours and names a route still connecting, and greys an offline computer", async () => {
    const { store } = await seedSession({
      status: "waiting-direct",
      transport: { ...directTransport, route: "relay", phase: "connecting" },
    });
    const m = await mountSession();
    const dot = () =>
      headerTitleButton(m.root)!.queryAll((node) => node.props.testID === "connection-dot")[0]!;
    try {
      expect(headerWords(m.root)).toEqual(["webBooks", "Codex · idle", "Connecting"]);
      expect(dot().props.style.backgroundColor).toBe("#F59E0B");
      await act(async () =>
        store.getState().patch("f1", () => ({ status: "offline", offlineReason: "computer" })),
      );
      expect(headerWords(m.root)).toEqual(["webBooks", "Codex · idle", "Offline"]);
      expect(dot().props.style.backgroundColor).toBe("#7C7C89");
      await act(async () => store.getState().patch("f1", () => ({ status: "error" })));
      expect(dot().props.style.backgroundColor).toBe("#F43F5E");
    } finally {
      await m.close();
    }
  });

  it("uses the state or terminal name for a plain shell", async () => {
    await seedSession({
      sessions: [{ id: "tmux:a", title: "zsh", backend: "tmux", state: "unknown" }],
    });
    const m = await mountSession();
    try {
      expect(headerWords(m.root)).toEqual(["zsh", "tmux"]);
    } finally {
      await m.close();
    }
  });

  it("opens the transport details from the title without a relay choice", async () => {
    await seedSession({
      status: "waiting-direct",
      transport: { ...directTransport, route: "relay", phase: "connecting" },
    });
    const m = await mountSession();
    const sheet = () =>
      m.root.container.queryAll(
        (n) => n.type === "Modal" && n.props.accessibilityLabel === "Connection details",
      )[0];
    try {
      expect(sheet()).toBeUndefined();
      await act(async () => headerTitleButton(m.root)!.props.onPress());
      const words = JSON.stringify(
        sheet()!
          .queryAll((n) => n.type === "NativeText")
          .map((n) => n.children),
      );
      expect(words).toContain("Connecting directly");
      expect(words).toContain("Establishing WebRTC. Terminal paused.");
      expect(words).not.toContain("relay temporarily");
      await act(async () => m.button("Close connection details")!.props.onPress());
      expect(sheet()).toBeUndefined();
    } finally {
      await m.close();
    }
  });

  it("keeps an actionable paused banner but drops the healthy connection strip", async () => {
    const { store } = await seedSession();
    const m = await mountSession();
    const strip = () =>
      m.root.container.queryAll(
        (n) =>
          n.type === "NativePressable" &&
          String(n.props.accessibilityLabel).startsWith("Connection:"),
      );
    try {
      expect(strip()).toHaveLength(0);
      await act(async () =>
        store.getState().patch("f1", () => ({
          status: "waiting-direct",
          transport: { ...directTransport, route: "relay", phase: "connecting" },
        })),
      );
      expect(strip()).toHaveLength(1);
      expect(strip()[0]!.props.accessibilityLabel).toBe("Connection: Connecting directly");
      expect(m.button("Use encrypted relay temporarily")).toBeUndefined();
      // Typing hides the banner; the header title still opens the same details.
      keyboardLayout.keyboardVisible = true;
      await m.render();
      expect(strip()).toHaveLength(0);
      keyboardLayout.keyboardVisible = false;
      await act(async () =>
        store.getState().patch("f1", () => ({ status: "online", transport: directTransport })),
      );
      expect(strip()).toHaveLength(0);
    } finally {
      keyboardLayout.keyboardVisible = false;
      await m.close();
    }
  });
});

describe("search and selection from the session menu", () => {
  const openMenuItem = async (m: Awaited<ReturnType<typeof mountSession>>, label: string) => {
    await act(async () => m.button("Session actions")!.props.onPress());
    await act(async () => m.button(label)!.props.onPress());
  };

  it("asks for snapshots while the terminal mouse is on, since clicks are checked against them", async () => {
    const { connectionManager } = await import("../src/net/manager");
    await seedSession({
      hello: {
        backends: [{ name: "tmux", capabilities: { terminalInput: true, mouseClick: true } }],
      } as never,
    });
    const m = await mountSession();
    const lease = vi.mocked(connectionManager.claimView).mock.results[0]!.value as {
      setRawStream: ReturnType<typeof vi.fn>;
    };
    try {
      expect(lease.setRawStream).toHaveBeenLastCalledWith(true);
      await act(async () => m.button("Session actions")!.props.onPress());
      await act(async () => m.button("Terminal mouse")!.props.onPress());
      expect(m.screen()!.props.mouseMode).toBe(true);
      expect(lease.setRawStream).toHaveBeenLastCalledWith(false);
      await act(async () => m.button("Session actions")!.props.onPress());
      await act(async () => m.button("Terminal mouse")!.props.onPress());
      expect(lease.setRawStream).toHaveBeenLastCalledWith(true);
    } finally {
      await m.close();
    }
  });

  it("opens terminal search from the menu", async () => {
    await seedSession();
    const m = await mountSession();
    try {
      expect(m.screen()!.props.searchOpen).toBe(false);
      await openMenuItem(m, "Search terminal history");
      expect(m.screen()!.props.searchOpen).toBe(true);
      await act(async () => m.screen()!.props.onSearchOpenChange(false));
      expect(m.screen()!.props.searchOpen).toBe(false);
      // Reading view cannot search xterm's buffer, so the menu does not offer it there.
      await openMenuItem(m, "Reading view");
      await act(async () => m.button("Session actions")!.props.onPress());
      expect(m.button("Search terminal history")).toBeUndefined();
    } finally {
      await m.close();
    }
  });

  it("replaces the header with Copy, Select all and Done while selecting", async () => {
    await seedSession();
    const m = await mountSession();
    const sent: object[] = [];
    const options = () =>
      m.root.container.queryAll((n) => n.type === "StackScreen")[0]!.props.options;
    try {
      m.screen()!.props.terminalControls.bind((command: object) => {
        sent.push(command);
        return true;
      });
      expect(m.button("Done selecting")).toBeUndefined();
      await openMenuItem(m, "Select text");
      expect(m.screen()!.props.selecting).toBe(true);
      expect(options().headerBackVisible).toBe(false);
      expect(m.button("Session actions")).toBeUndefined();
      expect(headerTitleButton(m.root)).toBeUndefined();
      const copy = m.button("Copy terminal selection")!;
      // Copy is never shown disabled: with nothing selected the terminal explains why.
      expect(copy.props.disabled).toBeFalsy();
      await act(async () => m.button("Select all loaded terminal text")!.props.onPress());
      await act(async () => m.button("Copy terminal selection")!.props.onPress());
      expect(sent).toEqual([{ type: "select-all" }, { type: "copy", format: "text" }]);
      // A completed copy ends selection like Android's action mode.
      await act(async () => m.screen()!.props.onCopied());
      expect(m.screen()!.props.selecting).toBe(false);
      expect(headerWords(m.root)).toEqual(["webBooks", "Codex · idle"]);
      // A long press inside the terminal enters the same mode; Done and Back leave it.
      await act(async () => m.screen()!.props.onSelectingChange(true));
      expect(m.button("Done selecting")).toBeDefined();
      await act(async () => m.button("Done selecting")!.props.onPress());
      expect(m.screen()!.props.selecting).toBe(false);
      await act(async () => m.screen()!.props.onSelectingChange(true));
      let handled = false;
      await act(async () => {
        handled = keyboardLayout.backHandlers.at(-1)!();
      });
      expect(handled).toBe(true);
      expect(m.screen()!.props.selecting).toBe(false);
      expect(keyboardLayout.backHandlers).toHaveLength(0);
    } finally {
      await m.close();
    }
  });

  it("highlights Copy once text is selected", async () => {
    await seedSession();
    const m = await mountSession();
    const copyColor = () =>
      m.button("Copy terminal selection")!.queryAll((n) => n.type === "NativeText")[0]!.props.style
        .color;
    try {
      await act(async () => m.screen()!.props.onSelectingChange(true));
      const idle = copyColor();
      expect(idle).toBe("#E8E8ED");
      await act(async () => m.screen()!.props.onSelectionChange(true));
      expect(copyColor()).toBe("#10B981");
    } finally {
      await m.close();
    }
  });

  it("takes a Reading snapshot instead of a contextual bar in Reading view", async () => {
    await seedSession();
    const m = await mountSession();
    try {
      await openMenuItem(m, "Reading view");
      await openMenuItem(m, "Select text");
      expect(m.screen()!.props.selecting).toBe(true);
      expect(m.button("Done selecting")).toBeUndefined();
      expect(headerTitleButton(m.root)).toBeDefined();
    } finally {
      await m.close();
    }
  });
});

describe("mounted focused session route", () => {
  it.each([true, false])(
    "acknowledges composed input through the native connection (host paste: %s)",
    async (terminalPaste) => {
      const { default: Session } = await import("../app/c/[fp]/s/[sid]");
      const { __FocusContext } = (await import("expo-router")) as unknown as {
        __FocusContext: import("react").Context<{
          focused: boolean;
          params: { fp: string; sid: string };
        }>;
      };
      const { connectionManager } = await import("../src/net/manager");
      const { useConnectionsStore } = await import("../src/store/connections");
      const lease = {
        revision: vi.fn(() => ({})),
        conversationRevision: vi.fn(() => ({})),
        setConversation: vi.fn(),
        requestOlderConversation: vi.fn(() => false),
        refreshConversation: vi.fn(() => false),
        release: vi.fn(),
        requestOlder: vi.fn(() => true),
        skipOversized: vi.fn(() => true),
        refreshHistory: vi.fn(() => true),
        retryOutput: vi.fn(() => true),
        protectHistory: vi.fn(() => true),
        setRawStream: vi.fn(),
        rendererError: vi.fn(),
        rendererReady: vi.fn(),
      };
      const connection = {
        status: "online",
        online: true,
        newReqId: vi.fn(() => "r1"),
        request: vi.fn(async (message: { reqId: string }) => ({
          type: "ack",
          reqId: message.reqId,
          ok: true,
        })),
      };
      vi.mocked(connectionManager.claimView).mockReset().mockReturnValue(lease);
      vi.mocked(connectionManager.get)
        .mockReset()
        .mockReturnValue(connection as never);
      useConnectionsStore.setState({ byComputer: {} });
      useConnectionsStore.getState().patch("other-computer", () => ({
        pendingInputs: { r1: { at: 1, sessionId: "tmux:other" } },
        toast: "Keep this computer's message",
      }));
      const otherComputer = useConnectionsStore.getState().read("other-computer");
      useConnectionsStore.getState().patch("f1", () => ({
        status: "online",
        pendingInputs: { other: { at: 1, sessionId: "tmux:other-session" } },
        agentOnline: true,
        sessions: [
          {
            id: "tmux:a",
            title: "Terminal",
            backend: "tmux",
            state: "running",
            alternateScreen: true,
            agent: { kind: "codex", task: "Fix tests" },
          },
        ] as never,
        hello: {
          backends: [{ name: "tmux", capabilities: { terminalInput: true, terminalPaste } }],
        } as never,
      }));
      const root = createRoot();
      try {
        await act(async () =>
          root.render(
            createElement(
              __FocusContext.Provider,
              { value: { focused: true, params: { fp: "f1", sid: sidToRoute("tmux:a") } } },
              createElement(Session),
            ),
          ),
        );
        const input = () => root.container.queryAll((node) => node.type === "InputBar")[0]!;
        // The host's full-screen report reaches the input bar, which picks Live keys from it.
        expect(input().props.alternateScreen).toBe(true);
        // So does the agent, which makes the bar an agent composer.
        expect(input().props.agent).toEqual({ kind: "codex", task: "Fix tests" });
        // Its state picks the waiting strip, which only a blocked session reads the screen for.
        expect(input().props.sessionState).toBe("running");
        expect(input().props.prompt).toBeUndefined();
        // No WebView/frame acknowledgement is required to safely submit a composed command.
        let accepted: unknown;
        await act(async () => {
          accepted = await input().props.onSubmitLine("first\n界\r\nsecond", "r1");
        });
        expect(accepted).toBe(true);
        expect(useConnectionsStore.getState().read("f1").pendingInputs).toEqual({
          other: { at: 1, sessionId: "tmux:other-session" },
          r1: { at: expect.any(Number), sessionId: "tmux:a" },
        });
        expect(connection.request).toHaveBeenCalledExactlyOnceWith(
          terminalPaste
            ? {
                type: "input.paste",
                reqId: "r1",
                sessionId: "tmux:a",
                text: "first\r界\rsecond",
                submit: true,
              }
            : {
                type: "input.terminal",
                reqId: "r1",
                sessionId: "tmux:a",
                data: "first\r界\rsecond\r",
              },
        );
        connection.request.mockResolvedValueOnce({ type: "ack", reqId: "r1", ok: false });
        await act(async () => {
          accepted = await input().props.onSubmitLine("rejected", "r1");
        });
        expect(accepted).toBe(false);
        const { DeliveryUnknownError } = await import("../src/net/connection");
        connection.request.mockRejectedValueOnce(new DeliveryUnknownError());
        await act(async () => {
          accepted = await input().props.onSubmitLine("unconfirmed", "retry-id");
        });
        expect(accepted).toBe("delivery-unknown");
        expect(useConnectionsStore.getState().read("f1").pendingInputs).toEqual({
          other: { at: 1, sessionId: "tmux:other-session" },
          r1: { at: expect.any(Number), sessionId: "tmux:a" },
        });
        const lostToast = useConnectionsStore.getState().read("f1").toast;
        expect(lostToast).toMatch(/delivered/i);
        await act(async () => {
          accepted = await input().props.onSubmitLine("unconfirmed", "retry-id");
        });
        expect(accepted).toBe(true);
        expect(connection.request.mock.calls.slice(-2).map(([message]) => message.reqId)).toEqual([
          "retry-id",
          "retry-id",
        ]);
        expect(connection.newReqId).not.toHaveBeenCalled();
        expect(useConnectionsStore.getState().read("f1").pendingInputs["retry-id"]).toEqual({
          at: expect.any(Number),
          sessionId: "tmux:a",
        });
        expect(useConnectionsStore.getState().read("f1").toast).toBe(lostToast);
        expect(useConnectionsStore.getState().read("other-computer")).toBe(otherComputer);
        connection.request.mockClear();
        await act(async () => {
          accepted = await input().props.onSubmitLine("界".repeat(20_000), "oversized");
        });
        expect(accepted).toBe(false);
        expect(connection.request).not.toHaveBeenCalled();
        // Keys and drafts completed with Tab go out as exact terminal bytes, not through xterm.
        expect(input().props.onTerminalInput("git ch\t")).toBe(true);
        expect(connection.request).toHaveBeenCalledExactlyOnceWith({
          type: "input.terminal",
          reqId: "r1",
          sessionId: "tmux:a",
          data: "git ch\t",
        });
        connection.request.mockClear();
        connection.online = false;
        await act(async () => {
          accepted = await input().props.onSubmitLine("keep this", "offline");
        });
        expect(accepted).toBe(false);
        expect(connection.request).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );

  it("switches reading locally without replacing input or lease and resets for another session", async () => {
    const { default: Session } = await import("../app/c/[fp]/s/[sid]");
    const { __FocusContext } = (await import("expo-router")) as unknown as {
      __FocusContext: import("react").Context<{
        focused: boolean;
        params: { fp: string; sid: string };
      }>;
    };
    const { connectionManager } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    const lease = {
      revision: () => ({}),
      conversationRevision: () => ({}),
      setConversation: vi.fn(),
      requestOlderConversation: vi.fn(),
      refreshConversation: vi.fn(),
      release: vi.fn(),
      setRawStream: vi.fn(),
    };
    vi.mocked(connectionManager.claimView)
      .mockReset()
      .mockReturnValue(lease as never);
    vi.mocked(connectionManager.get).mockReset();
    useConnectionsStore.setState({ byComputer: {} });
    const root = createRoot();
    const render = async (id: string) => {
      useConnectionsStore.getState().patch("f1", () => ({
        status: "online",
        agentOnline: true,
        transport: directTransport,
        sessions: [{ id, title: "Terminal", backend: "tmux", state: "running" }] as never,
        boundedView: {
          sessionId: id,
          snapshot: {
            status: "live",
            historyStatus: "ready",
            screen: {
              cols: 1,
              rows: 1,
              cursor: { x: 0, y: 0 },
              lines: [{ r: [{ t: "x" }] }],
              scrollbackTotal: 0,
              gen: 1,
            },
          },
        },
      }));
      await act(async () =>
        root.render(
          createElement(
            __FocusContext.Provider,
            { value: { focused: true, params: { fp: "f1", sid: sidToRoute(id) } } },
            createElement(Session),
          ),
        ),
      );
    };
    const button = (label: string) =>
      root.container.queryAll(
        (n) => n.type === "NativePressable" && n.props.accessibilityLabel === label,
      )[0]!;
    const screen = () => root.container.queryAll((n) => n.type === "ScreenView")[0]!;
    try {
      await render("tmux:a");
      const input = root.container.queryAll((n) => n.type === "InputBar")[0];
      expect(screen().props.readingMode).toBe(false);
      expect(button("Session actions")).toBeDefined();
      const headerTitle = () => headerWords(root);
      expect(headerTitle()).toEqual(["Terminal", "working"]);
      await act(async () =>
        useConnectionsStore.getState().patch("f1", (current) => ({
          sessions: current.sessions.map((s) => ({
            ...s,
            project: "shellbell",
            agent: { kind: "claude", task: "Relay security" },
          })),
        })),
      );
      // The project names the screen; the task stays in the list and menu, not the title bar.
      expect(headerTitle()).toEqual(["shellbell", "Claude · working"]);
      const connectionStrips = () =>
        root.container.queryAll(
          (node) =>
            node.type === "NativePressable" &&
            String(node.props.accessibilityLabel).startsWith("Connection:"),
        );
      // A live connection is the header dot, not a full-width strip.
      expect(connectionStrips()).toHaveLength(0);
      const terminal = screen();
      keyboardLayout.keyboardVisible = true;
      await render("tmux:a");
      expect(connectionStrips()).toHaveLength(0);
      expect(screen()).toBe(terminal);
      expect(screen().props.hideToolbar).toBe(true);
      keyboardLayout.keyboardVisible = false;
      await render("tmux:a");
      expect(screen().props.hideToolbar).toBe(false);
      const toggleReading = async () => {
        await act(async () => button("Session actions").props.onPress());
        await act(async () => button("Reading view").props.onPress());
      };
      await toggleReading();
      expect(screen().props.readingMode).toBe(true);
      // The rerenders above reseeded the plain session without its project.
      expect(headerTitle()).toEqual(["Terminal", "working · Reading"]);
      await act(async () => button("Session actions").props.onPress());
      expect(button("Reading view").props.accessibilityState).toMatchObject({ checked: true });
      await act(async () => button("Reading view").props.onPress());
      expect(screen().props.readingMode).toBe(false);
      expect(root.container.queryAll((n) => n.type === "InputBar")[0]).toBe(input);
      expect(connectionManager.claimView).toHaveBeenCalledTimes(1);
      expect(lease.release).not.toHaveBeenCalled();
      expect(connectionManager.get).not.toHaveBeenCalled();
      await toggleReading();
      const previousScreen = screen();
      await render("tmux:b");
      expect(screen()).not.toBe(previousScreen);
      expect(screen().props.readingMode).toBe(false);
      await render("tmux:a");
      expect(screen().props.readingMode).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("clears the keyboard using the window origin and preserves the focused input across geometry changes", async () => {
    const { default: Session } = await import("../app/c/[fp]/s/[sid]");
    const { __FocusContext } = (await import("expo-router")) as unknown as {
      __FocusContext: import("react").Context<{
        focused: boolean;
        params: { fp: string; sid: string };
      }>;
    };
    const { connectionManager } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    const lease = {
      revision: () => ({}),
      conversationRevision: () => ({}),
      setConversation: vi.fn(),
      requestOlderConversation: vi.fn(),
      refreshConversation: vi.fn(),
      release: vi.fn(),
      setRawStream: vi.fn(),
    };
    vi.mocked(connectionManager.claimView)
      .mockReset()
      .mockReturnValue(lease as never);
    useConnectionsStore.setState({ byComputer: {} });
    const root = createRoot();
    Object.assign(keyboardLayout, {
      windowHeight: 800,
      nativeY: 100,
      headerHeight: 100,
      nativeX: 0,
      keyboardHeight: 300,
      progress: 1,
      rejectMeasurement: false,
    });
    try {
      await act(async () =>
        root.render(
          createElement(
            __FocusContext.Provider,
            { value: { focused: true, params: { fp: "f1", sid: sidToRoute("tmux:a") } } },
            createElement(Session),
          ),
        ),
      );
      const avoiding = root.container.queryAll(
        (node) => typeof node.props.onLayout === "function",
      )[0]!;
      const input = root.container.queryAll((node) => node.type === "InputBar")[0];
      const content = root.container.queryAll(
        (node) => node.type === "NativeView" && node.props.style?.backgroundColor !== undefined,
      )[0]!;
      expect(content.props.style).toMatchObject({ paddingLeft: 24, paddingRight: 18 });
      expect(content.props.style.paddingTop).toBeUndefined();
      expect(content.props.style.paddingBottom).toBeUndefined();
      expect(content.props.onLayout).toBeTypeOf("function");
      await act(async () => content.props.onLayout({ nativeEvent: { layout: { height: 92 } } }));
      expect(input?.props.availableHeight).toBe(92);
      for (const height of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        await act(async () => content.props.onLayout({ nativeEvent: { layout: { height } } }));
        expect(input?.props.availableHeight).toBe(92);
      }
      await act(async () => content.props.onLayout({ nativeEvent: { layout: { height: 400 } } }));
      expect(input?.props.availableHeight).toBe(400);
      const layout = async (height: number) => {
        // A real orientation change rerenders the screen with navigation's
        // updated header measurement before its layout event is consumed.
        await act(async () => content.props.onLayout({ nativeEvent: { layout: { height } } }));
        await act(async () => {
          await avoiding.props.onLayout({
            nativeEvent: { layout: { x: 0, y: 0, width: 400, height } },
          });
        });
        const style = avoiding.props.style as [{ flex: number }, { paddingBottom: number }];
        return style[1].paddingBottom;
      };
      expect(await layout(700)).toBe(300);
      // Fold7 device trace: Fabric reports a zero native frame during mount.
      // The navigation header is nevertheless present and must clear the IME.
      keyboardLayout.nativeY = 0;
      expect(await layout(700)).toBe(300);
      keyboardLayout.nativeY = 60;
      keyboardLayout.headerHeight = 60;
      expect(await layout(740)).toBe(300);
      keyboardLayout.progress = 0;
      expect(await layout(740)).toBe(0);
      keyboardLayout.progress = 1;
      keyboardLayout.keyboardHeight = 250;
      expect(await layout(740)).toBe(250);
      expect(root.container.queryAll((node) => node.type === "InputBar")[0]).toBe(input);
      expect(connectionManager.claimView).toHaveBeenCalledTimes(1);
      expect(lease.release).not.toHaveBeenCalled();
      // Navigation's measured header clears the keyboard even when the native
      // window-position lookup is unavailable.
      keyboardLayout.rejectMeasurement = true;
      expect(await layout(740)).toBe(250);
    } finally {
      await act(async () => root.unmount());
      keyboardLayout.rejectMeasurement = false;
    }
    expect(lease.release).toHaveBeenCalledTimes(1);
  });

  it("opens in the agent's default view once its kind is known, and keeps it", async () => {
    const { default: Session } = await import("../app/c/[fp]/s/[sid]");
    const { __FocusContext } = (await import("expo-router")) as unknown as {
      __FocusContext: import("react").Context<{
        focused: boolean;
        params: { fp: string; sid: string };
      }>;
    };
    const { connectionManager } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    const leases = Array.from({ length: 3 }, () => ({
      revision: vi.fn(() => ({})),
      conversationRevision: vi.fn(() => ({})),
      setConversation: vi.fn(),
      requestOlderConversation: vi.fn(() => false),
      refreshConversation: vi.fn(() => false),
      release: vi.fn(),
      requestOlder: vi.fn(() => true),
      skipOversized: vi.fn(() => true),
      refreshHistory: vi.fn(() => true),
      retryOutput: vi.fn(() => true),
      protectHistory: vi.fn(() => true),
      setRawStream: vi.fn(),
      rendererError: vi.fn(),
      rendererReady: vi.fn(),
    }));
    vi.mocked(connectionManager.claimView).mockImplementation(() => {
      const next = leases.shift();
      if (!next) throw new Error("too many focus claims");
      return next;
    });
    const firstLease = leases[0]!;
    const secondLease = leases[1]!;
    const thirdLease = leases[2]!;
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("f1", () => ({
      status: "online",
      agentOnline: true,
      sessions: [
        // A Claude session opens in Conversation; a plain shell opens in Terminal.
        { id: "tmux:a", title: "A", backend: "tmux", state: "running" },
        { id: "tmux:b", title: "B", backend: "tmux", state: "running" },
      ] as never,
      boundedView: {
        sessionId: "tmux:a",
        snapshot: {
          status: "live",
          historyStatus: "ready",
          screen: {
            cols: 1,
            rows: 1,
            cursor: { x: 0, y: 0 },
            lines: [{ r: [{ t: "x" }] }],
            scrollbackTotal: 0,
            gen: 1,
          },
        },
      },
    }));
    const root = createRoot();
    const sessions = (agent?: { kind: string }) =>
      useConnectionsStore.getState().patch("f1", (current) => ({
        ...current,
        sessions: [
          { id: "tmux:a", title: "A", backend: "tmux", state: "running", ...(agent && { agent }) },
        ] as never,
      }));
    await act(async () => {
      root.render(
        createElement(
          __FocusContext.Provider,
          { value: { focused: true, params: { fp: "f1", sid: sidToRoute("tmux:a") } } },
          createElement(Session),
        ),
      );
    });
    // No agent yet: Terminal.
    expect(firstLease.setConversation).toHaveBeenLastCalledWith(false);
    await act(async () => sessions({ kind: "claude" }));
    expect(firstLease.setConversation).toHaveBeenLastCalledWith(true);
    // The agent quits, or the computer stops naming it: the view the owner sees stays.
    await act(async () => sessions());
    expect(firstLease.setConversation).toHaveBeenLastCalledWith(true);
    // Leaving for another session and coming back starts afresh: no agent now, so Terminal.
    const show = async (sid: string) =>
      act(async () => {
        root.render(
          createElement(
            __FocusContext.Provider,
            { value: { focused: true, params: { fp: "f1", sid: sidToRoute(sid) } } },
            createElement(Session),
          ),
        );
      });
    await show("tmux:b");
    await show("tmux:a");
    expect(connectionManager.claimView).toHaveBeenLastCalledWith("f1", "tmux:a", {
      conversation: false,
    });
    expect(thirdLease.setConversation).not.toHaveBeenCalledWith(true);
    await act(async () => {
      root.unmount();
    });
    void secondLease;
  });

  it("claims on focus, wires actions, and releases only its own lease on blur and parameter change", async () => {
    const { default: Session } = await import("../app/c/[fp]/s/[sid]");
    const { __FocusContext } = (await import("expo-router")) as unknown as {
      __FocusContext: import("react").Context<{
        focused: boolean;
        params: { fp: string; sid: string };
      }>;
    };
    const { connectionManager } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    const leases = Array.from({ length: 3 }, () => ({
      revision: vi.fn(() => ({})),
      conversationRevision: vi.fn(() => ({})),
      setConversation: vi.fn(),
      requestOlderConversation: vi.fn(() => false),
      refreshConversation: vi.fn(() => false),
      release: vi.fn(),
      requestOlder: vi.fn(() => true),
      skipOversized: vi.fn(() => true),
      refreshHistory: vi.fn(() => true),
      retryOutput: vi.fn(() => true),
      protectHistory: vi.fn(() => true),
      setRawStream: vi.fn(),
      rendererError: vi.fn(),
      rendererReady: vi.fn(),
    }));
    vi.mocked(connectionManager.claimView).mockImplementation(() => {
      const next = leases.shift();
      if (!next) throw new Error("too many focus claims");
      return next;
    });
    const firstLease = leases[0]!;
    const secondLease = leases[1]!;
    const thirdLease = leases[2]!;
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("f1", () => ({
      status: "online",
      agentOnline: true,
      sessions: [
        // A Claude session opens in Conversation; a plain shell opens in Terminal.
        { id: "tmux:a", title: "A", backend: "tmux", state: "running", agent: { kind: "claude" } },
        { id: "tmux:b", title: "B", backend: "tmux", state: "running" },
      ] as never,
      boundedView: {
        sessionId: "tmux:a",
        snapshot: {
          status: "live",
          historyStatus: "ready",
          screen: {
            cols: 1,
            rows: 1,
            cursor: { x: 0, y: 0 },
            lines: [{ r: [{ t: "x" }] }],
            scrollbackTotal: 0,
            gen: 1,
          },
        },
      },
    }));
    const root = createRoot();
    const render = async (focused: boolean, sessionId = "tmux:a") => {
      await act(async () => {
        root.render(
          createElement(
            __FocusContext.Provider,
            {
              value: { focused, params: { fp: "f1", sid: sidToRoute(sessionId) } },
            },
            createElement(Session),
          ),
        );
      });
    };
    await render(true);
    expect(connectionManager.claimView).toHaveBeenCalledWith("f1", "tmux:a", {
      conversation: true,
    });
    const view = root.container.queryAll((node) => node.type === "ScreenView")[0];
    expect(view).toBeDefined();
    await act(async () => {
      view?.props.onLoadOlder();
      view?.props.onSkipOversized();
      view?.props.onRefreshHistory();
      view?.props.onRetryOutput();
      view?.props.onProtectHistory("h:1");
    });
    expect(firstLease.requestOlder).toHaveBeenCalledTimes(1);
    const renderedRevision = firstLease.revision.mock.results[0]?.value;
    expect(firstLease.skipOversized).toHaveBeenCalledWith(renderedRevision);
    expect(firstLease.refreshHistory).toHaveBeenCalledWith(renderedRevision);
    expect(firstLease.retryOutput).toHaveBeenCalledWith(renderedRevision);
    expect(firstLease.protectHistory).toHaveBeenCalledWith("h:1", renderedRevision);
    const completeScreen = useConnectionsStore.getState().read("f1").boundedView?.snapshot.screen;
    await act(async () => {
      useConnectionsStore.getState().patch("f1", () => ({
        boundedView: {
          sessionId: "tmux:a",
          snapshot: { status: "loading", historyStatus: "waiting" },
          fallbackScreen: completeScreen,
        },
      }));
    });
    expect(
      root.container.queryAll((node) => node.type === "ScreenView")[0]?.props.fallbackScreen,
    ).toBe(completeScreen);
    keyboardLayout.dismiss.mockClear();
    await render(false);
    expect(firstLease.release).toHaveBeenCalledTimes(1);
    // Leaving the session must not leave its keyboard, or a stale "open" state, behind.
    expect(keyboardLayout.dismiss).toHaveBeenCalledTimes(1);
    await render(true);
    expect(connectionManager.claimView).toHaveBeenCalledTimes(2);
    expect(keyboardLayout.dismiss).toHaveBeenCalledTimes(1);
    await render(true, "tmux:b");
    expect(secondLease.release).toHaveBeenCalledTimes(1);
    // tmux:b runs no agent, so it opens in Terminal and asks for no conversation.
    expect(connectionManager.claimView).toHaveBeenLastCalledWith("f1", "tmux:b", {
      conversation: false,
    });
    await act(async () => {
      root.unmount();
    });
    expect(thirdLease.release).toHaveBeenCalledTimes(1);
  });
});
