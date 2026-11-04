import { afterEach, describe, expect, it, vi } from 'vitest'
import { captureConversationScrollAnchor, restoreConversationScrollAnchor } from './conversation-scroll-anchor'

afterEach(() => {
    document.body.replaceChildren()
    vi.restoreAllMocks()
})

function viewport() {
    const element = document.createElement('div')
    element.innerHTML = '<div class="happy-thread-messages"></div>'
    document.body.append(element)
    vi.spyOn(element, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 500, height: 500, left: 0, right: 400 } as DOMRect)
    return element
}

function place(element: HTMLElement, scroller: HTMLElement, absoluteTop: number, height = 50) {
    vi.spyOn(element, 'getBoundingClientRect').mockImplementation(() => ({
        top: absoluteTop - scroller.scrollTop,
        bottom: absoluteTop + height - scroller.scrollTop,
        height
    } as DOMRect))
}

describe('stable conversation content anchors', () => {
    it('prefers visible tool or user content over a clipped sliver whose nearest caret is above the viewport', () => {
        const rangeDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
        const caretDescriptor = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ top: 48.5, bottom: 62.5, height: 14 } as DOMRect)
        })
        try {
            for (const key of ['tool:visible', 'user-text:visible']) {
                const scroller = viewport()
                scroller.scrollTop = 212
                vi.spyOn(scroller, 'getBoundingClientRect').mockReturnValue({ top: 64, bottom: 872, height: 808, left: 0, right: 400 } as DOMRect)
                const sliver = document.createElement('div')
                sliver.dataset.hapiScrollAnchors = JSON.stringify(['tool:offscreen-header'])
                sliver.textContent = 'Run project commands Started 5:28 Finished 5:31 Duration 3 minutes'
                place(sliver, scroller, 223.5, 60)
                const readable = document.createElement('div')
                readable.dataset.hapiScrollAnchor = key
                const top = key.startsWith('tool:') ? 79.5 : 164
                place(readable, scroller, top + scroller.scrollTop)
                const clip = document.createElement('div')
                clip.style.overflowY = 'hidden'
                place(clip, scroller, 312, 20)
                const clipped = document.createElement('div')
                clipped.dataset.hapiScrollAnchor = 'tool:outside-inner-clip'
                place(clipped, scroller, 287, 10)
                clip.append(clipped)
                scroller.firstElementChild!.append(sliver, readable, clip)
                Object.defineProperty(document, 'caretPositionFromPoint', {
                    configurable: true,
                    value: () => ({ offsetNode: sliver.firstChild, offset: 27 })
                })
                const anchor = captureConversationScrollAnchor(scroller)!
                expect(anchor.id).toBe(key)
                expect(anchor.topOffset).toBe(top - 64)
                expect(anchor.alternatives?.some(point => point.id === 'tool:outside-inner-clip')).toBe(false)
                const fallback = anchor.alternatives?.find(point => point.id === 'tool:offscreen-header')
                expect(fallback?.topOffset).toBe(-52.5)
                expect(fallback?.textOffset).toBeUndefined()
                scroller.remove()
            }
        } finally {
            if (rangeDescriptor) {
                Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeDescriptor)
            } else {
                Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
            }
            if (caretDescriptor) {
                Object.defineProperty(document, 'caretPositionFromPoint', caretDescriptor)
            } else {
                Reflect.deleteProperty(document, 'caretPositionFromPoint')
            }
        }
    })

    it('preserves an expanded tool row after its aggregate message and group are replaced and the opposite edge is trimmed', () => {
        const scroller = viewport()
        scroller.scrollTop = 100
        const message = document.createElement('div')
        message.id = 'old-aggregate'
        const tool = document.createElement('button')
        tool.dataset.hapiScrollAnchor = 'tool:retained-source'
        message.append(tool)
        scroller.firstElementChild!.append(message)
        place(message, scroller, 100, 300)
        place(tool, scroller, 120)
        const anchor = captureConversationScrollAnchor(scroller)!
        message.remove()
        const replacement = document.createElement('div')
        replacement.id = 'different-aggregate'
        const row = document.createElement('button')
        row.dataset.hapiScrollAnchor = 'tool:retained-source'
        replacement.append(row)
        scroller.firstElementChild!.append(replacement)
        place(row, scroller, 620)
        expect(restoreConversationScrollAnchor(scroller, anchor)).toBe(true)
        expect(row.getBoundingClientRect().top).toBe(20)
        expect(scroller.scrollTop).toBe(600)
    })

    it('retains a collapsed group through member eviction using surviving real tool aliases', () => {
        const scroller = viewport()
        const group = document.createElement('div')
        group.dataset.hapiScrollAnchors = JSON.stringify(['tool:evicted', 'tool:survives'])
        scroller.firstElementChild!.append(group)
        place(group, scroller, 30)
        const anchor = captureConversationScrollAnchor(scroller)!
        group.remove()
        const regrouped = document.createElement('div')
        regrouped.dataset.hapiScrollAnchors = JSON.stringify(['tool:survives', 'tool:new'])
        scroller.firstElementChild!.append(regrouped)
        place(regrouped, scroller, 230)
        expect(restoreConversationScrollAnchor(scroller, anchor)).toBe(true)
        expect(regrouped.getBoundingClientRect().top).toBe(30)
    })

    it('keeps the same reading character when an earlier paragraph is inserted into a retained source', () => {
        const scroller = viewport()
        scroller.scrollTop = 100
        const source = document.createElement('div')
        source.dataset.hapiScrollAnchor = 'reasoning:retained-stream'
        const text = 'Existing line that I am reading.'
        source.textContent = text
        scroller.firstElementChild!.append(source)
        place(source, scroller, 50, 400)
        let characterTop = 120
        let restoredOffset = -1
        const rangeDescriptor = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
        const caretDescriptor = Object.getOwnPropertyDescriptor(document, 'caretPositionFromPoint')
        Object.defineProperty(document, 'caretPositionFromPoint', { configurable: true, value: () => ({ offsetNode: source.firstChild, offset: 5 }) })
        Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: function (this: Range) {
            restoredOffset = this.startOffset
            return { top: characterTop + this.startOffset - scroller.scrollTop, height: 10 } as DOMRect
        } })
        try {
            const anchor = JSON.parse(JSON.stringify(captureConversationScrollAnchor(scroller)))
            const prefix = 'prepended words '
            source.textContent = prefix + text
            characterTop = 420
            expect(restoreConversationScrollAnchor(scroller, anchor)).toBe(true)
            expect(restoredOffset).toBe(prefix.length + 5)
            expect(characterTop + restoredOffset - scroller.scrollTop).toBe(25)
        } finally {
            if (rangeDescriptor) Object.defineProperty(Range.prototype, 'getBoundingClientRect', rangeDescriptor)
            else Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
            if (caretDescriptor) Object.defineProperty(document, 'caretPositionFromPoint', caretDescriptor)
            else Reflect.deleteProperty(document, 'caretPositionFromPoint')
        }
    })
})
