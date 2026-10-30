import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setScreenHidden } from "../src/security/screen-hidden";
import { useConnectionsStore } from "../src/store/connections";
import { NewSessionSheet } from "../src/ui/NewSessionSheet";

const native = vi.hoisted(() => ({
  keyboard: false,
  width: 390,
  height: 844,
  size: { cols: 54, rows: 40 },
  listeners: new Map<string, () => void>(),
}));
vi.mock("../src/terminal/new-session-size", () => ({ newSessionSize: () => native.size }));
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const connection = vi.hoisted(() => ({
  online: true,
  request: vi.fn(),
  newReqId: () => "request-1",
}));
vi.mock("../src/net/manager", () => ({ connectionManager: { get: () => connection } }));
const screen = vi.hoisted(() => ({ focused: true }));
vi.mock("expo-router", async () => {
  const { useEffect } = await import("react");
  return {
    useFocusEffect: (effect: () => undefined | (() => void)) => {
      const focused = screen.focused;
      useEffect(() => (focused ? effect() : undefined), [focused, effect]);
    },
  };
});
vi.mock("react-native", () => ({
  ActivityIndicator: "ActivityIndicator",
  Modal: "Modal",
  Keyboard: {
    isVisible: () => native.keyboard,
    dismiss: vi.fn(),
    addListener: (name: string, fn: () => void) => {
      native.listeners.set(name, fn);
      return { remove: () => native.listeners.delete(name) };
    },
  },
  useWindowDimensions: () => ({ width: native.width, height: native.height }),
  TextInput: "TextInput",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
  StyleSheet: { create: (styles: object) => styles, absoluteFill: {} },
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardAvoidingView: "KeyboardAvoidingView",
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
  const choose = async (label: string) => act(async () => button(label).props.onPress());
  return {
    root,
    button,
    text,
    choose,
    onClose,
    onCreated,
    unmount: () => act(async () => root.unmount()),
  };
}

function advertiseTargets(targets: { backend: string; host: string; label: string }[]) {
  useConnectionsStore.getState().patch("computer", (current) => ({
    hello: { ...current.hello, sessionLaunchTargets: targets } as never,
  }));
}

describe("new session picker", () => {
  beforeEach(() => {
    native.keyboard = false;
    native.width = 390;
    native.height = 844;
    native.size = { cols: 54, rows: 40 };
    screen.focused = true;
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
      await m.choose("iTerm2");
      const press = m.button("Create window").props.onPress;
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

  it("does not open a session created after its screen lost focus", async () => {
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
      await m.choose("iTerm2");
      await act(async () => {
        m.button("Create window").props.onPress();
      });
      // A notification opened another session before the computer answered.
      screen.focused = false;
      await act(async () =>
        m.root.render(
          createElement(NewSessionSheet, {
            fp: "computer",
            visible: false,
            onClose: m.onClose,
            onCreated: m.onCreated,
          }),
        ),
      );
      await act(async () => {
        finish({ ok: true, sessionId: "iterm2:new" });
      });
      expect(m.onCreated).not.toHaveBeenCalled();
    } finally {
      await m.unmount();
    }
  });

  it("shows an advertised adapter without a desktop launch target as unavailable", async () => {
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
      expect(m.button("Example Terminal").props.disabled).toBe(true);
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
      expect(m.button("Herdr").props.disabled).toBe(false);
      await m.choose("tmux");
      await act(async () => m.button("Create window").props.onPress());
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "tmux", host: "ghostty", initialSize: { cols: 54, rows: 40 } },
      });
      expect(m.onCreated).toHaveBeenCalledWith("tmux:%1");
    } finally {
      await m.unmount();
    }
  });

  it("lists each engine once, then shows its desktop launch choices", async () => {
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
      expect(labels).toEqual(["iTerm2", "tmux", "Herdr"]);
      for (const label of ["New tmux window", "Start tmux session", "New Herdr tab"])
        expect(m.button(label)).toBeUndefined();
      expect(connection.request).not.toHaveBeenCalled();
      await m.choose("Herdr");
      expect(m.button("iTerm2").props.accessibilityState.selected).toBe(true);
      expect(m.button("Ghostty")).toBeDefined();
      await act(async () => m.button("Create window").props.onPress());
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "herdr", host: "iterm2", initialSize: { cols: 54, rows: 40 } },
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
      expect(m.button("iTerm2").props.disabled).toBe(true);
      expect(m.button("New tmux window")).toBeUndefined();
      expect(m.text()).toContain("Open iTerm2 and enable its Python API on your computer.");
      expect(m.text()).toContain(
        "No terminal app on your computer can show a new session yet. Install iTerm2 or Ghostty there, or update Shellbell on your computer.",
      );
      expect(m.text()).not.toContain("future-backend");
    } finally {
      await m.unmount();
    }
  });

  it("asks a Mac with no usable terminal to install one, instead of an update", async () => {
    useConnectionsStore.getState().patch("computer", () => ({
      status: "online",
      hello: {
        backends: [],
        terminalSetup: ["iterm2", "tmux", "herdr"].map((name) => ({
          name,
          connected: false,
          issue: "not-installed",
        })),
      } as never,
    }));
    const m = await mount();
    try {
      expect(m.text()).toContain(
        "Your Mac needs iTerm2, tmux or Herdr to open a new session. Install one there. iTerm2 is the easiest.",
      );
      expect(m.text()).not.toContain("update Shellbell");
    } finally {
      await m.unmount();
    }
  });

  it("blocks creation while the connection is paused", async () => {
    advertise(["iterm2"]);
    const m = await mount();
    try {
      await m.choose("iTerm2");
      expect(m.button("Create window").props.disabled).toBe(false);
      expect(m.text()).not.toContain("No terminal app");
      await act(async () =>
        useConnectionsStore.getState().patch("computer", () => ({ status: "waiting-direct" })),
      );
      expect(m.button("Create window").props.disabled).toBe(true);
      expect(m.text()).toContain("Reconnect to your computer");
      connection.online = false;
      await act(async () => m.button("Create window").props.onPress());
      expect(connection.request).not.toHaveBeenCalled();
      expect(m.onCreated).not.toHaveBeenCalled();
    } finally {
      await m.unmount();
    }
  });

  it("stays open and explains a connection drop while the computer has not answered", async () => {
    const { DeliveryUnknownError } = await import("../src/net/connection");
    advertise(["iterm2"]);
    let drop!: (error: Error) => void;
    connection.request.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          drop = reject;
        }),
    );
    const m = await mount();
    try {
      await m.choose("iTerm2");
      await act(async () => {
        m.button("Create window").props.onPress();
      });
      expect(m.button("Create window").props.disabled).toBe(true);
      await act(async () => {
        useConnectionsStore.getState().patch("computer", () => ({ status: "offline" }));
        drop(new DeliveryUnknownError());
      });
      expect(m.onClose).not.toHaveBeenCalled();
      expect(m.onCreated).not.toHaveBeenCalled();
      expect(m.text()).toContain(
        "Connection dropped before the computer answered. Check your computer, then try again.",
      );
      // No automatic retry: a second request could create a second session.
      expect(connection.request).toHaveBeenCalledOnce();
      await act(async () =>
        useConnectionsStore.getState().patch("computer", () => ({ status: "online" })),
      );
      expect(m.button("Create window").props.disabled).toBe(false);
      expect(m.text()).toContain("Connection dropped before the computer answered.");
      expect(connection.request).toHaveBeenCalledOnce();
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
      await m.choose("iTerm2");
      await act(async () => m.button("Create window").props.onPress());
      expect(m.text()).toContain("Could not create a session");
      expect(m.onCreated).not.toHaveBeenCalled();
      expect(m.onClose).not.toHaveBeenCalled();
      await act(async () => m.button("Create window").props.onPress());
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
      await m.choose("tmux");
      await act(async () => m.button("Create window").props.onPress());
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

  it("sends the chosen host and custom grid only after Create window", async () => {
    advertise(["herdr"]);
    advertiseTargets([
      { backend: "herdr", host: "iterm2", label: "iTerm2" },
      { backend: "herdr", host: "ghostty", label: "Ghostty" },
    ]);
    connection.request.mockResolvedValue({ ok: true, sessionId: "herdr:new" });
    const m = await mount();
    try {
      await m.choose("Herdr");
      await m.choose("Ghostty");
      await m.choose("Custom");
      const field = (label: string) =>
        m.root.container.queryAll(
          (node) => node.type === "TextInput" && node.props.accessibilityLabel === label,
        )[0]!;
      await act(async () => {
        field("Window columns").props.onChangeText("62");
        field("Window rows").props.onChangeText("48");
      });
      expect(connection.request).not.toHaveBeenCalled();
      await m.choose("Create window");
      expect(connection.request).toHaveBeenCalledWith({
        type: "session.create",
        reqId: "request-1",
        in: { kind: "tab", backend: "herdr", host: "ghostty", initialSize: { cols: 62, rows: 48 } },
      });
    } finally {
      await m.unmount();
    }
  });

  it("rejects invalid dimensions without sending a partial or clamped request", async () => {
    advertise(["iterm2"]);
    const m = await mount();
    try {
      await m.choose("iTerm2");
      await m.choose("Custom");
      const input = m.root.container.queryAll(
        (node) => node.type === "TextInput" && node.props.accessibilityLabel === "Window columns",
      )[0]!;
      for (const value of ["", "39", "241", "5.4", "1e2"]) {
        await act(async () => input.props.onChangeText(value));
        expect(m.button("Create window").props.disabled).toBe(true);
        await m.choose("Create window");
        expect(connection.request).not.toHaveBeenCalled();
      }
    } finally {
      await m.unmount();
    }
  });

  it("omits size for Computer default and resets to Fit phone when reopened", async () => {
    advertise(["iterm2"]);
    connection.request.mockResolvedValue({ ok: true, sessionId: "iterm2:new" });
    const m = await mount();
    try {
      await m.choose("iTerm2");
      await m.choose("Computer default");
      await m.choose("Create window");
      expect(connection.request.mock.calls[0]![0].in).toEqual({ kind: "tab", backend: "iterm2" });
      for (const visible of [false, true])
        await act(async () =>
          m.root.render(
            createElement(NewSessionSheet, {
              fp: "computer",
              visible,
              onClose: m.onClose,
              onCreated: m.onCreated,
            }),
          ),
        );
      expect(m.button("Herdr")).toBeUndefined();
      await m.choose("iTerm2");
      expect(m.button("Fit phone").props.accessibilityState.selected).toBe(true);
      await m.choose("Create window");
      expect(connection.request.mock.calls[1]![0].in.initialSize).toEqual({ cols: 54, rows: 40 });
    } finally {
      await m.unmount();
    }
  });

  it("does not silently switch hosts when the selected launch target disappears", async () => {
    advertise(["tmux"]);
    advertiseTargets([
      { backend: "tmux", host: "iterm2", label: "iTerm2" },
      { backend: "tmux", host: "ghostty", label: "Ghostty" },
    ]);
    const m = await mount();
    try {
      await m.choose("tmux");
      await m.choose("Ghostty");
      await act(async () =>
        advertiseTargets([{ backend: "tmux", host: "iterm2", label: "iTerm2" }]),
      );
      expect(m.button("Create window").props.disabled).toBe(true);
      await m.choose("Create window");
      expect(connection.request).not.toHaveBeenCalled();
      await m.choose("iTerm2");
      expect(m.button("Create window").props.disabled).toBe(false);
    } finally {
      await m.unmount();
    }
  });

  it("refreshes Fit phone after rotating with the custom keyboard open", async () => {
    advertise(["iterm2"]);
    connection.request.mockResolvedValue({ ok: true, sessionId: "iterm2:new" });
    const m = await mount();
    try {
      await m.choose("iTerm2");
      await m.choose("Custom");
      await act(async () => {
        native.keyboard = true;
        native.listeners.get("keyboardDidShow")?.();
      });
      native.width = 844;
      native.height = 390;
      native.size = { cols: 110, rows: 24 };
      await act(async () =>
        m.root.render(
          createElement(NewSessionSheet, {
            fp: "computer",
            visible: true,
            onClose: m.onClose,
            onCreated: m.onCreated,
          }),
        ),
      );
      await m.choose("Fit phone");
      expect(m.button("Create window").props.disabled).toBe(true);
      await act(async () => {
        native.keyboard = false;
        native.listeners.get("keyboardDidHide")?.();
      });
      await m.choose("Create window");
      expect(connection.request.mock.calls[0]![0].in.initialSize).toEqual({ cols: 110, rows: 24 });
      expect(m.text()).toContain("Closest supported fit");
    } finally {
      await m.unmount();
    }
  });

  it("does not close or navigate a reopened sheet when an older request completes", async () => {
    advertise(["iterm2"]);
    let finish!: (ack: { ok: boolean; sessionId: string }) => void;
    connection.request.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const m = await mount();
    try {
      await m.choose("iTerm2");
      await m.choose("Create window");
      for (const visible of [false, true])
        await act(async () =>
          m.root.render(
            createElement(NewSessionSheet, {
              fp: "computer",
              visible,
              onClose: m.onClose,
              onCreated: m.onCreated,
            }),
          ),
        );
      await act(async () => finish({ ok: true, sessionId: "iterm2:new" }));
      expect(m.onClose).not.toHaveBeenCalled();
      expect(m.onCreated).not.toHaveBeenCalled();
      expect(m.button("iTerm2").props.disabled).toBe(false);
      expect(connection.request).toHaveBeenCalledOnce();
    } finally {
      await m.unmount();
    }
  });

  it.each(["backdrop", "hardware back"])(
    "%s dismisses the number keyboard before leaving the selected engine",
    async (action) => {
      const { Keyboard } = await import("react-native");
      advertise(["iterm2"]);
      const m = await mount();
      try {
        await m.choose("iTerm2");
        await m.choose("Custom");
        await act(async () => {
          native.keyboard = true;
          native.listeners.get("keyboardDidShow")?.();
        });
        vi.mocked(Keyboard.dismiss).mockClear();
        if (action === "backdrop") await m.choose("Dismiss new session");
        else
          await act(async () =>
            m.root.container.queryAll((node) => node.type === "Modal")[0]!.props.onRequestClose(),
          );
        expect(Keyboard.dismiss).toHaveBeenCalledOnce();
        expect(m.onClose).not.toHaveBeenCalled();
        expect(m.button("Done editing window size")).toBeDefined();
        expect(m.button("Create window")).toBeDefined();
      } finally {
        await m.unmount();
      }
    },
  );
});
