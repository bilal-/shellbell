import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useConnectionsStore } from "../src/store/connections";
import { NewSessionSheet } from "../src/ui/NewSessionSheet";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const connection = vi.hoisted(() => ({
  online: true,
  request: vi.fn(),
  newReqId: () => "request-1",
}));
vi.mock("../src/net/manager", () => ({ connectionManager: { get: () => connection } }));
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Modal: "Modal",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { create: (styles: object) => styles, absoluteFill: {} },
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 34 }),
}));

function advertise(names: string[]) {
  useConnectionsStore.getState().patch("computer", () => ({
    status: "online",
    hello: {
      backends: names.map((name) => ({ name, capabilities: { createSession: true } })),
    } as never,
  }));
}

async function mount() {
  const root = createRoot();
  const onClose = vi.fn();
  const onCreated = vi.fn();
  await act(async () =>
    root.render(
      createElement(NewSessionSheet, { fp: "computer", visible: true, onClose, onCreated }),
    ),
  );
  const button = (label: string) =>
    root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
    )[0]!;
  const text = () =>
    root.container
      .queryAll((node) => node.type === "Text")
      .flatMap((node) => node.props.children)
      .join(" ");
  return { root, button, text, onClose, onCreated, unmount: () => act(async () => root.unmount()) };
}

describe("new session picker", () => {
  beforeEach(() => {
    useConnectionsStore.setState({ byComputer: {} });
    connection.online = true;
    connection.request.mockReset();
  });

  it("offers startup without an open session when the computer advertises an installed backend", async () => {
    advertise([]);
    useConnectionsStore.getState().patch("computer", (current) => ({
      hello: { ...current.hello, launchableBackends: ["tmux"] } as never,
    }));
    connection.request.mockResolvedValue({ ok: true, sessionId: "tmux:%1" });
    const m = await mount();
    try {
      expect(m.button("Start tmux session").props.disabled).toBe(false);
      await act(async () => m.button("Start tmux session").props.onPress());
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "tmux" },
      });
      expect(m.onCreated).toHaveBeenCalledWith("tmux:%1");
    } finally {
      await m.unmount();
    }
  });

  it("keeps all three apps visible and routes Herdr creation to the requested backend", async () => {
    advertise(["iterm2", "tmux", "herdr"]);
    connection.request.mockResolvedValue({ ok: true, sessionId: "herdr:new-tab" });
    const m = await mount();
    try {
      for (const label of ["New iTerm2 tab", "New tmux window", "New Herdr tab"])
        expect(m.button(label).props.disabled).toBe(false);
      await act(async () => m.button("New Herdr tab").props.onPress());
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "herdr" },
      });
      expect(m.onCreated).toHaveBeenCalledWith("herdr:new-tab");
      expect(m.onClose).toHaveBeenCalledOnce();
    } finally {
      await m.unmount();
    }
  });

  it("explains missing apps, rejects unknown advertised backends and blocks creation while paused", async () => {
    advertise(["iterm2", "future-backend"]);
    const m = await mount();
    try {
      expect(m.button("New iTerm2 tab").props.disabled).toBe(false);
      expect(m.button("New tmux window").props.disabled).toBe(true);
      expect(m.button("New Herdr tab").props.disabled).toBe(true);
      expect(m.text()).toContain("Start a tmux session on your computer.");
      expect(m.text()).toContain("Install Herdr on your computer.");
      expect(m.text()).not.toContain("future-backend");
      await act(async () =>
        useConnectionsStore.getState().patch("computer", () => ({ status: "waiting-direct" })),
      );
      expect(m.button("New iTerm2 tab").props.disabled).toBe(true);
      expect(m.text()).toContain("Reconnect to your computer");
      connection.online = false;
      await act(async () => m.button("New iTerm2 tab").props.onPress());
      expect(connection.request).not.toHaveBeenCalled();
      expect(m.onCreated).not.toHaveBeenCalled();
    } finally {
      await m.unmount();
    }
  });

  it("shows failed acknowledgements and allows retry without navigating to an uncreated session", async () => {
    advertise(["tmux"]);
    connection.request
      .mockResolvedValueOnce({ ok: false, error: "backend-unavailable" })
      .mockResolvedValueOnce({ ok: true, sessionId: "tmux:new-window" });
    const m = await mount();
    try {
      await act(async () => m.button("New tmux window").props.onPress());
      expect(m.text()).toContain("Could not create a session");
      expect(m.onCreated).not.toHaveBeenCalled();
      expect(m.onClose).not.toHaveBeenCalled();
      await act(async () => m.button("New tmux window").props.onPress());
      expect(m.onCreated).toHaveBeenCalledWith("tmux:new-window");
    } finally {
      await m.unmount();
    }
  });
});
