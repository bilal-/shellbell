import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import { useConnectionsStore } from "../src/store/connections";
import { SessionMenuButton } from "../src/ui/SessionMenuButton";
import { sidToRoute } from "../src/util/routes";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const io = vi.hoisted(() => ({ push: vi.fn(), request: vi.fn(), online: true }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: io.push }),
}));
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

it("keeps all four capability actions and cancel reachable, including horizontal split", async () => {
  const m = await mount();
  try {
    for (const label of [
      "Bring to front on computer",
      "New tmux window",
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
