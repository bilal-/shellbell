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
