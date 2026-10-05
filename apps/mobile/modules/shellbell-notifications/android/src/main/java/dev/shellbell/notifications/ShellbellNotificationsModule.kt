@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import android.app.NotificationManager
import android.app.Notification
import android.content.Context
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import kotlin.io.encoding.Base64

internal object NotificationStoreFactory {
  fun open(context: Context, initialize: Boolean = false): NotificationStore {
    check(!context.isDeviceProtectedStorage) { "notification storage unavailable" }
    val directory = File(context.noBackupFilesDir, "shellbell-notifications")
    val store = NotificationStore(FileNotificationDisk(directory), KeystoreNotificationVault(File(directory, "keys")))
    if (initialize) store.initialize()
    return store
  }
}

/** Host enrollment only. The receiver must not initialize missing pairing metadata. */
class ShellbellNotificationsModule : Module() {
  private fun context(): Context = appContext.reactContext ?: error("notification storage unavailable")
  private fun store() = NotificationStoreFactory.open(context(), initialize = true)
  private fun dismiss(computer: String, session: String? = null) {
    val manager = context().getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val active = manager.activeNotifications.map { entry ->
      val extras = entry.notification.extras
      NotificationRoute(entry.tag, entry.id, extras.getString("shellbell.computerFp"), extras.getString("shellbell.sessionId"), entry.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0)
    }
    for (entry in notificationDismissals(active, computer, session)) manager.cancel(entry.tag, entry.id)
  }
  override fun definition() = ModuleDefinition {
    Name("ShellbellNotifications")
    AsyncFunction("installNotificationKey") { computer: String, phone: String, generation: String, encoded: String ->
      check(encoded.matches(Regex("^[A-Za-z0-9_-]{43}$"))) { "notification key unavailable" }
      val key = Base64.UrlSafe.decode("$encoded=")
      try {
        check(key.size == 32 && Base64.UrlSafe.encode(key).trimEnd('=') == encoded) { "notification key unavailable" }
        store().install(computer, phone, generation, key, System.currentTimeMillis())
      } finally { key.fill(0) }
    }
    AsyncFunction("removeNotificationComputer") { computer: String ->
      store().removeComputer(computer)
      dismiss(computer)
    }
        AsyncFunction("setHideNotificationDetails") { hide: Boolean -> store().setHideDetails(hide) }
        AsyncFunction("getHideNotificationDetails") { store().hideDetails() }
    AsyncFunction("dismissNotificationSession") { computer: String, session: String -> dismiss(computer, session) }
    AsyncFunction("notificationReadiness") {
      val storage = try { store(); true } catch (_: Exception) { false }
      // The receiver is bundled. Durable storage and authenticated enrollment
      // remain mandatory before advertising rich push support.
      mapOf("crypto" to true, "storage" to storage, "receiver" to true)
    }
  }
}
