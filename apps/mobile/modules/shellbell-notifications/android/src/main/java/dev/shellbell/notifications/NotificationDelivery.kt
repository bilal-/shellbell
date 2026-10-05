package dev.shellbell.notifications

import org.json.JSONObject

internal object NotificationDelivery {
  fun dispatch(data: Map<String, String>, legacy: () -> Unit, native: () -> Unit) {
    // Expo's Android FCM contract serializes custom data in `body` (the same
    // field read by the installed SDK's NotificationData wrapper).
    val raw = data["body"]
    val rich = if (raw != null && raw.toByteArray(Charsets.UTF_8).size <= 3500) {
      try { JSONObject(raw).opt("shellbellNotification") == "notify-context-v1" }
      catch (_: Exception) { false }
    } else false
    if (rich) native() else legacy()
  }
}
