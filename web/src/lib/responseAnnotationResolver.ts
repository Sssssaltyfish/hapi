import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'
import type { NormalizedMessage } from '@/chat/types'
import type { ConversationOutlineItem } from '@/chat/outline'
import { normalizeDecryptedMessage } from '@/chat/normalize'
import { projectNativeItems } from '@/codex-native/projectNativeItems'
import type { NativeItemEntry } from '@/codex-native/types'
import { type ResponseAnnotation, type ResponseAnnotationSource } from './responseAnnotations'
import { splitCodexInputContext } from './codexInputContext'
import { parseNativeQuestionReply } from './nativeQuestionReply'

type PartLocator = { rawId: string; partId: string; nativeId?: string; turnId?: string }
export type AnnotationNavigationTarget = { item: ConversationOutlineItem; source: ResponseAnnotationSource; text: string }
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {}
function retain<K, V>(map: Map<K, V>, key: K, value: V, limit: number) {
    map.delete(key); map.set(key, value)
    while (map.size > limit) map.delete(map.keys().next().value!)
}
function abort(signal?: AbortSignal) { signal?.throwIfAborted() }
function waitFor<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return promise
    abort(signal)
    return new Promise((resolve, reject) => {
        const cancelled = () => reject(signal.reason)
        signal.addEventListener('abort', cancelled, { once: true })
        promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancelled))
    })
}
function parts(message: NormalizedMessage): PartLocator[] {
    if (message.role !== 'agent') return []
    const meta = record(message.meta)
    return message.content.flatMap((part, index) => part.type === 'text' ? [{
        rawId: message.id,
        partId: `agent-text:${part.streamId || `${message.id}:${index}`}`,
        ...(typeof meta.nativeCodexResponseItemId === 'string' ? { nativeId: meta.nativeCodexResponseItemId } : {}),
        ...(typeof meta.codexTurnId === 'string' ? { turnId: meta.codexTurnId } : {}),
    }] : [])
}
function entryMessages(entries: NativeItemEntry[]) {
    return projectNativeItems(entries, [], false).messages.map(normalizeDecryptedMessage).filter((value): value is NormalizedMessage => value !== null)
}

/** Bounded, session-owned browser cache. Raw history remains authoritative on the runner/daemon. */
export class ResponseAnnotationResolver {
    private locators = new Map<string, PartLocator>()
    private nativeTurns = new Map<string, string>()
    private annotations = new Map<string, readonly ResponseAnnotation[]>()
    private annotationSizes = new Map<string, number>()
    private annotationBytes = 0
    private normalized = new WeakMap<DecryptedMessage, NormalizedMessage | null>()
    private nativeCursor: string | null | undefined
    private nativePage: Promise<void> | null = null
    private nativeCursors = new Set<string>()
    constructor(private api: ApiClient, private session: Session) {}
    updateApi(api: ApiClient) { this.api = api }

    private rememberAnnotations(partId: string, value: readonly ResponseAnnotation[]) {
        if (this.annotations.get(partId) === value) return
        const bytes = JSON.stringify(value).length * 2
        this.annotationBytes -= this.annotationSizes.get(partId) ?? 0
        this.annotations.delete(partId); this.annotationSizes.delete(partId)
        // Oversized individual quotes remain available through the original read.
        if (bytes > 2 * 1024 * 1024) return
        this.annotations.set(partId, value); this.annotationSizes.set(partId, bytes); this.annotationBytes += bytes
        while (this.annotations.size > 128 || this.annotationBytes > 2 * 1024 * 1024) {
            const oldest = this.annotations.keys().next().value!
            this.annotationBytes -= this.annotationSizes.get(oldest) ?? 0
            this.annotations.delete(oldest); this.annotationSizes.delete(oldest)
        }
    }

    observe(messages: readonly DecryptedMessage[]) {
        let prompt: readonly ResponseAnnotation[] | undefined
        for (const raw of messages) {
            if (!this.normalized.has(raw)) this.normalized.set(raw, normalizeDecryptedMessage(raw))
            const message = this.normalized.get(raw)
            if (!message) continue
            if (message.role === 'user') {
                if (!parseNativeQuestionReply(message.content.text)) prompt = splitCodexInputContext(message.content.text).annotations
                continue
            }
            for (const part of parts(message)) {
                retain(this.locators, part.partId, part, 2048)
                if (part.nativeId && part.turnId) retain(this.nativeTurns, part.nativeId, part.turnId, 4096)
                if (prompt) this.rememberAnnotations(part.partId, prompt)
            }
        }
    }

    sourceForPart(partId?: string): { messageId: string; turnId?: string; partId?: string } | undefined {
        const part = partId ? this.locators.get(partId) : undefined
        if (!part) return
        return part.nativeId ? { messageId: part.nativeId, ...(part.turnId ? { turnId: part.turnId } : {}) }
            : { messageId: part.rawId, partId: part.partId }
    }

    private async nativeTurn(itemId: string, hint: string | undefined, signal?: AbortSignal): Promise<string> {
        if (hint) return hint
        const known = this.nativeTurns.get(itemId)
        if (known) return known
        // Old Desktop annotations have only itemId. The native protocol requires turnId;
        // lazily build an in-memory index from real item pages, retaining the cursor.
        let mayRestartAtHead = typeof this.nativeCursor === 'string'
        if (this.nativeCursor === null && !this.nativePage) { this.nativeCursor = undefined; this.nativeCursors.clear() }
        while (true) {
            abort(signal)
            if (!this.nativePage) {
                // Share one page request across all references. A closed popover
                // cancels its wait; the small shared read can finish for others.
                this.nativePage = (async () => {
                    const cursor = this.nativeCursor ?? undefined
                    const page = await this.api.getCodexNativeItems(this.session.metadata!.nativeCodex!.threadId, cursor, 'desc')
                    for (const entry of page.data) if (entry.turnId) retain(this.nativeTurns, entry.item.id, entry.turnId, 4096)
                    if (page.nextCursor && (page.nextCursor === cursor || this.nativeCursors.has(page.nextCursor))) throw new Error('History pagination did not advance. Please retry.')
                    if (page.nextCursor) this.nativeCursors.add(page.nextCursor)
                    this.nativeCursor = page.nextCursor
                })().finally(() => { this.nativePage = null })
            }
            await waitFor(this.nativePage, signal)
            const found = this.nativeTurns.get(itemId)
            if (found) return found
            if (this.nativeCursor) continue
            // A resumed scan may start older than a source evicted from the
            // bounded index. Finish that continuation, then wrap to the head
            // once in this lookup before reporting a genuinely missing item.
            if (!mayRestartAtHead) break
            mayRestartAtHead = false
            this.nativeCursor = undefined
            this.nativeCursors.clear()
        }
        throw new Error('The original message is no longer available.')
    }

    async readAnnotations(partId: string, signal?: AbortSignal): Promise<readonly ResponseAnnotation[]> {
        const cached = this.annotations.get(partId)
        if (cached) return cached
        const owner = this.locators.get(partId)
        if (!owner) throw new Error('The original reply could not be located.')
        let annotations: readonly ResponseAnnotation[] = []
        if (this.session.metadata?.nativeCodex && owner.nativeId) {
            const threadId = this.session.metadata.nativeCodex.threadId
            const turnId = await this.nativeTurn(owner.nativeId, owner.turnId, signal)
            let cursor: string | { type: 'item'; itemId: string } | undefined = { type: 'item', itemId: owner.nativeId }
            const seen = new Set<string>()
            do {
                abort(signal)
                const page = await this.api.getCodexNativeTurnItems(threadId, turnId, { cursor, sortDirection: 'desc', limit: 50, signal })
                for (const entry of page.data) {
                    if (entry.item.type !== 'userMessage' && entry.item.type !== 'steeringUserMessage') continue
                    const user = entryMessages([entry]).find(message => message.role === 'user')
                    if (!user || user.role !== 'user' || parseNativeQuestionReply(user.content.text)) continue
                    annotations = splitCodexInputContext(user.content.text).annotations
                    this.rememberAnnotations(partId, annotations)
                    return annotations
                }
                if (page.nextCursor && seen.has(page.nextCursor)) throw new Error('History pagination did not advance. Please retry.')
                if (page.nextCursor) seen.add(page.nextCursor)
                cursor = page.nextCursor ?? undefined
            } while (cursor)
        } else {
            const context = await this.api.getRunnerMessageContext(this.session.id, owner.rawId, signal)
            let page = context.page
            let beforeOwner = false
            do {
                abort(signal)
                const ordered = [...page.messages].sort((a, b) => a.createdAt - b.createdAt || (a.seq ?? 0) - (b.seq ?? 0))
                for (const raw of ordered.reverse()) {
                    if (raw.id === owner.rawId) { beforeOwner = true; continue }
                    if (!beforeOwner) continue
                    const message = normalizeDecryptedMessage(raw)
                    if (message?.role !== 'user' || parseNativeQuestionReply(message.content.text)) continue
                    annotations = splitCodexInputContext(message.content.text).annotations
                    this.rememberAnnotations(partId, annotations)
                    return annotations
                }
                if (!page.page.hasMore) break
                const beforeAt = page.page.nextBeforeAt
                const beforeSeq = page.page.nextBeforeSeq
                if (beforeAt == null || beforeSeq == null) throw new Error('History pagination did not advance. Please retry.')
                const next = await this.api.getMessages(this.session.id, { beforeAt, beforeSeq, limit: 50 }, signal)
                if (next.page.hasMore && next.page.nextBeforeAt === beforeAt && next.page.nextBeforeSeq === beforeSeq) throw new Error('History pagination did not advance. Please retry.')
                page = next
            } while (true)
        }
        this.rememberAnnotations(partId, annotations)
        return annotations
    }

    async resolve(annotation: ResponseAnnotation, signal?: AbortSignal): Promise<AnnotationNavigationTarget> {
        const source = annotation.source
        if (!source) throw new Error('This older quote has no saved message location.')
        let part: PartLocator | undefined
        let item: ConversationOutlineItem
        const native = this.session.metadata?.nativeCodex
        if (native) {
            const turnId = await this.nativeTurn(source.messageId, source.turnId, signal)
            const { entry } = await this.api.getCodexNativeItem(native.threadId, turnId, source.messageId, signal)
            part = entryMessages([entry]).flatMap(parts).find(value => value.nativeId === source.messageId)
            if (!part) throw new Error('The original response contains no text.')
            retain(this.locators, part.partId, part, 2048)
            item = { id: `quote:${part.partId}`, targetMessageId: part.partId, kind: 'user', label: '', createdAt: entry.startedAtMs ?? 0,
                nativeTurn: { turnId, itemId: source.messageId } }
        } else {
            const context = await this.api.getRunnerMessageContext(this.session.id, source.messageId, signal)
            const message = normalizeDecryptedMessage(context.message)
            const candidates = message ? parts(message) : []
            part = source.partId ? candidates.find(value => value.partId === source.partId)
                : candidates.length === 1 ? candidates[0] : undefined
            if (!part) throw new Error('The exact original text part could not be located.')
            retain(this.locators, part.partId, part, 2048)
            item = { id: `quote:${part.partId}`, targetMessageId: part.partId, kind: 'user', label: '', createdAt: context.position.at,
                historyPage: { kind: 'runner', beforeAt: context.position.at, beforeSeq: context.position.seq + 1, epoch: context.epoch } }
        }
        abort(signal)
        return { item, source, text: annotation.text }
    }
}
