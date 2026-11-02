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
const haptics = vi.hoisted(() => ({ impactAsync: vi.fn(async () => {}) }));
vi.mock("expo-haptics", () => ({
  impactAsync: haptics.impactAsync,
  ImpactFeedbackStyle: { Light: "light" },
}));
const savedModes = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-sqlite/kv-store", () => ({
  default: {
    getItemSync: (key: string) => savedModes.get(key) ?? null,
    setItemSync: (key: string, value: string) => void savedModes.set(key, value),
  },
}));
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
const conversationRenders = vi.hoisted(() => ({
  count: 0,
  last: null as { liveTail?: readonly string[] | null } | null,
}));
vi.mock("../src/conversation/ConversationView", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/conversation/ConversationView")>();
  return {
    ...actual,
    // Counts every render the screen asks of the conversation, then renders the real one.
    ConversationView: (props: Parameters<typeof actual.ConversationView>[0]) => {
      conversationRenders.count++;
      conversationRenders.last = props;
      return createElement(actual.ConversationView, props);
    },
  };
});
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

  const chatOpening = (root: Root) =>
    root.container.queryAll((n) => n.props.testID === "chat-opening");
  const conversationViews = (root: Root) =>
    root.container.queryAll((n) => n.props.testID === "conversation-view");
  const unavailableBanner = (root: Root) =>
    root.container.queryAll((n) => n.props.testID === "chat-unavailable");
  const texts = (root: Root) =>
    root.container
      .queryAll((n) => n.type === "NativeText")
      .map((n) => n.children.filter((child) => typeof child === "string").join(""));

  it("opens a Codex session straight into Chat and never gives way to the terminal on a timer", async () => {
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
        expect(chatOpening(m.root)).toHaveLength(1);
        expect(texts(m.root)).toContain("Opening Codex’s chat…");
        const layer = () =>
          m.root.container.queryAll((n) => n.props.testID === "terminal-layer")[0]!;
        expect(layer().props.style).toMatchObject({ opacity: 0 });
        const patch = (snapshot: object) =>
          act(async () => {
            store.getState().patch("f1", () => ({
              conversationView: {
                ...conversationReady,
                snapshot: { ...conversationReady.snapshot, ...snapshot },
              } as never,
            }));
          });
        const wait = (ms: number) =>
          act(async () => {
            vi.advanceTimersByTime(ms);
          });
        // However long the computer takes, Chat keeps opening.
        await wait(60_000);
        expect(chatOpening(m.root)).toHaveLength(1);
        expect(layer().props.style).toMatchObject({ opacity: 0 });
        await patch({ state: "ready" });
        expect(conversationViews(m.root)).toHaveLength(1);
        expect(chatOpening(m.root)).toHaveLength(0);
        // Checking again, say after a reconnect, keeps the rows it still has.
        await patch({ state: "checking" });
        expect(conversationViews(m.root)).toHaveLength(1);
        // A new generation clears the rows: the old ones stay, dimmed, while it opens.
        const dimmed = () => m.root.container.queryAll((n) => n.props.testID === "chat-dimmed");
        await patch({ state: "checking", entries: [] });
        await wait(60_000);
        expect(dimmed()).toHaveLength(1);
        expect(texts(m.root)).toContain("Checking…");
        expect(chatOpening(m.root)).toHaveLength(0);
        // Only the owner's pick switches to the terminal, and back.
        act(() => m.button("Session actions")?.props.onPress?.());
        act(() => m.button("Terminal")?.props.onPress?.());
        expect(dimmed()).toHaveLength(0);
        expect(layer().props.style).toMatchObject({ opacity: 1 });
        act(() => m.button("Session actions")?.props.onPress?.());
        act(() => m.button("Chat")?.props.onPress?.());
        expect(dimmed()).toHaveLength(1);
        // The first page swaps in for the dimmed rows in one render.
        await patch({ state: "ready" });
        expect(dimmed()).toHaveLength(0);
        expect(conversationViews(m.root)).toHaveLength(1);
      } finally {
        await m.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays in Chat with a banner when the conversation is unavailable", async () => {
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: {
        ...conversationReady,
        snapshot: {
          ...conversationReady.snapshot,
          state: "unavailable",
          reason: "source",
          entries: [],
        },
      },
    });
    const m = await mountSession();
    try {
      expect(unavailableBanner(m.root)).toHaveLength(1);
      expect(texts(m.root)).toContain("Chat isn’t available right now.");
      // No rows to keep: the banner sits over an empty chat.
      expect(conversationViews(m.root)).toHaveLength(0);
      await act(async () => m.button("Show terminal")!.props.onPress());
      expect(unavailableBanner(m.root)).toHaveLength(0);
      expect(
        m.root.container.queryAll((n) => n.props.testID === "terminal-layer")[0]?.props
          .pointerEvents,
      ).toBe("auto");
      // The owner's pick holds when the conversation comes back.
      await act(async () => {
        store.getState().patch("f1", () => ({ conversationView: conversationReady as never }));
      });
      expect(conversationViews(m.root)).toHaveLength(0);
    } finally {
      await m.close();
    }
  });

  it("keeps the last rows under the banner when a shown conversation becomes unavailable", async () => {
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
    });
    const m = await mountSession();
    try {
      expect(conversationViews(m.root)).toHaveLength(1);
      await act(async () => {
        store.getState().patch("f1", () => ({
          conversationView: {
            ...conversationReady,
            snapshot: {
              ...conversationReady.snapshot,
              state: "unavailable",
              reason: "source",
              entries: [],
            },
          } as never,
        }));
      });
      expect(unavailableBanner(m.root)).toHaveLength(1);
      expect(conversationViews(m.root)).toHaveLength(1);
      const flat = m.root.container.queryAll((n) => n.type === "FlatList")[0]!;
      expect(flat.props.data).toHaveLength(1);
      expect(
        m.root.container.queryAll((n) => n.props.testID === "terminal-layer")[0]?.props.style,
      ).toMatchObject({ opacity: 0 });
    } finally {
      await m.close();
    }
  });

  it("remembers the pick for a session with a terminal instance, and not without one", async () => {
    const { useChosenModes } = await import("../src/store/chosen-modes");
    const sessions = (instance?: string) => [
      {
        id: "tmux:a",
        title: "codex",
        agent: { kind: "codex" },
        backend: "tmux",
        state: "finished",
        ...(instance && { instance }),
      },
    ];
    for (const instance of ["term-1", undefined]) {
      useChosenModes.setState({ entries: {}, hydrated: true });
      await seedSession({
        hello: conversationHello,
        conversationView: conversationReady,
        sessions: sessions(instance),
      });
      const first = await mountSession();
      act(() => first.button("Session actions")?.props.onPress?.());
      act(() => first.button("Terminal")?.props.onPress?.());
      expect(conversationViews(first.root)).toHaveLength(0);
      await first.close();
      const again = await mountSession();
      try {
        expect(conversationViews(again.root)).toHaveLength(instance ? 0 : 1);
      } finally {
        await again.close();
      }
    }
  });

  it("switches Chat and Terminal in one tap from the header, for agent sessions only", async () => {
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
    });
    const m = await mountSession();
    try {
      expect(conversationViews(m.root)).toHaveLength(1);
      await act(async () => m.button("Show terminal")!.props.onPress());
      expect(conversationViews(m.root)).toHaveLength(0);
      expect(m.button("Show terminal")).toBeUndefined();
      await act(async () => m.button("Show chat")!.props.onPress());
      expect(conversationViews(m.root)).toHaveLength(1);
      // Reading view shows the terminal; the switch brings Chat back and leaves Reading.
      act(() => m.button("Session actions")?.props.onPress?.());
      act(() => m.button("Reading view")?.props.onPress?.());
      expect(m.screen()!.props.readingMode).toBe(true);
      await act(async () => m.button("Show chat")!.props.onPress());
      expect(m.screen()!.props.readingMode).toBe(false);
      expect(conversationViews(m.root)).toHaveLength(1);
      // Hidden without chat on the computer, or for a plain shell.
      await act(async () => {
        store.getState().patch("f1", () => ({
          hello: { ...conversationHello, conversationEnabled: false } as never,
        }));
      });
      expect(m.button("Show terminal")).toBeUndefined();
      expect(m.button("Show chat")).toBeUndefined();
    } finally {
      await m.close();
    }
    await seedSession({
      hello: conversationHello,
      sessions: [{ id: "tmux:a", title: "zsh", backend: "tmux", state: "unknown" }],
    });
    const shell = await mountSession();
    try {
      expect(shell.button("Show chat")).toBeUndefined();
      expect(shell.button("Session actions")).toBeDefined();
    } finally {
      await shell.close();
    }
  });

  describe("delivery receipt", () => {
    const receiptText = (root: Root) => {
      const node = root.container.queryAll((n) => n.props.testID === "send-receipt")[0];
      return node
        ? node
            .queryAll((n) => n.type === "NativeText")
            .flatMap((text) => text.children.filter((child) => typeof child === "string"))
            .join(" ")
        : null;
    };
    async function chatWithConnection() {
      const acks: ((ack: unknown) => void)[] = [];
      const connection = {
        status: "online",
        online: true,
        newReqId: vi.fn(() => "r1"),
        request: vi.fn(
          () =>
            new Promise((resolve) => {
              acks.push(resolve);
            }),
        ),
      };
      const { store } = await seedSession({
        hello: conversationHello,
        conversationView: conversationReady,
      });
      const { connectionManager } = await import("../src/net/manager");
      vi.mocked(connectionManager.get).mockReturnValue(connection as never);
      const m = await mountSession();
      const input = () => m.root.container.queryAll((n) => n.type === "InputBar")[0]!;
      const send = (reqId: string) => {
        let result: Promise<unknown> = Promise.resolve();
        act(() => {
          result = input().props.onSubmitLine("hello", reqId);
        });
        return result;
      };
      return { m, store, acks, connection, input, send };
    }

    it("shows Sending, then Sent with a check that fades after 5 seconds", async () => {
      vi.useFakeTimers();
      const { m, acks, input, send } = await chatWithConnection();
      try {
        expect(input().props.receipts).toBe(true);
        const result = send("r1");
        expect(receiptText(m.root)).toBe("Sending…");
        await act(async () => acks[0]!({ type: "ack", reqId: "r1", ok: true }));
        await expect(result).resolves.toBe(true);
        expect(receiptText(m.root)).toBe("Sent to Codex ✓");
        await act(async () => vi.advanceTimersByTime(4_999));
        expect(receiptText(m.root)).toBe("Sent to Codex ✓");
        await act(async () => vi.advanceTimersByTime(1));
        expect(receiptText(m.root)).toBeNull();
      } finally {
        await m.close();
        vi.useRealTimers();
      }
    });

    it("says why the computer refused, keeps it until tapped, and lets the next send replace it", async () => {
      const { m, acks, send } = await chatWithConnection();
      try {
        const first = send("r1");
        await act(async () =>
          acks[0]!({ type: "ack", reqId: "r1", ok: false, error: "conversation-changed" }),
        );
        await expect(first).resolves.toBe(false);
        expect(receiptText(m.root)).toBe(
          "Codex’s conversation changed. Check it before sending again.",
        );
        void send("r2");
        expect(receiptText(m.root)).toBe("Sending…");
        await act(async () =>
          acks[1]!({ type: "ack", reqId: "r2", ok: false, error: "waiting-for-you" }),
        );
        expect(receiptText(m.root)).toBe("Codex is waiting for you. Answer in the terminal.");
        await act(async () =>
          m.root.container.queryAll((n) => n.props.testID === "send-receipt")[0]!.props.onPress(),
        );
        expect(receiptText(m.root)).toBeNull();
      } finally {
        await m.close();
      }
    });

    it("turns unknown after 10 seconds, without a second request, and a late ack still lands", async () => {
      vi.useFakeTimers();
      const { m, acks, connection, send } = await chatWithConnection();
      try {
        const result = send("r1");
        await act(async () => vi.advanceTimersByTime(10_000));
        await expect(result).resolves.toBe("delivery-unknown");
        expect(receiptText(m.root)).toBe(
          "Not sure this reached Codex. Check the chat before sending again.",
        );
        // It stays until resolved: no fade for an unknown outcome.
        await act(async () => vi.advanceTimersByTime(60_000));
        expect(receiptText(m.root)).toContain("Not sure");
        expect(connection.request).toHaveBeenCalledOnce();
        await act(async () => acks[0]!({ type: "ack", reqId: "r1", ok: true }));
        expect(receiptText(m.root)).toBe("Sent to Codex ✓");
      } finally {
        await m.close();
        vi.useRealTimers();
      }
    });

    it("says why a send couldn't start in Chat, and toasts a refusal in Terminal", async () => {
      const { m, store, acks, connection, send } = await chatWithConnection();
      try {
        connection.online = false;
        await act(async () => {
          await send("r1");
        });
        expect(receiptText(m.root)).toBe(
          "Not sent: your computer isn’t connected. Your draft is still here.",
        );
        await act(async () => m.button("Show terminal")!.props.onPress());
        connection.online = true;
        const result = send("r2");
        expect(receiptText(m.root)).toBeNull();
        await act(async () => acks[0]!({ type: "ack", reqId: "r2", ok: false, error: "busy" }));
        await expect(result).resolves.toBe(false);
        expect(store.getState().read("f1").toast).toBe(
          "Your computer is still busy with earlier input. Try again in a moment.",
        );
      } finally {
        await m.close();
      }
    });
  });

  describe("waiting for you", () => {
    const card = (root: Root) =>
      root.container.queryAll((n) => n.props.testID === "waiting-card")[0];
    const input = (root: Root) => root.container.queryAll((n) => n.type === "InputBar")[0]!;

    it("pins a card and holds the composer while a blocked agent waits", async () => {
      const connection = {
        status: "online",
        online: true,
        newReqId: vi.fn(() => "k1"),
        request: vi.fn(async (message: { reqId: string }) => ({
          type: "ack",
          reqId: message.reqId,
          ok: true,
        })),
      };
      const { store } = await seedSession({
        hello: conversationHello,
        conversationView: conversationReady,
      });
      const { connectionManager } = await import("../src/net/manager");
      vi.mocked(connectionManager.get).mockReturnValue(connection as never);
      const m = await mountSession();
      const setState = (state: string) =>
        act(async () => {
          store.getState().patch("f1", (c) => ({
            sessions: c.sessions.map((s) => ({ ...s, state })) as never,
          }));
        });
      try {
        expect(card(m.root)).toBeUndefined();
        expect(input(m.root).props.holdReason).toBeNull();
        await setState("blocked");
        expect(card(m.root)).toBeDefined();
        expect(texts(m.root)).toContain("Codex is waiting for you");
        expect(input(m.root).props.holdReason).toBe("Answer in the terminal");
        await act(async () => m.button("Press Esc")!.props.onPress());
        expect(connection.request).toHaveBeenCalledWith({
          type: "input.key",
          reqId: "k1",
          sessionId: "tmux:a",
          key: "esc",
        });
        // An unknown state never blocks.
        await setState("unknown");
        expect(card(m.root)).toBeUndefined();
        expect(input(m.root).props.holdReason).toBeNull();
        await setState("blocked");
        // The card's Show terminal picks Terminal, where the composer is free again.
        const showTerminal = card(m.root)!.queryAll(
          (n) => n.type === "NativePressable" && n.props.accessibilityLabel === "Show terminal",
        )[0]!;
        await act(async () => showTerminal.props.onPress());
        expect(card(m.root)).toBeUndefined();
        expect(input(m.root).props.holdReason).toBeNull();
        expect(conversationViews(m.root)).toHaveLength(0);
      } finally {
        await m.close();
      }
    });

    it("shows the question when the screen proves it", async () => {
      await seedSession({
        hello: conversationHello,
        conversationView: conversationReady,
        boundedView: {
          sessionId: "tmux:a",
          snapshot: {
            status: "live",
            historyStatus: "ready",
            screen: {
              cols: 40,
              rows: 4,
              cursor: { x: 0, y: 3 },
              lines: [
                { r: [{ t: "Do you want to proceed?" }] },
                { r: [{ t: "❯ 1. Yes" }] },
                { r: [{ t: "  2. No" }] },
                { r: [] },
              ],
              scrollbackTotal: 0,
              gen: 1,
            },
          },
        },
      });
      const m = await mountSession();
      try {
        expect(card(m.root)).toBeDefined();
        expect(texts(m.root)).toContain("Do you want to proceed?");
      } finally {
        await m.close();
      }
    });
  });

  it("shows the agent working above the composer, ticking, and only with fresh evidence", async () => {
    vi.useFakeTimers();
    const screenOf = (rows: string[]) => ({
      sessionId: "tmux:a",
      snapshot: {
        status: "live",
        historyStatus: "ready",
        screen: {
          cols: 40,
          rows: rows.length,
          cursor: { x: 0, y: rows.length - 1 },
          lines: rows.map((t) => ({ r: t ? [{ t }] : [] })),
          scrollbackTotal: 0,
          gen: 1,
        },
      },
    });
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
      boundedView: screenOf(["• Ran cargo fmt", ""]),
    });
    const m = await mountSession();
    const bar = () => m.root.container.queryAll((n) => n.props.testID === "activity-bar")[0];
    const show = (rows: string[]) =>
      act(async () => {
        store.getState().patch("f1", () => ({ boundedView: screenOf(rows) as never }));
      });
    try {
      // What was on screen at open isn't evidence of work now.
      expect(bar()).toBeUndefined();
      await show(["• Ran cargo fmt", "• Working (8s • esc to interrupt)", ""]);
      expect(bar()?.props.accessibilityLabel).toBe("Working · 8s");
      await act(async () => vi.advanceTimersByTime(3000));
      expect(bar()?.props.accessibilityLabel).toBe("Working · 11s");
      // Nothing changed for more than 5 s: the bar never claims work without evidence.
      await act(async () => vi.advanceTimersByTime(3000));
      expect(bar()).toBeUndefined();
      // A password prompt hides everything read from the screen.
      await show(["• Working (20s • esc to interrupt)", "Password:"]);
      expect(bar()).toBeUndefined();
    } finally {
      await m.close();
      vi.useRealTimers();
    }
  });

  describe("the computer's chat status", () => {
    const sessionWith = (
      chat: object | undefined,
      agent: object | undefined = { kind: "codex" },
    ) => ({
      id: "tmux:a",
      title: "codex",
      backend: "tmux",
      state: "running",
      ...(agent && { agent }),
      ...(chat && { chat }),
    });
    const input = (root: Root) => root.container.queryAll((n) => n.type === "InputBar")[0]!;
    /** The stream's own rows, named with the chat they belong to (chat-v2 status `chat`). */
    const streamOf = (chat: string) => ({
      ...conversationReady,
      snapshot: { ...conversationReady.snapshot, chat },
    });
    async function mountWith(
      chat: { state: string; id?: string; agent?: string; reason?: string } | undefined,
      conversationView: object = chat?.id ? streamOf(chat.id) : conversationReady,
    ) {
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
      const { store } = await seedSession({
        hello: conversationHello,
        conversationView,
        sessions: [sessionWith(chat)],
      });
      const { connectionManager } = await import("../src/net/manager");
      vi.mocked(connectionManager.get).mockReturnValue(connection as never);
      const m = await mountSession();
      const update = (patch: object) =>
        act(async () => {
          store.getState().patch("f1", () => patch as never);
        });
      return { m, store, connection, update };
    }

    it("names the chat on screen in everything sent from Chat, and nothing in Terminal", async () => {
      const { m, connection } = await mountWith({ state: "found", id: "c1", agent: "codex" });
      try {
        expect(input(m.root).props.expectChat).toBe("c1");
        // Unchecked paths (Tab completion, Live keys) are off in Chat.
        expect(input(m.root).props.chatInput).toBe(true);
        await act(async () => {
          await input(m.root).props.onSubmitLine("hello", "r1");
        });
        expect(connection.request).toHaveBeenLastCalledWith(
          expect.objectContaining({ type: "input.terminal", expect: { chat: "c1" } }),
        );
        await act(async () => m.button("Show terminal")!.props.onPress());
        expect(input(m.root).props.expectChat).toBeUndefined();
        expect(input(m.root).props.chatInput).toBe(false);
        await act(async () => {
          await input(m.root).props.onSubmitLine("ls", "r2");
        });
        expect(connection.request.mock.lastCall![0]).not.toHaveProperty("expect");
      } finally {
        await m.close();
      }
    });

    it("never sends with a chat id the rows on screen don't belong to", async () => {
      const { m, connection, update } = await mountWith({
        state: "found",
        id: "c1",
        agent: "codex",
      });
      const dimmed = () => m.root.container.queryAll((n) => n.props.testID === "chat-dimmed");
      try {
        expect(input(m.root).props.expectChat).toBe("c1");
        // The session list names the new conversation before the stream's clear arrives: the
        // rows on screen are still c1's.
        await update({ sessions: [sessionWith({ state: "found", id: "c2", agent: "codex" })] });
        expect(input(m.root).props.expectChat).toBeUndefined();
        expect(input(m.root).props.holdReason).toBe("Opening Codex’s chat…");
        expect(dimmed()).toHaveLength(1);
        expect(texts(m.root)).toContain("Checking…");
        let sent: unknown;
        await act(async () => {
          sent = await input(m.root).props.onSubmitLine("hello", "r1");
        });
        expect(sent).toBe(false);
        expect(connection.request).not.toHaveBeenCalled();
        // The stream's clear and first page for c2 arrive: its rows and its id, together.
        await update({
          conversationView: {
            ...streamOf("c2"),
            subscriptionId: "subscription-2",
          },
        });
        expect(dimmed()).toHaveLength(0);
        expect(input(m.root).props.expectChat).toBe("c2");
        await act(async () => {
          await input(m.root).props.onSubmitLine("hello", "r2");
        });
        expect(connection.request).toHaveBeenLastCalledWith(
          expect.objectContaining({ expect: { chat: "c2" } }),
        );
      } finally {
        await m.close();
      }
    });

    it("holds the composer while the chat is still being found", async () => {
      const { m, connection } = await mountWith(
        { state: "finding", agent: "codex" },
        {
          ...conversationReady,
          snapshot: { ...conversationReady.snapshot, state: "checking", entries: [] },
        },
      );
      try {
        expect(chatOpening(m.root)).toHaveLength(1);
        expect(input(m.root).props.holdReason).toBe("Opening Codex’s chat…");
        let sent: unknown;
        await act(async () => {
          sent = await input(m.root).props.onSubmitLine("hello", "r1");
        });
        expect(sent).toBe(false);
        expect(connection.request).not.toHaveBeenCalled();
      } finally {
        await m.close();
      }
    });

    it("clears the old rows and says so when the chat is replaced", async () => {
      const { m, update } = await mountWith({ state: "found", id: "c1", agent: "codex" });
      const notice = () =>
        m.root.container.queryAll((n) => n.props.testID === "chat-notice")[0]?.props.children;
      const opening = {
        ...conversationReady,
        snapshot: { ...conversationReady.snapshot, state: "checking", entries: [] },
      };
      try {
        expect(conversationViews(m.root)).toHaveLength(1);
        await update({
          sessions: [
            sessionWith({ state: "found", id: "c2", agent: "claude" }, { kind: "claude" }),
          ],
          conversationView: opening,
        });
        expect(notice()).toBe("Now Claude");
        // Old rows are never shown for a different chat, not even dimmed.
        expect(conversationViews(m.root)).toHaveLength(0);
        expect(texts(m.root)).toContain("Opening Claude’s chat…");
        await update({ conversationView: conversationReady });
        expect(conversationViews(m.root)).toHaveLength(1);
        await update({
          sessions: [
            sessionWith({ state: "found", id: "c3", agent: "claude" }, { kind: "claude" }),
          ],
          conversationView: opening,
        });
        expect(notice()).toBe("New conversation");
      } finally {
        await m.close();
      }
    });

    it("keeps the last rows read-only under an exited card, even from an incomplete list", async () => {
      const { m, update } = await mountWith({ state: "found", id: "c1", agent: "codex" });
      const exited = () => m.root.container.queryAll((n) => n.props.testID === "chat-exited");
      try {
        await update({
          sessions: [
            sessionWith({ state: "none", agent: "codex", reason: "agent-exited" }, undefined),
          ],
          conversationView: {
            ...conversationReady,
            snapshot: { ...conversationReady.snapshot, state: "unavailable", entries: [] },
          },
        });
        expect(exited()).toHaveLength(1);
        expect(texts(m.root)).toContain("Codex exited");
        const flat = m.root.container.queryAll((n) => n.type === "FlatList")[0]!;
        expect(flat.props.data).toHaveLength(1);
        expect(input(m.root).props.holdReason).toBe("Codex exited. Use the terminal.");
        // A list that had to leave the session out keeps the last state.
        await update({ sessions: [], sessionsComplete: false });
        expect(exited()).toHaveLength(1);
        // A new agent starting replaces the card.
        await update({
          sessions: [sessionWith({ state: "finding", agent: "claude" }, { kind: "claude" })],
          sessionsComplete: true,
        });
        expect(exited()).toHaveLength(0);
        expect(chatOpening(m.root)).toHaveLength(1);
        expect(conversationViews(m.root)).toHaveLength(0);
      } finally {
        await m.close();
      }
    });

    it("says why there is no chat, with Show terminal", async () => {
      const { m } = await mountWith(
        { state: "none", agent: "codex", reason: "no-history" },
        {
          ...conversationReady,
          snapshot: { ...conversationReady.snapshot, state: "unavailable", entries: [] },
        },
      );
      try {
        expect(unavailableBanner(m.root)).toHaveLength(1);
        expect(texts(m.root)).toContain("No chat history for this session yet.");
        expect(input(m.root).props.holdReason).toBe("Chat isn’t available. Use the terminal.");
        await act(async () => m.button("Show terminal")!.props.onPress());
        expect(unavailableBanner(m.root)).toHaveLength(0);
        expect(input(m.root).props.holdReason).toBeNull();
      } finally {
        await m.close();
      }
    });
  });

  describe("an idle chat", () => {
    it.each(["finished", "running"])(
      "doesn't re-render the conversation as time passes (state %s)",
      async (state) => {
        vi.useFakeTimers();
        try {
          await seedSession({
            hello: conversationHello,
            conversationView: conversationReady,
            sessions: [
              {
                id: "tmux:a",
                title: "codex",
                agent: { kind: "codex" },
                backend: "tmux",
                state,
                activeAt: Date.now(),
              },
            ],
          });
          const m = await mountSession();
          try {
            expect(conversationViews(m.root)).toHaveLength(1);
            const before = conversationRenders.count;
            for (let i = 0; i < 60; i++) await act(async () => vi.advanceTimersByTime(1000));
            // The activity bar keeps its own clock; nothing else on screen changes.
            expect(conversationRenders.count).toBe(before);
          } finally {
            await m.close();
          }
        } finally {
          vi.useRealTimers();
        }
      },
    );
  });

  it("taps lightly when the agent finishes its turn or starts waiting, only in Chat on screen", async () => {
    haptics.impactAsync.mockClear();
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
      sessions: [
        {
          id: "tmux:a",
          title: "codex",
          agent: { kind: "codex" },
          backend: "tmux",
          state: "running",
        },
      ],
    });
    const m = await mountSession();
    const setState = (state: string) =>
      act(async () => {
        store.getState().patch("f1", (c) => ({
          sessions: c.sessions.map((s) => ({ ...s, state })) as never,
        }));
      });
    try {
      expect(haptics.impactAsync).not.toHaveBeenCalled();
      await setState("finished");
      expect(haptics.impactAsync).toHaveBeenCalledOnce();
      await setState("running");
      await setState("blocked");
      expect(haptics.impactAsync).toHaveBeenCalledTimes(2);
      // Not in Terminal.
      await act(async () => m.button("Show terminal")!.props.onPress());
      await setState("running");
      await setState("finished");
      expect(haptics.impactAsync).toHaveBeenCalledTimes(2);
    } finally {
      await m.close();
    }
  });

  it("passes the terminal's latest lines to the running step, never during a password prompt", async () => {
    const screenOf = (rows: string[]) => ({
      sessionId: "tmux:a",
      snapshot: {
        status: "live",
        historyStatus: "ready",
        screen: {
          cols: 40,
          rows: rows.length,
          cursor: { x: 0, y: rows.length - 1 },
          lines: rows.map((t) => ({ r: t ? [{ t }] : [] })),
          scrollbackTotal: 0,
          gen: 1,
        },
      },
    });
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: {
        ...conversationReady,
        snapshot: {
          ...conversationReady.snapshot,
          entries: [{ id: "call", kind: "tool-call", text: "Bash · npm test" }],
        },
      },
      sessions: [
        {
          id: "tmux:a",
          title: "codex",
          agent: { kind: "codex" },
          backend: "tmux",
          state: "running",
        },
      ],
      boundedView: screenOf(["$ npm test", "", ""]),
    });
    const m = await mountSession();
    // The list renders no cells without a native layout, so read what the screen hands it.
    const tail = () => conversationRenders.last?.liveTail ?? null;
    const show = (rows: string[]) =>
      act(async () => {
        store.getState().patch("f1", () => ({ boundedView: screenOf(rows) as never }));
      });
    try {
      expect(tail()).toBeNull();
      await show(["$ npm test", "PASS a", ""]);
      expect(tail()).toEqual(["PASS a"]);
      await show(["$ npm test", "PASS a", "PASS b"]);
      expect(tail()).toEqual(["PASS a", "PASS b"]);
      await show(["$ npm test", "PASS a", "Password:"]);
      expect(tail()).toBeNull();
      // A password prompt clears what was kept, and lines shown with it never come back.
      await show(["$ npm test", "PASS a", "PASS c"]);
      expect(tail()).toEqual(["PASS c"]);
      // The next step starts with an empty tail, and fills with what it prints.
      await act(async () => {
        store.getState().patch("f1", (c) => ({
          conversationView: {
            ...c.conversationView!,
            snapshot: {
              ...c.conversationView!.snapshot,
              entries: [
                { id: "call", kind: "tool-call", text: "Bash · npm test" },
                { id: "result", kind: "tool-result", text: "Done" },
                { id: "call2", kind: "tool-call", text: "Bash · npm run lint" },
              ],
            },
          } as never,
        }));
      });
      expect(tail()).toBeNull();
      await show(["$ npm run lint", "PASS a", "PASS c"]);
      expect(tail()).toEqual(["$ npm run lint"]);
    } finally {
      await m.close();
    }
  });

  it("shows a left session's kept rows at once, dimmed, until the first page arrives", async () => {
    const { conversationCache } = await import("../src/net/conversation-cache");
    const opening = {
      ...conversationReady,
      snapshot: { ...conversationReady.snapshot, state: "checking", entries: [] },
    };
    conversationCache.keep("f1", "tmux:a", {
      snapshot: conversationReady.snapshot as never,
      chat: "c1",
      agent: "codex",
    });
    const sessions = (id: string) => [
      {
        id: "tmux:a",
        title: "codex",
        agent: { kind: "codex" },
        backend: "tmux",
        state: "running",
        chat: { state: "found", id, agent: "codex" },
      },
    ];
    try {
      const { store } = await seedSession({
        hello: conversationHello,
        conversationView: opening,
        sessions: sessions("c1"),
      });
      const m = await mountSession();
      const dimmed = () => m.root.container.queryAll((n) => n.props.testID === "chat-dimmed");
      try {
        expect(dimmed()).toHaveLength(1);
        expect(texts(m.root)).toContain("Checking…");
        await act(async () => {
          store.getState().patch("f1", () => ({ conversationView: conversationReady as never }));
        });
        expect(dimmed()).toHaveLength(0);
        expect(conversationViews(m.root)).toHaveLength(1);
      } finally {
        await m.close();
      }
      // Rows kept for another conversation never show.
      await seedSession({
        hello: conversationHello,
        conversationView: opening,
        sessions: sessions("c2"),
      });
      const other = await mountSession();
      try {
        expect(other.root.container.queryAll((n) => n.props.testID === "chat-dimmed")).toHaveLength(
          0,
        );
        expect(chatOpening(other.root)).toHaveLength(1);
      } finally {
        await other.close();
      }
    } finally {
      conversationCache.clear();
    }
  });

  it("shows what is queued for the agent above the composer, only in Chat", async () => {
    await seedSession({
      hello: conversationHello,
      conversationView: {
        ...conversationReady,
        snapshot: { ...conversationReady.snapshot, queued: [{ text: "also run lint" }] },
      },
    });
    const m = await mountSession();
    const queue = () => m.root.container.queryAll((n) => n.props.testID === "queued-list");
    try {
      expect(queue()).toHaveLength(1);
      expect(queue()[0]!.props.accessibilityLabel).toBe("Queued for Codex: also run lint");
      await act(async () => m.button("Show terminal")!.props.onPress());
      expect(queue()).toHaveLength(0);
    } finally {
      await m.close();
    }
  });

  it("never shows Secret input's text in the live tail, even as a wrapped echo", async () => {
    vi.useFakeTimers();
    const screenOf = (rows: string[]) => ({
      sessionId: "tmux:a",
      snapshot: {
        status: "live",
        historyStatus: "ready",
        screen: {
          cols: 40,
          rows: rows.length,
          cursor: { x: 0, y: rows.length - 1 },
          lines: rows.map((t) => ({ r: t ? [{ t }] : [] })),
          scrollbackTotal: 0,
          gen: 1,
        },
      },
    });
    try {
      const { store } = await seedSession({
        hello: conversationHello,
        conversationView: {
          ...conversationReady,
          snapshot: {
            ...conversationReady.snapshot,
            entries: [{ id: "call", kind: "tool-call", text: "Bash · ssh-add" }],
          },
        },
        sessions: [
          {
            id: "tmux:a",
            title: "codex",
            agent: { kind: "codex" },
            backend: "tmux",
            state: "running",
          },
        ],
        boundedView: screenOf(["$ ssh-add", "", "", ""]),
      });
      const m = await mountSession();
      const input = () => m.root.container.queryAll((n) => n.type === "InputBar")[0]!;
      const tail = () => conversationRenders.last?.liveTail ?? null;
      const show = (rows: string[]) =>
        act(async () => {
          store.getState().patch("f1", () => ({ boundedView: screenOf(rows) as never }));
        });
      try {
        await act(async () => input().props.onSecretChange(true));
        // A long token typed in Secret input, echoed and wrapped across two rows.
        await show([
          "$ ssh-add",
          "❯ hunter2-very-long-secret-token-that-w",
          "raps-ONTO-A-SECOND-ROW",
          "",
        ]);
        expect(tail()).toBeNull();
        await act(async () => {
          input().props.onSecretSent();
          input().props.onSecretChange(false);
        });
        // Within 2 s of sending, the screen is still private.
        await show(["❯ hunter2-very-long-secret-token-that-w", "raps-ONTO-A-SECOND-ROW", "ok", ""]);
        expect(tail()).toBeNull();
        await act(async () => vi.advanceTimersByTime(2500));
        // Later the echo scrolls up a row: what was seen while private never comes back.
        await show(["raps-ONTO-A-SECOND-ROW", "ok", "Identity added", ""]);
        expect(tail()).toEqual(["Identity added"]);
        expect(JSON.stringify(tail())).not.toContain("ONTO");
      } finally {
        await m.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets go of a left screen's rows, so they never show after the two minutes", async () => {
    const { conversationCache } = await import("../src/net/conversation-cache");
    const { default: Session } = await import("../app/c/[fp]/s/[sid]");
    const { __FocusContext } = (await import("expo-router")) as unknown as {
      __FocusContext: import("react").Context<{
        focused: boolean;
        params: { fp: string; sid: string };
      }>;
    };
    const opening = {
      ...conversationReady,
      snapshot: { ...conversationReady.snapshot, state: "checking", entries: [] },
    };
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: conversationReady,
    });
    const root = createRoot();
    const render = (focused: boolean) =>
      act(async () =>
        root.render(
          createElement(
            __FocusContext.Provider,
            { value: { focused, params: { fp: "f1", sid: sidToRoute("tmux:a") } } },
            createElement(Session),
          ),
        ),
      );
    try {
      await render(true);
      expect(conversationViews(root)).toHaveLength(1);
      // Another session is pushed on top: this screen stays mounted, blurred, and its
      // conversation is retired.
      await render(false);
      await act(async () => {
        store.getState().patch("f1", () => ({ conversationView: undefined }));
      });
      // Two minutes pass: the kept rows expire (or a memory warning clears them).
      conversationCache.clear();
      // Coming back opens the chat afresh, without the expired rows.
      await act(async () => {
        store.getState().patch("f1", () => ({ conversationView: opening as never }));
      });
      await render(true);
      expect(root.container.queryAll((n) => n.props.testID === "chat-dimmed")).toHaveLength(0);
      expect(chatOpening(root)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      conversationCache.clear();
    }
  });

  it("shows the terminal for search from Chat, then returns to Chat", async () => {
    await seedSession({ hello: conversationHello, conversationView: conversationReady });
    const m = await mountSession();
    const { connectionManager } = await import("../src/net/manager");
    const lease = vi.mocked(connectionManager.claimView).mock.results[0]!.value;
    try {
      expect(conversationViews(m.root)).toHaveLength(1);
      act(() => m.button("Session actions")?.props.onPress?.());
      act(() => m.button("Search terminal history")?.props.onPress?.());
      expect(m.screen()!.props.searchOpen).toBe(true);
      expect(conversationViews(m.root)).toHaveLength(0);
      await act(async () => m.screen()!.props.onSearchOpenChange(false));
      expect(conversationViews(m.root)).toHaveLength(1);
      act(() => m.button("Session actions")?.props.onPress?.());
      act(() => m.button("Reading view")?.props.onPress?.());
      expect(conversationViews(m.root)).toHaveLength(0);
      act(() => m.button("Session actions")?.props.onPress?.());
      act(() => m.button("Reading view")?.props.onPress?.());
      expect(conversationViews(m.root)).toHaveLength(1);
      expect(lease.setConversation).not.toHaveBeenCalledWith(false);
    } finally {
      await m.close();
    }
  });

  it("says how to let the computer tell Codex conversations apart", async () => {
    const { store } = await seedSession({
      hello: conversationHello,
      conversationView: {
        ...conversationReady,
        snapshot: { ...conversationReady.snapshot, state: "unavailable", reason: "unbound" },
      },
    });
    const m = await mountSession();
    try {
      expect(headerWords(m.root).join(" ")).toContain(
        "Can’t show this Codex session’s full history yet.",
      );
      act(() => m.button("Session actions")?.props.onPress?.());
      act(() => m.button("Chat")?.props.onPress?.());
      expect(store.getState().byComputer.f1?.toast).toContain("shellbell agents setup");
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
      expect(headerWords(m.root).join(" ")).toContain("Chat");
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
