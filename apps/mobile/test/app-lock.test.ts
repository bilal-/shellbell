import * as LocalAuthentication from "expo-local-authentication";
import { act, createElement } from "react";
import { createRoot } from "test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppLockGate } from "../src/components/AppLockGate";
import {
  LOCK_DEFAULTS,
  lockAfterAway,
  readLockSettings,
  useAppLock,
} from "../src/security/app-lock";
import { controlLocked } from "../src/security/control-lock";
import { authenticate } from "../src/security/unlock-method";
import { useComputersStore } from "../src/store/computers";
import { consentData, consentStorage, resetConsentStorage } from "./helpers/consent-storage";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const app = vi.hoisted(() => ({
  state: "active" as string,
  listeners: new Set<(state: string) => void>(),
}));
vi.mock("expo-sqlite/kv-store", async () => ({
  default: (await import("./helpers/consent-storage")).consentStorage,
}));
vi.mock("react-native", () => ({
  View: "View",
  Text: "Text",
  Pressable: "Pressable",
  Modal: "Modal",
  StyleSheet: { create: (value: unknown) => value },
  Keyboard: { dismiss: vi.fn() },
  Platform: { OS: "ios" },
  Animated: {
    Value: class {
      interpolate() {
        return 0;
      }
    },
    View: "Animated.View",
    timing: () => ({ start: vi.fn() }),
  },
  AppState: {
    get currentState() {
      return app.state;
    },
    addEventListener: (_: string, listener: (state: string) => void) => {
      app.listeners.add(listener);
      return { remove: () => app.listeners.delete(listener) };
    },
  },
}));
vi.mock("react-native-safe-area-context", () => ({ SafeAreaView: "SafeAreaView" }));
vi.mock("../src/ui/SplashMark", () => ({ SplashMark: "SplashMark" }));

const auth = vi.mocked(LocalAuthentication);
const KEY = "shellbell.app-lock.v1";
const computer = {
  fp: "f".repeat(64),
  name: "Mac",
  accent: "amber",
  relayUrl: "wss://relay.example",
  pairedAt: "2026-10-10T00:00:00.000Z",
  lastSeenAt: null,
  pushEnabled: true,
};

async function changeAppState(state: string) {
  app.state = state;
  await act(async () => {
    for (const listener of [...app.listeners]) listener(state);
  });
}

async function mount() {
  const root = createRoot();
  await act(async () => root.render(createElement(AppLockGate, null, createElement("Terminal"))));
  return root;
}

const modal = (root: ReturnType<typeof createRoot>) =>
  root.container.queryAll((node) => node.type === "Modal")[0]!;
const unlockButton = (root: ReturnType<typeof createRoot>) =>
  root.container.queryAll((node) => node.type === "Pressable")[0];

beforeEach(() => {
  resetConsentStorage();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.parse("2026-10-10T12:00:00Z"));
  app.state = "active";
  app.listeners.clear();
  useAppLock.setState({ ...LOCK_DEFAULTS, hydrated: false, locked: true });
  useComputersStore.setState({ computers: [computer], hydrated: true });
  auth.getEnrolledLevelAsync.mockResolvedValue(LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG);
  auth.supportedAuthenticationTypesAsync.mockResolvedValue([
    LocalAuthentication.AuthenticationType.FACIAL_RECOGNITION,
  ]);
  auth.authenticateAsync.mockReset().mockResolvedValue({ success: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("saved settings", () => {
  it("defaults on and fails closed on anything but an explicit off", () => {
    expect(readLockSettings()).toEqual({ enabled: true, delayMs: 60_000 });
    consentData.set(KEY, "{not json");
    expect(readLockSettings().enabled).toBe(true);
    consentData.set(KEY, JSON.stringify({ enabled: "no", delayMs: 12 }));
    expect(readLockSettings()).toEqual({ enabled: true, delayMs: 60_000 });
    consentData.set(KEY, JSON.stringify({ enabled: false, delayMs: 0 }));
    expect(readLockSettings()).toEqual({ enabled: false, delayMs: 0 });
  });

  it("treats a clock moved backwards as long enough away", () => {
    expect(lockAfterAway(59_999, 60_000)).toBe(false);
    expect(lockAfterAway(60_000, 60_000)).toBe(true);
    expect(lockAfterAway(-1, 900_000)).toBe(true);
    expect(lockAfterAway(0, 0)).toBe(true);
  });

  it("persists choices and releases the lock when turned off", () => {
    useAppLock.getState().setDelay(300_000);
    useAppLock.getState().setEnabled(false);
    expect(JSON.parse(consentStorage.setItemSync.mock.calls.at(-1)![1])).toEqual({
      enabled: false,
      delayMs: 300_000,
    });
    expect(useAppLock.getState().locked).toBe(false);
    expect(controlLocked()).toBe(false);
  });
});

describe("AppLockGate", () => {
  it("locks a cold start, asks with Face ID and refuses control until unlocked", async () => {
    let finish!: (value: { success: true }) => void;
    auth.authenticateAsync.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const root = await mount();
    try {
      expect(modal(root).props.visible).toBe(true);
      expect(controlLocked()).toBe(true);
      expect(auth.authenticateAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          disableDeviceFallback: false,
          biometricsSecurityLevel: "strong",
        }),
      );
      expect(unlockButton(root)!.props.accessibilityLabel).toBe("Unlock with Face ID");
      await act(async () => finish({ success: true }));
      expect(modal(root).props.visible).toBe(false);
      expect(controlLocked()).toBe(false);
      expect(root.container.queryAll((node) => node.type === "Terminal")).toHaveLength(1);
    } finally {
      root.unmount();
    }
  });

  it("does not lock a fresh install, a phone without a passcode or a choice to turn it off", async () => {
    for (const setup of [
      () => useComputersStore.setState({ computers: [] }),
      () => auth.getEnrolledLevelAsync.mockResolvedValue(LocalAuthentication.SecurityLevel.NONE),
      () => consentData.set(KEY, JSON.stringify({ enabled: false, delayMs: 60_000 })),
    ]) {
      resetConsentStorage();
      useAppLock.setState({ ...LOCK_DEFAULTS, hydrated: false, locked: true });
      useComputersStore.setState({ computers: [computer], hydrated: true });
      auth.getEnrolledLevelAsync.mockResolvedValue(
        LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG,
      );
      auth.authenticateAsync.mockClear();
      setup();
      const root = await mount();
      try {
        expect(modal(root).props.visible).toBe(false);
        expect(controlLocked()).toBe(false);
        expect(auth.authenticateAsync).not.toHaveBeenCalled();
      } finally {
        root.unmount();
      }
    }
  });

  it("covers the app switcher and locks again only after the chosen time away", async () => {
    const root = await mount();
    try {
      expect(useAppLock.getState().locked).toBe(false);
      auth.authenticateAsync.mockClear();

      await changeAppState("inactive");
      expect(modal(root).props.visible).toBe(true);
      expect(unlockButton(root)).toBeUndefined();
      await changeAppState("active");
      expect(modal(root).props.visible).toBe(false);

      await changeAppState("background");
      vi.setSystemTime(Date.now() + 59_000);
      await changeAppState("active");
      expect(useAppLock.getState().locked).toBe(false);

      await changeAppState("background");
      vi.setSystemTime(Date.now() + 61_000);
      auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
      await changeAppState("active");
      expect(useAppLock.getState().locked).toBe(true);
      expect(controlLocked()).toBe(true);
      expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);

      // Cancelling returns the app to "active" without leaving it: no prompt loop.
      await changeAppState("active");
      expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);

      auth.authenticateAsync.mockResolvedValue({ success: true });
      await act(async () => unlockButton(root)!.props.onPress());
      expect(useAppLock.getState().locked).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it("still counts time away that began during another authentication prompt", async () => {
    const root = await mount();
    try {
      expect(useAppLock.getState().locked).toBe(false);
      // Settings asks before turning App Lock off; leaving the app dismisses that prompt.
      let finish!: (value: { success: false; error: "system_cancel" }) => void;
      auth.authenticateAsync.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const asked = authenticate("Turn off App Lock");
      await changeAppState("inactive");
      await changeAppState("background");
      expect(modal(root).props.visible).toBe(true);
      vi.setSystemTime(Date.now() + 120_000);
      await changeAppState("active");
      auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
      await act(async () => {
        finish({ success: false, error: "system_cancel" });
        await asked;
      });
      expect(useAppLock.getState().locked).toBe(true);
      expect(controlLocked()).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it("does not lock after an Android screen-lock prompt that succeeds", async () => {
    consentData.set(KEY, JSON.stringify({ enabled: true, delayMs: 0 }));
    const root = await mount();
    try {
      auth.authenticateAsync.mockClear();
      let finish!: (value: { success: true }) => void;
      auth.authenticateAsync.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const asked = authenticate("Turn off App Lock");
      // The PIN screen is another activity, so the app goes to the background behind it.
      await changeAppState("background");
      vi.setSystemTime(Date.now() + 10_000);
      await act(async () => {
        finish({ success: true });
        await asked;
      });
      await changeAppState("active");
      expect(useAppLock.getState().locked).toBe(false);
      expect(modal(root).props.visible).toBe(false);
      expect(auth.authenticateAsync).toHaveBeenCalledTimes(1);
    } finally {
      root.unmount();
    }
  });

  it("uncovers the app after turning App Lock off behind an Android screen-lock prompt", async () => {
    const root = await mount();
    try {
      let finish!: (value: { success: true }) => void;
      auth.authenticateAsync.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
      const asked = authenticate("Turn off App Lock");
      await changeAppState("background");
      expect(modal(root).props.visible).toBe(true);
      await act(async () => {
        finish({ success: true });
        if ((await asked) === "unlocked") useAppLock.getState().setEnabled(false);
      });
      await changeAppState("active");
      expect(modal(root).props.visible).toBe(false);
    } finally {
      root.unmount();
    }
  });

  it("stays locked when the phone cannot say how it unlocks", async () => {
    auth.getEnrolledLevelAsync.mockRejectedValue(new Error("keystore busy"));
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
    const root = await mount();
    try {
      expect(modal(root).props.visible).toBe(true);
      expect(controlLocked()).toBe(true);
      expect(unlockButton(root)!.props.accessibilityLabel).toBe("Unlock with passcode");

      auth.authenticateAsync.mockResolvedValue({ success: true });
      await act(async () => unlockButton(root)!.props.onPress());
      expect(useAppLock.getState().locked).toBe(false);

      await changeAppState("background");
      vi.setSystemTime(Date.now() + 61_000);
      auth.authenticateAsync.mockResolvedValue({ success: false, error: "user_cancel" });
      await changeAppState("active");
      expect(useAppLock.getState().locked).toBe(true);
      expect(modal(root).props.visible).toBe(true);
    } finally {
      root.unmount();
    }
  });

  it("explains a lockout and stays locked", async () => {
    auth.authenticateAsync.mockResolvedValue({ success: false, error: "lockout" });
    const root = await mount();
    try {
      expect(useAppLock.getState().locked).toBe(true);
      const text = root.container
        .queryAll((node) => node.type === "Text")
        .flatMap((node) => node.props.children)
        .join(" ");
      expect(text).toContain("Too many attempts");
    } finally {
      root.unmount();
    }
  });
});
