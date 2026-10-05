import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({ Pressable: "Pressable", ScrollView: "ScrollView", Text: "Text" }));

import { QuickKeys } from "../src/input/QuickKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("remote quick keys", () => {
  it.each([
    ["darwin", "⌃C", "Return"],
    ["linux", "Ctrl+C", "Enter"],
    ["win32", "Ctrl+C", "Enter"],
    ["unknown", "Ctrl+C", "Enter"],
    [undefined, "Ctrl+C", "Enter"],
  ] as const)(
    "presents %s while sending the original named keys",
    async (hostPlatform, ctrlLabel, enterName) => {
      const root = createRoot();
      const onKey = vi.fn();
      const onPaste = vi.fn();
      const onGuide = vi.fn();
      try {
        await act(async () =>
          root.render(createElement(QuickKeys, { hostPlatform, onKey, onPaste, onGuide })),
        );
        const buttons = root.container.queryAll((node) => node.type === "Pressable");
        // The explanation must be reachable before scrolling past unfamiliar keys.
        expect(buttons[0]?.props.accessibilityLabel).toBe("Key guide");
        const keyButtons = buttons.filter(
          (node) => !["Paste to terminal", "Key guide"].includes(node.props.accessibilityLabel),
        );
        expect(keyButtons.map((node) => node.props.accessibilityLabel)).toEqual([
          "Escape",
          "Tab",
          "Backspace",
          "Control C",
          "Control D",
          "Control Z",
          "Control L",
          "Control U",
          "Arrow up",
          "Arrow down",
          "Arrow left",
          "Arrow right",
          enterName,
          "Control R",
          "Control A",
          "Control E",
        ]);
        expect(
          root.container.queryAll((node) => node.type === "Text").flatMap((node) => node.children),
        ).toContain(ctrlLabel);
        for (const button of keyButtons) {
          expect(button.props.accessibilityRole).toBe("button");
          expect(button.props.accessibilityHint).toMatch(/terminal/i);
          await act(async () => button.props.onPress());
        }
        expect(onKey.mock.calls.map(([key]) => key)).toEqual([
          "esc",
          "tab",
          "backspace",
          "ctrl-c",
          "ctrl-d",
          "ctrl-z",
          "ctrl-l",
          "ctrl-u",
          "up",
          "down",
          "left",
          "right",
          "enter",
          "ctrl-r",
          "ctrl-a",
          "ctrl-e",
        ]);
        onKey.mockClear();
        await act(async () =>
          buttons.find((node) => node.props.accessibilityLabel === "Key guide")!.props.onPress(),
        );
        expect(onGuide).toHaveBeenCalledTimes(1);
        expect(onKey).not.toHaveBeenCalled();
        expect(onPaste).not.toHaveBeenCalled();
        await act(async () =>
          buttons
            .find((node) => node.props.accessibilityLabel === "Paste to terminal")!
            .props.onPress(),
        );
        expect(onPaste).toHaveBeenCalledTimes(1);
        expect(onKey).not.toHaveBeenCalled();
      } finally {
        await act(async () => root.unmount());
      }
    },
  );
});
