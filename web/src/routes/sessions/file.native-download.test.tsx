import { StrictMode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { I18nProvider } from '@/lib/i18n-context'
import { encodeBase64 } from '@/lib/utils'
import FilePage from './file'

const mocks = vi.hoisted(() => ({
    path: 'C:\\exports\\artifact.unknown',
    readFile: vi.fn(),
    download: vi.fn(),
}))

vi.mock('@tanstack/react-router', () => ({
    useParams: () => ({ sessionId: 'native-alias' }),
    useSearch: () => ({ path: encodeBase64(mocks.path) }),
}))
vi.mock('@/hooks/queries/useSession', () => ({
    useSession: () => ({ session: { metadata: { nativeCodex: { endpointId: 'host', threadId: 'thread' } } } }),
}))
vi.mock('@/lib/app-context', () => ({ useAppContext: () => ({ api: { readCodexNativeFile: mocks.readFile } }) }))
vi.mock('@/hooks/useAppGoBack', () => ({ useAppGoBack: () => vi.fn() }))
vi.mock('@/lib/file-download', () => ({ downloadBase64File: mocks.download }))
vi.mock('@/lib/shiki', () => ({ langAlias: {}, useShikiHighlighter: (content: string) => content }))
vi.mock('@/components/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }))

describe('Native file download fallback', () => {
    it('downloads unsupported content once, retries manually, and preserves previews and read errors', async () => {
        mocks.readFile.mockImplementation(async (_endpoint, _thread, path: string) => {
            if (path.endsWith('.missing')) return { success: false, error: 'File not found' }
            if (path.endsWith('.invalid')) return { success: true, content: '/v//' }
            return { success: true, content: encodeBase64(path.endsWith('.text') ? 'Readable text' : '\0binary') }
        })
        const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
        const page = () => <StrictMode><QueryClientProvider client={client}><I18nProvider><FilePage /></I18nProvider></QueryClientProvider></StrictMode>
        const view = render(page())
        await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(1))
        expect(mocks.download).toHaveBeenLastCalledWith('artifact.unknown', encodeBase64('\0binary'), null)
        await client.refetchQueries()
        view.rerender(page())
        expect(mocks.download).toHaveBeenCalledTimes(1)
        fireEvent.click(screen.getByRole('button', { name: 'Download file' }))
        expect(mocks.download).toHaveBeenCalledTimes(2)

        mocks.path = 'C:\\exports\\picture.tiff'
        view.rerender(page())
        const image = await screen.findByRole('img')
        expect(mocks.download).toHaveBeenCalledTimes(2)
        fireEvent.error(image)
        fireEvent.error(image)
        expect(mocks.download).toHaveBeenCalledTimes(3)
        expect(mocks.download).toHaveBeenLastCalledWith('picture.tiff', encodeBase64('\0binary'), 'image/tiff')

        mocks.path = 'C:\\exports\\artifact.text'
        view.rerender(page())
        await screen.findByText('Readable text')
        expect(mocks.download).toHaveBeenCalledTimes(3)

        mocks.path = 'C:\\exports\\artifact.unknown'
        view.rerender(page())
        await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(4))

        mocks.path = 'C:\\exports\\artifact.invalid'
        view.rerender(page())
        await waitFor(() => expect(mocks.download).toHaveBeenCalledTimes(5))
        expect(mocks.download).toHaveBeenLastCalledWith('artifact.invalid', '/v//', null)

        mocks.path = 'C:\\exports\\artifact.missing'
        view.rerender(page())
        await screen.findByText(/not found/i)
        expect(mocks.download).toHaveBeenCalledTimes(5)
        expect(screen.queryByRole('button', { name: 'Download file' })).not.toBeInTheDocument()
    })
})
