import "../src/bootstrap/crypto";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Linking from "expo-linking";
import { router, Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { AppState, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { loadOrCreateIdentity } from "../src/identity/keys";
import { connectionManager } from "../src/net/manager";
import { startNetworkMonitor } from "../src/net/native-network";
import { retryPendingRevocations } from "../src/net/revocation-retry";
import {
  ensureChannel,
  getNativePushToken,
  installNativePushTokenListener,
  installNotificationHandler,
  installTapHandler,
  kvTitleStorage,
  registerRingTask,
  showForegroundEvent,
} from "../src/notifications";
import { nativeNotifications, nativeNotificationsAvailable } from "../src/notifications/native";
import { createTapHandler, type NavTarget, parseDeepLink } from "../src/notifications/routing";
import { useComputersStore, useUiStore } from "../src/store/computers";
import { networkSource } from "../src/store/network";
import { tokens } from "../src/theme/tokens";
import { NavigationViewport } from "../src/ui/NavigationViewport";
import { NetworkBanner } from "../src/ui/NetworkBanner";
import { SettingsButton } from "../src/ui/SettingsButton";
import { ToastHost } from "../src/ui/ToastHost";
import { sidFromRoute } from "../src/util/routes";

void SplashScreen.preventAutoHideAsync();

// M1: the manifest version, not a hardcoded literal that would silently drift from the real
// build (the relay records `appVersion` on every phone socket).
const APP_VERSION = Constants.expoConfig?.version ?? "0.1.0";

const pairedFps = (): string[] =>
  useComputersStore
    .getState()
    .computers.filter((c) => !c.removing)
    .map((c) => c.fp);

/** Cancellable so a second tap (or an unmount) cannot leave a chain of timers running (C8). */
let sessionOpenTimer: ReturnType<typeof setTimeout> | null = null;

function cancelPendingOpen(): void {
  if (sessionOpenTimer !== null) clearTimeout(sessionOpenTimer);
  sessionOpenTimer = null;
}

/**
 * Spec 10.8: open the computer immediately, then the session once `sessions` has actually arrived
 * and contains it. If it never arrives (a session that ended while the phone was away), stay on
 * the sessions list — a push is a hint, never an instruction.
 */
function openTarget(t: NavTarget): void {
  cancelPendingOpen();
  if (!pairedFps().includes(t.computerFp)) return;
  // M3: `navigate` (not `push`) so repeated ring taps on the same computer reuse the existing
  // screen instead of stacking duplicates that each need their own Back.
  router.navigate(`/c/${t.computerFp}`);
  const route = t.sessionRoute;
  if (route === null) return;
  const sessionId = sidFromRoute(route);
  let attempts = 0;
  const tryOpen = () => {
    sessionOpenTimer = null;
    if (!pairedFps().includes(t.computerFp)) return;
    if (connectionManager.isSessionCurrent(t.computerFp, sessionId)) {
      router.push(`/c/${t.computerFp}/s/${route}`);
      return;
    }
    attempts += 1;
    if (attempts < 20) sessionOpenTimer = setTimeout(tryOpen, 500);
  };
  tryOpen();
}

export default function RootLayout() {
  // I6: a corrupt/unreadable keychain (or a locked one on Android) must not leave the app
  // silently stuck on "idle" forever with no connection manager ever started -- it gets an
  // honest, non-actionable-detail error screen instead. The message deliberately never includes
  // the underlying exception (it can name on-device key paths).
  const [identityError, setIdentityError] = useState(false);

  useEffect(() => startNetworkMonitor(), []);

  useEffect(() => {
    useComputersStore.getState().hydrate();
    useUiStore.getState().hydrate();
    // Fonts are natively embedded (expo-font config plugin, review I2) -- there is no JS font
    // load to gate on, so the splash can come down as soon as the tree is ready to paint.
    void SplashScreen.hideAsync();
  }, []);

  useEffect(() => {
    const retry = () => {
      void retryPendingRevocations().catch(() => undefined);
    };
    retry();
    const interval = setInterval(retry, 30_000);
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") retry();
    });
    return () => {
      clearInterval(interval);
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    // Spec 10.8: the handler and the Android `rings` channel must exist before any push can
    // arrive, so both are installed at startup rather than at permission time.
    installNotificationHandler();
    void ensureChannel();
    void registerRingTask();
    const handle = createTapHandler(openTarget, pairedFps);
    const offTap = installTapHandler(handle);
    const offToken = installNativePushTokenListener((token) => {
      connectionManager.registerNativePushToken(token);
    });
    const onUrl = (url: string) => {
      const t = parseDeepLink(url, pairedFps());
      if (t !== null) openTarget(t);
    };
    const urlSub = Linking.addEventListener("url", (e) => onUrl(e.url));
    void Linking.getInitialURL()
      .then((u) => {
        if (u !== null) onUrl(u);
      })
      .catch(() => undefined);
    return () => {
      offTap();
      offToken();
      urlSub.remove();
      cancelPendingOpen();
    };
  }, []);

  useEffect(() => {
    // Covers this cold start's paired computers' `K_pair`s in the same one-time keychain
    // migration pass as the identity key (review C1) -- safe because the hydrate effect above
    // runs first (declaration order within one commit).
    const startFps = useComputersStore.getState().computers.map((c) => c.fp);
    loadOrCreateIdentity(startFps)
      .then(({ identity, fp }) => {
        connectionManager.start({
          network: networkSource,
          identity,
          phoneFp: fp,
          phoneName: Device.deviceName ?? "My phone",
          appVersion: APP_VERSION,
          notificationNative: nativeNotificationsAvailable ? nativeNotifications : undefined,
          // Spec 10.8: sent as `push-token` on every `auth-ok` by `ComputerConnection`.
          pushToken: async (computerFp) => {
            const t = await getNativePushToken();
            if (t === null) return null;
            const c = useComputersStore.getState().computers.find((x) => x.fp === computerFp);
            if (c === undefined || c.removing) return null;
            return { ...t, enabled: c.pushEnabled };
          },
          onForegroundEvent: showForegroundEvent,
          titleStorage: kvTitleStorage,
        });
      })
      .catch(() => setIdentityError(true));
  }, []);

  if (identityError) {
    return (
      <KeyboardProvider>
        <View
          style={{
            flex: 1,
            alignItems: "center",
            justifyContent: "center",
            padding: 24,
            gap: 8,
            backgroundColor: tokens.bg,
          }}
        >
          <StatusBar style="light" />
          <Text style={{ color: tokens.text, textAlign: "center", fontSize: 16 }}>
            Could not access secure storage.
          </Text>
          <Text style={{ color: tokens.textMuted, textAlign: "center" }}>
            Restart Shellbell. If this keeps happening, reinstall the app and re-pair.
          </Text>
        </View>
      </KeyboardProvider>
    );
  }

  return (
    // Wraps the whole tree (not just the session screen) so KeyboardProvider is always mounted
    // before any screen that needs it -- react-native-keyboard-controller's hooks/components
    // throw if used outside it. See app/c/[fp]/s/[sid].tsx for why plain `KeyboardAvoidingView`
    // cannot keep the input above the keyboard on Android 15/16.
    <KeyboardProvider>
      <SafeAreaProvider>
        <GestureHandlerRootView style={{ flex: 1, backgroundColor: tokens.bg }}>
          <StatusBar style="light" />
          <NavigationViewport>
            <Stack
              screenOptions={{
                headerStyle: { backgroundColor: tokens.bg },
                headerTintColor: tokens.text,
                contentStyle: { backgroundColor: tokens.bg },
              }}
            >
              <Stack.Screen
                name="index"
                options={{ title: "Computers", headerRight: () => <SettingsButton /> }}
              />
              <Stack.Screen name="pair" options={{ presentation: "modal", title: "Pair" }} />
              <Stack.Screen name="settings" options={{ title: "Settings" }} />
              <Stack.Screen name="c/[fp]" options={{ headerShown: false }} />
              <Stack.Screen name="dev/render-spike" options={{ title: "Render spike" }} />
            </Stack>
            <NetworkBanner />
            <ToastHost />
          </NavigationViewport>
        </GestureHandlerRootView>
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}
