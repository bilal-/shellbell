import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-native", () => ({
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Text: "Text",
  View: "View",
}));

import { bytesForKey } from "@shellbell/protocol";
import { COMPACT_KEY_ROW_HEIGHT, composerLayout } from "../src/input/layout";
import { QuickKeys, WARNING_KEY_COLOR } from "../src/input/QuickKeys";

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
      // The keys a phone keyboard lacks come first, before the modifiers and the rest of the row.
      expect(
        root.container
          .queryAll((node) => node.type === "Pressable")
          .slice(0, 7)
          .map((node) => node.props.accessibilityLabel),
      ).toEqual([
        "Control C",
        "Tab",
        "Arrow up",
        "Arrow down",
        "Escape",
        "Enter",
        "Shift modifier",
      ]);
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
        // The first keys are the ones a phone keyboard lacks; the guide closes the row.
        expect(buttons.at(-1)?.props.accessibilityLabel).toBe("Key guide");
        const keyButtons = buttons.filter(
          (node) => !["Paste to terminal", "Key guide"].includes(node.props.accessibilityLabel),
        );
        expect(keyButtons.map((node) => node.props.accessibilityLabel)).toEqual([
          "Control C",
          "Tab",
          "Arrow up",
          "Arrow down",
          "Escape",
          enterName,
          "Arrow left",
          "Arrow right",
          "Backspace",
          "Shift Tab",
          "Control D",
          "Control Z",
          "Control L",
          "Control U",
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
          "ctrl-c",
          "tab",
          "up",
          "down",
          "esc",
          "enter",
          "left",
          "right",
          "backspace",
          "shift-tab",
          "ctrl-d",
          "ctrl-z",
          "ctrl-l",
          "ctrl-u",
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

  const renderKeys = async (props: Partial<Parameters<typeof QuickKeys>[0]> = {}) => {
    const root = createRoot();
    const onKey = vi.fn();
    const onText = vi.fn(() => true);
    await act(async () =>
      root.render(
        createElement(QuickKeys, {
          onKey,
          onText,
          onPaste: vi.fn(),
          hostPlatform: "linux",
          ...props,
        }),
      ),
    );
    const labels = () =>
      root.container
        .queryAll((node) => node.type === "Pressable")
        .map((node) => node.props.accessibilityLabel as string);
    const button = (label: string) => {
      const match = root.container.queryAll(
        (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
      )[0];
      expect(match, label).toBeDefined();
      return match!;
    };
    return { root, onKey, onText, labels, button };
  };

  it("puts a coding agent's keys first: Esc, menus, Shift-Tab, digits, then ^C", async () => {
    const { root, onKey, onText, labels, button } = await renderKeys({ agent: true });
    try {
      expect(labels().slice(0, 10)).toEqual([
        "Escape",
        "Arrow up",
        "Arrow down",
        "Enter",
        "Shift Tab, switch mode",
        "Send 1",
        "Send 2",
        "Send 3",
        "Control C",
        "Shift modifier",
      ]);
      // The rest of the row follows the modifiers, Tab included.
      expect(labels()).toContain("Tab");
      expect(labels()).toContain("Control E");
      expect(
        root.container.queryAll((node) => node.type === "Text").flatMap((node) => node.children),
      ).toContain("⇧Tab");
      await act(async () => button("Shift Tab, switch mode").props.onPress());
      expect(onKey).toHaveBeenCalledExactlyOnceWith("shift-tab");
      expect(bytesForKey("shift-tab")).toBe("\x1b[Z");
      for (const digit of ["1", "2", "3"])
        await act(async () => button(`Send ${digit}`).props.onPress());
      expect(onText.mock.calls).toEqual([["1"], ["2"], ["3"]]);
      expect(onKey).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("sends Shift-Tab and the digits with modifiers as terminal bytes", async () => {
    const { root, onKey, onText, button } = await renderKeys({ agent: true });
    try {
      await act(async () => button("Alt modifier").props.onPress());
      await act(async () => button("Alt Shift Tab, switch mode").props.onPress());
      expect(onText).toHaveBeenLastCalledWith("\x1b\x1b[Z");
      await act(async () => button("Alt modifier").props.onPress());
      await act(async () => button("Alt Send 2").props.onPress());
      expect(onText).toHaveBeenLastCalledWith("\x1b2");
      // Control has no encoding for a digit.
      await act(async () => button("Control modifier").props.onPress());
      expect(button("Control Send 1").props.disabled).toBe(true);
      expect(onKey).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("leaves the digits out when no character can be typed", async () => {
    const { root, labels } = await renderKeys({ agent: true, onText: undefined });
    try {
      expect(labels().slice(0, 6)).toEqual([
        "Escape",
        "Arrow up",
        "Arrow down",
        "Enter",
        "Shift Tab, switch mode",
        "Control C",
      ]);
      expect(labels().filter((label) => /^Send \d$/.test(label))).toEqual([]);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("tints Esc and ^C, and only those, with the warning colour", async () => {
    for (const agent of [false, true]) {
      const { root } = await renderKeys({ agent });
      try {
        const warned = root.container
          .queryAll(
            (node) =>
              node.type === "Pressable" &&
              typeof node.props.style?.borderColor === "string" &&
              node.props.style.borderColor.startsWith(WARNING_KEY_COLOR),
          )
          .map((node) => node.props.accessibilityLabel);
        expect(warned).toEqual(agent ? ["Escape", "Control C"] : ["Control C", "Escape"]);
        expect(
          root.container
            .queryAll(
              (node) => node.type === "Text" && node.props.style?.color === WARNING_KEY_COLOR,
            )
            .flatMap((node) => node.children),
        ).toEqual(agent ? ["Esc", "Ctrl+C"] : ["Ctrl+C", "Esc"]);
      } finally {
        await act(async () => root.unmount());
      }
    }
  });

  it("keeps compact keys 40 points tall, 8 points apart", async () => {
    expect(COMPACT_KEY_ROW_HEIGHT).toBe(40);
    expect(composerLayout(92, 40, false).keyHeight).toBe(40);
    const { root, button } = await renderKeys({ keyHeight: COMPACT_KEY_ROW_HEIGHT });
    try {
      expect(button("Control C").props.style.height).toBe(40);
      const row = root.container.queryAll((node) => node.type === "ScrollView")[0]!;
      expect(row.props.contentContainerStyle.gap).toBe(8);
    } finally {
      await act(async () => root.unmount());
    }
  });

  it("fades the right edge only while more keys lie beyond it", async () => {
    const { root } = await renderKeys({ agent: true });
    const fade = () => root.container.queryAll((node) => node.props.testID === "keys-edge-fade")[0];
    const row = () => root.container.queryAll((node) => node.type === "ScrollView")[0]!;
    const scrollTo = (x: number) =>
      act(async () => row().props.onScroll({ nativeEvent: { contentOffset: { x, y: 0 } } }));
    try {
      expect(fade()).toBeUndefined();
      await act(async () => row().props.onLayout({ nativeEvent: { layout: { width: 360 } } }));
      await act(async () => row().props.onContentSizeChange(1400, 44));
      expect(fade()).toBeDefined();
      // It never takes a tap or a screen reader's focus from the key under it.
      expect(fade()!.props.pointerEvents).toBe("none");
      expect(fade()!.props.importantForAccessibility).toBe("no-hide-descendants");
      expect(fade()!.props.style).toMatchObject({ position: "absolute", right: 0 });
      await scrollTo(500);
      expect(fade()).toBeDefined();
      await scrollTo(1040);
      expect(fade()).toBeUndefined();
      await scrollTo(0);
      expect(fade()).toBeDefined();
      // A row that fits, such as a landscape tablet's, has nothing to hint at.
      await act(async () => row().props.onLayout({ nativeEvent: { layout: { width: 1600 } } }));
      expect(fade()).toBeUndefined();
    } finally {
      await act(async () => root.unmount());
    }
  });
});
