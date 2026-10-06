import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  keyboardVisible: true,
  dismiss: vi.fn(),
  request: vi.fn(async () => ({})),
  clipboard: "pasted",
  connectionStatus: "online",
  modalInsets: { top: 0, bottom: 0, left: 24, right: 48 },
  rootInsets: { top: 44, bottom: 34, left: 0, right: 0 },
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const host = (name: string) => (props: object) => createElement(name, props);
  return {
    Platform: { OS: "ios" },
    Keyboard: { dismiss: native.dismiss },
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    TextInput: host("TextInput"),
    ScrollView: host("ScrollView"),
    Modal: (props: { visible: boolean }) => (props.visible ? createElement("Modal", props) : null),
  };
});
vi.mock("react-native-keyboard-controller", () => ({
  useKeyboardState: (select: (state: { isVisible: boolean }) => unknown) =>
    select({ isVisible: native.keyboardVisible }),
}));
vi.mock("react-native-safe-area-context", async () => {
  const { createContext, createElement, useContext } = await import("react");
  const Insets = createContext<typeof native.rootInsets | null>(null);
  return {
    useSafeAreaInsets: () => useContext(Insets) ?? native.rootInsets,
    SafeAreaProvider: ({ children }: { children: import("react").ReactNode }) =>
      createElement(Insets.Provider, { value: native.modalInsets }, children),
  };
});
vi.mock("expo-glass-effect", () => ({ isGlassEffectAPIAvailable: () => false }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { setItemSync: vi.fn(), getItemSync: () => null },
}));
vi.mock("expo-clipboard", () => ({ getStringAsync: async () => native.clipboard }));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../src/net/manager", () => ({
  connectionManager: {
    get: () => ({
      status: native.connectionStatus,
      online: native.connectionStatus === "online",
      newReqId: () => "r1",
      request: native.request,
    }),
  },
}));

import { InputBar } from "../src/input/InputBar";
import { useConnectionsStore } from "../src/store/connections";
import { TerminalControls } from "../src/terminal/controls";
import { NavigationViewport } from "../src/ui/NavigationViewport";

it("keeps Android landscape composition inside the terminal instead of full-screen IME extraction", async () => {
  const root = createRoot();
  try {
    await act(async () =>
      root.render(
        createElement(InputBar, {
          fp: "offline",
          sessionId: "fixture",
          accent: "#0f0",
          showChips: false,
        }),
      ),
    );
    expect(
      root.container.queryAll((n) => n.type === "TextInput")[0]?.props.disableFullscreenUI,
    ).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("mounted compact input", () => {
  it("uses the modal window's changing safe area without dropping the draft or sending input", async () => {
    const root = createRoot();
    const render = () =>
      act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "offline",
            sessionId: "fixture",
            accent: "#0f0",
            showChips: false,
          }),
        ),
      );
    const button = (label: string) =>
      root.container.queryAll(
        (n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
      )[0]!;
    const field = () => root.container.queryAll((n) => n.type === "TextInput")[0]!;
    const guideInsets = () =>
      root.container
        .queryAll((n) => n.type === "View" && n.props.style?.paddingRight !== undefined)
        .map((n) => n.props.style);
    try {
      await render();
      await act(async () => field().props.onChangeText("keep this draft"));
      await act(async () => button("Key guide").props.onPress());
      expect(guideInsets()).toContainEqual(
        expect.objectContaining({
          paddingTop: 0,
          paddingBottom: 0,
          paddingLeft: 24,
          paddingRight: 48,
        }),
      );
      native.modalInsets = { top: 30, bottom: 22, left: 0, right: 0 };
      await render();
      expect(guideInsets()).toContainEqual(
        expect.objectContaining({
          paddingTop: 30,
          paddingBottom: 22,
          paddingLeft: 0,
          paddingRight: 0,
        }),
      );
      await act(async () => button("Done").props.onPress());
      expect(field().props.value).toBe("keep this draft");
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("uses the selected remote host in the guide without replacing drafts or sending local actions", async () => {
    const root = createRoot();
    const render = async (fp: string) =>
      act(async () =>
        root.render(
          createElement(InputBar, {
            fp,
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: false,
            availableHeight: 700,
          }),
        ),
      );
    const button = (label: string) =>
      root.container.queryAll(
        (n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
      )[0]!;
    const words = () =>
      root.container
        .queryAll((n) => n.type === "Text")
        .flatMap((n) => n.children)
        .join(" ");
    try {
      useConnectionsStore.getState().patch("mac", () => ({
        hello: {
          type: "hello",
          agentVersion: "1",
          backends: [],
          computerName: "mac",
          accent: "#0f0",
          hostPlatform: "darwin",
        },
      }));
      useConnectionsStore.getState().patch("linux", () => ({
        hello: {
          type: "hello",
          agentVersion: "1",
          backends: [],
          computerName: "linux",
          accent: "#0f0",
          hostPlatform: "linux",
        },
      }));
      useConnectionsStore.getState().patch("mac", () => ({ status: "online" }));
      useConnectionsStore.getState().patch("linux", () => ({ status: "online" }));
      await render("mac");
      const field = root.container.queryAll((n) => n.type === "TextInput")[0]!;
      const ime = { keyboardType: field.props.keyboardType, autoCorrect: field.props.autoCorrect };
      await act(async () => field.props.onChangeText("keep my draft"));
      expect(words()).toContain("⌃C");
      await act(async () => button("Key guide").props.onPress());
      expect(words()).toContain("Shellbell host: macOS");
      expect(words()).toContain("⌘ Command");
      expect(native.dismiss).toHaveBeenCalledTimes(1);
      expect(native.request).not.toHaveBeenCalled();
      await render("linux");
      expect(words()).toContain("Shellbell host: Linux");
      expect(words()).toContain("Ctrl+C");
      expect(words()).not.toContain("⌃C");
      expect(root.container.queryAll((n) => n.type === "TextInput")[0]).toBe(field);
      expect(field.props.value).toBe("keep my draft");
      expect({
        keyboardType: field.props.keyboardType,
        autoCorrect: field.props.autoCorrect,
      }).toEqual(ime);
      await act(async () => button("Done").props.onPress());
      expect(native.request).not.toHaveBeenCalled();
      await act(async () => button("Control C").props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.key",
        reqId: "r1",
        sessionId: "tmux:a",
        key: "ctrl-c",
      });
      native.request.mockClear();
      await act(async () => button("Paste to terminal").props.onPress());
      expect(native.request).not.toHaveBeenCalled();
      expect(field.props.value).toBe("pasted");
      native.request.mockClear();
      await render("legacy");
      await act(async () => button("Key guide").props.onPress());
      expect(words()).toContain("Shellbell host: OS not reported");
      expect(words()).not.toContain("Shellbell host: Linux");
      expect(native.request).not.toHaveBeenCalled();
      await render("linux");
      expect(words()).toContain("Shellbell host: Linux");
      await act(async () =>
        useConnectionsStore.getState().patch("linux", () => ({ hello: undefined })),
      );
      expect(words()).toContain("Shellbell host: OS not reported");
      expect(words()).not.toContain("Shellbell host: Linux");
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  beforeEach(() => {
    native.modalInsets = { top: 0, bottom: 0, left: 24, right: 48 };
    native.rootInsets = { top: 44, bottom: 34, left: 0, right: 0 };
    native.keyboardVisible = true;
    native.dismiss.mockClear();
    native.request.mockClear();
    native.connectionStatus = "online";
    useConnectionsStore.setState({ byComputer: {} });
  });

  it("keeps unsent line drafts through network loss and only sends after explicit submission", async () => {
    const root = createRoot();
    const render = () =>
      act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "fixture",
            accent: "#0f0",
            showChips: false,
          }),
        ),
      );
    const field = () => root.container.queryAll((node) => node.type === "TextInput")[0]!;
    const send = () =>
      root.container.queryAll(
        (node) => node.type === "Pressable" && node.props.accessibilityLabel === "Send",
      )[0]!;
    try {
      await act(async () =>
        useConnectionsStore.getState().patch("f", () => ({ status: "online" })),
      );
      await render();
      await act(async () => field().props.onChangeText("unsent command"));
      native.connectionStatus = "offline";
      await act(async () =>
        useConnectionsStore.getState().patch("f", () => ({ status: "offline" })),
      );
      expect(send().props.disabled).toBe(true);
      await act(async () => field().props.onSubmitEditing());
      expect(field().props.value).toBe("unsent command");
      expect(native.request).not.toHaveBeenCalled();
      expect(useConnectionsStore.getState().read("f").history).toEqual([]);
      native.connectionStatus = "online";
      await act(async () =>
        useConnectionsStore.getState().patch("f", () => ({ status: "online" })),
      );
      expect(field().props.value).toBe("unsent command");
      expect(native.request).not.toHaveBeenCalled();
      await act(async () => send().props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.line",
        reqId: "r1",
        sessionId: "fixture",
        text: "unsent command",
      });
      expect(field().props.value).toBe("");
    } finally {
      native.connectionStatus = "online";
      await act(async () => root.unmount());
    }
  });

  it("hides the keyboard accessories on physical attachment and restores the unsent draft on detach", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    const commands = vi.fn(() => true);
    controls.bind(commands);
    const render = (hardwareKeyboard = false) =>
      act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "fixture",
            accent: "#0f0",
            showChips: true,
            terminalControls: controls,
            hardwareKeyboard,
          }),
        ),
      );
    const button = (label: string) =>
      root.container.queryAll((node) => node.props.accessibilityLabel === label)[0]!;
    try {
      await render();
      expect(root.container.queryAll((node) => node.type === "TextInput")).toHaveLength(0);
      await act(async () => button("Compose a command before sending").props.onPress());
      await act(async () =>
        root.container
          .queryAll((node) => node.type === "TextInput")[0]!
          .props.onChangeText("keep this draft"),
      );
      await act(async () => button("Key guide").props.onPress());
      await render(true);
      expect(
        root.container.queryAll(
          (node) => node.type === "Pressable" || node.type === "TextInput" || node.type === "Modal",
        ),
      ).toHaveLength(0);
      expect(commands).toHaveBeenCalledExactlyOnceWith({ type: "focus" });
      expect(native.request).not.toHaveBeenCalled();
      await render(false);
      await act(async () => button("Compose a command before sending").props.onPress());
      expect(root.container.queryAll((node) => node.type === "TextInput")[0]!.props.value).toBe(
        "keep this draft",
      );
      expect(root.container.queryAll((node) => node.type === "Modal")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("uses xterm for typing and keeps command composition local until explicit send", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    const commands = vi.fn(() => true);
    controls.bind(commands);
    const button = (label: string) =>
      root.container.queryAll((node) => node.props.accessibilityLabel === label)[0]!;
    try {
      useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "fixture",
            accent: "#0f0",
            showChips: false,
            terminalControls: controls,
          }),
        ),
      );
      await act(async () => button("Show terminal keyboard").props.onPress());
      expect(commands).toHaveBeenCalledExactlyOnceWith({ type: "focus" });
      commands.mockClear();
      await act(async () => button("Compose a command before sending").props.onPress());
      const field = root.container.queryAll((node) => node.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("first\nsecond"));
      expect(commands).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
      await act(async () => button("Send").props.onPress());
      expect(commands).toHaveBeenCalledExactlyOnceWith({
        type: "paste",
        text: "first\nsecond",
        submit: true,
      });
      expect(field.props.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("caps a long draft in a short pane without remounting or sending it, then restores it", async () => {
    const root = createRoot();
    const render = (availableHeight: number) =>
      act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: true,
            availableHeight,
          }),
        ),
      );
    try {
      await render(400);
      const field = root.container.queryAll((n) => n.type === "TextInput")[0]!;
      await act(async () => {
        field.props.onChangeText("long draft stays local");
        field.props.onContentSizeChange({ nativeEvent: { contentSize: { height: 80 } } });
      });
      await render(92);
      expect(root.container.queryAll((n) => n.type === "TextInput")[0]).toBe(field);
      expect(field.props.value).toBe("long draft stays local");
      expect(field.props.style.height).toBe(48);
      expect(
        root.container.queryAll(
          (n) => n.type === "Pressable" && n.props.accessibilityLabel === "Terminal keys",
        ),
      ).toHaveLength(1);
      expect(
        root.container.queryAll(
          (n) => n.type === "Pressable" && n.props.accessibilityLabel === "Paste to terminal",
        ),
      ).toHaveLength(0);
      expect(native.dismiss).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
      await render(400);
      expect(
        root.container.queryAll(
          (n) => n.type === "Pressable" && n.props.accessibilityLabel === "Paste to terminal",
        ),
      ).toHaveLength(1);
      expect(field.props.style.height).toBe(80);
      expect(field.props.value).toBe("long draft stays local");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("opens and dismisses controls locally while retaining draft, and sends only explicit key actions", async () => {
    const root = createRoot();
    try {
      useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: true,
            availableHeight: 92,
          }),
        ),
      );
      const field = root.container.queryAll((n) => n.type === "TextInput")[0]!;
      const button = (label: string) =>
        root.container.queryAll(
          (n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
        )[0]!;
      await act(async () => field.props.onChangeText("unsent"));
      await act(async () => button("Terminal keys").props.onPress());
      // iPhone native Modal defaults to portrait, independently of app.json.
      expect(
        root.container.queryAll((n) => n.type === "Modal")[0]!.props.supportedOrientations,
      ).toEqual(expect.arrayContaining(["portrait", "landscape-left", "landscape-right"]));
      expect(native.dismiss).toHaveBeenCalledTimes(1);
      expect(native.request).not.toHaveBeenCalled();
      expect(field.props.multiline).toBe(true);
      expect(field.props.value).toBe("unsent");
      expect(native.request).not.toHaveBeenCalled();
      await act(async () => button("Escape").props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.key",
        reqId: "r1",
        sessionId: "tmux:a",
        key: "esc",
      });
      native.request.mockClear();
      await act(async () => button("Done").props.onPress());
      expect(root.container.queryAll((n) => n.type === "Modal")).toHaveLength(0);
      expect(field.props.value).toBe("unsent");
      await act(async () => button("Terminal keys").props.onPress());
      await act(async () =>
        root.container.queryAll((n) => n.type === "Modal")[0]!.props.onRequestClose(),
      );
      expect(root.container.queryAll((n) => n.type === "Modal")).toHaveLength(0);
      expect(native.request).not.toHaveBeenCalled();
      expect(field.props.value).toBe("unsent");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

it.each([
  ["three-button navigation", 48],
  ["gesture navigation", 24],
  ["home indicator", 34],
  ["landscape with no bottom bar", 0],
] as const)("keeps input mounted above %s through keyboard dismissal", async (_mode, bottom) => {
  native.rootInsets.bottom = bottom;
  native.keyboardVisible = false;
  const root = createRoot();
  const render = () =>
    act(async () =>
      root.render(
        createElement(
          NavigationViewport,
          null,
          createElement(InputBar, {
            fp: "f",
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: false,
            availableHeight: 400 - bottom,
          }),
        ),
      ),
    );
  const viewport = () =>
    root.container.queryAll((node) => node.type === "View" && node.props.style?.flex === 1)[0]!;
  const field = () => root.container.queryAll((node) => node.type === "TextInput")[0]!;
  const bar = () =>
    root.container.queryAll((node) => node.type === "View" && Array.isArray(node.props.style))[0]!;
  try {
    await render();
    const originalField = field();
    await act(async () => originalField.props.onChangeText("unsent draft"));
    expect(viewport().props.style.paddingBottom).toBe(bottom);
    expect(bar().props.style[0].paddingBottom).toBe(8);
    native.keyboardVisible = true;
    await render();
    expect(viewport().props.style.paddingBottom).toBe(0);
    expect(field()).toBe(originalField);
    native.keyboardVisible = false;
    await render();
    expect(viewport().props.style.paddingBottom).toBe(bottom);
    expect(bar().props.style[0].paddingBottom).toBe(8);
    expect(field()).toBe(originalField);
    expect(field().props.value).toBe("unsent draft");
    expect(native.request).not.toHaveBeenCalled();
    expect(native.dismiss).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});

describe("input size admission", () => {
  it("retains command composition on older hosts with a hardware keyboard and hides key accessories", async () => {
    const root = createRoot();
    try {
      useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "fixture",
            accent: "#0f0",
            showChips: true,
            hardwareKeyboard: true,
          }),
        ),
      );
      expect(root.container.queryAll((node) => node.type === "TextInput")).toHaveLength(1);
      expect(
        root.container.queryAll(
          (node) =>
            node.props.accessibilityLabel === "Key guide" ||
            node.props.accessibilityLabel === "Control modifier",
        ),
      ).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  beforeEach(() => {
    native.request.mockClear();
    native.clipboard = "pasted";
    native.connectionStatus = "online";
    useConnectionsStore.setState({ byComputer: {} });
  });
  it.each(["x".repeat(60_000), "界".repeat(20_000), "x".repeat(65_537)])(
    "keeps oversized clipboard text for review and rejects submission before sending Enter (%#)",
    async (text) => {
      const root = createRoot();
      native.clipboard = `${text}\n`;
      try {
        useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
        await act(async () =>
          root.render(
            createElement(InputBar, {
              fp: "f",
              sessionId: "tmux:a",
              accent: "#0f0",
              showChips: false,
            }),
          ),
        );
        const paste = root.container.queryAll(
          (node) =>
            node.type === "Pressable" && node.props.accessibilityLabel === "Paste to terminal",
        )[0]!;
        await act(async () => paste.props.onPress());
        expect(native.request).not.toHaveBeenCalled();
        const field = root.container.queryAll((node) => node.type === "TextInput")[0]!;
        expect(field.props.value).toBe(native.clipboard);
        await act(async () => field.props.onSubmitEditing());
        const connection = useConnectionsStore.getState().read("f");
        expect(connection.pendingInputs).toEqual({});
        expect(connection.toast).toMatch(/line too long/i);
        expect(connection.toast).not.toMatch(/delivered/i);
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
  it("retains oversized command drafts without sending a destructive edit or Enter", async () => {
    const root = createRoot();
    try {
      useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: false,
          }),
        ),
      );
      const field = root.container.queryAll((node) => node.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("界".repeat(20_000)));
      await act(async () => field.props.onSubmitEditing());
      expect(native.request).not.toHaveBeenCalled();
      expect(field.props.value).toBe("界".repeat(20_000));
      expect(useConnectionsStore.getState().read("f").toast).toMatch(/line too long/i);
    } finally {
      await act(async () => root.unmount());
    }
  });
});
