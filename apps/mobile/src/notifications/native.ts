import { requireOptionalNativeModule } from "expo-modules-core";

export interface NotificationReadiness {
  crypto: boolean;
  receiver: boolean;
  storage: boolean;
}

/** Only derived notification keys cross this boundary. Never pass a pairing key. */
export interface NativeNotifications {
  installNotificationKey(
    computerFp: string,
    phoneFp: string,
    generation: string,
    key: string,
  ): Promise<void>;
  removeNotificationComputer(computerFp: string): Promise<void>;
  setHideNotificationDetails(hide: boolean): Promise<void>;
  getHideNotificationDetails(): Promise<boolean>;
  dismissNotificationSession(computerFp: string, sessionId: string): Promise<void>;
  notificationReadiness(): Promise<NotificationReadiness>;
}

export function createNativeNotifications(native: NativeNotifications | null): NativeNotifications {
  let pending: Promise<unknown> = Promise.resolve();
  const serialized = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const required = (): NativeNotifications => {
    if (!native) throw new Error("Native notifications unavailable in this build");
    return native;
  };
  return {
    async installNotificationKey(computerFp, phoneFp, generation, key) {
      await serialized(() =>
        required().installNotificationKey(computerFp, phoneFp, generation, key),
      );
    },
    async removeNotificationComputer(computerFp) {
      await serialized(() => required().removeNotificationComputer(computerFp));
    },
    async setHideNotificationDetails(hide) {
      await serialized(() => required().setHideNotificationDetails(hide));
    },
    async getHideNotificationDetails() {
      return serialized(async () => {
        const hide = await required().getHideNotificationDetails();
        if (typeof hide !== "boolean") throw new Error("Notification privacy state unavailable");
        return hide;
      });
    },
    async dismissNotificationSession(computerFp, sessionId) {
      await serialized(() => required().dismissNotificationSession(computerFp, sessionId));
    },
    async notificationReadiness() {
      try {
        const value = await required().notificationReadiness();
        return {
          crypto: value?.crypto === true,
          receiver: value?.receiver === true,
          storage: value?.storage === true,
        };
      } catch {
        return { crypto: false, receiver: false, storage: false };
      }
    },
  };
}

const nativeModule = requireOptionalNativeModule<NativeNotifications>("ShellbellNotifications");
export const nativeNotificationsAvailable = nativeModule !== null;
export const nativeNotifications = createNativeNotifications(nativeModule);
