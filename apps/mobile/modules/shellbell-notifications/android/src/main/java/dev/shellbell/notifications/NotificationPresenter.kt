@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import java.security.MessageDigest
import kotlin.io.encoding.Base64
import org.json.JSONObject

internal data class NotificationView(
  val tag: String, val title: String, val body: String, val subtitle: String = "",
  val group: String? = null, val computerFp: String? = null, val sessionId: String? = null,
  val summary: Boolean = false, val silent: Boolean = false,
  /** Which terminal rang, from the sealed payload only, so a tap can tell a reused pane apart. */
  val instance: String? = null,
) {
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
      // What it's working on, where, and what happened: the same for every terminal and agent.
      val title = text("customName") ?: text("repository")?.let { listOfNotNull(it, text("branch")).joinToString(" · ") }
        ?: text("title") ?: "Terminal"
      val agent = text("agentName") ?: "An agent"
      val body = when (payload.getString("reason")) {
        "agent-blocked" -> "$agent needs your answer"
        "agent-finished" -> "$agent finished"
        "quiet" -> "Went quiet. Waiting for you?"
        "prompt-returned" -> "Back at the prompt"
        "command-finished" -> (if (payload.optLong("exitCode", 0) == 0L) "Command finished" else "Command failed (exit ${payload.getLong("exitCode")})") +
          (if (payload.has("durationMs")) " after ${duration(payload.getLong("durationMs"))}" else "")
        else -> return generic()
      }
      val computer = payload.getString("computerFp"); val session = payload.getString("sessionId")
      return NotificationView(sessionTag(computer, session), title, body, c.getString("computerName"), computerGroup(computer), computer, session,
        instance = payload.opt("instance") as? String)
    }
    /** As the relay's `formatDuration`: `45s`, `1m 35s`, `1h 02m`. */
    fun duration(ms: Long): String {
      val s = (ms + 500) / 1000
      if (s < 60) return "${s}s"
      val m = s / 60
      if (m < 60) return "${m}m ${(s % 60).toString().padStart(2, '0')}s"
      return "${m / 60}h ${(m % 60).toString().padStart(2, '0')}m"
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
