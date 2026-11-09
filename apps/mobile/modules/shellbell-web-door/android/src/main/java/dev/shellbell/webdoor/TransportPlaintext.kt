package dev.shellbell.webdoor

import java.nio.ByteBuffer
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher

/** Android providers may estimate ciphertext length even for AEAD decrypt.
 * Supply bounded provider capacity and expose only authenticated plaintext. */
internal object TransportPlaintext {
  fun open(cipher: Cipher, input: ByteBuffer, output: ByteBuffer): Int {
    require(input.remaining() in 16..65535)
    val expected = input.remaining() - 16
    require(output.remaining() == expected)
    val capacity = cipher.getOutputSize(input.remaining())
    require(capacity in expected..65535)
    val scratch = ByteArray(capacity)
    try {
      val written = cipher.doFinal(input, ByteBuffer.wrap(scratch))
      check(written == expected)
      output.put(scratch, 0, written)
      return written
    } catch (_: AEADBadTagException) {
      return -1
    } finally {
      scratch.fill(0)
    }
  }
}
