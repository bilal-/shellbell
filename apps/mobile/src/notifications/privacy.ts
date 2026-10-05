import type { NativeNotifications } from "./native";

/** A rejected fsync may follow a successful rename: failure does not mean rollback. */
export async function saveNotificationPrivacy(
  native: Pick<NativeNotifications, "setHideNotificationDetails" | "getHideNotificationDetails">,
  hide: boolean,
): Promise<{ saved: boolean; hide: boolean | null }> {
  try {
    await native.setHideNotificationDetails(hide);
    return { saved: true, hide };
  } catch {
    try {
      return { saved: false, hide: await native.getHideNotificationDetails() };
    } catch {
      return { saved: false, hide: null };
    }
  }
}
