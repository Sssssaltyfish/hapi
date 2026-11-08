import { useState } from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AssistantRuntimeProvider, useAuiState, useExternalStoreRuntime } from '@assistant-ui/react'
import { MarkdownRenderer } from '../src/components/MarkdownRenderer'
import { HappyChatProvider, type HappyChatContextValue } from '../src/components/AssistantChat/context'
import { I18nProvider } from '../src/lib/i18n-context'
import type { ApiClient } from '../src/api/client'
import fragment from './visualization-example.html?raw'
import '../src/index.css'

const isNative = new URLSearchParams(location.search).has('native')
let reads = 0
const file = async () => {
    reads++
    document.documentElement.dataset.fileReads = String(reads)
    return { success: true, content: btoa(fragment) }
}
const api = {
    getConversationCacheScope: () => ({ key: 'visualization-fixture', persistent: true }),
    readSessionFile: async () => { document.documentElement.dataset.reader = 'runner'; return file() },
    readCodexNativeFile: async () => { document.documentElement.dataset.reader = 'native'; return file() },
} as unknown as ApiClient
const reference = '\uE200visualize\uE202' + JSON.stringify({ path: '/workspace/counter.html', title: 'Counter', mode: 'wide' }) + '\uE201'
const context: HappyChatContextValue = {
    api,
    sessionId: isNative ? 'codex-native:fixture:thread' : 'fixture-session',
    metadata: { path: '/workspace', host: 'fixture' },
    terminalToolDisplayMode: 'compact',
    showSessionSummaryInChat: false,
    disabled: false,
    onRefresh: () => {},
    hasMoreMessages: false,
    isSyncingTail: false,
    isLoadingMoreMessages: false,
    loadOlderMessagesPreservingScroll: async () => 'loaded',
}
function Content() {
    const [visible, setVisible] = useState(true)
    const draft = useAuiState(state => state.composer.text)
    return <main className="mx-auto max-w-2xl p-4">
        <div className="flex gap-3">
            <button onClick={() => setVisible(value => !value)}>Toggle message</button>
            <button onClick={() => { document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark' }}>Toggle theme</button>
        </div>
        <HappyChatProvider value={context}>
            {visible ? <MarkdownRenderer content={reference} inlineVisualizations /> : null}
        </HappyChatProvider>
        <output data-testid="draft">{draft}</output>
    </main>
}
function Harness() {
    const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => { document.documentElement.dataset.sent = 'true' } })
    return <AssistantRuntimeProvider runtime={runtime}><Content /></AssistantRuntimeProvider>
}
document.documentElement.dataset.theme = 'light'
ReactDOM.createRoot(document.getElementById('root')!).render(
    <QueryClientProvider client={new QueryClient()}><I18nProvider><Harness /></I18nProvider></QueryClientProvider>
)
