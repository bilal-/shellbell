@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.UUID
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock
import kotlin.io.encoding.Base64
import org.json.JSONObject

internal interface NotificationKeyVault {
    fun put(account: String, key: ByteArray)
    fun get(account: String): ByteArray?
    fun remove(account: String)
    fun removeAll()
}
internal interface NotificationDisk {
    fun <T> locked(block: () -> T): T
    fun read(): String?
    fun write(value: String)
}
internal class FileNotificationDisk(private val directory: File, private val syncDirectory: (File) -> Unit = {
    val fd = Os.open(it.absolutePath, OsConstants.O_RDONLY, 0)
    try { Os.fsync(fd) } finally { Os.close(fd) }
}) : NotificationDisk {
    companion object { private val processLock = ReentrantLock() }
    override fun <T> locked(block: () -> T): T = processLock.withLock {
        if (!directory.isDirectory && !directory.mkdirs()) throw IllegalStateException("notification storage unavailable")
        RandomAccessFile(File(directory, "state.lock"), "rw").use { stream -> stream.channel.lock().use { block() } }
    }
    override fun read(): String? {
        val file = File(directory, "state.json")
        if (!file.exists()) return null
        if (!file.isFile || file.length() > 8 * 1024 * 1024) throw IllegalStateException("notification storage unavailable")
        val bytes = file.inputStream().use { it.readNBytesCompat(8 * 1024 * 1024 + 1) }
        if (bytes.size > 8 * 1024 * 1024) throw IllegalStateException("notification storage unavailable")
        return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
    }
    override fun write(value: String) {
        val bytes = value.toByteArray(Charsets.UTF_8)
        if (bytes.size > 8 * 1024 * 1024) throw IllegalStateException("notification storage unavailable")
        val temporary = File.createTempFile("state-", ".tmp", directory)
        try {
            temporary.setReadable(false, false); temporary.setReadable(true, true)
            temporary.setWritable(false, false); temporary.setWritable(true, true)
            FileOutputStream(temporary).use { it.write(bytes); it.fd.sync() }
            if (!temporary.renameTo(File(directory, "state.json"))) throw IllegalStateException("notification storage unavailable")
            syncDirectory(directory)
        } finally { temporary.delete() }
    }
}
// InputStream.readNBytes is not available on all supported Android API levels.
private fun java.io.InputStream.readNBytesCompat(limit: Int): ByteArray {
    val output = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    while (output.size() < limit) {
        val count = read(buffer, 0, minOf(buffer.size, limit - output.size()))
        if (count < 0) break
        if (count == 0) throw IllegalStateException("notification storage unavailable")
        output.write(buffer, 0, count)
    }
    return output.toByteArray()
}
internal data class NotificationPermit(val computerFp: String, val phoneFp: String, val generation: String, val epoch: String,
    val sessionId: String? = null, val sequence: String? = null, val expiresAt: Long? = null)
internal data class NotificationEvaluation(val disposition: Disposition, val payload: JSONObject? = null, val permit: NotificationPermit? = null)

internal class NotificationStore(private val disk: NotificationDisk, private val vault: NotificationKeyVault) {
    private fun invalid(): Nothing = throw IllegalStateException("notification storage unavailable")
    private fun text(value: JSONObject, field: String) = value.opt(field) as? String ?: invalid()
    private fun fingerprint(value: String) = value.matches(Regex("^[a-z2-7]{26}$"))
    private fun generation(value: String): Boolean = try {
        value.matches(Regex("^[A-Za-z0-9_-]{22}$")) && Base64.UrlSafe.decode("$value==").let { it.size == 16 && Base64.UrlSafe.encode(it).trimEnd('=') == value }
    } catch (_: Exception) { false }
    private fun account(computer: String, record: JSONObject, generation: String) = "$computer.${text(record, "phoneFp")}.$generation"
    private fun load(): JSONObject {
        val state = JSONObject(disk.read() ?: invalid())
        if (state.opt("version") != 1 || state.opt("hideDetails") !is Boolean) invalid()
        val computers = state.getJSONObject("computers")
        for (computer in computers.keys()) {
            val record = computers.getJSONObject(computer)
            if (!fingerprint(computer) || !fingerprint(text(record, "phoneFp")) || !generation(text(record, "generation")) || text(record, "epoch").isEmpty()) invalid()
            if (record.has("previous") && (!generation(text(record, "previous")) || record.getLong("previousUntil") !in 0..9_007_199_254_740_991L)) invalid()
            val sessions = record.getJSONObject("sessions")
            if (sessions.length() > 500) invalid()
            for (session in sessions.keys()) {
                val entry = sessions.getJSONObject(session); val seq = text(entry, "sequence")
                if (session.isEmpty() || session.length > 128 || seq.toULongOrNull()?.let { it > 0uL && it.toString() == seq } != true || entry.getLong("expiresAt") !in 0..9_007_199_254_800_991L) invalid()
            }
        }
        return state
    }
    private fun <T> transaction(block: (JSONObject) -> T): T = disk.locked {
        val state = load(); val before = state.toString(); val result = block(state)
        val after = state.toString(); if (before != after) disk.write(after)
        result
    }
    fun initialize() = disk.locked {
        if (disk.read() != null) { load(); return@locked }
        vault.removeAll()
        disk.write(JSONObject().put("version", 1).put("hideDetails", false).put("computers", JSONObject()).toString())
    }
    fun install(computerFp: String, phoneFp: String, generation: String, key: ByteArray, now: Long) {
        if (!fingerprint(computerFp) || !fingerprint(phoneFp) || !generation(generation) || key.size != 32 || now !in 0..9_007_199_254_440_991L) invalid()
        disk.locked {
            val state = load()
            val computers = state.getJSONObject("computers")
            var record = computers.optJSONObject(computerFp)
            if (record != null && text(record, "phoneFp") != phoneFp) {
                vault.remove(account(computerFp, record, text(record, "generation")))
                if (record.has("previous")) vault.remove(account(computerFp, record, text(record, "previous")))
                record = null
            }
            if (record == null) record = JSONObject().put("phoneFp", phoneFp).put("generation", generation).put("epoch", UUID.randomUUID().toString()).put("sessions", JSONObject())
            else if (text(record, "generation") == generation) {
                val existing = vault.get(account(computerFp, record, generation))
                try { if (existing != null && !existing.contentEquals(key)) invalid() } finally { existing?.fill(0) }
            } else {
                if (record.opt("previous") == generation) invalid()
                if (record.has("previous")) vault.remove(account(computerFp, record, text(record, "previous")))
                record.put("previous", text(record, "generation")).put("previousUntil", now + 300_000).put("generation", generation)
            }
            computers.put(computerFp, record)
            // Persist ownership first: a crash can cause generic fallback, but
            // must never orphan a key outside the revocation record.
            disk.write(state.toString())
            vault.put(account(computerFp, record, generation), key)
        }
    }
    fun removeComputer(computerFp: String) = transaction { state ->
        val record = state.getJSONObject("computers").remove(computerFp) as? JSONObject ?: return@transaction
        vault.remove(account(computerFp, record, text(record, "generation")))
        if (record.has("previous")) vault.remove(account(computerFp, record, text(record, "previous")))
    }
    fun setHideDetails(hide: Boolean) { transaction { it.put("hideDetails", hide) } }
    fun hideDetails(): Boolean = transaction { it.getBoolean("hideDetails") }
    fun evaluate(box: JSONObject, now: Long): NotificationEvaluation = try {
        transaction { state ->
            val computer = text(box, "computerFp"); val phone = text(box, "phoneFp"); val generation = text(box, "generation")
            val record = state.getJSONObject("computers").optJSONObject(computer)
            if (record == null || text(record, "phoneFp") != phone) return@transaction NotificationEvaluation(Disposition.STALE)
            if (record.has("previous") && record.getLong("previousUntil") < now) {
                vault.remove(account(computer, record, text(record, "previous"))); record.remove("previous"); record.remove("previousUntil")
            }
            if (generation != record.opt("generation") && generation != record.opt("previous")) return@transaction NotificationEvaluation(Disposition.STALE)
            var permit = NotificationPermit(computer, phone, generation, text(record, "epoch"))
            val key = vault.get(account(computer, record, generation)) ?: return@transaction NotificationEvaluation(Disposition.GENERIC, permit = permit)
            val payload = try {
                val plain = NotificationCrypto.open(key, box)
                try { JSONObject(plain.toString(Charsets.UTF_8)) } finally { plain.fill(0) }
            } catch (_: Exception) { return@transaction NotificationEvaluation(Disposition.GENERIC, permit = permit) }
            finally { key.fill(0) }
            val sessions = record.getJSONObject("sessions")
            val replay = ReplayState()
            for (session in sessions.keys()) {
                val entry = sessions.getJSONObject(session)
                replay.sessions[session] = ReplayEntry(text(entry, "sequence"), entry.getLong("expiresAt"))
            }
            val decision = NotificationPolicy.evaluate(payload, now, state.getBoolean("hideDetails"), replay)
            if (decision == Disposition.STALE) return@transaction NotificationEvaluation(Disposition.STALE)
            val session = text(payload, "sessionId"); val sequence = text(payload, "sequence")
            if (replay.sessions[session]?.sequence == sequence) permit = permit.copy(sessionId = session, sequence = sequence, expiresAt = payload.getLong("expiresAt") + 60_000)
            val next = JSONObject()
            replay.sessions.forEach { (id, entry) -> next.put(id, JSONObject().put("sequence", entry.sequence).put("expiresAt", entry.expiresAt)) }
            record.put("sessions", next)
            NotificationEvaluation(decision, if (decision == Disposition.RICH) payload else null, permit)
        }
    } catch (_: Exception) { NotificationEvaluation(Disposition.GENERIC) }
    fun publish(result: NotificationEvaluation, now: Long, deliver: (NotificationEvaluation) -> Unit): Boolean {
        if (result.disposition == Disposition.STALE) return false
        val permit = result.permit
        if (permit == null) { deliver(NotificationEvaluation(Disposition.GENERIC)); return true }
        return try {
            disk.locked {
                val state = load(); val record = state.getJSONObject("computers").optJSONObject(permit.computerFp) ?: return@locked false
                if (record.opt("phoneFp") != permit.phoneFp || record.opt("epoch") != permit.epoch ||
                    !(record.opt("generation") == permit.generation || (record.opt("previous") == permit.generation && record.optLong("previousUntil", 0) >= now))) return@locked false
                if (permit.sessionId != null && (record.getJSONObject("sessions").optJSONObject(permit.sessionId)?.opt("sequence") != permit.sequence || (permit.expiresAt ?: 0) < now)) return@locked false
                deliver(if (state.getBoolean("hideDetails")) NotificationEvaluation(Disposition.GENERIC, permit = permit) else result)
                true
            }
        } catch (_: Exception) { false }
    }
}
