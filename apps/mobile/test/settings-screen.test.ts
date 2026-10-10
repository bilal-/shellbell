import * as LocalAuthentication from "expo-local-authentication";
import { act, createElement } from "react";
import { Alert } from "react-native";
import { createRoot } from "test-renderer";
import { expect, it, vi } from "vitest";
import SettingsScreen from "../app/settings";
import { LOCK_DEFAULTS, useAppLock } from "../src/security/app-lock";
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
  Platform: { OS: "ios" },
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

it("turns App Lock off only after a warning and the phone's own authentication", async () => {
  const auth = vi.mocked(LocalAuthentication);
  auth.getEnrolledLevelAsync.mockResolvedValue(LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG);
  auth.supportedAuthenticationTypesAsync.mockResolvedValue([
    LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
  ]);
  useAppLock.setState({ ...LOCK_DEFAULTS, hydrated: true, locked: false });
  const alert = vi.mocked(Alert.alert);
  const root = createRoot();
  await act(async () => root.render(createElement(SettingsScreen)));
  const lockSwitch = () =>
    root.container.queryAll(
      (node) => node.type === "Switch" && node.props.accessibilityLabel === "App Lock",
    )[0]!;
  const text = () =>
    root.container
      .queryAll((node) => node.type === "Text")
      .flatMap((node) => node.props.children)
      .join(" ");
  try {
    expect(lockSwitch().props.value).toBe(true);
    expect(text()).toContain("Ask for Face ID");
    expect(text()).toContain("Your passcode also works.");

    await act(async () => lockSwitch().props.onValueChange(false));
    const [title, message, buttons] = alert.mock.calls.at(-1)!;
    expect(title).toBe("Turn off App Lock?");
    expect(message).toContain("at your own risk");
    expect(useAppLock.getState().enabled).toBe(true);
    const turnOff = buttons!.find((b) => b.text === "Turn Off")!;

    auth.authenticateAsync.mockResolvedValueOnce({ success: false, error: "user_cancel" });
    await act(async () => turnOff.onPress!());
    expect(useAppLock.getState().enabled).toBe(true);

    auth.authenticateAsync.mockResolvedValueOnce({ success: true });
    await act(async () => turnOff.onPress!());
    expect(useAppLock.getState().enabled).toBe(false);
    expect(lockSwitch().props.value).toBe(false);
    expect(text()).toContain("Anyone who can open this phone");
  } finally {
    await act(async () => root.unmount());
  }
});
