package dev.shellbell.notifications

import java.io.File
import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.StandardOpenOption
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test

private class MemoryKeyVault : NotificationKeyVault {
    val values = mutableMapOf<String, ByteArray>()
    var beforePut: (() -> Unit)? = null
    override fun put(account: String, key: ByteArray) { beforePut?.invoke(); values[account] = key.copyOf() }
    override fun get(account: String) = values[account]?.copyOf()
    override fun remove(account: String) { values.remove(account)?.fill(0) }
    override fun removeAll() { values.values.forEach { it.fill(0) }; values.clear() }
}

class NotificationStoreTest {
    @Test fun directorySyncFailureCanFollowCommittedPrivacyRename() {
        var fail = false
        val store = NotificationStore(FileNotificationDisk(root) { if (fail) error("directory fsync failed") }, vault)
        store.initialize()
        store.setHideDetails(true)
        fail = true
        assertThrows(IllegalStateException::class.java) { store.setHideDetails(false) }
        fail = false
        assertFalse(store.hideDetails())
    }
    @Test fun privacyPreferenceReadsDurableStateAcrossStoreInstances() {
        val store = installed()
        assertFalse(store.hideDetails())
        store.setHideDetails(true)
        assertTrue(NotificationStore(disk, vault).hideDetails())
        store.setHideDetails(false)
        assertFalse(store.hideDetails())
    }
    private lateinit var root: File
    private lateinit var disk: FileNotificationDisk
    private lateinit var vault: MemoryKeyVault
    private lateinit var box: JSONObject
    private lateinit var key: ByteArray
    @Before fun setUp() {
        root = Files.createTempDirectory("shellbell-notification-").toFile()
        disk = FileNotificationDisk(root) { directory -> FileChannel.open(directory.toPath(), StandardOpenOption.READ).use { it.force(true) } }
        vault = MemoryKeyVault()
        val fixture = JSONObject(File(System.getProperty("shellbell.vectors")).readText())
        box = fixture.getJSONObject("box")
        key = fixture.getString("key").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
    @After fun tearDown() { root.deleteRecursively() }
    private fun installed(): NotificationStore = NotificationStore(disk, vault).also {
        it.initialize(); it.install(box.getString("computerFp"), box.getString("phoneFp"), box.getString("generation"), key, 1000)
    }
    @Test fun authenticatedReplaySurvivesRestartWithoutPersistingPrivateLabels() {
        val store = installed()
        assertEquals(Disposition.RICH, store.evaluate(box, 1000).disposition)
        assertEquals(Disposition.STALE, NotificationStore(disk, vault).evaluate(box, 1000).disposition)
        val text = File(root, "state.json").readText()
        assertFalse(text.contains("MacBook")); assertFalse(text.contains("repository"))
        assertFalse(text.contains(java.util.Base64.getEncoder().encodeToString(key)))
    }
    @Test fun tamperingCannotAdvanceReplayAndUnavailableKeyCannotShowDetails() {
        val store = installed()
        val bad = JSONObject(box.toString()).put("nonce", "AAAAAAAAAAAAAAAA")
        assertEquals(Disposition.GENERIC, store.evaluate(bad, 1000).disposition)
        assertEquals(Disposition.RICH, store.evaluate(box, 1000).disposition)
        vault.removeAll()
        val result = store.evaluate(box, 1000)
        assertEquals(Disposition.GENERIC, result.disposition); assertNull(result.payload)
    }
    @Test fun unpairRevokesPendingPresentationAndDeletesKeys() {
        val store = installed(); val pending = store.evaluate(box, 1000)
        store.removeComputer(box.getString("computerFp"))
        var shown = 0
        assertFalse(store.publish(pending, 1000) { shown++ })
        assertEquals(0, shown); assertTrue(vault.values.isEmpty())
        assertEquals(Disposition.STALE, store.evaluate(box, 1000).disposition)
    }
    @Test fun privacyChangesAreRecheckedAndMissingMetadataCannotReviveOldKeys() {
        val store = installed(); val pending = store.evaluate(box, 1000)
        store.setHideDetails(true)
        assertTrue(store.publish(pending, 1000) { assertEquals(Disposition.GENERIC, it.disposition); assertNull(it.payload) })
        File(root, "state.json").delete()
        assertEquals(Disposition.GENERIC, store.evaluate(box, 1000).disposition)
        store.initialize(); assertTrue(vault.values.isEmpty())
        assertEquals(Disposition.STALE, store.evaluate(box, 1000).disposition)
    }
    @Test fun previousGenerationKeyExpiresAfterFiveMinutes() {
        val store = installed()
        store.install(box.getString("computerFp"), box.getString("phoneFp"), "AgICAgICAgICAgICAgICAg", ByteArray(32) { 9 }, 1000)
        assertEquals(Disposition.RICH, store.evaluate(box, 1000).disposition)
        assertEquals(Disposition.STALE, store.evaluate(box, 301_001).disposition)
        assertEquals(1, vault.values.size)
    }
    @Test fun enrollmentIsDurablyTrackedBeforeKeyCreationSoCrashesCannotOrphanKeys() {
        val store = installed(); val generation = "AgICAgICAgICAgICAgICAg"
        vault.beforePut = {
            val record = JSONObject(File(root, "state.json").readText()).getJSONObject("computers").getJSONObject(box.getString("computerFp"))
            assertEquals(generation, record.getString("generation"))
        }
        store.install(box.getString("computerFp"), box.getString("phoneFp"), generation, ByteArray(32) { 9 }, 1000)
    }
    @Test fun failedMetadataCommitNeverReturnsPrivatePayload() {
        val store = installed()
        val failing = FileNotificationDisk(root) { throw IllegalStateException("unavailable") }
        val result = NotificationStore(failing, vault).evaluate(box, 1000)
        assertEquals(Disposition.GENERIC, result.disposition); assertNull(result.payload)
    }
}
