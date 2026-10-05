@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import android.app.Activity
import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.content.ContextWrapper
import android.os.Build
import android.os.Bundle
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.firebase.messaging.RemoteMessage
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec
import kotlin.io.encoding.Base64
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Separate instrumentation APK/UID: never touches the owner's Shellbell app data. */
class NotificationQaActivity : Activity() {
  override fun onCreate(state: Bundle?) {
    super.onCreate(state)
    setContentView(TextView(this).apply { text = "Synthetic notification QA. No terminal connection." })
  }
}

@RunWith(AndroidJUnit4::class)
class NotificationDeviceTest {
    @Test fun firstRichAlertRemovesMatchingLegacyIdZeroButPreservesOtherSessions() = checkLegacyReplacement(true)

    @Test fun firstRichAlertRemovesFcmFallbackWithoutBodyButPreservesOtherSessions() = checkLegacyReplacement(false)

    private fun checkLegacyReplacement(withBody: Boolean) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assertNotEquals("sh.bilal.shellbell", context.packageName)
    if (Build.VERSION.SDK_INT >= 33) ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(
      "pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")).use { it.readBytes() }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancelAll()
    manager.createNotificationChannel(android.app.NotificationChannel("rings", "Rings", NotificationManager.IMPORTANCE_HIGH))
    val fixture = JSONObject(instrumentation.context.assets.open("notification-vectors.json").bufferedReader().use { it.readText() })
    val view = NotificationView.authenticated(fixture.getJSONObject("payload"))
    fun legacy(session: String): Notification = Notification.Builder(context, "rings")
      .setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle("Old format")
            .setExtras(Bundle().apply { if (withBody) putString("body", JSONObject().put("computerFp", view.computerFp).put("sessionId", session).toString()) }).build()
    manager.notify(view.tag, 0, legacy(view.sessionId!!))
    manager.notify("other-session", 0, legacy("other"))
    waitFor { manager.activeNotifications.size == 2 }
    AndroidNotificationManagerPort(context).post(view)
        waitFor {
            val active = manager.activeNotifications
            active.any { it.tag == view.tag && it.id == AndroidNotificationManagerPort.ID } &&
                active.none { it.tag == view.tag && it.id == 0 }
        }
    assertFalse(manager.activeNotifications.any { it.tag == view.tag && it.id == 0 })
    assertTrue(manager.activeNotifications.any { it.tag == "other-session" && it.id == 0 })
    manager.cancelAll()
  }
  private fun waitFor(condition: () -> Boolean) {
    val deadline = SystemClock.elapsedRealtime() + 5000
    while (!condition()) {
      check(SystemClock.elapsedRealtime() < deadline) { "notification condition timed out" }
      SystemClock.sleep(10)
    }
  }
  @Test fun actualSdkServiceDecryptsOnceGroupsTwoSessionsAndKeepsKeysPrivate() {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val context = instrumentation.targetContext
    assertNotEquals("sh.bilal.shellbell", context.packageName)
    assertTrue(context.packageName.matches(Regex("^[a-zA-Z0-9_.]+$")))
    if (Build.VERSION.SDK_INT >= 33) {
      ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(
        "pm grant ${context.packageName} android.permission.POST_NOTIFICATIONS")).use { it.readBytes() }
    }
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    manager.cancelAll() // QA package only.
    val fixture = JSONObject(instrumentation.context.assets.open("notification-vectors.json").bufferedReader().use { it.readText() })
    val base = fixture.getJSONObject("payload")
    val key = fixture.getString("key").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    val store = NotificationStoreFactory.open(context, initialize = true)
    store.removeComputer(base.getString("computerFp"))
    store.install(base.getString("computerFp"), base.getString("phoneFp"), base.getString("generation"), key, System.currentTimeMillis())
    val service = ShellbellMessagingService()
    ContextWrapper::class.java.getDeclaredMethod("attachBaseContext", Context::class.java).apply { isAccessible = true }.invoke(service, context)
    fun message(session: String, sequence: String, label: String): RemoteMessage {
      val now = System.currentTimeMillis()
      val payload = JSONObject(base.toString()).put("sessionId", session).put("sequence", sequence)
        .put("issuedAt", now).put("expiresAt", now + 120000)
      payload.getJSONObject("context").put("observedAt", now).put("sessionLabel", label).put("repository", "shellbell-qa").put("branch", "notifications")
      val box = JSONObject(fixture.getJSONObject("box").toString()).put("sessionId", session)
      val ad = listOf("shellbell-notification-v1", "computerFp", "phoneFp", "generation", "sessionId", "eventId")
        .mapIndexed { index, field -> if (index == 0) field else box.getString(field) }
        .joinToString(",", "[", "]") { JSONObject.quote(it) }.toByteArray(Charsets.UTF_8)
      val nonce = ByteArray(12).also { SecureRandom().nextBytes(it) }
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
        init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce)); updateAAD(ad)
      }
      box.put("nonce", Base64.UrlSafe.encode(nonce).trimEnd('='))
      box.put("ciphertext", Base64.UrlSafe.encode(cipher.doFinal(payload.toString().toByteArray(Charsets.UTF_8))).trimEnd('='))
      val data = JSONObject().put("shellbellNotification", "notify-context-v1").put("context", box)
        .put("computerFp", payload.getString("computerFp")).put("sessionId", session).put("kind", "blocked")
      return RemoteMessage.Builder("synthetic-qa").addData("body", data.toString()).build()
    }
    val first = message("tmux:qa1", "1", "Terminal QA 1")
    service.onMessageReceived(first)
    waitFor { manager.activeNotifications.count { it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 } == 1 }
    val original = manager.activeNotifications.single { it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }
    assertEquals("shellbell-qa · notifications", original.notification.extras.getString(Notification.EXTRA_TITLE))
    assertTrue(original.notification.extras.getString(Notification.EXTRA_TEXT)!!.startsWith("Terminal QA 1 ·"))
    service.onMessageReceived(first)
    assertEquals(original.postTime, manager.activeNotifications.single { it.tag == original.tag }.postTime)
    service.onMessageReceived(message("tmux:qa1", "2", "Terminal QA 1 updated"))
    waitFor { manager.activeNotifications.any { it.tag == original.tag && it.notification.extras.getString(Notification.EXTRA_SUB_TEXT)?.contains("updated") == true } }
    service.onMessageReceived(message("tmux:qa2", "1", "Terminal QA 2"))
    waitFor { manager.activeNotifications.size == 3 }
    val children = manager.activeNotifications.filter { it.notification.flags and Notification.FLAG_GROUP_SUMMARY == 0 }
    assertEquals(2, children.size); assertEquals(2, children.map { it.tag }.distinct().size)
    val summary = manager.activeNotifications.single { it.notification.flags and Notification.FLAG_GROUP_SUMMARY != 0 }
    assertEquals(Notification.GROUP_ALERT_CHILDREN, summary.notification.groupAlertBehavior)
    val metadata = java.io.File(context.noBackupFilesDir, "shellbell-notifications/state.json").readText()
    assertFalse(metadata.contains("shellbell-qa")); assertFalse(metadata.contains(fixture.getString("key")))
    key.fill(0)
    // Synthetic notifications remain for a tray screenshot; uninstall the QA APK afterwards.
  }
}
