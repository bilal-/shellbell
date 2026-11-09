package dev.shellbell.webdoor

import java.nio.ByteBuffer
import javax.crypto.Cipher
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class TransportPlaintextTest {
  private fun cipher(mode: Int, nonce: ByteArray): Cipher = Cipher.getInstance("ChaCha20-Poly1305").apply {
    init(mode, SecretKeySpec(ByteArray(32) { it.toByte() }, "ChaCha20"), IvParameterSpec(nonce))
    updateAAD(byteArrayOf(1, 2, 3))
  }

  @Test fun authenticatesEmptyOffsetAndMaximumViewsWithDifferentNonces() {
    for ((sequence, size) in listOf(0, 31, 65519).withIndex()) {
      val nonce = ByteArray(12).also { it[4] = sequence.toByte() }
      val plain = ByteArray(size) { it.toByte() }
      val encrypted = cipher(Cipher.ENCRYPT_MODE, nonce).doFinal(plain)
      val input = ByteBuffer.allocateDirect(encrypted.size + 9).apply {
        position(5); put(encrypted); flip(); position(5)
      }
      val output = ByteBuffer.allocate(size + 13).apply {
        put(ByteArray(capacity()) { 0x5a.toByte() }); position(7); limit(7 + size)
      }
      assertEquals(size, TransportPlaintext.open(cipher(Cipher.DECRYPT_MODE, nonce), input, output))
      assertArrayEquals(plain, output.array().copyOfRange(7, 7 + size))
      assertEquals(0x5a.toByte(), output.array()[0])
      assertEquals(0x5a.toByte(), output.array().last())
      encrypted[encrypted.lastIndex] = (encrypted.last().toInt() xor 1).toByte()
      val untouched = ByteArray(size) { 0x33 }
      assertEquals(-1, TransportPlaintext.open(cipher(Cipher.DECRYPT_MODE, nonce),
        ByteBuffer.wrap(encrypted), ByteBuffer.wrap(untouched)))
      assertArrayEquals(ByteArray(size) { 0x33 }, untouched)
    }
  }
}
