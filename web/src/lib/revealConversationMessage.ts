import { getConversationMessageAnchorId } from '@/chat/outline'

function nextLayout(): Promise<void> {
    return new Promise(resolve => {
        let frame = 0
        const done = () => { clearTimeout(timer); cancelAnimationFrame(frame); resolve() }
        const timer = setTimeout(done, 50)
        frame = requestAnimationFrame(done)
    })
}

/** Wait for the actual runtime message, then verify it inside the chat viewport. */
export async function revealConversationMessage(options: {
    targetMessageId: string
    viewport: () => HTMLElement | null
    isCurrent: () => boolean
    ready?: () => boolean
    timeoutMs?: number
}): Promise<HTMLElement | null> {
    const deadline = Date.now() + (options.timeoutMs ?? 10_000)
    let visibleFrames = 0
    while (options.isCurrent() && Date.now() < deadline) {
        const viewport = options.viewport()
        const target = document.getElementById(getConversationMessageAnchorId(options.targetMessageId))
        if (viewport && target && viewport.contains(target) && (options.ready?.() ?? true)) {
            const bounds = viewport.getBoundingClientRect()
            const rect = target.getBoundingClientRect()
            viewport.scrollTo({ top: viewport.scrollTop + rect.top - bounds.top - 16, behavior: 'instant' })
            const aligned = target.getBoundingClientRect()
            if (bounds.height > 0 && aligned.height > 0 && aligned.bottom > bounds.top && aligned.top < bounds.bottom) {
                visibleFrames += 1
                if (visibleFrames >= 2) return target
            } else visibleFrames = 0
        } else visibleFrames = 0
        await nextLayout()
    }
    return null
}
