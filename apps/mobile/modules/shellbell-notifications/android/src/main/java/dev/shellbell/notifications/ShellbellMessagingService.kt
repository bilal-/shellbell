@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.ProcessLifecycleOwner
import com.google.firebase.messaging.RemoteMessage
import expo.modules.notifications.service.ExpoFirebaseMessagingService
import expo.modules.notifications.notifications.presentation.builders.ExpoNotificationBuilder
import kotlin.io.encoding.Base64
import org.json.JSONObject

internal fun notificationAppForeground() = ProcessLifecycleOwner.get().lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED)

internal class AndroidNotificationManagerPort(private val context: Context) : NotificationManagerPort {
  companion object { const val ID = 41041; const val CHANNEL = "rings" }
  override fun post(view: NotificationView) {
    val compat = NotificationManagerCompat.from(context)
    if (!compat.areNotificationsEnabled()) return
    val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (Build.VERSION.SDK_INT >= 26 && manager.getNotificationChannel(CHANNEL) == null) {
      manager.createNotificationChannel(NotificationChannel(CHANNEL, "Rings", NotificationManager.IMPORTANCE_HIGH).apply {
        enableVibration(true); vibrationPattern = longArrayOf(0, 250, 100, 250)
        enableLights(true); lightColor = 0xff10b981.toInt()
      })
    }
    val info = context.packageManager.getApplicationInfo(context.packageName, PackageManager.GET_META_DATA)
    val icon = info.metaData?.getInt("expo.modules.notifications.default_notification_icon", 0)?.takeIf { it != 0 }
      ?: context.applicationInfo.icon
    val intent = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return
    intent.action = Intent.ACTION_VIEW
    if (view.computerFp != null) {
      val route = view.sessionId?.let { "/s/" + Base64.UrlSafe.encode(it.toByteArray(Charsets.UTF_8)).trimEnd('=') } ?: ""
      intent.data = Uri.parse("shellbell://c/${view.computerFp}$route")
    }
    intent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val pending = PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val generic = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(icon).setContentTitle("Shellbell")
      .setContentText("A terminal session needs attention").setContentIntent(pending).build()
    val metadata = Bundle().apply {
      view.computerFp?.let { putString("shellbell.computerFp", it) }
      view.sessionId?.let { putString("shellbell.sessionId", it) }
    }
    val builder = NotificationCompat.Builder(context, CHANNEL).setSmallIcon(icon)
      .setContentTitle(view.title).setContentText(view.collapsedText()).setSubText(view.subtitle.ifEmpty { null })
      .setStyle(NotificationCompat.BigTextStyle().bigText(listOf(view.body, view.subtitle).filter { it.isNotEmpty() }.joinToString("\n")))
      .setContentIntent(pending).setAutoCancel(true).setExtras(metadata)
      .setCategory(NotificationCompat.CATEGORY_STATUS).setPriority(NotificationCompat.PRIORITY_HIGH)
      .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(generic)
      .setColor(0xff10b981.toInt()).setSilent(view.silent)
    if (view.group != null) builder.setGroup(view.group).setGroupSummary(view.summary).setGroupAlertBehavior(NotificationCompat.GROUP_ALERT_CHILDREN)
    if (view.summary) builder.setOnlyAlertOnce(true)
    try {
      compat.notify(view.tag, ID, builder.build())
      // Expo uses ID 0, so even the same tag cannot replace an old-format alert. Only
      // delete exact legacy routing metadata after successfully posting its replacement.
      try {
        for (entry in manager.activeNotifications) {
          if (legacyNotificationMatches(entry.notification.extras.getString(ExpoNotificationBuilder.EXTRAS_BODY_KEY), view, entry.tag, entry.id))
            manager.cancel(entry.tag, entry.id)
        }
      } catch (_: Exception) { /* Already posted: failed legacy inspection must not post a second fallback. */ }
    } catch (_: SecurityException) { /* permission revoked during delivery */ }
  }
}

/** Exactly one FCM owner. Unmarked legacy messages keep Expo's installed delegate. */
class ShellbellMessagingService : ExpoFirebaseMessagingService() {
  override fun onMessageReceived(remoteMessage: RemoteMessage) {
    NotificationDelivery.dispatch(remoteMessage.data, { super.onMessageReceived(remoteMessage) }, {
      val manager = AndroidNotificationManagerPort(this)
      try {
        val box = JSONObject(remoteMessage.data.getValue("body")).getJSONObject("context")
        val store = NotificationStoreFactory.open(this)
        NotificationPresenter(store::evaluate, store::publish, manager, ::notificationAppForeground)
          .receive(box, System.currentTimeMillis())
      } catch (_: Exception) {
        // Never re-enter Expo/JS after claiming the message; labels are not logged.
        if (!notificationAppForeground()) manager.post(NotificationView.generic())
      }
    })
  }
}
