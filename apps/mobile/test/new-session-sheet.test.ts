import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setScreenHidden } from "../src/security/screen-hidden";
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

function advertiseTargets(targets: { backend: string; host: string; label: string }[]) {
  useConnectionsStore.getState().patch("computer", (current) => ({
    hello: { ...current.hello, sessionLaunchTargets: targets } as never,
  }));
}

describe("new session picker", () => {
  beforeEach(() => {
    useConnectionsStore.setState({ byComputer: {} });
    connection.online = true;
    connection.request.mockReset();
  });

  it("creates only one session when a button is pressed twice before rendering", async () => {
    advertise(["iterm2"]);
    let finish!: (value: { ok: boolean; sessionId: string }) => void;
    connection.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const m = await mount();
    try {
      const press = m.button("New iTerm2 tab").props.onPress;
      await act(async () => {
        press();
        press();
      });
      expect(connection.request).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        finish({ ok: true, sessionId: "iterm2:new" });
      });
      await m.unmount();
    }
  });

  it("does not offer an adapter that has no terminal window on the computer", async () => {
    advertise([]);
    useConnectionsStore.getState().patch("computer", (current) => ({
      hello: {
        ...current.hello,
        backendCatalog: [
          {
            name: "example",
            label: "Example Terminal",
            connected: false,
            launchable: true,
            capabilities: { createSession: true },
          },
        ],
      } as never,
    }));
    const m = await mount();
    try {
      expect(m.button("Start Example Terminal")).toBeUndefined();
      expect(m.text()).not.toContain("Example Terminal");
    } finally {
      await m.unmount();
    }
  });

  it("sends the selected engine and terminal app when no sessions are open", async () => {
    advertise([]);
    useConnectionsStore.getState().patch("computer", (current) => ({
      hello: { ...current.hello, launchableBackends: ["tmux", "herdr"] } as never,
    }));
    advertiseTargets([
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { backend: "herdr", host: "iterm2", label: "iTerm2" },
    ]);
    connection.request.mockResolvedValue({ ok: true, sessionId: "tmux:%1" });
    const m = await mount();
    try {
      expect(m.button("Herdr in iTerm2").props.disabled).toBe(false);
      await act(async () => m.button("tmux in Ghostty").props.onPress());
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "tmux", host: "ghostty" },
      });
      expect(m.onCreated).toHaveBeenCalledWith("tmux:%1");
    } finally {
      await m.unmount();
    }
  });

  it("lists iTerm2 first, then tmux and Herdr in each terminal app, and nothing phone-only", async () => {
    advertise(["iterm2", "tmux", "herdr"]);
    advertiseTargets([
      { backend: "herdr", host: "ghostty", label: "Ghostty" },
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
      { backend: "herdr", host: "iterm2", label: "iTerm2" },
      { backend: "tmux", host: "iterm2", label: "iTerm2" },
    ]);
    connection.request.mockResolvedValue({ ok: true, sessionId: "herdr:new-tab" });
    const m = await mount();
    try {
      // Session options are the buttons that carry a detail line as their hint.
      const labels = m.root.container
        .queryAll((node) => node.type === "Pressable" && node.props.accessibilityHint)
        .map((node) => node.props.accessibilityLabel);
      expect(labels).toEqual([
        "New iTerm2 tab",
        "tmux in iTerm2",
        "tmux in Ghostty",
        "Herdr in iTerm2",
        "Herdr in Ghostty",
      ]);
      for (const label of ["New tmux window", "Start tmux session", "New Herdr tab"])
        expect(m.button(label)).toBeUndefined();
      expect(m.text()).toContain("Opens in Ghostty on your computer.");
      await act(async () => m.button("Herdr in iTerm2").props.onPress());
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "herdr", host: "iterm2" },
      });
      expect(m.onCreated).toHaveBeenCalledWith("herdr:new-tab");
      expect(m.onClose).toHaveBeenCalledOnce();
    } finally {
      await m.unmount();
    }
  });

  it("explains when the computer cannot open any new session in a terminal window", async () => {
    advertise(["tmux", "future-backend"]);
    const m = await mount();
    try {
      expect(m.button("New iTerm2 tab").props.disabled).toBe(true);
      expect(m.button("New tmux window")).toBeUndefined();
      expect(m.text()).toContain("Open iTerm2 and enable its Python API on your computer.");
      expect(m.text()).toContain("No terminal app on your computer can show a new session yet.");
      expect(m.text()).not.toContain("future-backend");
    } finally {
      await m.unmount();
    }
  });

  it("blocks creation while the connection is paused", async () => {
    advertise(["iterm2"]);
    const m = await mount();
    try {
      expect(m.button("New iTerm2 tab").props.disabled).toBe(false);
      expect(m.text()).not.toContain("No terminal app");
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
    advertise(["iterm2"]);
    connection.request
      .mockResolvedValueOnce({ ok: false, error: "backend-unavailable" })
      .mockResolvedValueOnce({ ok: true, sessionId: "iterm2:new" });
    const m = await mount();
    try {
      await act(async () => m.button("New iTerm2 tab").props.onPress());
      expect(m.text()).toContain("Could not create a session");
      expect(m.onCreated).not.toHaveBeenCalled();
      expect(m.onClose).not.toHaveBeenCalled();
      await act(async () => m.button("New iTerm2 tab").props.onPress());
      expect(m.onCreated).toHaveBeenCalledWith("iterm2:new");
    } finally {
      await m.unmount();
    }
  });

  it("shows the computer's reason when it refuses to create a session", async () => {
    advertise(["tmux"]);
    advertiseTargets([{ backend: "tmux", host: "ghostty", label: "Ghostty" }]);
    connection.request.mockResolvedValue({
      ok: false,
      error: "The terminal window could not open on your computer, so the new session was closed.",
    });
    const m = await mount();
    try {
      await act(async () => m.button("tmux in Ghostty").props.onPress());
      expect(m.text()).toContain(
        "The terminal window could not open on your computer, so the new session was closed.",
      );
      expect(m.text()).not.toContain("Could not create a session");
      expect(m.onCreated).not.toHaveBeenCalled();
    } finally {
      await m.unmount();
    }
  });
  it("closes instead of hiding while App Lock covers the app", async () => {
    advertise(["tmux"]);
    const m = await mount();
    try {
      expect(m.onClose).not.toHaveBeenCalled();
      await act(async () => setScreenHidden(true));
      expect(m.root.container.queryAll((node) => node.type === "Modal")[0]!.props.visible).toBe(
        false,
      );
      expect(m.onClose).toHaveBeenCalledTimes(1);
    } finally {
      setScreenHidden(false);
      await m.unmount();
    }
  });
});
