package dev.shellbell.notifications

import java.io.File
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class DirectProviderContractTest {
    @Test fun directFcmEnvelopeHasOneNativeOwnerAndAuthenticatedReplacementIdentity() {
        val vectors = File(requireNotNull(System.getProperty("shellbell.vectors")))
        val crypto = JSONObject(vectors.readText())
        val fixture = JSONObject(File(vectors.parentFile, "../../relay-core/test-support/native-push-payloads.json").readText())
        val message = fixture.getJSONObject("fcm").getJSONObject("message")
        assertFalse(message.has("notification"))
        val data = message.getJSONObject("data")
        val key = crypto.getString("key").chunked(2).map { it.toInt(16).toByte() }.toByteArray()
        val active = mutableMapOf<String, NotificationView>()
        var posts = 0
        val manager = object : NotificationManagerPort {
            override fun post(view: NotificationView) { active[view.tag] = view; if (!view.summary) posts++ }
        }
        val presenter = NotificationPresenter(
            evaluate = { box, _ ->
                try { NotificationEvaluation(Disposition.RICH, JSONObject(NotificationCrypto.open(key, box).toString(Charsets.UTF_8))) }
                catch (_: Exception) { NotificationEvaluation(Disposition.GENERIC) }
            },
            publish = { result, _, deliver -> deliver(result); true }, manager = manager)
        fun receive(body: String) = NotificationDelivery.dispatch(mapOf("body" to body),
            { fail("Rich FCM data must not also reach the legacy owner") },
            { presenter.receive(JSONObject(body).getJSONObject("context"), 1000) })
        receive(data.getString("body"))
        val rich = active.values.single { !it.summary }
        assertEquals(1, posts)
        assertEquals("shellbell · fix/通知", rich.title)
        assertEquals(message.getJSONObject("android").getString("collapse_key"), rich.tag)
        assertEquals(crypto.getJSONObject("box").getString("computerFp"), rich.computerFp)
        assertEquals(crypto.getJSONObject("box").getString("sessionId"), rich.sessionId)
        receive(data.getString("body"))
        assertEquals(1, active.values.count { !it.summary })
        val tampered = JSONObject(data.getString("body"))
        tampered.getJSONObject("context").put("ciphertext", "AAAAAAAAAAAAAAAA")
        active.clear(); posts = 0
        receive(tampered.toString())
        assertEquals(1, posts)
        val generic = active.values.single()
        assertEquals("Shellbell", generic.title)
        assertEquals("A terminal session needs attention", generic.body)
        assertNull(generic.computerFp); assertNull(generic.sessionId)
    }
}
