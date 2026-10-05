package dev.shellbell.notifications

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class NotificationCryptoTest {
    @Test fun relayTransportFixturesDecryptAndPresentTwoSessionsWithoutTitleCache() {
        val fixture = JSONObject(File(File(System.getProperty("shellbell.vectors")).parentFile, "notification-transport-vectors.json").readText())
        val cases = fixture.getJSONArray("cases")
        val views = (0 until cases.length()).map { index ->
            val box = cases.getJSONObject(index).getJSONObject("box")
            val payload = JSONObject(NotificationCrypto.open(bytes(fixture.getString("key")), box).toString(Charsets.UTF_8))
            NotificationView.authenticated(payload)
        }
        assertEquals(2, views.map { it.tag }.toSet().size)
        assertEquals(2, views.map { it.collapsedText() }.toSet().size)
        assertTrue(views.all { it.title == "private-repository-qa · private-branch-qa" })
    }
  private fun fixture() = JSONObject(File(System.getProperty("shellbell.vectors")).readText())
  private fun bytes(hex: String) = hex.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

  @Test fun decryptsSharedOpenSSLFixtureWithoutJavaScript() {
    val f = fixture()
    assertEquals(f.getString("plaintext"), NotificationCrypto.open(bytes(f.getString("key")), f.getJSONObject("box")).toString(Charsets.UTF_8))
  }

  @Test fun rejectsSharedNegativeVectors() {
    val bad = fixture().getJSONArray("invalid")
    for (i in 0 until bad.length()) {
      val f = bad.getJSONObject(i)
      assertThrows(f.getString("name"), Exception::class.java) {
        NotificationCrypto.open(bytes(f.getString("key")), f.getJSONObject("box"))
      }
    }
  }

  @Test fun rejectsUnknownFieldsAndOversizedCiphertext() {
    val f = fixture()
    val box = f.getJSONObject("box").put("output", "secret")
    val key = bytes(f.getString("key"))
    assertThrows(Exception::class.java) { NotificationCrypto.open(key, box) }
    box.remove("output")
    box.put("ciphertext", "A".repeat(2071))
    assertThrows(Exception::class.java) { NotificationCrypto.open(key, box) }
  }
}
