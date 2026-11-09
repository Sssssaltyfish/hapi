/** Runs inside the DSH plugin. The factory has no external runtime dependencies. */
export const DSH_REASONING_BRIDGE_SOURCE = String.raw`
function createReasoningBridge(send, warn, newId, metaKey, snapshotInterval) {
    const attempts = new Map()
    const settlements = new Map()

    const notify = (sessionId, block, text, live) => {
        void send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId, update: {
            sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text },
            _meta: { [metaKey]: { id: block.id, live } },
        } } }).catch(error => warn('HAPI reasoning update failed: ' + String(error)))
    }

    const pause = sessionId => {
        const attempt = attempts.get(sessionId)
        if (!attempt) return
        clearTimeout(attempt.timer)
        attempt.timer = undefined
    }

    const finish = (sessionId, message, interrupted) => {
        const attempt = attempts.get(sessionId)
        if (!attempt) return
        pause(sessionId)
        attempts.delete(sessionId)

        // Use the same order as the DSH block assembler. The ACP projection
        // skips empty reasoning blocks and interrupted messages omit whitespace.
        const blocks = [...attempt.blocks.values()]
        const streamed = blocks.filter(block => interrupted ? block.text.trim() : block.text.length)
        const canonical = message?.content.filter(block => block.type === 'reasoning' && block.text.length)
        const aligned = canonical?.length === streamed.length
            && canonical.every((block, index) => block.text === streamed[index].text)
        if (aligned && streamed.some(block => block.published)) {
            let messages = settlements.get(sessionId)
            if (!messages) {
                messages = new Map()
                settlements.set(sessionId, messages)
            }
            messages.set(message.id, { blocks: streamed, index: 0 })
        }

        for (const block of blocks) {
            if (block.published && (!aligned || !streamed.includes(block))) {
                // DSH may retry or abandon a model request. Close only the
                // preview the user saw, under this attempt's own identity.
                notify(sessionId, block, block.published, false)
            }
        }
    }

    return {
        frame(sessionId, frame, canPreview) {
            if (frame.type === 'start') {
                if (!canPreview) return
                finish(sessionId)
                attempts.set(sessionId, { id: frame.attemptId, turn: frame.turn, step: frame.step, blocks: new Map() })
                return
            }
            const attempt = attempts.get(sessionId)
            if (!attempt || attempt.id !== frame.attemptId) return
            if (frame.type === 'end') {
                const event = attempt.event
                const committed = frame.outcome.kind === 'committed' && frame.outcome.eventType === 'assistant/message'
                    && event?.seq === frame.outcome.seq
                finish(sessionId, committed ? event.data.message : undefined, committed && event.data.interrupted)
                return
            }
            if (frame.type !== 'chunk') return
            const chunk = frame.chunk
            if (!(chunk.type === 'reasoning-delta' || (chunk.type === 'block-start' && chunk.blockType === 'reasoning')
                || (chunk.type === 'block-end' && chunk.block.type === 'reasoning'))) return
            let block = attempt.blocks.get(chunk.index)
            if (!block) {
                block = { id: newId(), text: '', published: '', closed: false }
                attempt.blocks.set(chunk.index, block)
            }
            if (block.closed) return
            if (chunk.type === 'reasoning-delta') block.text += chunk.text
            if (chunk.type === 'block-end') {
                block.text = chunk.block.text
                block.closed = true
            }
            if (!canPreview || attempt.timer || block.text === block.published) return
            attempt.timer = setTimeout(() => {
                attempt.timer = undefined
                for (const thought of attempt.blocks.values()) {
                    if (!thought.text.trim() || thought.text === thought.published) continue
                    thought.published = thought.text
                    notify(sessionId, thought, thought.text, true)
                }
            }, snapshotInterval)
        },
        event(session, event) {
            const attempt = attempts.get(session.id)
            if (attempt && event.type === 'assistant/message' && event.data.turn === attempt.turn && event.data.step === attempt.step) {
                attempt.event = event
            }
        },
        update(sessionId, update) {
            if (update.sessionUpdate !== 'agent_thought_chunk') return update
            const messages = settlements.get(sessionId)
            const settlement = messages?.get(update.messageId)
            if (!settlement) return update
            const block = settlement.blocks[settlement.index++]
            if (settlement.index === settlement.blocks.length) {
                messages.delete(update.messageId)
                if (!messages.size) settlements.delete(sessionId)
            }
            return block.published
                ? { ...update, _meta: { ...update._meta, [metaKey]: { id: block.id, live: false } } }
                : update
        },
        pause,
        clear(sessionId) {
            finish(sessionId)
            const messages = settlements.get(sessionId)
            if (!messages) return
            settlements.delete(sessionId)
            // If ACP failed to project a committed message, retire any still
            // live snapshots before the prompt response leaves the bridge.
            for (const settlement of messages.values()) {
                for (const block of settlement.blocks.slice(settlement.index)) {
                    if (block.published) notify(sessionId, block, block.published, false)
                }
            }
        },
    }
}
`
