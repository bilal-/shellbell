import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));

import { QuickKeys } from "../src/input/QuickKeys";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("remote quick keys", () => {
  it("keeps the modifiers armed when input is rejected and clears them after an accepted character", async () => {
    const onText = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
    const root = createRoot();
    try {
      await act(async () =>
        root.render(
          createElement(QuickKeys, {
            onKey: vi.fn(),
            onText,
            onPaste: vi.fn(),
            hostPlatform: "linux",
          }),
        ),
      );
      const button = (label: string) =>
        root.container.queryAll(
          (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
        )[0]!;
      await act(async () => button("Control modifier").props.onPress());
      await act(async () => button("Alt modifier").props.onPress());
      expect(button("Control Alt Tab").props.disabled).toBe(true);
      expect(button("Alt Control C")).toBeDefined();
      expect(
        root.container.queryAll(
          (node) =>
            node.type === "Pressable" && /Control Control/.test(node.props.accessibilityLabel),
        ),
      ).toHaveLength(0);
      await act(async () => button("Send Control Alt C").props.onPress());
      expect(onText).toHaveBeenLastCalledWith("\x1b\x03");
      expect(button("Control modifier").props.accessibilityState.selected).toBe(true);
      expect(button("Alt modifier").props.accessibilityState.selected).toBe(true);
      await act(async () => button("Send Control Alt C").props.onPress());
      expect(onText).toHaveBeenCalledTimes(2);
      expect(button("Control modifier").props.accessibilityState.selected).toBe(false);
      expect(button("Alt modifier").props.accessibilityState.selected).toBe(false);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("disables modifier and input buttons while terminal input is paused", async () => {
    const root = createRoot();
    try {
      await act(async () =>
        root.render(
          createElement(QuickKeys, {
            onKey: vi.fn(),
            onText: vi.fn(),
            onPaste: vi.fn(),
            disabled: true,
          }),
        ),
      );
      const buttons = root.container.queryAll((node) => node.type === "Pressable");
      expect(buttons.length).toBeGreaterThan(16);
      expect(
        buttons.every(
          (node) => node.props.disabled === true && node.props.accessibilityState.disabled === true,
        ),
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends Shift Left as a modified terminal key without changing the ordinary arrow", async () => {
    const onKey = vi.fn();
    const onText = vi.fn();
    const root = createRoot();
    try {
      await act(async () =>
        root.render(
          createElement(QuickKeys, {
            onKey,
            onText,
            onPaste: vi.fn(),
          }),
        ),
      );
      const button = (label: string) => {
        const match = root.container.queryAll(
          (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
        )[0];
        expect(match, label).toBeDefined();
        return match!;
      };
      expect(
        root.container.queryAll((node) => node.type === "Pressable")[3]?.props.accessibilityLabel,
      ).toBe("Arrow left");
      await act(async () => button("Shift modifier").props.onPress());
      expect(button("Shift modifier").props.accessibilityState.selected).toBe(true);
      await act(async () => button("Shift Arrow left").props.onPress());
      expect(onText).toHaveBeenCalledExactlyOnceWith("\x1b[1;2D");
      expect(onKey).not.toHaveBeenCalled();
      expect(button("Shift modifier").props.accessibilityState.selected).toBe(false);
      await act(async () => button("Arrow left").props.onPress());
      expect(onKey).toHaveBeenCalledExactlyOnceWith("left");
    } finally {
      await act(async () => root.unmount());
    }
  });

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
