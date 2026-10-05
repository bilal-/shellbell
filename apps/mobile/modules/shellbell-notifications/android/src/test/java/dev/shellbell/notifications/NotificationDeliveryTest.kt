package dev.shellbell.notifications

import org.junit.Assert.*
import org.junit.Test

class NotificationDeliveryTest {
  @Test fun richMessagesHaveExactlyOneNativeOwner() {
    val owners = mutableListOf<String>()
    NotificationDelivery.dispatch(mapOf("body" to """{"shellbellNotification":"notify-context-v1","context":{}}"""),
      { owners.add("legacy") }, { owners.add("native") })
    assertEquals(listOf("native"), owners)
  }

  @Test fun legacyAndMalformedMessagesKeepLegacyHandling() {
    val owners = mutableListOf<String>()
    for (data in listOf(emptyMap(), mapOf("body" to "not-json"), mapOf("body" to """{"kind":"blocked"}"""))) {
      NotificationDelivery.dispatch(data, { owners.add("legacy") }, { owners.add("native") })
    }
    assertEquals(listOf("legacy", "legacy", "legacy"), owners)
  }

  @Test fun aFailingNativeOwnerDoesNotAlsoDispatchThroughJavascript() {
    var legacy = false
    assertThrows(IllegalStateException::class.java) {
      NotificationDelivery.dispatch(mapOf("body" to """{"shellbellNotification":"notify-context-v1"}"""),
        { legacy = true }, { throw IllegalStateException("native test failure") })
    }
    assertFalse(legacy)
  }
}
