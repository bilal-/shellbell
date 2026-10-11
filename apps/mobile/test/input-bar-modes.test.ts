import { act, createElement } from "react";
import { createRoot, type Root } from "test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  log: [] as unknown[],
  request: vi.fn(async (message: { reqId: string }) => {
    native.log.push(message);
    return { type: "ack", reqId: message.reqId, ok: true };
  }),
  newReqId: vi.fn(() => "r1"),
}));
vi.mock("react-native", async () => {
  const { createElement } = await import("react");
  const host = (name: string) => (props: object) => createElement(name, props);
  return {
    Platform: { OS: "ios" },
    Keyboard: { dismiss: vi.fn() },
    View: host("View"),
    Text: host("Text"),
    Pressable: host("Pressable"),
    TextInput: host("TextInput"),
    ScrollView: host("ScrollView"),
    Modal: (props: { visible: boolean }) => (props.visible ? createElement("Modal", props) : null),
  };
});
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("expo-glass-effect", () => ({ isGlassEffectAPIAvailable: () => false }));
vi.mock("expo-sqlite/kv-store", () => ({
  default: { setItemSync: vi.fn(), getItemSync: () => null },
}));
vi.mock("expo-clipboard", () => ({ getStringAsync: vi.fn(async () => "") }));
vi.mock("expo-haptics", () => ({
  impactAsync: async () => {},
  ImpactFeedbackStyle: { Light: "light" },
}));
vi.mock("../src/net/manager", () => ({
  connectionManager: {
    get: () => ({
      status: "online",
      online: true,
      newReqId: native.newReqId,
      request: native.request,
    }),
  },
}));

import { InputBar } from "../src/input/InputBar";
import { LIVE_BATCH_MS, LIVE_IDLE_RESET_MS } from "../src/input/liveKeys";
import { useConnectionsStore } from "../src/store/connections";
import { TerminalControls } from "../src/terminal/controls";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

type Props = Partial<Parameters<typeof InputBar>[0]>;

function setup() {
  const root = createRoot();
  const controls = new TerminalControls();
  const commands = vi.fn(() => true);
  controls.bind(commands);
  const onTerminalInput = vi.fn((data: string) => {
    native.log.push(data);
    return true;
  });
  const render = (props: Props = {}) =>
    act(async () =>
      root.render(
        createElement(InputBar, {
          fp: "f",
          sessionId: "tmux:a",
          accent: "#0f0",
          showChips: false,
          terminalControls: controls,
          onTerminalInput,
          ...props,
        }),
      ),
    );
  return { root, commands, onTerminalInput, render };
}

const pressable = (root: Root, label: string) =>
  root.container.queryAll((n) => n.type === "Pressable" && n.props.accessibilityLabel === label);
const field = (root: Root, label: string) =>
  root.container.queryAll((n) => n.type === "TextInput" && n.props.accessibilityLabel === label)[0];
const wait = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  native.log.length = 0;
  native.request.mockClear();
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("Live keys", () => {
  it("swaps the command bar for a keystroke field and batches what is typed", async () => {
    const { root, onTerminalInput, render } = setup();
    try {
      await render();
      await act(async () => field(root, "Command draft")!.props.onChangeText("kept draft"));
      await act(async () => pressable(root, "Live keys")[0]!.props.onPress());
      expect(field(root, "Command draft")).toBeUndefined();
      const live = field(root, "Live keys input")!;
      expect(live.props.autoFocus).toBe(true);
      expect(live.props).toMatchObject({
        autoCorrect: false,
        spellCheck: false,
        autoComplete: "off",
        autoCapitalize: "none",
        keyboardType: "ascii-capable",
      });
      expect(pressable(root, "Live keys")[0]!.props.accessibilityState.checked).toBe(true);
      await act(async () => live.props.onChangeText("d"));
      await act(async () => live.props.onChangeText("dd"));
      expect(onTerminalInput).not.toHaveBeenCalled();
      await wait(LIVE_BATCH_MS);
      expect(onTerminalInput).toHaveBeenCalledExactlyOnceWith("dd");
      expect(native.request).not.toHaveBeenCalled();
      // Leaving Live keys returns to the command bar with its draft intact.
      await act(async () => pressable(root, "Live keys")[0]!.props.onPress());
      expect(field(root, "Live keys input")).toBeUndefined();
      expect(field(root, "Command draft")!.props.value).toBe("kept draft");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends DEL for Backspace on an empty field, once per press, and Return for Enter", async () => {
    const { root, onTerminalInput, render } = setup();
    try {
      await render({ alternateScreen: true });
      const live = () => field(root, "Live keys input")!;
      const backspace = () => live().props.onKeyPress({ nativeEvent: { key: "Backspace" } });
      await act(async () => backspace());
      await wait(LIVE_BATCH_MS);
      expect(onTerminalInput.mock.calls).toEqual([["\x7f"]]);
      // A deletion the text change already sent is not sent again by its key event.
      await act(async () => live().props.onChangeText("x"));
      await act(async () => live().props.onChangeText(""));
      await act(async () => backspace());
      // With text in the field, the key event comes first and the change does the deleting.
      await act(async () => live().props.onChangeText("y"));
      await act(async () => backspace());
      await act(async () => live().props.onChangeText(""));
      await act(async () => live().props.onSubmitEditing());
      await wait(LIVE_BATCH_MS);
      expect(onTerminalInput.mock.calls).toEqual([["\x7f"], ["x\x7fy\x7f\r"]]);
      expect(live().props.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("clears its small buffer after a pause and keeps deleting what was already typed", async () => {
    const { root, onTerminalInput, render } = setup();
    try {
      await render({ alternateScreen: true });
      const live = () => field(root, "Live keys input")!;
      await act(async () => live().props.onChangeText("ab"));
      await wait(LIVE_IDLE_RESET_MS);
      expect(live().props.value).toBe("");
      await act(async () => live().props.onKeyPress({ nativeEvent: { key: "Backspace" } }));
      await act(async () => live().props.onChangeText("c"));
      await wait(LIVE_BATCH_MS);
      expect(onTerminalInput.mock.calls).toEqual([["ab"], ["\x7fc"]]);
      const long = "x".repeat(32);
      await act(async () => live().props.onChangeText(long));
      expect(live().props.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps typed keys ahead of a quick key pressed before the batch window ends", async () => {
    const { root, render } = setup();
    try {
      await render({ alternateScreen: true });
      await act(async () => field(root, "Live keys input")!.props.onChangeText(":"));
      await act(async () => field(root, "Live keys input")!.props.onChangeText(":q"));
      await act(async () => pressable(root, "Escape")[0]!.props.onPress());
      await act(async () => field(root, "Live keys input")!.props.onChangeText(":qi"));
      await act(async () => pressable(root, "Send Enter")[0]!.props.onPress());
      await wait(LIVE_BATCH_MS);
      expect(native.log).toEqual([
        ":q",
        expect.objectContaining({ type: "input.key", key: "esc" }),
        "i",
        expect.objectContaining({ type: "input.key", key: "enter" }),
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("follows the host's full-screen report until the user picks a mode", async () => {
    const { root, render } = setup();
    const live = () => field(root, "Live keys input");
    try {
      await render({ alternateScreen: false });
      expect(live()).toBeUndefined();
      await render({ alternateScreen: true });
      expect(live()).toBeDefined();
      // Opened by the host without the keyboard up: do not raise it over vim.
      expect(live()!.props.autoFocus).toBe(false);
      await act(async () => pressable(root, "Live keys")[0]!.props.onPress());
      expect(live()).toBeUndefined();
      await render({ alternateScreen: true });
      expect(live()).toBeUndefined();
      await render({ alternateScreen: undefined });
      expect(live()).toBeUndefined();
      await render({ alternateScreen: false });
      expect(live()).toBeUndefined();
      // Typing `less` in the command bar keeps the keyboard when the pager takes over.
      await act(async () => field(root, "Command draft")!.props.onFocus());
      await render({ alternateScreen: true });
      expect(live()!.props.autoFocus).toBe(true);
      await render({ alternateScreen: false });
      expect(live()).toBeUndefined();
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("is not offered without exact terminal input", async () => {
    const { root, render } = setup();
    try {
      await render({
        terminalControls: undefined,
        onTerminalInput: undefined,
        alternateScreen: true,
      });
      expect(pressable(root, "Live keys")).toHaveLength(0);
      expect(field(root, "Live keys input")).toBeUndefined();
      expect(field(root, "Command draft")).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("Secret input", () => {
  it("is offered at a password prompt, sends once and never reaches history", async () => {
    const { root, render } = setup();
    const onSubmitLine = vi.fn(async () => true as const);
    try {
      await render({ onSubmitLine, secretPrompt: true });
      await act(async () => field(root, "Command draft")!.props.onChangeText("kept draft"));
      await act(async () => pressable(root, "Type password securely")[0]!.props.onPress());
      expect(field(root, "Command draft")).toBeUndefined();
      const secret = field(root, "Secret input")!;
      expect(secret.props).toMatchObject({
        secureTextEntry: true,
        autoFocus: true,
        autoCorrect: false,
        spellCheck: false,
        autoComplete: "off",
      });
      expect(secret.props.multiline).toBeFalsy();
      expect(pressable(root, "Type password securely")).toHaveLength(0);
      await act(async () => secret.props.onChangeText("hunter2 x"));
      await act(async () => pressable(root, "Send secret")[0]!.props.onPress());
      expect(onSubmitLine).toHaveBeenCalledExactlyOnceWith("hunter2 x", "r1");
      expect(useConnectionsStore.getState().read("f").history).toEqual([]);
      // Back to the command bar, draft intact, and history browsing never shows the password.
      expect(field(root, "Secret input")).toBeUndefined();
      expect(field(root, "Command draft")!.props.value).toBe("kept draft");
      await act(async () => pressable(root, "Previous command")[0]!.props.onPress());
      expect(field(root, "Command draft")!.props.value).toBe("kept draft");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("opens from the keys row and forgets an unsent password on cancel", async () => {
    const { root, render } = setup();
    const onSubmitLine = vi.fn(async () => true as const);
    try {
      await render({ onSubmitLine, alternateScreen: true });
      expect(pressable(root, "Type password securely")).toHaveLength(0);
      await act(async () => pressable(root, "Secret input")[0]!.props.onPress());
      await act(async () => field(root, "Secret input")!.props.onChangeText("half typed"));
      // A full-screen program ending must not take the password field away.
      await render({ onSubmitLine, alternateScreen: false });
      expect(field(root, "Secret input")!.props.value).toBe("half typed");
      await act(async () => pressable(root, "Cancel secret input")[0]!.props.onPress());
      expect(field(root, "Secret input")).toBeUndefined();
      // It returns to the mode it came from.
      expect(field(root, "Live keys input")).toBeDefined();
      await act(async () => pressable(root, "Secret input")[0]!.props.onPress());
      expect(field(root, "Secret input")!.props.value).toBe("");
      expect(onSubmitLine).not.toHaveBeenCalled();
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
