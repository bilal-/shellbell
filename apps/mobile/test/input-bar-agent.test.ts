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
  haptic: vi.fn(async () => {}),
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
  impactAsync: native.haptic,
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
const placeholder = (root: Root) => field(root, "Command draft")?.props.placeholder;
const keyRow = (root: Root) =>
  root.container
    .queryAll((n) => n.type === "ScrollView" && n.props.horizontal === true)[0]!
    .queryAll((n) => n.type === "Pressable" && n.props.accessibilityRole === "button")
    .map((n) => n.props.accessibilityLabel as string);
const icons = (root: Root) =>
  root.container.queryAll((n) => n.type === "SymbolView").map((n) => n.props.name.ios as string);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  native.log.length = 0;
  native.request.mockClear();
  native.haptic.mockClear();
  useConnectionsStore.setState({ byComputer: {} });
  useConnectionsStore.getState().patch("f", () => ({ status: "online" }));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("agent-aware command bar", () => {
  it.each([
    ["codex", "Message Codex…"],
    ["claude", "Message Claude…"],
    ["aider", "Message Aider…"],
    ["unknown", "Message the agent…"],
    ["%%%", "Message the agent…"],
  ])("talks to %s in the placeholder and shows the agent glyph", async (kind, text) => {
    const { root, render } = setup();
    try {
      await render({ agent: { kind } });
      expect(placeholder(root)).toBe(text);
      expect(icons(root)).toContain("sparkles");
      const prompt = root.container.queryAll((n) => n.type === "Text" && n.children.includes("$"));
      expect(prompt).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps the shell prompt and shell key order without an agent", async () => {
    const { root, render } = setup();
    try {
      await render();
      expect(placeholder(root)).toBe("Type a command, then send");
      expect(icons(root)).not.toContain("sparkles");
      expect(
        root.container.queryAll((n) => n.type === "Text" && n.children.includes("$")),
      ).toHaveLength(1);
      expect(keyRow(root).slice(0, 6)).toEqual([
        "Control C",
        "Tab",
        "Arrow up",
        "Arrow down",
        "Escape",
        "Enter",
      ]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("orders the keys for the agent and sends Shift-Tab and digits as keys", async () => {
    const { root, onTerminalInput, render } = setup();
    try {
      await render({ agent: { kind: "claude" } });
      expect(keyRow(root).slice(0, 9)).toEqual([
        "Escape",
        "Arrow up",
        "Arrow down",
        "Enter",
        "Shift Tab, switch mode",
        "Send 1",
        "Send 2",
        "Send 3",
        "Control C",
      ]);
      await act(async () => pressable(root, "Shift Tab, switch mode")[0]!.props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.key",
        reqId: "r1",
        sessionId: "tmux:a",
        key: "shift-tab",
      });
      await act(async () => pressable(root, "Send 2")[0]!.props.onPress());
      expect(onTerminalInput).toHaveBeenCalledExactlyOnceWith("2");
      expect(field(root, "Command draft")!.props.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("Send and Enter", () => {
  /** The trailing button of the command bar, after the field. */
  const action = (root: Root) =>
    root.container.queryAll(
      (n) =>
        n.type === "Pressable" &&
        (n.props.accessibilityLabel === "Send" ||
          (n.props.accessibilityLabel === "Enter" && n.props.onLongPress !== undefined)),
    )[0]!;

  it("turns an empty draft's Send into an enabled, outlined Enter that sends Return", async () => {
    const { root, render } = setup();
    try {
      await render();
      const enter = action(root);
      expect(enter.props.accessibilityLabel).toBe("Enter");
      expect(enter.props.disabled).toBe(false);
      expect(enter.props.accessibilityState.disabled).toBe(false);
      expect(enter.props.style).toMatchObject({
        borderColor: "#0f0",
        backgroundColor: "transparent",
      });
      await act(async () => enter.props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith({
        type: "input.key",
        reqId: "r1",
        sessionId: "tmux:a",
        key: "enter",
      });
      // Typing turns it back into Send, which sends the draft.
      await act(async () => field(root, "Command draft")!.props.onChangeText("ls"));
      expect(action(root).props.accessibilityLabel).toBe("Send");
      expect(action(root).props.style.backgroundColor).toBe("#0f0");
      // Whitespace is not a draft.
      await act(async () => field(root, "Command draft")!.props.onChangeText("  "));
      expect(action(root).props.accessibilityLabel).toBe("Enter");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("disables Enter only while the computer is unreachable", async () => {
    const { root, render } = setup();
    try {
      await render();
      await act(async () =>
        useConnectionsStore.getState().patch("f", () => ({ status: "offline" })),
      );
      expect(action(root).props.disabled).toBe(true);
      await act(async () =>
        useConnectionsStore.getState().patch("f", () => ({ status: "online" })),
      );
      expect(action(root).props.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("lets Return start a new line for an agent and sends the whole message once", async () => {
    const { root, render } = setup();
    const onSubmitLine = vi.fn(async () => true as const);
    try {
      await render({ agent: { kind: "claude" }, onSubmitLine });
      const draft = field(root, "Command draft")!;
      expect(draft.props.multiline).toBe(true);
      expect(draft.props.submitBehavior).toBe("newline");
      expect(draft.props.onSubmitEditing).toBeUndefined();
      expect(draft.props.returnKeyType).toBe("default");
      await act(async () => draft.props.onChangeText("Fix the flaky test\nthen run the suite"));
      await act(async () => action(root).props.onPress());
      expect(onSubmitLine).toHaveBeenCalledExactlyOnceWith(
        "Fix the flaky test\nthen run the suite",
        "r1",
      );
      expect(native.request).not.toHaveBeenCalled();
      expect(field(root, "Command draft")!.props.value).toBe("");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps Return as send for a shell", async () => {
    const { root, render } = setup();
    const onSubmitLine = vi.fn(async () => true as const);
    try {
      await render({ onSubmitLine });
      const draft = field(root, "Command draft")!;
      expect(draft.props.submitBehavior).toBe("submit");
      expect(draft.props.returnKeyType).toBe("send");
      await act(async () => draft.props.onChangeText("make test"));
      await act(async () => draft.props.onSubmitEditing());
      expect(onSubmitLine).toHaveBeenCalledExactlyOnceWith("make test", "r1");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("opens draft history from a long press on Send or Enter, and from a screen reader", async () => {
    const { root, render } = setup();
    try {
      useConnectionsStore.getState().patch("f", () => ({ history: ["npm ci", "make test"] }));
      await render();
      await act(async () => action(root).props.onLongPress());
      expect(field(root, "Command draft")!.props.value).toBe("make test");
      expect(action(root).props.accessibilityLabel).toBe("Send");
      await act(async () => action(root).props.onLongPress());
      expect(field(root, "Command draft")!.props.value).toBe("npm ci");
      await act(async () => field(root, "Command draft")!.props.onChangeText(""));
      expect(action(root).props.accessibilityActions).toEqual([
        { name: "longpress", label: "Previous command" },
      ]);
      await act(async () =>
        action(root).props.onAccessibilityAction({ nativeEvent: { actionName: "longpress" } }),
      );
      expect(field(root, "Command draft")!.props.value).toBe("make test");
      expect(native.request).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("waiting strip", () => {
  const MENU = {
    question: "Do you want to proceed?",
    options: [
      { digit: "1", label: "Yes" },
      { digit: "2", label: "Yes, and don't ask again for npm test" },
      { digit: "3", label: "No, and tell Codex what to do differently" },
    ],
  };
  const texts = (root: Root) =>
    root.container.queryAll((n) => n.type === "Text").flatMap((n) => n.children);

  it("replaces the keys row with generic replies when no menu can be read", async () => {
    const { root, onTerminalInput, render } = setup();
    try {
      await render({
        agent: { kind: "codex" },
        sessionState: "blocked",
        prompt: { question: "Overwrite config.json? [y/N]", options: null },
        showChips: true,
      });
      expect(texts(root)).toContain("Codex is waiting");
      expect(texts(root)).toContain("Overwrite config.json? [y/N]");
      expect(pressable(root, "Control C")).toHaveLength(0);
      // The strip stands in for the smaller reply chips too.
      expect(pressable(root, "Send y")).toHaveLength(0);
      const labels = ["Yes", "No", "Enter", "Escape"];
      const chips = root.container
        .queryAll((n) => n.type === "Pressable" && (n.props.style?.minHeight ?? 0) >= 48)
        .map((n) => n.props.accessibilityLabel);
      expect(chips).toEqual(labels);
      expect(pressable(root, "Escape")[0]!.props.style.borderColor).toMatch(/^#F59E0B/);
      await act(async () => pressable(root, "Yes")[0]!.props.onPress());
      expect(onTerminalInput).toHaveBeenCalledExactlyOnceWith("y");
      expect(native.haptic).toHaveBeenCalledTimes(1);
      // Answered: back to the keys row until the state changes again.
      expect(pressable(root, "Yes")).toHaveLength(0);
      expect(pressable(root, "Control C")).toHaveLength(1);
      await render({ agent: { kind: "codex" }, sessionState: "blocked", prompt: MENU });
      expect(pressable(root, "Yes")).toHaveLength(0);
      await render({ agent: { kind: "codex" }, sessionState: "running" });
      expect(texts(root)).not.toContain("Codex is waiting");
      expect(pressable(root, "Control C")).toHaveLength(1);
      await render({ agent: { kind: "codex" }, sessionState: "blocked", prompt: MENU });
      expect(texts(root)).toContain("Codex is waiting");
      expect(pressable(root, "Choose 1, Yes")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("offers one chip per numbered choice that types its digit, and keeps Esc", async () => {
    const { root, onTerminalInput, render } = setup();
    try {
      await render({ agent: { kind: "claude" }, sessionState: "blocked", prompt: MENU });
      expect(texts(root)).toContain("Claude is waiting");
      expect(texts(root)).toContain("Do you want to proceed?");
      const chips = root.container
        .queryAll((n) => n.type === "Pressable" && (n.props.style?.minHeight ?? 0) >= 48)
        .map((n) => n.props.accessibilityLabel);
      expect(chips).toEqual([
        "Choose 1, Yes",
        "Choose 2, Yes, and don't ask again for npm test",
        "Choose 3, No, and tell Codex what to do differently",
        "Escape",
      ]);
      expect(pressable(root, "Yes")).toHaveLength(0);
      expect(texts(root)).toContain("No, and tell Codex what to do differently");
      await act(async () =>
        pressable(root, "Choose 2, Yes, and don't ask again for npm test")[0]!.props.onPress(),
      );
      expect(onTerminalInput).toHaveBeenCalledExactlyOnceWith("2");
      expect(pressable(root, "Choose 1, Yes")).toHaveLength(0);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends Esc and Enter as keys and says who waits without a known agent", async () => {
    const { root, render } = setup();
    try {
      await render({ sessionState: "blocked", prompt: { question: null, options: null } });
      expect(texts(root)).toContain("Waiting for you");
      await act(async () => pressable(root, "Escape")[0]!.props.onPress());
      expect(native.request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ type: "input.key", key: "esc" }),
      );
      expect(native.haptic).toHaveBeenCalledTimes(1);
      await render({ sessionState: "running" });
      await render({ sessionState: "blocked" });
      await act(async () => pressable(root, "Enter")[0]!.props.onPress());
      expect(native.request).toHaveBeenLastCalledWith(
        expect.objectContaining({ type: "input.key", key: "enter" }),
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("stays out of Live keys and Secret input, and keeps waiting while offline", async () => {
    const { root, render } = setup();
    try {
      await render({ sessionState: "blocked", alternateScreen: true });
      expect(field(root, "Live keys input")).toBeDefined();
      expect(texts(root)).not.toContain("Waiting for you");
      await render({ sessionState: "blocked", alternateScreen: false, secretPrompt: true });
      expect(texts(root)).toContain("Waiting for you");
      await act(async () => pressable(root, "Type password securely")[0]!.props.onPress());
      expect(texts(root)).not.toContain("Waiting for you");
      await act(async () => pressable(root, "Cancel secret input")[0]!.props.onPress());
      await act(async () =>
        useConnectionsStore.getState().patch("f", () => ({ status: "offline" })),
      );
      expect(pressable(root, "Yes")[0]!.props.disabled).toBe(true);
      await act(async () => pressable(root, "Yes")[0]!.props.onPress());
      // Nothing was sent, so the strip stays.
      expect(pressable(root, "Yes")).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("keeps only the replies, at key height, in a short pane", async () => {
    const { root, render } = setup();
    try {
      await render({ sessionState: "blocked", prompt: MENU, availableHeight: 92 });
      expect(texts(root)).not.toContain("Waiting for you");
      expect(texts(root)).not.toContain("Do you want to proceed?");
      expect(pressable(root, "Choose 1, Yes")[0]!.props.style.minHeight).toBe(40);
    } finally {
      await act(async () => root.unmount());
    }
  });
});

describe("Live keys toggle", () => {
  const toggle = (root: Root) => pressable(root, "Live keys")[0];
  /** The field's row: the View holding the text field. */
  const fieldRow = (root: Root, label: string) =>
    root.container.queryAll(
      (n) =>
        n.type === "View" &&
        n.queryAll((c) => c.type === "TextInput" && c.props.accessibilityLabel === label).length >
          0 &&
        n.props.style?.borderRadius === 16,
    )[0]!;

  it("sits in the field next to the history button, not in the keys row", async () => {
    const { root, render } = setup();
    try {
      await render();
      expect(keyRow(root)).not.toContain("Live keys");
      const row = root.container.queryAll(
        (n) => n.type === "ScrollView" && n.props.horizontal === true,
      )[0]!;
      expect(row.queryAll((n) => n.props.accessibilityLabel === "Live keys")).toHaveLength(0);
      const inField = fieldRow(root, "Command draft")
        .queryAll((n) => n.type === "Pressable")
        .map((n) => n.props.accessibilityLabel);
      expect(inField).toEqual(["Previous command", "Live keys"]);
      expect(toggle(root)!.props.accessibilityRole).toBe("switch");
      expect(toggle(root)!.props.accessibilityState.checked).toBe(false);
      expect(icons(root)).toContain("keyboard");
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("fills with the accent when on and stays in the Live field to turn it off", async () => {
    const { root, render } = setup();
    try {
      await render();
      await act(async () => toggle(root)!.props.onPress());
      const live = field(root, "Live keys input")!;
      expect(live.props.placeholder).toBe("Typing goes straight to the terminal");
      expect(
        fieldRow(root, "Live keys input")
          .queryAll((n) => n.type === "Pressable")
          .map((n) => n.props.accessibilityLabel),
      ).toEqual(["Live keys"]);
      expect(toggle(root)!.props.accessibilityState.checked).toBe(true);
      const disc = toggle(root)!.queryAll((n) => n.type === "View")[0]!;
      expect(disc.props.style.backgroundColor).toBe("#0f0");
      await act(async () => toggle(root)!.props.onPress());
      expect(field(root, "Command draft")).toBeDefined();
      expect(toggle(root)!.queryAll((n) => n.type === "View")[0]!.props.style.backgroundColor).toBe(
        "transparent",
      );
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("is hidden for an agent unless a full-screen program is running", async () => {
    const { root, render } = setup();
    try {
      await render({ agent: { kind: "claude" } });
      expect(toggle(root)).toBeUndefined();
      await render({ agent: { kind: "claude" }, alternateScreen: false });
      expect(toggle(root)).toBeUndefined();
      // The host's report still turns Live keys on and off by itself.
      await render({ agent: { kind: "claude" }, alternateScreen: true });
      expect(field(root, "Live keys input")).toBeDefined();
      expect(toggle(root)).toBeDefined();
      await render({ agent: { kind: "claude" }, alternateScreen: false });
      expect(field(root, "Command draft")).toBeDefined();
      expect(toggle(root)).toBeUndefined();
      // Without exact terminal input there are no Live keys to offer.
      await render({ terminalControls: undefined, onTerminalInput: undefined });
      expect(toggle(root)).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("stays available while blocked, when the keys row gives way to the strip", async () => {
    const { root, render } = setup();
    try {
      await render({ sessionState: "blocked" });
      expect(pressable(root, "Control C")).toHaveLength(0);
      expect(toggle(root)).toBeDefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
