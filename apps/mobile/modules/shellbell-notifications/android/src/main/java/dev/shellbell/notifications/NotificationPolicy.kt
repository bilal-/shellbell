package dev.shellbell.notifications

import org.json.JSONObject

internal enum class Disposition { RICH, GENERIC, STALE }
internal data class ReplayEntry(val sequence: String, val expiresAt: Long)
internal data class ReplayState(val sessions: MutableMap<String, ReplayEntry> = mutableMapOf())

internal object NotificationPolicy {
    // Input must already be authenticated and bound to the local enrollment.
    // The caller persists the state before presenting any alert.
    fun evaluate(payload: JSONObject, now: Long, hideDetails: Boolean, state: ReplayState): Disposition {
        val session = payload.opt("sessionId") as? String ?: return Disposition.GENERIC
        val text = payload.opt("sequence") as? String ?: return Disposition.GENERIC
        val sequence = text.toULongOrNull() ?: return Disposition.GENERIC
        val issued = payload.opt("issuedAt") as? Number ?: return Disposition.GENERIC
        val expires = payload.opt("expiresAt") as? Number ?: return Disposition.GENERIC
        if (session.isEmpty() || session.length > 128 || sequence == 0uL || sequence.toString() != text ||
            now !in 0..9_007_199_254_740_991L || listOf(issued, expires).any {
                !it.toDouble().isFinite() || it.toDouble() < 0 || it.toDouble() > 9_007_199_254_740_991.0 || it.toDouble() != it.toLong().toDouble()
            }) return Disposition.GENERIC
        val issuedAt = issued.toLong(); val expiresAt = expires.toLong()
        if (expiresAt <= issuedAt || expiresAt - issuedAt > 120_000) return Disposition.GENERIC
        if (issuedAt > now + 60_000 || expiresAt < now - 60_000) return Disposition.STALE
        val high = state.sessions[session]?.sequence?.toULongOrNull()
        if (high != null && sequence <= high) return Disposition.STALE
        val live = state.sessions.filterValues { it.expiresAt >= now }
        if (!live.containsKey(session) && live.size >= 500) return Disposition.GENERIC
        state.sessions.clear(); state.sessions.putAll(live)
        state.sessions[session] = ReplayEntry(text, expiresAt + 60_000)
        return if (hideDetails) Disposition.GENERIC else Disposition.RICH
    }
}
