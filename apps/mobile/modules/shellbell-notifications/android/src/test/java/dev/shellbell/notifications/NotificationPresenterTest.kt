package dev.shellbell.notifications

import java.io.File
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotificationPresenterTest {
  @Test fun fcmFallbackWithoutBodyIsRemovedOnlyForExactSessionTagAndLegacyId() {
    val view = NotificationView.authenticated(payload())
    assertTrue(legacyNotificationMatches(null, view, view.tag, 0))
    assertFalse(legacyNotificationMatches(null, view, view.tag, 41041))
    assertFalse(legacyNotificationMatches(null, view, "${view.tag}-other", 0))
    assertFalse(legacyNotificationMatches(null, view, null, 0))
    assertFalse(legacyNotificationMatches(null, view.copy(summary = true), view.tag, 0))
    assertFalse(legacyNotificationMatches(null, view.copy(computerFp = null), view.tag, 0))
    assertFalse(legacyNotificationMatches(null, view.copy(sessionId = null), view.tag, 0))
    val rich = JSONObject().put("computerFp", view.computerFp).put("sessionId", view.sessionId)
      .put("shellbellNotification", "notify-context-v1")
    assertFalse(legacyNotificationMatches(rich.toString(), view, view.tag, 0))
  }
    @Test fun legacyMigrationMatchesOnlyExactSessionAndNeverUnsequencedRichMetadata() {
        val view = NotificationView.authenticated(payload())
        val data = JSONObject().put("computerFp", view.computerFp).put("sessionId", view.sessionId)
        assertTrue(legacyNotificationMatches(data.toString(), view))
        assertFalse(legacyNotificationMatches(JSONObject(data.toString()).put("sessionId", "other").toString(), view))
        assertFalse(legacyNotificationMatches(JSONObject(data.toString()).put("computerFp", "other").toString(), view))
        assertFalse(legacyNotificationMatches(data.put("shellbellNotification", "notify-context-v1").toString(), view))
        assertFalse(legacyNotificationMatches("invalid", view))
    }
    @Test fun exactDismissalPreservesOtherSessionsAndRemovesOnlyEmptyComputerSummary() {
        val a = NotificationRoute("a", 1, "computer", "one", false)
        val b = NotificationRoute("b", 1, "computer", "two", false)
        val group = NotificationRoute("summary", 1, "computer", null, true)
        val other = NotificationRoute("other", 1, "other-computer", "one", false)
        assertEquals(listOf(a), notificationDismissals(listOf(a, b, group, other), "computer", "one"))
        assertEquals(listOf(a, group), notificationDismissals(listOf(a, group, other), "computer", "one"))
        assertEquals(listOf(a, b, group), notificationDismissals(listOf(a, b, group, other), "computer", null))
    }
  private fun payload() = JSONObject(File(System.getProperty("shellbell.vectors")).readText()).getJSONObject("payload")
  private class Manager : NotificationManagerPort {
    val active = mutableMapOf<String, NotificationView>()
    val audible = mutableListOf<String>()
    override fun post(view: NotificationView) { active[view.tag] = view; if (!view.silent) audible.add(view.tag) }
  }
  private fun presenter(manager: Manager, foreground: () -> Boolean = { false }): NotificationPresenter {
    val replay = mutableMapOf<String, ReplayState>()
    return NotificationPresenter(evaluate = { payload, now ->
      val fp = payload.getString("computerFp")
      val decision = NotificationPolicy.evaluate(payload, now, false, replay.getOrPut(fp) { ReplayState() })
      NotificationEvaluation(decision, if (decision == Disposition.RICH) payload else null,
        NotificationPermit(fp, payload.getString("phoneFp"), payload.getString("generation"), "epoch", payload.getString("sessionId"), payload.getString("sequence"), 181000))
    }, publish = { result, _, deliver -> deliver(result); true }, manager = manager, foreground = foreground)
  }
  @Test fun duplicatesSoundOnceAndNewerEventsReplaceOnlyTheSameSession() {
    val manager = Manager(); val presenter = presenter(manager); val p = payload()
    presenter.receive(p, 1000); presenter.receive(p, 1000)
    assertEquals(1, manager.audible.size); assertEquals(1, manager.active.values.count { !it.summary })
    presenter.receive(JSONObject(p.toString()).put("sequence", "2"), 1000)
    assertEquals(2, manager.audible.size); assertEquals(1, manager.active.values.count { !it.summary })
    presenter.receive(p, 1000)
    assertEquals(2, manager.audible.size)
  }
  @Test fun sameRepositorySessionsAndDifferentComputersDoNotCollide() {
    val manager = Manager(); val presenter = presenter(manager); val p = payload()
    presenter.receive(p, 1000)
    presenter.receive(JSONObject(p.toString()).put("sessionId", "tmux:2"), 1000)
    presenter.receive(JSONObject(p.toString()).put("computerFp", "c".repeat(26)), 1000)
    assertEquals(3, manager.active.values.count { !it.summary })
    assertEquals(2, manager.active.values.count { it.summary })
    assertTrue(manager.active.values.filter { it.summary }.all { it.silent })
    assertTrue(manager.active.values.filter { it.summary }.all { it.title == "MacBook" })
    assertEquals(3, manager.audible.size)
  }
  @Test fun foregroundAndRevokedNotificationsDoNotPost() {
    val manager = Manager(); presenter(manager) { true }.receive(payload(), 1000)
    assertTrue(manager.active.isEmpty())
    NotificationPresenter(evaluate = { _, _ -> NotificationEvaluation(Disposition.RICH, payload()) },
      publish = { _, _, _ -> false }, manager = manager).receive(payload(), 1000)
    assertTrue(manager.active.isEmpty())
  }
  @Test fun genericFallbackDoesNotReuseUntrustedLabelsOrSessionIdentity() {
    val manager = Manager()
    NotificationPresenter(evaluate = { _, _ -> NotificationEvaluation(Disposition.GENERIC, payload()) },
      publish = { result, _, deliver -> deliver(result); true }, manager = manager).receive(payload(), 1000)
    val view = manager.active.values.single()
    assertEquals("Shellbell", view.title); assertEquals("A terminal session needs attention", view.body)
    assertNull(view.computerFp); assertNull(view.sessionId)
  }
  @Test fun formattingMatchesOtherClientsAndSharedTupleVectors() {
    val p = payload(); p.getJSONObject("context").put("agentName", "Claude").put("shell", "zsh")
    val view = NotificationView.authenticated(p)
    assertEquals("shellbell · fix/通知", view.title)
    assertEquals("MacBook · Terminal 2 · zsh", view.subtitle)
    assertEquals("Claude waiting for your response", view.body)
    assertEquals("Terminal 2 · Claude waiting for your response", view.collapsedText())
    val vectors = JSONArray(File(File(System.getProperty("shellbell.vectors")).parentFile, "notification-presentation-vectors.json").readText())
    for (i in 0 until vectors.length()) {
      val v = vectors.getJSONObject(i)
      assertEquals(v.getString("sessionTag"), NotificationView.sessionTag(v.getString("computerFp"), v.getString("sessionId")))
      assertEquals(v.getString("computerGroup"), NotificationView.computerGroup(v.getString("computerFp")))
    }
  }
}
