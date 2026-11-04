package app.hapi.protocol.window

import app.hapi.protocol.wire.DecryptedMessage
import app.hapi.protocol.wire.HapiJson
import app.hapi.protocol.wire.QueuedStateResponse
import app.hapi.protocol.wire.SteerQueuedMessageResponse
import app.hapi.protocol.wire.SyncEvent
import app.hapi.protocol.wire.SyncEvents
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertSame
import kotlin.test.assertTrue

class PendingDeliveryTest {
    @Test fun `pending wire and consumed receipt keep distinct queue states`() {
        val response = HapiJson.decodeFromString(SteerQueuedMessageResponse.serializer(), """{"status":"pending","localId":"l-1"}""")
        assertEquals("pending", response.status)
        val recovery = HapiJson.decodeFromString(QueuedStateResponse.serializer(), """{"queuedLocalIds":["l-1"],"dispatchingLocalIds":["l-1"],"invokedLocalMessages":[]}""")
        assertEquals(listOf("l-1"), recovery.dispatchingLocalIds)
        val event = assertIs<SyncEvent.MessagesDispatching>(SyncEvents.parse("""{"type":"messages-dispatching","sessionId":"s","localIds":["l-1"]}"""))
        assertEquals(listOf("l-1"), event.localIds)
        val row = HapiJson.decodeFromString(DecryptedMessage.serializer(), """{"id":"m-1","localId":"l-1","seq":1,"createdAt":10,"invokedAt":null,"deliveryState":"dispatching","content":{"role":"user","content":{"type":"text","text":"hello"}}}""").asWindowMessage()
        var state = MessageWindowState(sessionId = "s", messages = listOf(row))
        assertEquals(MessageStatus.Dispatching, row.status)
        assertTrue(row.isQueuedForInvocation)
        assertNull(row.invokedAtOrNull)
        state = MessageWindowLogic.updateStatus(state, "l-1", MessageStatus.Sent)
        assertTrue(state.messages.single().isDispatching)
        assertEquals("dispatching", state.messages.single().wire.deliveryState)
        state = MessageWindowLogic.markConsumed(state, listOf("l-1"), 20)
        assertFalse(state.messages.single().isQueuedForInvocation)
        assertEquals(MessageStatus.Sent, state.messages.single().status)
        assertNull(state.messages.single().wire.deliveryState)
        assertSame(state.messages.single(), MessageWindowLogic.markDispatching(state, listOf("l-1")).messages.single())
    }

    @Test fun `pending can become unknown or requeued without invocation`() {
        var state = MessageWindowState(sessionId = "s", messages = listOf(buildOptimisticMessage(localId = "l-1", text = "hello", createdAt = 10, status = MessageStatus.Queued)))
        state = MessageWindowLogic.markDispatching(state, listOf("l-1"))
        assertEquals(listOf("l-1"), MessageWindowLogic.queuedReconcileCandidateLocalIds(state))
        val snapshot = HapiJson.encodeToString(WindowMessage.serializer(), state.messages.single())
        assertEquals(MessageStatus.Dispatching, HapiJson.decodeFromString(WindowMessage.serializer(), snapshot).status)
        state = MessageWindowLogic.markIndeterminate(state, listOf("l-1"))
        assertEquals(MessageStatus.Indeterminate, MessageWindowLogic.markDispatching(state, listOf("l-1")).messages.single().status)
        state = MessageWindowLogic.markRequeued(state, listOf("l-1"))
        assertEquals(MessageStatus.Queued, state.messages.single().status)
        assertNull(state.messages.single().wire.deliveryState)
        assertNull(state.messages.single().invokedAtOrNull)
    }
}
