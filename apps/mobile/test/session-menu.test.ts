import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { setScreenHidden } from "../src/security/screen-hidden";
import { useConnectionsStore } from "../src/store/connections";
import { SessionMenuButton } from "../src/ui/SessionMenuButton";
import { sidToRoute } from "../src/util/routes";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const io = vi.hoisted(() => ({ push: vi.fn(), request: vi.fn(), online: true, focused: true }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useRouter: () => ({ push: io.push }),
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = io.focused;
      useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
  };
});
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Alert: { alert: vi.fn() },
  Modal: (props: { visible: boolean }) => (props.visible ? createElement("Modal", props) : null),
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34 }),
}));
vi.mock("../src/net/manager", () => ({
  connectionManager: {
    get: () => ({ online: io.online, request: io.request, newReqId: () => "req-1" }),
  },
}));

beforeEach(() => {
  io.online = true;
  io.focused = true;
  io.push.mockReset();
  io.request.mockReset().mockResolvedValue({ ok: true, sessionId: "tmux:two" });
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    sessions: [
      {
        id: "tmux:one",
        title: "Work",
        backend: "tmux",
        state: "running",
        cols: 80,
        rows: 24,
        windowId: "1",
        windowNumber: 1,
        tabId: "1",
        tabIndex: 0,
        paneIndex: 0,
        isFocusedOnMac: false,
      },
    ],
    hello: {
      backends: [
        { name: "tmux", connected: true, capabilities: { focus: true, createSession: true } },
      ],
    } as never,
  }));
});

async function mount() {
  const root = createRoot();
  await act(async () =>
    root.render(createElement(SessionMenuButton, { fp: "computer", sessionId: "tmux:one" })),
  );
  const button = (label: string) =>
    root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
    )[0]!;
  await act(async () => button("Session actions").props.onPress());
  return { root, button, close: () => act(async () => root.unmount()) };
}

it("opens a new tmux session in the computer's preferred terminal app", async () => {
  useConnectionsStore.getState().patch("computer", (current) => ({
    hello: {
      ...current.hello,
      sessionLaunchTargets: [
        { backend: "tmux", host: "ghostty", label: "Ghostty" },
        { backend: "tmux", host: "iterm2", label: "iTerm2" },
      ],
    } as never,
  }));
  const m = await mount();
  try {
    expect(m.button("New tmux window")).toBeUndefined();
    await act(async () => m.button("New tmux session in iTerm2").props.onPress());
    expect(io.request).toHaveBeenCalledExactlyOnceWith({
      type: "session.create",
      reqId: "req-1",
      in: { kind: "tab", backend: "tmux", host: "iterm2" },
    });
  } finally {
    await m.close();
  }
});

it("offers no new tmux session when the computer has no terminal app to show it", async () => {
  const m = await mount();
  try {
    expect(m.button("New tmux window")).toBeUndefined();
    expect(
      m.root.container.queryAll(
        (node) =>
          node.type === "Pressable" &&
          String(node.props.accessibilityLabel ?? "").startsWith("New tmux"),
      ),
    ).toEqual([]);
  } finally {
    await m.close();
  }
});

it("does not offer Herdr splits, which would not appear on the computer", async () => {
  useConnectionsStore.getState().patch("computer", (current) => ({
    sessions: current.sessions.map((session) => ({
      ...session,
      id: "herdr:one",
      backend: "herdr",
    })),
    hello: {
      backends: [{ name: "herdr", capabilities: { focus: true, createSession: true } }],
    } as never,
  }));
  const root = createRoot();
  await act(async () =>
    root.render(createElement(SessionMenuButton, { fp: "computer", sessionId: "herdr:one" })),
  );
  const labels = () =>
    root.container
      .queryAll((node) => node.type === "Pressable")
      .map((node) => node.props.accessibilityLabel);
  try {
    await act(async () =>
      root.container
        .queryAll(
          (node) =>
            node.type === "Pressable" && node.props.accessibilityLabel === "Session actions",
        )[0]!
        .props.onPress(),
    );
    expect(labels()).toContain("Bring to front on computer");
    expect(labels()).not.toContain("Split vertical");
    expect(labels()).not.toContain("Split horizontal");
  } finally {
    await act(async () => root.unmount());
  }
});

it("shows the computer's reason when it refuses a split", async () => {
  io.request.mockResolvedValue({
    ok: false,
    error:
      "This session is not open in a terminal window on your computer, so it cannot be split or extended from the phone.",
  });
  const m = await mount();
  try {
    await act(async () => m.button("Split vertical").props.onPress());
    expect(useConnectionsStore.getState().byComputer.computer?.toast).toBe(
      "This session is not open in a terminal window on your computer, so it cannot be split or extended from the phone.",
    );
    expect(io.push).not.toHaveBeenCalled();
  } finally {
    await m.close();
  }
});

it("keeps all four capability actions and cancel reachable, including horizontal split", async () => {
  useConnectionsStore.getState().patch("computer", (current) => ({
    hello: {
      ...current.hello,
      sessionLaunchTargets: [{ backend: "tmux", host: "ghostty", label: "Ghostty" }],
    } as never,
  }));
  const m = await mount();
  try {
    for (const label of [
      "Bring to front on computer",
      "New tmux session in Ghostty",
      "Split vertical",
      "Split horizontal",
      "Cancel session actions",
    ])
      expect(m.button(label), label).toBeDefined();
    await act(async () => m.button("Split horizontal").props.onPress());
    expect(io.request).toHaveBeenCalledExactlyOnceWith({
      type: "session.create",
      reqId: "req-1",
      in: { kind: "split", sessionId: "tmux:one", direction: "horizontal" },
    });
    expect(io.push).toHaveBeenCalledExactlyOnceWith(`/c/computer/s/${sidToRoute("tmux:two")}`);
  } finally {
    await m.close();
  }
});

it("disables remote actions while disconnected", async () => {
  useConnectionsStore.getState().patch("computer", () => ({ status: "offline" }));
  const m = await mount();
  try {
    expect(m.button("Split horizontal").props.disabled).toBe(true);
    expect(m.button("Bring to front on computer").props.accessibilityState.disabled).toBe(true);
    await act(async () => m.button("Cancel session actions").props.onPress());
    expect(io.request).not.toHaveBeenCalled();
  } finally {
    await m.close();
  }
});

it("does not duplicate a pending action and explains uncertain failures", async () => {
  let reject!: (error: Error) => void;
  io.request.mockImplementation(
    () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const m = await mount();
  try {
    const press = m.button("Split horizontal").props.onPress;
    await act(async () => {
      press();
      press();
    });
    expect(io.request).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("connection lost")));
    expect(useConnectionsStore.getState().byComputer.computer?.toast).toContain(
      "Check the session list before trying again",
    );
  } finally {
    await m.close();
  }
});

it("closes instead of hiding while App Lock covers the app, so it cannot return over another screen", async () => {
  const m = await mount();
  const sheet = () => m.root.container.queryAll((node) => node.type === "Modal");
  try {
    expect(sheet()).toHaveLength(1);
    await act(async () => setScreenHidden(true));
    expect(sheet()).toHaveLength(0);
    await act(async () => setScreenHidden(false));
    expect(sheet()).toHaveLength(0);
  } finally {
    setScreenHidden(false);
    await m.close();
  }
});

it("closes when its session screen loses focus", async () => {
  const m = await mount();
  const sheet = () => m.root.container.queryAll((node) => node.type === "Modal");
  const render = () =>
    act(async () =>
      m.root.render(createElement(SessionMenuButton, { fp: "computer", sessionId: "tmux:one" })),
    );
  try {
    expect(sheet()).toHaveLength(1);
    io.focused = false;
    await render();
    expect(sheet()).toHaveLength(0);
    io.focused = true;
    await render();
    expect(sheet()).toHaveLength(0);
  } finally {
    await m.close();
  }
});
