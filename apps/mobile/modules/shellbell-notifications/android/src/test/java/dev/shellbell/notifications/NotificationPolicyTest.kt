package dev.shellbell.notifications

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotificationPolicyTest {
    private fun payload(sequence: String = "1", session: String = "session", issued: Long = 100_000) = JSONObject()
        .put("sessionId", session).put("sequence", sequence).put("issuedAt", issued).put("expiresAt", issued + 120_000)
    @Test fun expiryAndSixtySecondSkewBoundaries() {
        for ((now, expected) in listOf(40_000L to Disposition.RICH, 39_999L to Disposition.STALE, 280_000L to Disposition.RICH, 280_001L to Disposition.STALE)) {
            assertEquals(expected, NotificationPolicy.evaluate(payload(), now, false, ReplayState()))
        }
    }
    @Test fun reverseAndDuplicateSequencesNeverReplaceNewerContent() {
        val state = ReplayState()
        assertEquals(Disposition.RICH, NotificationPolicy.evaluate(payload("2"), 100_000, false, state))
        for (sequence in listOf("1", "2")) assertEquals(Disposition.STALE, NotificationPolicy.evaluate(payload(sequence), 100_000, false, state))
        assertEquals("2", state.sessions["session"]?.sequence)
    }
    @Test fun capacityFailsClosedAndPrunesOnlyExpiredRecords() {
        val state = ReplayState()
        for (i in 0 until 500) assertEquals(Disposition.RICH, NotificationPolicy.evaluate(payload(session = "s$i"), 100_000, false, state))
        assertEquals(Disposition.GENERIC, NotificationPolicy.evaluate(payload(session = "overflow"), 100_000, false, state))
        assertEquals(500, state.sessions.size)
        assertEquals(Disposition.RICH, NotificationPolicy.evaluate(payload(session = "new", issued = 300_000), 300_000, false, state))
        assertEquals(1, state.sessions.size)
    }
    @Test fun hiddenDetailsStillAdvanceReplayAndInvalidSequenceDoesNot() {
        val state = ReplayState()
        assertEquals(Disposition.GENERIC, NotificationPolicy.evaluate(payload(), 100_000, true, state))
        assertEquals(Disposition.STALE, NotificationPolicy.evaluate(payload(), 100_000, false, state))
        for (invalid in listOf("0", "01", "-1", "18446744073709551616")) assertEquals(Disposition.GENERIC, NotificationPolicy.evaluate(payload(invalid), 100_000, false, state))
        assertEquals("1", state.sessions["session"]?.sequence)
    }
}
