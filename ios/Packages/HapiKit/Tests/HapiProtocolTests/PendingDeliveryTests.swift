import Foundation
import HapiProtocol
import Testing

@Suite("Pending message delivery")
struct PendingDeliveryTests {
    @Test func pendingWireAndReceiptKeepDistinctQueueStates() throws {
        let response = try JSONDecoder().decode(SteerQueuedMessageResponse.self, from: Data(#"{"status":"pending","localId":"l-1"}"#.utf8))
        #expect(response == .pending(localId: "l-1"))
        let recovery = try JSONDecoder().decode(QueuedStateResponse.self, from: Data(#"{"queuedLocalIds":["l-1"],"dispatchingLocalIds":["l-1"],"invokedLocalMessages":[]}"#.utf8))
        #expect(recovery.dispatchingLocalIds == ["l-1"])
        let event = try JSONDecoder().decode(SyncEvent.self, from: Data(#"{"type":"messages-dispatching","sessionId":"s","localIds":["l-1"]}"#.utf8))
        #expect(event == .messagesDispatching(namespace: nil, sessionId: "s", localIds: ["l-1"]))
        let wire = try JSONDecoder().decode(DecryptedMessage.self, from: Data(#"{"id":"m-1","localId":"l-1","seq":1,"createdAt":10,"invokedAt":null,"deliveryState":"dispatching","content":{"role":"user","content":{"type":"text","text":"hello"}}}"#.utf8))
        var state = MessageWindowState(sessionId: "s")
        state.messages = [WindowMessage(wire: wire)]
        #expect(state.messages[0].status == .dispatching)
        #expect(state.messages[0].isQueuedForInvocation)
        #expect(state.messages[0].invokedAtNumber == nil)
        state = MessageWindowLogic.updateStatus(state, localId: "l-1", status: .sent)
        #expect(state.messages[0].isDispatching)
        #expect(state.messages[0].asDecryptedMessage.deliveryState == "dispatching")
        state = MessageWindowLogic.markConsumed(state, localIds: ["l-1"], invokedAt: 20)
        #expect(!state.messages[0].isQueuedForInvocation)
        #expect(state.messages[0].status == .sent)
        #expect(state.messages[0].asDecryptedMessage.deliveryState == nil)
        let consumed = state.messages[0]
        #expect(MessageWindowLogic.markDispatching(state, localIds: ["l-1"]).messages[0] === consumed)
    }

    @Test func pendingCanBecomeUnknownOrRequeuedWithoutInvocation() throws {
        var state = MessageWindowState(sessionId: "s")
        state.messages = [buildOptimisticMessage(localId: "l-1", text: "hello", createdAt: 10, status: .queued)]
        state = MessageWindowLogic.markDispatching(state, localIds: ["l-1"])
        #expect(MessageWindowLogic.queuedReconcileCandidateLocalIds(state) == ["l-1"])
        let snapshot = try JSONEncoder().encode(state.messages[0])
        #expect(try JSONDecoder().decode(WindowMessage.self, from: snapshot).status == .dispatching)
        state = MessageWindowLogic.markIndeterminate(state, localIds: ["l-1"])
        #expect(state.messages[0].status == .indeterminate)
        #expect(MessageWindowLogic.markDispatching(state, localIds: ["l-1"]).messages[0].status == .indeterminate)
        state = MessageWindowLogic.markRequeued(state, localIds: ["l-1"])
        #expect(state.messages[0].status == .queued)
        #expect(state.messages[0].invokedAtNumber == nil)
        #expect(state.messages[0].asDecryptedMessage.deliveryState == nil)
    }
}
