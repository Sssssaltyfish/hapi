import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { HappyChatProvider } from '@/components/AssistantChat/context'
import { GeneratedImageCard } from '@/components/AssistantChat/messages/ToolMessage'
import { I18nProvider } from '@/lib/i18n-context'
import type { ApiClient } from '@/api/client'
import type { HappyChatContextValue } from '@/components/AssistantChat/context'

function renderCard(options: {
    mimeType: string | null
    locale?: 'en' | 'zh-CN'
    getGeneratedImageBlob?: ReturnType<typeof vi.fn>
}) {
    if (options.locale) {
        localStorage.setItem('hapi-lang', options.locale)
    } else {
        localStorage.removeItem('hapi-lang')
    }

    const getGeneratedImageBlob = options.getGeneratedImageBlob ?? vi.fn(async () => new Blob(['x'], { type: options.mimeType ?? 'image/png' }))
    const createSessionMediaUrl = vi.fn(async () => ({ url: '/api/media/stream-ticket', expiresAt: Date.now() + 60_000 }))
    const api = { getGeneratedImageBlob, createSessionMediaUrl } as unknown as ApiClient
    const value: HappyChatContextValue = {
        api,
        sessionId: 'session-1',
        metadata: null,
        terminalToolDisplayMode: 'compact',
        showSessionSummaryInChat: false,
        disabled: false,
        onRefresh: () => {},
        hasMoreMessages: false,
        isSyncingTail: false,
        isLoadingMoreMessages: false,
        loadOlderMessagesPreservingScroll: async () => 'loaded',
    }

    render(
        <I18nProvider>
            <HappyChatProvider value={value}>
                <GeneratedImageCard
                    block={{
                        kind: 'generated-image',
                        id: 'block-1',
                        localId: null,
                        createdAt: 1,
                        imageId: 'img-1',
                        fileName: 'clip.mp4',
                        mimeType: options.mimeType,
                    }}
                />
            </HappyChatProvider>
        </I18nProvider>
    )

    return { getGeneratedImageBlob, createSessionMediaUrl }
}

describe('GeneratedImageCard video fetch', () => {
    it('labels displayed images in English without implying AI generation', () => {
        renderCard({ mimeType: 'image/png', locale: 'en' })

        expect(screen.getByText('Displayed image: clip.mp4')).toBeInTheDocument()
        expect(screen.queryByText(/Generated image/)).not.toBeInTheDocument()
    })

    it('localizes the displayed image label in Chinese', () => {
        renderCard({ mimeType: 'image/png', locale: 'zh-CN' })

        expect(screen.getByText('展示图片：clip.mp4')).toBeInTheDocument()
        expect(screen.queryByText(/Generated image/)).not.toBeInTheDocument()
    })

    it('prepares a stream for video without requesting its full blob', async () => {
        const { getGeneratedImageBlob, createSessionMediaUrl } = renderCard({ mimeType: 'video/mp4' })

        await waitFor(() => expect(document.querySelector('video[controls][playsinline][preload="none"]'))
            .toHaveAttribute('src', '/api/media/stream-ticket'))
        expect(createSessionMediaUrl).toHaveBeenCalledWith('session-1', { generatedImageId: 'img-1' }, expect.any(AbortSignal))
        expect(getGeneratedImageBlob).not.toHaveBeenCalled()
    })

    it('still fetches images on mount', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'image/png' })

        await waitFor(() => {
            expect(getGeneratedImageBlob).toHaveBeenCalledWith('session-1', 'img-1')
        })
    })

    it('renders audio with browser playback controls and a stream source', async () => {
        const { getGeneratedImageBlob } = renderCard({ mimeType: 'audio/wav' })

        await waitFor(() => {
            expect(document.querySelector('audio[controls]')).toHaveAttribute('src', '/api/media/stream-ticket')
        })
        expect(getGeneratedImageBlob).not.toHaveBeenCalled()
    })

    it('loads unknown files on demand and renders a download link', async () => {
        renderCard({ mimeType: 'application/octet-stream' })

        fireEvent.click(screen.getByRole('button', { name: 'Prepare download' }))

        await waitFor(() => {
            expect(screen.getByRole('link', { name: /Download clip\.mp4/ })).toHaveAttribute('download', 'clip.mp4')
        })
    })
})
