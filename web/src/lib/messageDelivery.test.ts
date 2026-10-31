import { describe, expect, it } from 'vitest'
import { isSteeringSupportedForSession } from '@hapi/protocol'
import {
    consumeComposerSendIntent,
    getRestoredComposerSendIntent,
    getRetryDeliveryMode,
    resolveMessageDeliveryMode,
} from './messageDelivery'

describe('consumeComposerSendIntent', () => {
    it('consumes an explicit queue request exactly once', () => {
        const ref = { current: 'queue' as const }

        expect(consumeComposerSendIntent(ref)).toBe('queue')
        expect(ref.current).toBe('default')
        expect(consumeComposerSendIntent(ref)).toBe('default')
    })

    it('defaults safely when no composer ref is present', () => {
        expect(consumeComposerSendIntent()).toBe('default')
    })
})

describe('retry delivery safety', () => {
    it('preserves queue and downgrades steer or missing legacy provenance to queue', () => {
        expect(getRetryDeliveryMode('queue')).toBe('queue')
        expect(getRetryDeliveryMode('steer')).toBe('queue')
        expect(getRetryDeliveryMode(undefined)).toBe('queue')
        expect(getRestoredComposerSendIntent('queue')).toBe('queue')
        expect(getRestoredComposerSendIntent('steer')).toBe('queue')
        expect(getRestoredComposerSendIntent(undefined)).toBe('queue')
    })
})

describe('resolveMessageDeliveryMode', () => {
    const base = {
        agentFlavor: 'pi',
        isSessionThinking: true,
        intent: 'default' as const,
    }

    it('only applies the saved steer default to a supported live turn', () => {
        for (const agentFlavor of ['codex', 'cursor', 'pi']) {
            expect(resolveMessageDeliveryMode({ ...base, agentFlavor, defaultMode: 'steer' })).toBe('steer')
        }
        for (const agentFlavor of ['claude', 'dsh', 'agy', 'future-provider']) {
            for (const steering of [true, false]) expect(resolveMessageDeliveryMode({ ...base, agentFlavor, defaultMode: 'steer',
                steeringSupported: isSteeringSupportedForSession({ flavor: agentFlavor, capabilities: { steering } }) })).toBe(steering ? 'steer' : 'queue')
        }
        for (const agentFlavor of ['agy', 'claude', 'dsh', 'copilot', 'gemini', 'grok', 'kimi', 'opencode', 'future-provider', null, undefined]) {
            expect(resolveMessageDeliveryMode({ ...base, agentFlavor, defaultMode: 'steer' })).toBe('queue')
        }
        for (const metadata of [{ flavor: 'cursor', cursorSessionProtocol: 'stream-json' as const }, { flavor: 'cursor', cursorSessionId: 'pre-acp' }]) {
            expect(resolveMessageDeliveryMode({ ...base, agentFlavor: metadata.flavor, defaultMode: 'steer',
                steeringSupported: isSteeringSupportedForSession(metadata) })).toBe('queue')
        }
        for (const override of [{ steeringSupported: false }, { isSessionThinking: false },
            { intent: 'queue' as const }, { scheduledAt: Date.now() + 1000 }, { routesToScratchlist: true }]) {
            expect(resolveMessageDeliveryMode({ ...base, defaultMode: 'steer', ...override })).toBe('queue')
        }
    })

    // With no saved preference the existing queue default remains unchanged.
    it.each([
        { name: 'thinking Pi (previously auto-steered)', input: base },
        { name: 'thinking Pi with explicit queue intent', input: { ...base, intent: 'queue' as const } },
        { name: 'idle Pi', input: { ...base, isSessionThinking: false } },
        { name: 'non-Pi flavor', input: { ...base, agentFlavor: 'codex' } },
        { name: 'scheduled message', input: { ...base, scheduledAt: Date.now() + 60_000 } },
        { name: 'scratchlist route', input: { ...base, routesToScratchlist: true } },
    ])('queues $name', ({ input }) => {
        expect(resolveMessageDeliveryMode(input)).toBe('queue')
    })

    it('keeps the retry-restore contract: a failed steer retry restores as queue', () => {
        const ref = { current: getRestoredComposerSendIntent('steer') }
        const retryIntent = consumeComposerSendIntent(ref)

        expect(retryIntent).toBe('queue')
        expect(ref.current).toBe('default')
        expect(resolveMessageDeliveryMode({ ...base, intent: retryIntent })).toBe('queue')
    })
})
