package dev.shellbell.notifications

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.system.Os
import android.system.OsConstants
import java.io.File
import java.io.FileOutputStream
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal fun interface NotificationWrappingKeyProvider { fun key(): SecretKey }
internal class AndroidNotificationWrappingKeyProvider : NotificationWrappingKeyProvider {
    companion object { private val lock = Any(); private const val alias = "shellbell.notification.wrap.v1" }
    override fun key(): SecretKey = synchronized(lock) {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(alias, null) as? SecretKey) ?: KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true).setUserAuthenticationRequired(false).build())
            generateKey()
        }
    }
}
private fun syncKeyDirectory(directory: File) {
    val fd = Os.open(directory.absolutePath, OsConstants.O_RDONLY, 0)
    try { Os.fsync(fd) } finally { Os.close(fd) }
}

/// The factory supplies a credential-protected noBackupFilesDir subdirectory.
/// Only AES-GCM-wrapped notification keys reach disk; the wrapping key is never exported.
internal class KeystoreNotificationVault(
    private val directory: File,
    private val wrapping: NotificationWrappingKeyProvider = AndroidNotificationWrappingKeyProvider(),
    private val syncDirectory: (File) -> Unit = ::syncKeyDirectory,
) : NotificationKeyVault {
    private fun unavailable(): Nothing = throw IllegalStateException("notification key unavailable")
    private fun account(value: String): String {
        if (!value.matches(Regex("^[A-Za-z0-9._-]{1,128}$"))) unavailable()
        return value
    }
    override fun put(account: String, key: ByteArray) {
        val id = account(account)
        if (key.size != 32) unavailable()
        try {
            if (!directory.isDirectory && !directory.mkdirs()) unavailable()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, wrapping.key())
            cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
            val ciphertext = cipher.doFinal(key)
            if (cipher.iv.size != 12 || ciphertext.size != 48) unavailable()
            val temporary = File.createTempFile("$id.tmp-", ".keytmp", directory)
            try {
                temporary.setReadable(false, false); temporary.setReadable(true, true)
                temporary.setWritable(false, false); temporary.setWritable(true, true)
                FileOutputStream(temporary).use { it.write(cipher.iv); it.write(ciphertext); it.fd.sync() }
                if (!temporary.renameTo(File(directory, "$id.key"))) unavailable()
                syncDirectory(directory)
            } finally { temporary.delete() }
        } catch (_: Exception) { unavailable() }
    }
    override fun get(account: String): ByteArray? {
        val id = account(account)
        try {
            val file = File(directory, "$id.key")
            if (!file.exists()) return null
            if (!file.isFile || file.length() != 60L) unavailable()
            val bytes = file.readBytes()
            if (bytes.size != 60) unavailable()
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, wrapping.key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12)))
            cipher.updateAAD(id.toByteArray(Charsets.UTF_8))
            val key = cipher.doFinal(bytes.copyOfRange(12, bytes.size))
            if (key.size != 32) { key.fill(0); unavailable() }
            return key
        } catch (_: Exception) { unavailable() }
    }
    override fun remove(account: String) {
        val id = account(account)
        if (!directory.exists()) return
        for (file in directory.listFiles() ?: unavailable()) {
            if ((file.name == "$id.key" || (file.name.startsWith("$id.tmp-") && file.name.endsWith(".keytmp"))) && !file.delete()) unavailable()
        }
        syncDirectory(directory)
    }
    override fun removeAll() {
        if (!directory.exists()) return
        for (file in directory.listFiles() ?: unavailable()) {
            if ((file.name.endsWith(".key") || file.name.endsWith(".keytmp")) && !file.delete()) unavailable()
        }
        syncDirectory(directory)
    }
}
