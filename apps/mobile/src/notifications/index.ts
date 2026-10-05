import * as Application from "expo-application";
import * as Haptics from "expo-haptics";
import * as ExpoNotifications from "expo-notifications";
import Storage from "expo-sqlite/kv-store";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { connectionManager } from "../net/manager";
import { useConnectionsStore } from "../store/connections";
import { tokens } from "../theme/tokens";
import { notificationIdFor } from "./content";
import { matchingNotificationIds } from "./dismiss";
import { nativeNotifications, nativeNotificationsAvailable } from "./native";

export async function dismissComputerNotifications(
  computerFp: string,
  sessionId?: string,
): Promise<void> {
  if (nativeNotificationsAvailable && sessionId !== undefined)
    await nativeNotifications.dismissNotificationSession(computerFp, sessionId);
  const shown = await ExpoNotifications.getPresentedNotificationsAsync();
  const ids = new Set(matchingNotificationIds(shown, computerFp, sessionId));
  if (sessionId !== undefined) ids.add(notificationIdFor(computerFp, sessionId));
  await Promise.all([...ids].map((id) => ExpoNotifications.dismissNotificationAsync(id)));
}

import {
  getNativePushToken as acquireNativePushToken,
  type NativeTokenApi,
  type PushToken,
  installNativePushTokenListener as subscribeNativePushToken,
} from "./native-token";
import {
  buildScheduleInput,
  extractRingPayload,
  handleIncomingRing,
  type RawRingTaskData,
  type RingHandlerDeps,
  selectRingInput,
} from "./ring";
import { foregroundToast } from "./routing";

export type { PushToken } from "./native-token";

import { lookupSessionTitle, type TitleStorage } from "./sessionTitles";

/** The real, on-device backend for `sessionTitles.ts`'s injectable `TitleStorage`. */
export const kvTitleStorage: TitleStorage = {
  getItemSync: (k) => Storage.getItemSync(k),
  setItemSync: (k, v) => Storage.setItemSync(k, v),
};

export interface PermissionState {
  granted: boolean;
  canAskAgain: boolean;
}

/** A narrow port over `expo-notifications` so tests can inject a fake without expo's types. */
export interface NotificationsApi {
  setHandler(): void;
  ensureChannel(): Promise<void>;
  getPermissions(): Promise<PermissionState>;
  requestPermissions(): Promise<PermissionState>;
  onResponse(cb: (data: unknown) => void): () => void;
  getLastResponseData(): Promise<unknown>;
}

export const expoNotificationsApi: NotificationsApi = {
  setHandler() {
    ExpoNotifications.setNotificationHandler({
      // Spec 10.8: a foregrounded phone shows an in-app toast, not an OS banner. It is also not
      // push-eligible at all (11.3) — this only covers the lease-expiry race.
      handleNotification: async () => ({
        shouldShowBanner: false,
        shouldShowList: true,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });
  },
  async ensureChannel() {
    if (Platform.OS !== "android") return;
    await ExpoNotifications.setNotificationChannelAsync("rings", {
      name: "Rings",
      importance: ExpoNotifications.AndroidImportance.HIGH,
      vibrationPattern: [0, 250, 100, 250],
      // spec 10.9: emerald is the app's fixed brand accent, not a per-computer accent.
      lightColor: tokens.accents.emerald,
    });
  },
  async getPermissions() {
    const p = await ExpoNotifications.getPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain };
  },
  async requestPermissions() {
    const p = await ExpoNotifications.requestPermissionsAsync();
    return { granted: p.granted, canAskAgain: p.canAskAgain };
  },
  onResponse(cb) {
    const sub = ExpoNotifications.addNotificationResponseReceivedListener((r) => {
      cb(r.notification.request.content.data);
    });
    return () => sub.remove();
  },
  async getLastResponseData() {
    const r = await ExpoNotifications.getLastNotificationResponseAsync();
    return r?.notification.request.content.data ?? null;
  },
};

/** Call once, from a `_layout.tsx` effect. Never at module scope (it would break node tests). */
export function installNotificationHandler(api: NotificationsApi = expoNotificationsApi): void {
  api.setHandler();
}

export async function ensureChannel(api: NotificationsApi = expoNotificationsApi): Promise<void> {
  await api.ensureChannel();
}

/** Spec 10.8: asked once, after the first successful pairing. `false` if already denied. */
export async function requestPermissionOnce(
  api: NotificationsApi = expoNotificationsApi,
): Promise<boolean> {
  const cur = await api.getPermissions();
  if (cur.granted) return true;
  if (!cur.canAskAgain) return false;
  return (await api.requestPermissions()).granted;
}

const nativeTokenApi: NativeTokenApi = {
  platform: Platform.OS,
  getPermissions: () => expoNotificationsApi.getPermissions(),
  getDevicePushToken: async () => String((await ExpoNotifications.getDevicePushTokenAsync()).data),
  getIosEnvironment: () => Application.getIosPushNotificationServiceEnvironmentAsync(),
  isIosAppStoreBuild: async () =>
    (await Application.getIosApplicationReleaseTypeAsync()) ===
    Application.ApplicationReleaseType.APP_STORE,
  onToken: (cb) => {
    const subscription = ExpoNotifications.addPushTokenListener((token) => cb(String(token.data)));
    return () => subscription.remove();
  },
};

export function getNativePushToken(
  api: NativeTokenApi = nativeTokenApi,
): Promise<PushToken | null> {
  return acquireNativePushToken(api);
}

export function installNativePushTokenListener(
  onToken: (token: PushToken) => void,
  api: NativeTokenApi = nativeTokenApi,
): () => void {
  return subscribeNativePushToken(onToken, api);
}

/**
 * Subscribes to notification taps and replays a cold-start tap. `handle` is built by
 * `createTapHandler` in `_layout.tsx` so the validation stays pure and testable.
 */
export function installTapHandler(
  handle: (data: unknown) => void,
  api: NotificationsApi = expoNotificationsApi,
): () => void {
  const off = api.onResponse(handle);
  void api
    .getLastResponseData()
    .then((d) => {
      if (d !== null && d !== undefined) handle(d);
    })
    .catch(() => undefined);
  return off;
}

/** Spec 10.8 foreground path: in-app toast + haptic. `unread` is already bumped by the manager. */
export function showForegroundEvent(fp: string, sessionTitle: string, kind: string): void {
  const text = foregroundToast(sessionTitle, kind);
  if (text === null) return;
  void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  useConnectionsStore.getState().patch(fp, () => ({ toast: text }));
}

/**
 * Registers this phone's push token with a computer as soon as its socket exists. Needed because
 * permission is granted seconds *after* the first `auth-ok` has already run with no permission
 * (review row C7/P2). `notifyPushToggle` is a no-op while no connection exists, hence the bounded
 * retry rather than a single call.
 */
export async function registerPushTokenWhenConnected(fp: string): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    if (connectionManager.get(fp) !== undefined) {
      connectionManager.notifyPushToggle(fp, true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The real, Expo-backed deps for `handleIncomingRing` (pure logic lives in `./ring.ts`). */
export const defaultRingHandlerDeps: RingHandlerDeps = {
  allowDetails: async () =>
    !nativeNotificationsAvailable || !(await nativeNotifications.getHideNotificationDetails()),
  lookup: (fp, sessionId) => lookupSessionTitle(fp, sessionId, kvTitleStorage),
  present: async (n) => {
    await ExpoNotifications.scheduleNotificationAsync(buildScheduleInput(n));
  },
  dismiss: async (id) => {
    await ExpoNotifications.dismissNotificationAsync(id);
  },
};

export const RING_TASK = "shellbell-ring";

/** Defined at module scope: the OS may start the task before any React tree exists. */
TaskManager.defineTask(RING_TASK, async ({ data, error }) => {
  if (error) return;
  const input = selectRingInput(data as RawRingTaskData | undefined);
  if (!input) return;
  const payload = extractRingPayload(input.content);
  if (!payload) return;
  await handleIncomingRing(payload, input.identifier, defaultRingHandlerDeps);
});

/** Registration failures are swallowed: an unregistered task just means generic notifications
 * keep showing (spec §4's designed fallback), never a crash. */
export async function registerRingTask(): Promise<void> {
  try {
    await ExpoNotifications.registerTaskAsync(RING_TASK);
  } catch {
    // Fallback is the generic notification — never crash startup over this.
  }
}
