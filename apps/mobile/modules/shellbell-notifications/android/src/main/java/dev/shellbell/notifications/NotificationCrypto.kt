@file:OptIn(kotlin.io.encoding.ExperimentalEncodingApi::class)
package dev.shellbell.notifications

import org.json.JSONObject
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import kotlin.io.encoding.Base64
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

internal object NotificationCrypto {
  private val headerKeys = listOf("computerFp", "phoneFp", "generation", "sessionId", "eventId")
  private fun fail(): Nothing = throw IllegalArgumentException("invalid notification")
  private fun text(o: JSONObject, name: String): String = o.opt(name) as? String ?: fail()
  private fun keys(o: JSONObject) = o.keys().asSequence().toSet()

  private fun bytes(value: String, min: Int, max: Int): ByteArray {
    if (value.length > (max * 4 + 2) / 3 || !value.matches(Regex("^[A-Za-z0-9_-]+$"))) fail()
        val bytes = Base64.UrlSafe.decode(value + "=".repeat((4 - value.length % 4) % 4))
        if (bytes.size !in min..max || Base64.UrlSafe.encode(bytes).trimEnd('=') != value) fail()
    return bytes
  }

  private fun routing(o: JSONObject): List<String> {
    val h = headerKeys.map { text(o, it) }
    for (fp in h.take(2)) if (!fp.matches(Regex("^[a-z2-7]{26}$"))) fail()
    bytes(h[2], 16, 16)
    if (h[3].isEmpty() || h[3].length > 128) fail()
    bytes(h[4], 16, 16)
    return h
  }

  // JSON.stringify-compatible array strings, not JSONObject.quote's optional slash escaping.
  internal fun quote(s: String): String = buildString {
    append('"')
    for (c in s) when(c) {
      '"' -> append("\\\"")
      '\\' -> append("\\\\")
      '\b' -> append("\\b")
      '\u000c' -> append("\\f")
      '\n' -> append("\\n")
      '\r' -> append("\\r")
      '\t' -> append("\\t")
      else -> if (c.code < 32) append("\\u" + c.code.toString(16).padStart(4, '0')) else append(c)
    }
    append('"')
  }

  private fun integer(value: Any?, nonnegative: Boolean = true): Double {
    val d = (value as? Number)?.toDouble() ?: fail()
    if (!d.isFinite() || d % 1.0 != 0.0 || kotlin.math.abs(d) > 9007199254740991.0 || (nonnegative && d < 0)) fail()
    return d
  }

  private fun label(value: Any?, limit: Int) {
    val s = value as? String ?: fail()
    if (s.isBlank() || s.toByteArray(Charsets.UTF_8).size > limit ||
      Regex("[\\p{Cc}\\p{Cs}\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]").containsMatchIn(s)) fail()
  }

  private fun validate(p: JSONObject, header: List<String>) {
    val required = (headerKeys + listOf("context", "reason", "issuedAt", "expiresAt", "sequence")).toSet()
    if (!keys(p).containsAll(required) || !(required + setOf("exitCode", "durationMs")).containsAll(keys(p)) || routing(p) != header) fail()
    if (text(p, "reason") !in listOf("command-finished", "prompt-returned", "agent-finished", "agent-blocked", "quiet")) fail()
    val seq = text(p, "sequence")
    if (!seq.matches(Regex("^[1-9][0-9]{0,19}$")) || seq.toULongOrNull() == null) fail()
    val context = p.opt("context") as? JSONObject ?: fail()
    val limits = mapOf("computerName" to 128, "sessionLabel" to 128, "customName" to 256,
      "repository" to 256, "branch" to 256, "title" to 256, "shell" to 64, "agentName" to 64)
    if (!keys(context).containsAll(setOf("computerName", "sessionLabel", "observedAt")) ||
      !(limits.keys + "observedAt").containsAll(keys(context))) fail()
    for ((name, limit) in limits) if (context.has(name)) label(context.opt(name), limit)
    val issued = integer(p.opt("issuedAt"))
    val expires = integer(p.opt("expiresAt"))
    if (expires <= issued || expires - issued > 120000 || integer(context.opt("observedAt")) > issued) fail()
    if (p.has("exitCode")) integer(p.opt("exitCode"), false)
    if (p.has("durationMs")) integer(p.opt("durationMs"))
  }

  fun open(key: ByteArray, box: JSONObject): ByteArray {
    try {
      if (key.size != 32 || keys(box) != (headerKeys + listOf("nonce", "ciphertext")).toSet()) fail()
      val header = routing(box)
      val nonce = bytes(text(box, "nonce"), 12, 12)
      val encrypted = bytes(text(box, "ciphertext"), 17, 1552)
      val ad = (listOf("shellbell-notification-v1") + header).joinToString(",", "[", "]") { quote(it) }.toByteArray(Charsets.UTF_8)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding")
      cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
      cipher.updateAAD(ad)
      val plaintext = cipher.doFinal(encrypted)
      if (plaintext.size > 1536) fail()
      val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(plaintext)).toString()
      validate(JSONObject(decoded), header)
      return plaintext
    } catch (_: Exception) { fail() }
  }
}
