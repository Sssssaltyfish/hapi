import { expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ApiClient } from '@/api/client'
import { HappyChatProvider, type HappyChatContextValue } from '@/components/AssistantChat/context'
import { MarkdownRenderer } from '@/components/MarkdownRenderer'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'

vi.mock('@tanstack/react-router', async importOriginal => ({
    ...await importOriginal<typeof import('@tanstack/react-router')>(),
    useNavigate: () => vi.fn(),
}))

function renderMedia(content: string, options?: { sessionId?: string; firstTicketExpired?: boolean }) {
    const file = { success: true, content: 'YQ==' }
    const readSessionFile = vi.fn(async () => file)
    const readCodexNativeFile = vi.fn(async () => file)
    const createSessionMediaUrl = vi.fn(async () => ({ url: '/api/media/stream-ticket', expiresAt: Date.now() + 60_000 }))
    if (options?.firstTicketExpired) {
        createSessionMediaUrl.mockResolvedValueOnce({ url: '/api/media/stream-ticket', expiresAt: Date.now() - 1 })
    }
    const value: HappyChatContextValue = {
        api: { readSessionFile, readCodexNativeFile, createSessionMediaUrl } as unknown as ApiClient,
        sessionId: options?.sessionId ?? 'runner-1',
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
    return {
        ...render(<I18nProvider><HappyChatProvider value={value}>
            <MarkdownRenderer content={content} inlineMedia />
        </HappyChatProvider></I18nProvider>),
        readSessionFile, readCodexNativeFile, createSessionMediaUrl,
    }
}

it('renders remote images and native players while preserving ordinary file links', () => {
    const { container, readSessionFile } = renderMedia([
        '![Photo](https://example.test/thumbnail?id=1)',
        '[Clip](https://example.test/clip.MP4?token=signed#t=1)',
        '![Audio](https://example.test/voice.opus)',
        '[Report](./report.pdf)',
    ].join('\n\n'), { sessionId: 'codex-native:host-1:thread-1' })

    expect(screen.getByRole('img', { name: 'Photo' })).toHaveAttribute('src', 'https://example.test/thumbnail?id=1')
    expect(container.querySelector('video[controls][playsinline]')).toHaveAttribute('src', 'https://example.test/clip.MP4?token=signed#t=1')
    expect(container.querySelector('audio[controls]')).toHaveAttribute('src', 'https://example.test/voice.opus')
    expect(screen.getByRole('link', { name: 'Report' })).toHaveAttribute('href', expect.stringContaining('/file?'))
    expect(readSessionFile).not.toHaveBeenCalled()
})

it('gives runner audio to the browser by stream URL and preserves the file link', async () => {
    const { container, readSessionFile, createSessionMediaUrl } = renderMedia('[Voice](media/my%20voice.wav)')
    const href = screen.getByRole('link', { name: 'Voice' }).getAttribute('href')!
    expect(new URL(href, 'https://hapi.example').searchParams.get('path')).toBe(encodeBase64('media/my voice.wav'))
    expect(readSessionFile).not.toHaveBeenCalled()

    await waitFor(() => expect(container.querySelector('audio[controls][preload="none"]')).toHaveAttribute('src', '/api/media/stream-ticket'))
    expect(createSessionMediaUrl).toHaveBeenCalledWith('runner-1', { path: 'media/my voice.wav', mimeType: 'audio/wav' }, expect.any(AbortSignal))
    expect(readSessionFile).not.toHaveBeenCalled()
})

it('restores the playback position when an expired stream is renewed under the same URL', async () => {
    const { container, createSessionMediaUrl } = renderMedia('[Voice](voice.wav)', { firstTicketExpired: true })
    await waitFor(() => expect(container.querySelector('audio')).toHaveAttribute('src', '/api/media/stream-ticket'))
    const audio = container.querySelector('audio')!
    const play = vi.spyOn(audio, 'play').mockResolvedValue(undefined)
    const load = vi.spyOn(audio, 'load').mockImplementation(() => {})
    audio.currentTime = 12
    fireEvent.error(audio)
    await waitFor(() => expect(load).toHaveBeenCalledOnce())
    expect(audio.preload).toBe('metadata')
    audio.currentTime = 0
    fireEvent.loadedMetadata(audio)
    expect(audio.currentTime).toBe(12)
    expect(play).not.toHaveBeenCalled()
    expect(createSessionMediaUrl).toHaveBeenCalledTimes(2)
})

it('uses the Native media URL for linked images and preserves their link', async () => {
    const { readSessionFile, readCodexNativeFile, createSessionMediaUrl } = renderMedia(
        '[![Generated](<C:/exports/generated%20image.png>)](https://example.test/other.png)',
        { sessionId: 'codex-native:host-1:thread-1' },
    )
    const image = await screen.findByRole('img', { name: 'Generated' })
    expect(image).toHaveAttribute('src', '/api/media/stream-ticket')
    expect(screen.getAllByRole('img')).toHaveLength(1)
    expect(image.closest('a')).toHaveAttribute('href', 'https://example.test/other.png')
    expect(createSessionMediaUrl).toHaveBeenCalledWith('codex-native:host-1:thread-1',
        { path: 'C:/exports/generated image.png', mimeType: 'image/png' }, expect.any(AbortSignal))
    expect(readCodexNativeFile).not.toHaveBeenCalled()
    expect(readSessionFile).not.toHaveBeenCalled()
})

it('opens an audio preview in a portaled dialog and restores focus on close', async () => {
    const { container } = renderMedia('![Voice](https://example.test/voice.ogg)')
    const trigger = screen.getByRole('button', { name: 'Preview Voice' })
    fireEvent.click(trigger)
    const dialog = screen.getByRole('dialog', { name: 'Voice' })
    expect(container).not.toContainElement(dialog)
    expect(dialog.querySelector('audio[controls]')).toHaveAttribute('src', 'https://example.test/voice.ogg')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await waitFor(() => expect(trigger).toHaveFocus())
})
