package dev.shellbell.notifications

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import javax.crypto.spec.SecretKeySpec
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

class NotificationKeyVaultTest {
    private lateinit var root: File
    private lateinit var vault: KeystoreNotificationVault
    @Before fun setup() {
        root = Files.createTempDirectory("shellbell-wrapped-keys-").toFile()
        vault = KeystoreNotificationVault(root, NotificationWrappingKeyProvider { SecretKeySpec(ByteArray(32) { 4 }, "AES") }) {
            FileChannel.open(it.toPath(), StandardOpenOption.READ).use { channel -> channel.force(true) }
        }
    }
    @After fun cleanup() { root.deleteRecursively() }
    @Test fun storesOnlyAuthenticatedCiphertextAndFreshNonces() {
        val key = ByteArray(32) { 7 }
        vault.put("computer.phone.generation", key)
        val first = File(root, "computer.phone.generation.key").readBytes()
        assertEquals(60, first.size)
        assertFalse(first.toList().windowed(32).contains(key.toList()))
        assertArrayEquals(key, vault.get("computer.phone.generation"))
        vault.put("computer.phone.generation", key)
        assertFalse(first.contentEquals(File(root, "computer.phone.generation.key").readBytes()))
        assertArrayEquals(key, vault.get("computer.phone.generation"))
    }
    @Test fun swappingOrTamperingWithWrappedRecordsCannotExportAKey() {
        vault.put("one", ByteArray(32) { 7 })
        File(root, "one.key").copyTo(File(root, "two.key"))
        assertThrows(Exception::class.java) { vault.get("two") }
        val bytes = File(root, "one.key").readBytes(); bytes[20] = (bytes[20].toInt() xor 1).toByte()
        File(root, "one.key").writeBytes(bytes)
        assertThrows(Exception::class.java) { vault.get("one") }
    }
    @Test fun revocationDeletesOnlyOwnedWrappedKeysAndRejectsInvalidPaths() {
        vault.put("one", ByteArray(32) { 7 }); vault.put("two", ByteArray(32) { 8 })
        File(root, "unrelated.txt").writeText("leave intact")
        vault.remove("one"); assertNull(vault.get("one"))
        vault.removeAll(); assertNull(vault.get("two"))
        assertTrue(File(root, "unrelated.txt").exists())
        assertThrows(Exception::class.java) { vault.put("../escape", ByteArray(32)) }
        assertThrows(Exception::class.java) { vault.put("invalid-length", ByteArray(16)) }
    }
}
