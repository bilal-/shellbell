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
      Screen: (props: { options?: { headerRight?: () => import("react").ReactNode } }) =>
        createElement("StackScreen", props, props.options?.headerRight?.()),
    },
  };
});
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
        release: vi.fn(),
        requestOlder: vi.fn(() => true),
        skipOversized: vi.fn(() => true),
        refreshHistory: vi.fn(() => true),
        retryOutput: vi.fn(() => true),
        protectHistory: vi.fn(() => true),
      };
      const connection = {
        status: "online",
        online: true,
        newReqId: vi.fn(() => "r1"),
        request: vi.fn(async () => ({ type: "ack", reqId: "r1", ok: true })),
      };
      vi.mocked(connectionManager.claimView).mockReset().mockReturnValue(lease);
      vi.mocked(connectionManager.get)
        .mockReset()
        .mockReturnValue(connection as never);
      useConnectionsStore.setState({ byComputer: {} });
      useConnectionsStore.getState().patch("f1", () => ({
        status: "online",
        agentOnline: true,
        sessions: [{ id: "tmux:a", title: "Terminal", backend: "tmux", state: "running" }] as never,
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
        // No WebView/frame acknowledgement is required to safely submit a composed command.
        let accepted: boolean | undefined;
        await act(async () => {
          accepted = await input().props.onSubmitLine("first\n界\r\nsecond");
        });
        expect(accepted).toBe(true);
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
          accepted = await input().props.onSubmitLine("rejected");
        });
        expect(accepted).toBe(false);
        connection.request.mockClear();
        await act(async () => {
          accepted = await input().props.onSubmitLine("界".repeat(20_000));
        });
        expect(accepted).toBe(false);
        expect(connection.request).not.toHaveBeenCalled();
        connection.online = false;
        await act(async () => {
          accepted = await input().props.onSubmitLine("keep this");
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
    const lease = { revision: () => ({}), release: vi.fn() };
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
      await act(async () => button("Switch to reading view").props.onPress());
      expect(screen().props.readingMode).toBe(true);
      expect(
        root.container.queryAll((n) => n.type === "StackScreen")[0]!.props.options.title,
      ).toContain("Reading");
      await act(async () => button("Switch to terminal grid").props.onPress());
      expect(screen().props.readingMode).toBe(false);
      expect(root.container.queryAll((n) => n.type === "InputBar")[0]).toBe(input);
      expect(connectionManager.claimView).toHaveBeenCalledTimes(1);
      expect(lease.release).not.toHaveBeenCalled();
      expect(connectionManager.get).not.toHaveBeenCalled();
      await act(async () => button("Switch to reading view").props.onPress());
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
    const lease = { revision: () => ({}), release: vi.fn() };
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
      release: vi.fn(),
      requestOlder: vi.fn(() => true),
      skipOversized: vi.fn(() => true),
      refreshHistory: vi.fn(() => true),
      retryOutput: vi.fn(() => true),
      protectHistory: vi.fn(() => true),
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
    expect(connectionManager.claimView).toHaveBeenCalledWith("f1", "tmux:a");
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
    await render(false);
    expect(firstLease.release).toHaveBeenCalledTimes(1);
    await render(true);
    expect(connectionManager.claimView).toHaveBeenCalledTimes(2);
    await render(true, "tmux:b");
    expect(secondLease.release).toHaveBeenCalledTimes(1);
    expect(connectionManager.claimView).toHaveBeenLastCalledWith("f1", "tmux:b");
    await act(async () => {
      root.unmount();
    });
    expect(thirdLease.release).toHaveBeenCalledTimes(1);
  });

  it("sends legacy history through the focused lease and fences an old callback after blur", async () => {
    const { default: Session } = await import("../app/c/[fp]/s/[sid]");
    const { __FocusContext } = (await import("expo-router")) as unknown as {
      __FocusContext: import("react").Context<{
        focused: boolean;
        params: { fp: string; sid: string };
      }>;
    };
    const { connectionManager } = await import("../src/net/manager");
    const { useConnectionsStore } = await import("../src/store/connections");
    let revision = {};
    const lease = {
      revision: vi.fn(() => revision),
      release: vi.fn(),
      requestOlder: vi.fn(() => true),
      skipOversized: vi.fn(() => true),
      refreshHistory: vi.fn(() => true),
      retryOutput: vi.fn(() => true),
      protectHistory: vi.fn(() => true),
    };
    vi.mocked(connectionManager.claimView).mockReset().mockReturnValue(lease);
    const oldConnection = { newReqId: vi.fn(() => "old"), request: vi.fn(async () => ({})) };
    const replacement = { newReqId: vi.fn(() => "new"), request: vi.fn(async () => ({})) };
    vi.mocked(connectionManager.get)
      .mockReset()
      .mockReturnValue(oldConnection as never);
    useConnectionsStore.setState({ byComputer: {} });
    useConnectionsStore.getState().patch("f1", () => ({
      status: "online",
      agentOnline: true,
      sessions: [{ id: "tmux:a", title: "A", backend: "tmux", state: "running" }] as never,
      view: {
        sessionId: "tmux:a",
        view: {
          state: {
            cols: 10,
            rows: 1,
            cursor: { x: 0, y: 0 },
            lines: [],
            scrollbackTotal: 10,
            gen: 1,
            history: [],
            historyFrom: 10,
          },
          keyed: [],
        },
      },
    }));
    const root = createRoot();
    const render = async (focused: boolean) => {
      await act(async () => {
        root.render(
          createElement(
            __FocusContext.Provider,
            {
              value: { focused, params: { fp: "f1", sid: sidToRoute("tmux:a") } },
            },
            createElement(Session),
          ),
        );
      });
    };
    await render(true);
    const callback = root.container.queryAll((node) => node.type === "ScreenView")[0]?.props
      .onLoadOlder;
    const oldActions = root.container.queryAll((node) => node.type === "ScreenView")[0]?.props;
    await act(async () => {
      callback();
    });
    expect(lease.requestOlder).toHaveBeenCalledWith(revision);
    expect(oldConnection.request).not.toHaveBeenCalled();
    const oldRevision = revision;
    revision = {};
    await act(async () => {
      useConnectionsStore.getState().patch("f1", () => ({ agentOnline: false }));
    });
    const currentCallback = root.container.queryAll((node) => node.type === "ScreenView")[0]?.props
      .onLoadOlder;
    const currentActions = root.container.queryAll((node) => node.type === "ScreenView")[0]?.props;
    await act(async () => {
      currentCallback();
    });
    expect(lease.requestOlder).toHaveBeenLastCalledWith(revision);
    await act(async () => {
      callback();
      oldActions?.onSkipOversized();
      oldActions?.onRefreshHistory();
      oldActions?.onRetryOutput();
      oldActions?.onProtectHistory("old:1");
      currentActions?.onSkipOversized();
      currentActions?.onRefreshHistory();
      currentActions?.onRetryOutput();
      currentActions?.onProtectHistory("new:1");
    });
    expect(lease.requestOlder).toHaveBeenLastCalledWith(oldRevision);
    expect(lease.skipOversized.mock.calls.slice(-2)).toEqual([[oldRevision], [revision]]);
    expect(lease.refreshHistory.mock.calls.slice(-2)).toEqual([[oldRevision], [revision]]);
    expect(lease.retryOutput.mock.calls.slice(-2)).toEqual([[oldRevision], [revision]]);
    expect(lease.protectHistory.mock.calls.slice(-2)).toEqual([
      ["old:1", oldRevision],
      ["new:1", revision],
    ]);
    expect(oldConnection.request).not.toHaveBeenCalled();
    await render(false);
    vi.mocked(connectionManager.get).mockReturnValue(replacement as never);
    await act(async () => {
      callback();
    });
    expect(replacement.request).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });
});
