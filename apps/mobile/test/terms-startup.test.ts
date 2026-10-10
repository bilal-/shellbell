import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { beforeEach, expect, it, vi } from "vitest";
import RootLayout from "../app/_layout";
import { acceptTerms } from "../src/store/consent";
import { consentStorage, resetConsentStorage } from "./helpers/consent-storage";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const flow = vi.hoisted(() => ({
  start: vi.fn(),
  stop: vi.fn(),
  monitor: vi.fn(() => vi.fn()),
  hydrate: vi.fn(),
  retry: vi.fn().mockResolvedValue(undefined),
  identity: vi.fn(),
}));
vi.mock("../src/bootstrap/crypto", () => ({}));
vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));
vi.mock("expo-constants", () => ({ default: { expoConfig: { version: "1.1.0" } } }));
vi.mock("expo-device", () => ({ deviceName: "Test phone" }));
vi.mock("expo-linking", () => ({
  addEventListener: () => ({ remove: vi.fn() }),
  getInitialURL: async () => null,
}));
vi.mock("expo-splash-screen", () => ({ preventAutoHideAsync: vi.fn(), hideAsync: vi.fn() }));
vi.mock("expo-system-ui", () => ({ setBackgroundColorAsync: vi.fn() }));
vi.mock("expo-status-bar", () => ({ StatusBar: "StatusBar" }));
vi.mock("expo-router", async () => {
  const { createElement } = await import("react");
  return {
    Stack: Object.assign((props: object) => createElement("Stack", props), { Screen: "Screen" }),
    ThemeProvider: "ThemeProvider",
    DarkTheme: {},
    router: { navigate: vi.fn(), push: vi.fn() },
  };
});
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  ScrollView: "ScrollView",
  StyleSheet: { create: (value: unknown) => value },
  Linking: { openURL: vi.fn() },
  AppState: { currentState: "active", addEventListener: () => ({ remove: vi.fn() }) },
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: "SafeAreaProvider",
  SafeAreaView: "SafeAreaView",
}));
vi.mock("react-native-gesture-handler", () => ({
  GestureHandlerRootView: "GestureHandlerRootView",
}));
vi.mock("react-native-keyboard-controller", () => ({ KeyboardProvider: "KeyboardProvider" }));
vi.mock("../src/identity/keys", () => ({ loadOrCreateIdentity: flow.identity }));
vi.mock("../src/net/manager", () => ({
  connectionManager: { start: flow.start, stop: flow.stop },
}));
vi.mock("../src/net/native-network", () => ({ startNetworkMonitor: flow.monitor }));
vi.mock("../src/net/revocation-retry", () => ({ retryPendingRevocations: flow.retry }));
vi.mock("../src/store/computers", () => ({
  useComputersStore: { getState: () => ({ hydrate: flow.hydrate, computers: [] }) },
  useUiStore: { getState: () => ({ hydrate: flow.hydrate }) },
}));
vi.mock("../src/store/network", () => ({ networkSource: {} }));
vi.mock("../src/notifications", () => ({
  ensureChannel: vi.fn(),
  getNativePushToken: vi.fn(),
  installNativePushTokenListener: () => vi.fn(),
  installNotificationHandler: vi.fn(),
  installTapHandler: () => vi.fn(),
  kvTitleStorage: {},
  registerRingTask: vi.fn(),
  showForegroundEvent: vi.fn(),
}));
vi.mock("../src/notifications/native", () => ({
  nativeNotifications: {},
  nativeNotificationsAvailable: false,
}));
vi.mock("../src/notifications/routing", () => ({
  createTapHandler: () => vi.fn(),
  parseDeepLink: () => null,
}));
vi.mock("../src/ui/NavigationViewport", () => ({ NavigationViewport: "NavigationViewport" }));
vi.mock("../src/ui/NetworkBanner", () => ({ NetworkBanner: "NetworkBanner" }));
vi.mock("../src/ui/SettingsButton", () => ({ SettingsButton: "SettingsButton" }));
vi.mock("../src/ui/ToastHost", () => ({ ToastHost: "ToastHost" }));

beforeEach(() => {
  resetConsentStorage();
  vi.clearAllMocks();
  flow.identity.mockReset().mockResolvedValue({ identity: {}, fp: "test-phone" });
});
function button(root: ReturnType<typeof createRoot>, label: string) {
  return root.container
    .queryAll((node) => node.type === "Pressable")
    .find((node) => node.props.children.props.children === label)!;
}
it("keeps actual root startup, revocation retries and identity access behind saved agreement", async () => {
  const root = createRoot();
  try {
    await act(async () => root.render(createElement(RootLayout)));
    await act(async () => button(root, "Decline").props.onPress());
    for (const operation of [flow.start, flow.hydrate, flow.monitor, flow.retry, flow.identity]) {
      expect(operation).not.toHaveBeenCalled();
    }
    await act(async () => button(root, "Review terms").props.onPress());
    consentStorage.setItemSync.mockImplementationOnce(() => {
      throw new Error("locked");
    });
    await act(async () => button(root, "Agree").props.onPress());
    expect(flow.start).not.toHaveBeenCalled();
    expect(flow.identity).not.toHaveBeenCalled();
    await act(async () => button(root, "Agree").props.onPress());
    expect(flow.start).toHaveBeenCalledTimes(1);
    expect(flow.retry).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
  expect(flow.stop).toHaveBeenCalledTimes(1);
});
it("does not start a connection after the root unmounts during identity loading", async () => {
  acceptTerms();
  let resolve!: (value: object) => void;
  flow.identity.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const root = createRoot();
  await act(async () => root.render(createElement(RootLayout)));
  await act(async () => root.unmount());
  await act(async () => resolve({ identity: {}, fp: "test-phone" }));
  expect(flow.start).not.toHaveBeenCalled();
  expect(flow.stop).toHaveBeenCalledTimes(1);
});
