import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import SettingsScreen from "../app/settings";
import { useUiStore } from "../src/store/computers";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));
vi.stubGlobal("__DEV__", false);
vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Linking: { openURL: vi.fn() },
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  Switch: "Switch",
  Text: "Text",
  View: "View",
  StyleSheet: { create: (styles: object) => styles },
}));
vi.mock("expo-application", () => ({ nativeApplicationVersion: "0.1.0", nativeBuildVersion: "4" }));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "99.0.0" } } }));
vi.mock("expo-device", () => ({ deviceName: "Fold 7" }));
vi.mock("expo-router", () => ({ Link: "Link" }));
vi.mock("../src/ui/ShellbellMark", () => ({ ShellbellMark: "ShellbellMark" }));
vi.mock("../src/identity/keys", () => ({
  loadOrCreateIdentity: async () => ({ fp: "a".repeat(64) }),
}));
vi.mock("../src/notifications/native", () => ({
  nativeNotificationsAvailable: false,
  nativeNotifications: {},
}));
vi.mock("../src/store/computers", async () => {
  const { create } = await import("zustand");
  return {
    MIN_FONT_SIZE: 5,
    MAX_FONT_SIZE: 24,
    useUiStore: create<{
      fontSize: number;
      fitWidth: boolean;
      setFontSize: (n: number) => void;
      setFitWidth: (b: boolean) => void;
    }>((set) => ({
      fontSize: 14,
      fitWidth: false,
      setFontSize: (fontSize) => set({ fontSize }),
      setFitWidth: (fitWidth) => set({ fitWidth }),
    })),
  };
});

it("shows the installed version and preserves the chosen font size while automatic fitting disables its controls", async () => {
  const root = createRoot();
  await act(async () => root.render(createElement(SettingsScreen)));
  const button = (label: string) =>
    root.container.queryAll(
      (node) => node.type === "Pressable" && node.props.accessibilityLabel === label,
    )[0]!;
  const fitSwitch = () =>
    root.container.queryAll(
      (node) => node.type === "Switch" && node.props.accessibilityLabel === "Scale terminal to fit",
    )[0]!;
  const text = () =>
    root.container
      .queryAll((node) => node.type === "Text")
      .flatMap((node) => node.props.children)
      .join(" ");
  try {
    expect(text()).toContain("0.1.0");
    expect(text()).toContain("Build 4");
    expect(text()).not.toContain("99.0.0");
    expect(button("Increase font size").props.disabled).toBe(false);
    await act(async () => button("Increase font size").props.onPress());
    expect(useUiStore.getState().fontSize).toBe(15);
    await act(async () => fitSwitch().props.onValueChange(true));
    expect(button("Increase font size").props.disabled).toBe(true);
    expect(button("Decrease font size").props.accessibilityState.disabled).toBe(true);
    expect(text()).toContain("Auto");
    expect(text()).toContain("does not wrap text");
    expect(text()).toContain("Tap Read in a session");
    expect(useUiStore.getState().fontSize).toBe(15);
    await act(async () => fitSwitch().props.onValueChange(false));
    expect(button("Increase font size").props.disabled).toBe(false);
    expect(useUiStore.getState().fontSize).toBe(15);
  } finally {
    await act(async () => root.unmount());
  }
});
