import { expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { nativeThreadReferenceMessage } from './nativeThreadReferences'
import { serializeResponseAnnotations, splitResponseAnnotations } from '@/lib/responseAnnotations'
import { splitCodexThreadReferences } from '@hapi/protocol/sessionCitation'

it('preserves quote context and emits only real Desktop host/thread references before the user request', async () => {
    const resolve = vi.fn(async () => ({ sessionId: 'codex-native:remote:target', endpointId: 'remote', threadId: 'target', hostId: 'wsl:Ubuntu' }))
    const api = { getCodexNativeReferenceCapabilities: vi.fn(async () => ({ readThread: true })), resolveCodexNativeThreadReference: resolve } as unknown as ApiClient
    const quoted = [{ text: 'selected text', source: { messageId: 'response', startOffset: 0, endOffset: 13 } }]
    const result = await nativeThreadReferenceMessage(api, { endpointId: 'local', threadId: 'current' },
        serializeResponseAnnotations('Compare [Other chat](/sessions/codex-native%3Aremote%3Atarget)', quoted))
    expect(resolve).toHaveBeenCalledWith({ threadId: 'target', targetEndpointId: 'remote' })
    const annotations = splitResponseAnnotations(result)
    expect(annotations.annotations).toEqual(quoted)
    const references = splitCodexThreadReferences(annotations.body)
    expect(references.references).toEqual([{ hostId: 'wsl:Ubuntu', threadId: 'target' }])
    expect(references.body).toBe('## My request:\nCompare [Other chat](thread://target?hostId=wsl%3AUbuntu)\n')
})

it('never requests a thread read or changes an ordinary prompt, and refuses an unavailable reference tool', async () => {
    const capability = vi.fn(async () => ({ readThread: false }))
    const api = { getCodexNativeReferenceCapabilities: capability } as unknown as ApiClient
    expect(await nativeThreadReferenceMessage(api, { endpointId: 'local', threadId: 'current' }, 'ordinary text')).toBe('ordinary text')
    expect(capability).not.toHaveBeenCalled()
    await expect(nativeThreadReferenceMessage(api, { endpointId: 'local', threadId: 'current' }, '[Other](/sessions/codex-native%3Aremote%3Atarget)')).rejects.toThrow('cannot read referenced chats')
})

it('unions an existing Desktop context with a new chip without nesting machine wrappers', async () => {
    const api = {
        getCodexNativeReferenceCapabilities: async () => ({ readThread: true }),
        resolveCodexNativeThreadReference: async () => ({ sessionId: 'codex-native:remote:next', endpointId: 'remote', threadId: 'next', hostId: 'wsl:Ubuntu' }),
    } as unknown as ApiClient
    const existing = await nativeThreadReferenceMessage(api, { endpointId: 'local', threadId: 'current' },
        serializeResponseAnnotations('See [Next](/sessions/codex-native%3Aremote%3Anext)', [{ text: 'quote' }]))
    const result = await nativeThreadReferenceMessage(api, { endpointId: 'local', threadId: 'current' },
        existing + ' and [Next again](/sessions/codex-native%3Aremote%3Anext)')
    expect(result.match(/## Referenced chats with Codex:/g)).toHaveLength(1)
    expect(splitResponseAnnotations(result).annotations).toEqual([{ text: 'quote' }])
    expect(splitCodexThreadReferences(splitResponseAnnotations(result).body).references).toEqual([{ hostId: 'wsl:Ubuntu', threadId: 'next' }])
})

it('replaces the entire absolute HAPI session URL with its host-scoped thread destination', async () => {
    const api = {
        getCodexNativeReferenceCapabilities: async () => ({ readThread: true }),
        resolveCodexNativeThreadReference: async () => ({ sessionId: 'codex-native:windows:target', endpointId: 'windows', threadId: 'target', hostId: 'local' }),
    } as unknown as ApiClient
    const result = await nativeThreadReferenceMessage(api, { endpointId: 'windows', threadId: 'current' },
        'See [Original](https://hapi.example/sessions/codex-native%3Awindows%3Atarget?outline=true)')
    expect(splitCodexThreadReferences(result).body).toBe('## My request:\nSee [Original](thread://target?hostId=local)\n')
})
