@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import java.security.MessageDigest
import kotlin.io.encoding.Base64
import org.json.JSONObject

internal data class NotificationView(
  val tag: String, val title: String, val body: String, val subtitle: String = "",
  val group: String? = null, val computerFp: String? = null, val sessionId: String? = null,
  val summary: Boolean = false, val silent: Boolean = false,
  val sessionLabel: String? = null,
) {
  // OEMs may truncate subtext before reaching the session name. Keep the
  // session identity first in the collapsed content, not only in the header.
  fun collapsedText() = sessionLabel?.let { "$it · $body" } ?: body
  companion object {
    private fun hash(prefix: String, vararg tuple: String): String = prefix + Base64.UrlSafe.encode(
      MessageDigest.getInstance("SHA-256").digest(tuple.joinToString(",", "[", "]", transform = NotificationCrypto::quote).toByteArray(Charsets.UTF_8))
    ).trimEnd('=')
    fun sessionTag(computer: String, session: String) = hash("sb1_", "shellbell-push-session-v1", computer, session)
    fun computerGroup(computer: String) = hash("sbc1_", "shellbell-push-computer-v1", computer)
    fun generic(permit: NotificationPermit? = null): NotificationView {
      val computer = permit?.computerFp.takeIf { permit?.sessionId != null }
      val session = permit?.sessionId
      return NotificationView(if (computer != null && session != null) sessionTag(computer, session) else "sb1_generic",
        "Shellbell", "A terminal session needs attention", group = computer?.let(::computerGroup), computerFp = computer, sessionId = session)
    }
    fun authenticated(payload: JSONObject): NotificationView {
      val c = payload.getJSONObject("context")
      fun text(name: String) = c.opt(name) as? String
      val title = text("customName") ?: text("repository")?.let { listOfNotNull(it, text("branch")).joinToString(" · ") }
        ?: text("title") ?: c.getString("sessionLabel")
      val subtitle = listOfNotNull(text("computerName"), text("sessionLabel"), text("shell")).joinToString(" · ")
      val agent = text("agentName") ?: "Agent"
      val body = when (payload.getString("reason")) {
        "agent-blocked" -> "$agent waiting for your response"
        "agent-finished" -> "$agent finished"
        "quiet" -> "Session went quiet"
        "prompt-returned" -> "Terminal returned to a prompt"
        "command-finished" -> (if (payload.optLong("exitCode", 0) == 0L) "Command finished" else "Command exited with code ${payload.getLong("exitCode")}") +
          (if (payload.has("durationMs")) " · ${payload.getLong("durationMs") / 1000}s" else "")
        else -> return generic()
      }
      val computer = payload.getString("computerFp"); val session = payload.getString("sessionId")
      return NotificationView(sessionTag(computer, session), title, body, subtitle, computerGroup(computer), computer, session, sessionLabel = c.getString("sessionLabel"))
    }
  }
}

internal fun interface NotificationManagerPort { fun post(view: NotificationView) }

internal fun legacyNotificationMatches(body: String?, current: NotificationView, tag: String? = null, id: Int? = null): Boolean {
    if (current.summary || current.computerFp == null || current.sessionId == null) return false
    // FCM's automatically displayed fallback has no Expo routing body. Android
    // identifies notifications by (tag, id), so native ID 41041 cannot replace ID 0.
    if (body == null) return id == 0 && tag == NotificationView.sessionTag(current.computerFp, current.sessionId)
    if (body.length > 16384) return false
    return try {
        val data = JSONObject(body)
        !data.has("shellbellNotification") && data.opt("computerFp") == current.computerFp && data.opt("sessionId") == current.sessionId
    } catch (_: Exception) { false }
}

internal data class NotificationRoute(val tag: String?, val id: Int, val computer: String?, val session: String?, val summary: Boolean)
internal fun notificationDismissals(active: List<NotificationRoute>, computer: String, session: String?): List<NotificationRoute> {
    val remainingChildren = active.any { it.computer == computer && !it.summary && it.session != session }
    return active.filter {
        it.computer == computer && (session == null || it.session == session || (it.summary && !remainingChildren))
    }
}

internal class NotificationPresenter(
  private val evaluate: (JSONObject, Long) -> NotificationEvaluation,
  private val publish: (NotificationEvaluation, Long, (NotificationEvaluation) -> Unit) -> Boolean,
  private val manager: NotificationManagerPort,
  private val foreground: () -> Boolean = { false },
) {
  fun receive(box: JSONObject, now: Long) {
    val result = evaluate(box, now)
    if (result.disposition == Disposition.STALE || foreground()) return
    publish(result, now) { current ->
      if (foreground() || current.disposition == Disposition.STALE) return@publish
      val view = if (current.disposition == Disposition.RICH && current.payload != null)
        NotificationView.authenticated(current.payload) else NotificationView.generic(current.permit)
      manager.post(view)
      val computerName = if (current.disposition == Disposition.RICH) current.payload?.optJSONObject("context")?.optString("computerName") else null
      if (view.group != null) manager.post(NotificationView(view.group, computerName ?: "Shellbell", "Terminal activity",
        group = view.group, computerFp = view.computerFp, summary = true, silent = true))
    }
  }
}
