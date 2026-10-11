import * as Clipboard from "expo-clipboard";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  keyboardVisible: true,
  keyboardHeight: null as number | null,
  dismiss: vi.fn(),
  request: vi.fn(async (message: { reqId: string }) => ({
    type: "ack",
    reqId: message.reqId,
    ok: true,
  })),
  newReqId: vi.fn(() => "r1"),
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
  useKeyboardState: (select: (state: { isVisible: boolean; height: number }) => unknown) =>
    select({
      isVisible: native.keyboardVisible,
      height: native.keyboardHeight ?? (native.keyboardVisible ? 300 : 0),
    }),
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
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn(async () => native.clipboard) }));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../src/net/manager", () => ({
  connectionManager: {
    get: () => ({
      status: native.connectionStatus,
      online: native.connectionStatus === "online",
      newReqId: native.newReqId,
      request: native.request,
    }),
  },
}));

import { InputBar } from "../src/input/InputBar";
import { setScreenHidden } from "../src/security/screen-hidden";
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
    const field = () => root.container.queryAll((node) => node.type === "TextInput")[0];
    try {
      await render();
      await act(async () => field()!.props.onChangeText("keep this draft"));
      await act(async () => button("Key guide").props.onPress());
      await render(true);
      expect(
        root.container.queryAll(
          (node) => node.type === "Pressable" || node.type === "TextInput" || node.type === "Modal",
        ),
      ).toHaveLength(0);
      // The native field is already gone when xterm takes the physical keyboard's focus.
      expect(commands.mock.calls).toEqual([[{ type: "focus" }]]);
      expect(native.request).not.toHaveBeenCalled();
      await render(false);
      expect(field()!.props.value).toBe("keep this draft");
      expect(root.container.queryAll((node) => node.type === "Modal")).toHaveLength(0);
      expect(commands).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("opens on the command bar and never hands the phone keyboard to xterm", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    const commands = vi.fn(() => true);
    controls.bind(commands);
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
            availableHeight: 92,
          }),
        ),
      );
      const fields = root.container.queryAll((node) => node.type === "TextInput");
      expect(fields).toHaveLength(1);
      expect(fields[0]!.props.accessibilityLabel).toBe("Command draft");
      // Opening a session must not raise the keyboard over the terminal.
      expect(fields[0]!.props.autoFocus).toBeFalsy();
      const labels = root.container
        .queryAll((node) => node.type === "Pressable")
        .map((node) => node.props.accessibilityLabel);
      expect(labels).not.toContain("Type directly");
      expect(labels).not.toContain("Draft command");
      // The keys row stays in a compact pane: the Live keys switch, then the primary keys.
      expect(labels.slice(0, 7)).toEqual([
        "Live keys",
        "Control C",
        "Escape",
        "Tab",
        "Arrow up",
        "Arrow down",
        "Enter",
      ]);
      expect(commands).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps command composition local until explicit send", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    const commands = vi.fn(() => true);
    const onSubmitLine = vi.fn(async () => true);
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
            onSubmitLine,
          }),
        ),
      );
      const field = root.container.queryAll((node) => node.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("first\nsecond"));
      expect(commands).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
      await act(async () => button("Send").props.onPress());
      expect(onSubmitLine).toHaveBeenCalledExactlyOnceWith("first\nsecond", "r1");
      expect(commands).not.toHaveBeenCalled();
      expect(field.props.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends real arrow keys from the keys row and keeps local history on its own button", async () => {
    const root = createRoot();
    const button = (label: string) =>
      root.container.queryAll(
        (n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
      )[0]!;
    try {
      useConnectionsStore.getState().patch("f", () => ({
        status: "online",
        history: ["make test"],
      }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: false,
            // Compact, as with the keyboard up in landscape: the keys row must still be there.
            availableHeight: 92,
          }),
        ),
      );
      const field = root.container.queryAll((n) => n.type === "TextInput")[0]!;
      await act(async () => button("Arrow up").props.onPress());
      await act(async () => button("Arrow down").props.onPress());
      expect(native.request.mock.calls.map(([message]) => message)).toEqual([
        { type: "input.key", reqId: "r1", sessionId: "tmux:a", key: "up" },
        { type: "input.key", reqId: "r1", sessionId: "tmux:a", key: "down" },
      ]);
      expect(field.props.value).toBe("");
      native.request.mockClear();
      await act(async () => button("Previous command").props.onPress());
      expect(field.props.value).toBe("make test");
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("completes a draft with Tab by sending its text and then Tab in one ordered message", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    const commands = vi.fn(() => true);
    controls.bind(commands);
    const onTerminalInput = vi.fn(() => true);
    const button = (label: string) =>
      root.container.queryAll(
        (n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
      )[0]!;
    try {
      useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "tmux:a",
            accent: "#0f0",
            showChips: false,
            terminalControls: controls,
            onTerminalInput,
          }),
        ),
      );
      const field = root.container.queryAll((n) => n.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("git ch"));
      await act(async () => button("Tab").props.onPress());
      expect(onTerminalInput).toHaveBeenCalledExactlyOnceWith("git ch\t");
      expect(field.props.value).toBe("");
      expect(native.request).not.toHaveBeenCalled();
      expect(useConnectionsStore.getState().read("f").history).toEqual([]);
      // With nothing drafted, Tab is the terminal's Tab key.
      await act(async () => button("Tab").props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.key",
        reqId: "r1",
        sessionId: "tmux:a",
        key: "tab",
      });
      native.request.mockClear();
      // A multi-line draft would run its first line, so Tab leaves it alone.
      await act(async () => field.props.onChangeText("one\ntwo"));
      await act(async () => button("Tab").props.onPress());
      expect(onTerminalInput).toHaveBeenCalledTimes(1);
      expect(native.request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "input.key", key: "tab" }),
      );
      expect(field.props.value).toBe("one\ntwo");
      expect(commands).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("completes a draft with Tab on hosts without exact terminal input", async () => {
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
      const field = root.container.queryAll((n) => n.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("ls ~/Doc"));
      await act(async () =>
        root.container
          .queryAll((n) => n.type === "Pressable" && n.props.accessibilityLabel === "Tab")[0]!
          .props.onPress(),
      );
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.text",
        reqId: "r1",
        sessionId: "tmux:a",
        text: "ls ~/Doc\t",
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
      expect(field.props.style.height).toBe(40);
      // The keys row stays, a little shorter, and the reply chips give way.
      const key = (label: string) =>
        root.container.queryAll(
          (n) => n.type === "Pressable" && n.props.accessibilityLabel === label,
        );
      expect(key("Control C")).toHaveLength(1);
      expect(key("Control C")[0]!.props.style.height).toBe(36);
      expect(key("Paste to terminal")).toHaveLength(1);
      expect(key("Escape")).toHaveLength(1);
      expect(native.dismiss).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
      await render(400);
      expect(key("Control C")[0]!.props.style.height).toBe(44);
      expect(key("Escape")).toHaveLength(2);
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
      await act(async () => button("Key guide").props.onPress());
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
      await act(async () => button("Key guide").props.onPress());
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

it("closes the terminal keys when App Lock hides the app instead of reopening them after", async () => {
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
          availableHeight: 92,
        }),
      ),
    );
    const modals = () => root.container.queryAll((n) => n.type === "Modal");
    await act(async () =>
      root.container
        .queryAll(
          (n) => n.type === "Pressable" && n.props.accessibilityLabel === "Terminal keys",
        )[0]!
        .props.onPress(),
    );
    expect(modals()).toHaveLength(1);
    await act(async () => setScreenHidden(true));
    expect(modals()).toHaveLength(0);
    await act(async () => setScreenHidden(false));
    expect(modals()).toHaveLength(0);
  } finally {
    setScreenHidden(false);
    await act(async () => root.unmount());
  }
});

it("keeps the navigation inset when keyboard state says open but the keyboard has no height", async () => {
  // Android can leave the keyboard "visible" after Back pops a session whose input had focus;
  // a stale flag with nothing on screen must not drop every route under the navigation bar.
  const savedBottom = native.rootInsets.bottom;
  native.rootInsets.bottom = 48;
  const root = createRoot();
  const render = () =>
    act(async () => root.render(createElement(NavigationViewport, null, createElement("Screen"))));
  const viewport = () =>
    root.container.queryAll((node) => node.type === "View" && node.props.style?.flex === 1)[0]!;
  try {
    native.keyboardVisible = true;
    native.keyboardHeight = 0;
    await render();
    expect(viewport().props.style.paddingBottom).toBe(48);
    native.keyboardHeight = 280;
    await render();
    expect(viewport().props.style.paddingBottom).toBe(0);
    native.keyboardVisible = false;
    await render();
    expect(viewport().props.style.paddingBottom).toBe(48);
  } finally {
    native.keyboardVisible = true;
    native.keyboardHeight = null;
    native.rootInsets.bottom = savedBottom;
    await act(async () => root.unmount());
  }
});

describe("input size admission", () => {
  it("discards a clipboard read after switching terminal sessions", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    const oldSession = vi.fn(() => true);
    const newSession = vi.fn(() => true);
    const unbind = controls.bind(oldSession);
    let finish!: (text: string) => void;
    vi.mocked(Clipboard.getStringAsync).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            key: "old",
            fp: "f",
            sessionId: "old",
            accent: "#0f0",
            showChips: false,
            terminalControls: controls,
          }),
        ),
      );
      const paste = root.container.queryAll(
        (node) =>
          node.type === "Pressable" && node.props.accessibilityLabel === "Paste to terminal",
      )[0]!;
      await act(async () => paste.props.onPress());
      expect(oldSession).not.toHaveBeenCalled();
      unbind();
      controls.bind(newSession);
      await act(async () =>
        root.render(
          createElement(InputBar, {
            key: "new",
            fp: "f",
            sessionId: "new",
            accent: "#0f0",
            showChips: false,
            terminalControls: controls,
          }),
        ),
      );
      await act(async () => finish("private clipboard from old session"));
      expect(newSession).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
  it("retains the request identity when explicitly retrying unconfirmed delivery", async () => {
    const { DeliveryUnknownError } = await import("../src/net/connection");
    const root = createRoot();
    native.newReqId.mockReset().mockReturnValueOnce("first").mockReturnValue("fresh");
    native.request.mockRejectedValueOnce(new DeliveryUnknownError());
    try {
      useConnectionsStore.getState().patch("f", () => ({
        status: "online",
        pendingInputs: { other: { at: 1, sessionId: "other-session" } },
      }));
      await act(async () =>
        root.render(
          createElement(InputBar, {
            fp: "f",
            sessionId: "fixture",
            accent: "#0f0",
            showChips: false,
          }),
        ),
      );
      const field = root.container.queryAll((node) => node.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("run once"));
      await act(async () => field.props.onSubmitEditing());
      expect(field.props.value).toBe("run once");
      expect(useConnectionsStore.getState().read("f").history).toEqual([]);
      expect(useConnectionsStore.getState().read("f").pendingInputs).toEqual({
        other: { at: 1, sessionId: "other-session" },
      });
      expect(useConnectionsStore.getState().read("f").toast).toMatch(/delivery unconfirmed/i);
      await act(async () => field.props.onSubmitEditing());
      expect(native.request.mock.calls.map(([message]) => message.reqId)).toEqual([
        "first",
        "first",
      ]);
      expect(native.newReqId).toHaveBeenCalledTimes(1);
      expect(field.props.value).toBe("");
      expect(useConnectionsStore.getState().read("f").history).toEqual(["run once"]);
      expect(useConnectionsStore.getState().read("f").pendingInputs).toEqual({
        other: { at: 1, sessionId: "other-session" },
        first: { at: expect.any(Number), sessionId: "fixture" },
      });
    } finally {
      native.newReqId.mockReset().mockReturnValue("r1");
      await act(async () => root.unmount());
    }
  });

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

  it("keeps a draft while submission is pending and after rejected delivery", async () => {
    const root = createRoot();
    const controls = new TerminalControls();
    controls.bind(() => true);
    let finish!: (accepted: boolean) => void;
    const submitLine = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        }),
    );
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
            onSubmitLine: submitLine,
          }),
        ),
      );
      const field = root.container.queryAll((node) => node.type === "TextInput")[0]!;
      await act(async () => field.props.onChangeText("retain me"));
      await act(async () => {
        void button("Send").props.onPress();
      });
      expect(submitLine).toHaveBeenCalledExactlyOnceWith("retain me", "r1");
      expect(field.props.value).toBe("retain me");
      expect(button("Send").props.disabled).toBe(true);
      await act(async () => {
        void button("Send").props.onPress();
      });
      expect(submitLine).toHaveBeenCalledTimes(1);
      await act(async () => finish(false));
      expect(field.props.value).toBe("retain me");
      expect(useConnectionsStore.getState().read("f").history).toEqual([]);
      await act(async () => {
        void button("Send").props.onPress();
      });
      expect(submitLine).toHaveBeenCalledTimes(2);
      expect(field.props.value).toBe("retain me");
      await act(async () => finish(true));
      expect(field.props.value).toBe("");
      expect(useConnectionsStore.getState().read("f").history).toEqual(["retain me"]);
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
