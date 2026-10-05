export type PushToken =
  | { token: string; platform: "android"; provider: "fcm" }
  | { token: string; platform: "ios"; provider: "apns"; environment: "development" | "production" };

export interface NativeTokenApi {
  platform: string;
  getPermissions(): Promise<{ granted: boolean }>;
  getDevicePushToken(): Promise<string>;
  getIosEnvironment(): Promise<"development" | "production" | null>;
  /** Native release classification; App Store/TestFlight apps can have no embedded profile. */
  isIosAppStoreBuild?(): Promise<boolean>;
  onToken(cb: (token: string) => void): () => void;
}

async function destination(api: NativeTokenApi, token: string): Promise<PushToken | null> {
  if (!token || !(await api.getPermissions()).granted) return null;
  if (api.platform === "android") return { token, platform: "android", provider: "fcm" };
  if (api.platform !== "ios") return null;
  let environment = await api.getIosEnvironment();
  if (environment === null && (await api.isIosAppStoreBuild?.()) === true) {
    environment = "production";
  }
  return environment === null ? null : { token, platform: "ios", provider: "apns", environment };
}

export async function getNativePushToken(api: NativeTokenApi): Promise<PushToken | null> {
  try {
    if (!(await api.getPermissions()).granted) return null;
    return await destination(api, await api.getDevicePushToken());
  } catch {
    return null;
  }
}

export function installNativePushTokenListener(
  onToken: (token: PushToken) => void,
  api: NativeTokenApi,
): () => void {
  let active = true;
  let revision = 0;
  const remove = api.onToken((token) => {
    const current = ++revision;
    void destination(api, token)
      .then((value) => {
        if (active && current === revision && value) onToken(value);
      })
      .catch(() => undefined);
  });
  return () => {
    active = false;
    remove();
  };
}
