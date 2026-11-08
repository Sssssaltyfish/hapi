import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { useAui } from '@assistant-ui/react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useHappyChatContext, useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { ExpandIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { parseCodexNativeSessionId } from '@/codex-native/session-key'
import { formatReadFileError } from '@/lib/files-i18n'
import type { VisualizationReference } from '@/lib/remark-visualizations'
import { useTranslation } from '@/lib/use-translation'
import { cn, decodeBase64 } from '@/lib/utils'
import { buildVisualizationDocument, type VisualizationGlobals } from '@/lib/visualization-document'
import { encodeWidgetState, readVisualizationMessage, readWidgetState, saveWidgetState, VISUALIZATION_CHANNEL } from './InlineVisualization/bridge'

const MAX_HTML_BYTES = 1024 * 1024
const MAX_HTML_BASE64 = 4 * Math.ceil(MAX_HTML_BYTES / 3)
const MAX_CACHED_FILES = 24
const MAX_FRAME_HEIGHT = 8192
const VISUALIZATION_QUERY = ['inline-visualization-file'] as const

const THEME_TOKENS = {
    '--background': '--app-bg', '--foreground': '--app-fg',
    '--card': '--app-secondary-bg', '--card-foreground': '--app-fg',
    '--popover': '--app-dialog-bg', '--popover-foreground': '--app-fg',
    '--primary': '--app-button', '--primary-foreground': '--app-button-text',
    '--secondary': '--app-secondary-bg', '--secondary-foreground': '--app-fg',
    '--muted': '--app-secondary-bg', '--muted-foreground': '--app-hint',
    '--accent': '--app-chat-user-chip-bg', '--accent-foreground': '--app-chat-user-chip-fg',
    '--destructive': '--app-badge-error-text', '--border': '--app-border',
    '--input': '--app-border', '--ring': '--app-link',
    '--blue': '--app-git-renamed-color', '--orange': '--app-git-unstaged-color',
    '--green': '--app-badge-success-text', '--red': '--app-badge-error-text',
    '--yellow': '--app-badge-warning-text',
    '--viz-series-1': '--app-link', '--viz-series-2': '--app-git-renamed-color',
    '--viz-series-3': '--app-badge-success-text', '--viz-series-4': '--app-git-unstaged-color',
    '--viz-series-5': '--app-badge-error-text', '--viz-series-6': '--app-badge-warning-text',
} as const

class VisualizationFileError extends Error {
    constructor(readonly reason: 'tooLarge' | 'invalidText') { super(reason) }
}

type StateScope = { key: string; persistent: boolean }
type VisualizationFile = { html: string; revision: number }
type Action = { requestId: number; type: 'followup'; text: string; title?: string }
    | { requestId: number; type: 'open'; text: string }

// A fragment can ask to display a confirmation, but the host owns one at a time.
let confirmationOwner: string | null = null

function stopEvent(event: SyntheticEvent) { event.stopPropagation() }

function readGlobals(widgetState: unknown): VisualizationGlobals {
    const root = document.documentElement
    const theme = root.dataset.theme === 'dark' || root.dataset.theme === 'oled' ? 'dark' : 'light'
    const computed = getComputedStyle(root)
    const styles: Record<string, string> = {}
    for (const [key, token] of Object.entries(THEME_TOKENS)) {
        const value = computed.getPropertyValue(token).trim()
        if (value) styles[key] = value
    }
    return { theme, styles, widgetState }
}

function externalHref(value: unknown): string | null {
    if (typeof value !== 'string' || value.length > 4096) return null
    try {
        const url = new URL(value)
        return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
    } catch { return null }
}

function VisualizationFrame({ html, name, stateScope, height, setHeight, onConfirmationChange, onDismiss }: {
    html: string; name: string; stateScope: StateScope; height: number; setHeight: (height: number) => void
    onConfirmationChange: (open: boolean) => void
    onDismiss?: () => void
}) {
    const { disabled } = useHappyChatContext()
    const aui = useAui()
    const { t } = useTranslation()
    const frame = useRef<HTMLIFrameElement>(null)
    const previousFocus = useRef<HTMLElement | null>(null)
    const [bridgeId] = useState(() => Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-'))
    const [initialState] = useState<unknown>(() => readWidgetState(stateScope.key, stateScope.persistent))
    const snapshot = useRef(initialState)
    const [srcDoc] = useState(() => buildVisualizationDocument(html, bridgeId, readGlobals(snapshot.current)))
    const [action, setAction] = useState<Action | null>(null)

    function post(message: { type: 'result'; requestId: number; error?: string } | { type: 'globals'; globals: VisualizationGlobals }) {
        frame.current?.contentWindow?.postMessage({ channel: VISUALIZATION_CHANNEL, bridgeId, ...message }, '*')
    }

    useLayoutEffect(() => {
        const publishGlobals = () => post({ type: 'globals', globals: readGlobals(snapshot.current) })
        const receive = (event: MessageEvent) => {
            const message = readVisualizationMessage(event, frame.current?.contentWindow ?? null, bridgeId)
            if (!message) return
            if (message.type === 'ready') {
                publishGlobals()
                return
            }
            if (message.type === 'height') {
                const value = message.height
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
                    setHeight(Math.min(MAX_FRAME_HEIGHT, Math.max(1, Math.ceil(value))))
                }
                return
            }
            if (message.type === 'escape') {
                if (confirmationOwner === null && document.activeElement === frame.current) onDismiss?.()
                return
            }

            const requestId = message.requestId
            if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId <= 0) return
            const reject = (error: string) => post({ type: 'result', requestId, error })
            if (message.type === 'state') {
                const serialized = encodeWidgetState(message.state)
                if (serialized === null) return reject('Widget state must be JSON and at most 16 KiB.')
                snapshot.current = JSON.parse(serialized)
                saveWidgetState(stateScope.key, stateScope.persistent, serialized)
                post({ type: 'result', requestId })
                return
            }

            let requestedAction: Action
            if (message.type === 'open') {
                const href = externalHref(message.href)
                if (!href) return reject('Only HTTP and HTTPS links can be opened.')
                requestedAction = { requestId, type: 'open', text: href }
            } else if (message.type === 'followup') {
                if (disabled) return reject('The composer is unavailable.')
                const text = typeof message.prompt === 'string' && message.prompt.length <= 16 * 1024 ? message.prompt.trim() : ''
                if (!text) return reject('A follow-up needs a prompt of at most 16 KiB.')
                const title = typeof message.title === 'string' ? message.title.trim().slice(0, 250) : undefined
                requestedAction = { requestId, type: 'followup', text, title }
            } else {
                return
            }

            if (confirmationOwner !== null) return reject('A visualization action is awaiting confirmation.')
            confirmationOwner = bridgeId
            previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
            setAction(requestedAction)
            onConfirmationChange(true)
        }

        window.addEventListener('message', receive)
        publishGlobals()
        const themeChanges = new MutationObserver(publishGlobals)
        themeChanges.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-theme', 'class'] })
        return () => {
            window.removeEventListener('message', receive)
            themeChanges.disconnect()
        }
    }, [bridgeId, disabled, onConfirmationChange, onDismiss, setHeight, stateScope.key, stateScope.persistent])

    useEffect(() => () => {
        if (confirmationOwner === bridgeId) {
            confirmationOwner = null
            onConfirmationChange(false)
        }
    }, [bridgeId, onConfirmationChange])

    function settle(confirmed: boolean) {
        if (!action || confirmationOwner !== bridgeId) return
        let error: string | undefined
        if (!confirmed) error = 'Action cancelled.'
        else if (action.type === 'open') window.open(action.text, '_blank', 'noopener,noreferrer')
        else if (disabled) error = 'The composer is unavailable.'
        else {
            const composer = aui.composer()
            const draft = composer.getState().text
            composer.setText(draft ? `${draft}\n\n${action.text}` : action.text)
        }
        post({ type: 'result', requestId: action.requestId, error })
        confirmationOwner = null
        setAction(null)
        onConfirmationChange(false)
    }

    return <>
        <iframe ref={frame} title={name} srcDoc={srcDoc} sandbox="allow-scripts" referrerPolicy="no-referrer"
            className="block w-full min-w-0 max-w-full border-0" style={{ height }} />
        <Dialog open={action !== null} onOpenChange={open => { if (!open) settle(false) }}>
            {action ? <DialogContent aria-modal="true" className="max-h-[calc(100dvh-24px)] max-w-md overflow-y-auto"
                overlayProps={{ onPointerDown: stopEvent, onClick: stopEvent }}
                onPointerDown={stopEvent} onClick={stopEvent}
                onCloseAutoFocus={event => {
                    event.preventDefault()
                    previousFocus.current?.focus({ preventScroll: true })
                }}>
                <DialogHeader>
                    <DialogTitle className="[overflow-wrap:anywhere]">
                        {action.type === 'followup' ? action.title || t('visualization.followup.title') : t('visualization.link.title')}
                    </DialogTitle>
                    <DialogDescription>{t(action.type === 'followup' ? 'visualization.followup.description' : 'visualization.link.description')}</DialogDescription>
                </DialogHeader>
                <p className="my-3 max-h-[40dvh] overflow-y-auto whitespace-pre-wrap text-sm [overflow-wrap:anywhere]">{action.text}</p>
                <div className="flex flex-wrap justify-end gap-2">
                    <Button type="button" variant="secondary" onClick={() => settle(false)}>{t('button.cancel')}</Button>
                    <Button type="button" disabled={action.type === 'followup' && disabled} onClick={() => settle(true)}>
                        {t(action.type === 'followup' ? 'visualization.followup.confirm' : 'dialog.uri.open')}
                    </Button>
                </div>
            </DialogContent> : null}
        </Dialog>
    </>
}

function VisualizationPreview({ reference, stateScope, name, expanded, setExpanded, inlineHeight, setInlineHeight, setConfirming }: {
    reference: VisualizationReference; stateScope: StateScope; name: string
    expanded: boolean; setExpanded: (expanded: boolean) => void
    inlineHeight: number; setInlineHeight: (height: number) => void; setConfirming: (confirming: boolean) => void
}) {
    const { api, sessionId, metadata } = useHappyChatContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const native = metadata?.nativeCodex ?? parseCodexNativeSessionId(sessionId)
    const trigger = useRef<HTMLButtonElement>(null)
    const [expandedHeight, setExpandedHeight] = useState(128)
    const closeExpanded = useCallback(() => setExpanded(false), [setExpanded])
    const { path } = reference
    const queryKey = [...VISUALIZATION_QUERY, stateScope.key] as const
    const query = useQuery({
        queryKey,
        retry: false,
        staleTime: 30_000,
        refetchOnWindowFocus: false,
        gcTime: 5 * 60_000,
        queryFn: async ({ signal }) => {
            const file = native
                ? await api.readCodexNativeFile(native.endpointId, native.threadId, path, signal)
                : await api.readSessionFile(sessionId, path, signal)
            if (!file.success || typeof file.content !== 'string') throw new Error(file.error ?? 'Failed to read file')
            if (file.content.length > MAX_HTML_BASE64) throw new VisualizationFileError('tooLarge')
            const base64 = file.content.trim()
            const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
            if (Math.floor(base64.length * 3 / 4) - padding > MAX_HTML_BYTES) throw new VisualizationFileError('tooLarge')
            const decodedText = decodeBase64(base64, true)
            if (!decodedText.ok || !decodedText.text.trim() || decodedText.text.includes('\0')) throw new VisualizationFileError('invalidText')

            const unused = queryClient.getQueryCache().findAll({ queryKey: VISUALIZATION_QUERY })
                .filter(entry => entry.getObserversCount() === 0)
                .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt)
            for (const entry of unused.slice(MAX_CACHED_FILES)) queryClient.getQueryCache().remove(entry)
            const previous = queryClient.getQueryData<VisualizationFile>(queryKey)
            return previous?.html === decodedText.text
                ? previous : { html: decodedText.text, revision: (previous?.revision ?? 0) + 1 }
        },
    })

    const error = query.error instanceof VisualizationFileError
        ? t(query.error.reason === 'tooLarge' ? 'visualization.error.tooLarge' : 'visualization.error.invalidText')
        : query.error ? formatReadFileError(query.error.message, t) : null
    const reload = (event: SyntheticEvent) => {
        stopEvent(event)
        void query.refetch()
    }

    if (error && query.data === undefined) {
        return <span className="flex flex-wrap items-center gap-2 text-sm text-[var(--app-hint)]">
            <span role="status" className="[overflow-wrap:anywhere]">{error}</span>
            <Button type="button" variant="secondary" size="sm" disabled={query.isFetching} onClick={reload}>{t('button.retry')}</Button>
        </span>
    }
    if (query.data === undefined) return <span role="status" className="block text-sm text-[var(--app-hint)]" style={{ minHeight: inlineHeight }}>
        {t('media.preview.loading', { name })}
    </span>

    const previewLabel = t('media.preview.open', { name })
    const frameProps = { html: query.data.html, name, stateScope, onConfirmationChange: setConfirming }
    return <>
        <Dialog open={expanded} onOpenChange={setExpanded}>
            <span className="mb-1 flex items-center justify-end gap-1">
                <button type="button" aria-label={t('visualization.reload')} disabled={query.isFetching || expanded}
                    onPointerDown={stopEvent} onClick={reload}
                    className="min-h-8 rounded-md px-2 text-xs text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)] disabled:opacity-50 [@media(pointer:coarse)]:min-h-11">
                    {t(error ? 'button.retry' : 'files.page.refresh')}
                </button>
                <DialogTrigger asChild>
                    <button ref={trigger} type="button" aria-label={previewLabel} title={previewLabel}
                        onPointerDown={stopEvent} onClick={stopEvent}
                        className="flex size-8 shrink-0 items-center justify-center rounded-md text-[var(--app-hint)] hover:bg-[var(--app-subtle-bg)] hover:text-[var(--app-fg)] focus-visible:ring-2 focus-visible:ring-[var(--app-link)] [@media(pointer:coarse)]:size-11">
                        <ExpandIcon />
                    </button>
                </DialogTrigger>
            </span>
            <DialogContent aria-modal="true" aria-describedby={undefined}
                className={cn('max-h-[calc(100dvh-24px)] overflow-y-auto overscroll-contain', reference.mode === 'wide' ? 'max-w-[1056px]' : 'max-w-3xl')}
                overlayProps={{ onPointerDown: stopEvent, onClick: stopEvent }}
                onPointerDownOutside={event => event.preventDefault()}
                onPointerDown={stopEvent} onClick={stopEvent}
                onCloseAutoFocus={event => {
                    event.preventDefault()
                    trigger.current?.focus({ preventScroll: true })
                }}>
                <DialogHeader><DialogTitle className="[overflow-wrap:anywhere]">{name}</DialogTitle></DialogHeader>
                <div className="mt-3 min-w-0">
                    {expanded ? <VisualizationFrame key={query.data.revision} {...frameProps}
                        height={expandedHeight} setHeight={setExpandedHeight} onDismiss={closeExpanded} /> : null}
                </div>
            </DialogContent>
        </Dialog>
        {error ? <span role="status" className="block text-sm text-[var(--app-hint)] [overflow-wrap:anywhere]">{error}</span> : null}
        {expanded ? <span className="block" style={{ height: inlineHeight }} />
            : <VisualizationFrame key={query.data.revision} {...frameProps} height={inlineHeight} setHeight={setInlineHeight} />}
    </>
}

function ObservedVisualization({ reference, stateScope }: { reference: VisualizationReference; stateScope: StateScope }) {
    const { t } = useTranslation()
    const element = useRef<HTMLSpanElement>(null)
    const [near, setNear] = useState(false)
    const [expanded, setExpanded] = useState(false)
    const [confirming, setConfirming] = useState(false)
    const [inlineHeight, setInlineHeight] = useState(128)
    const [placeholderHeight, setPlaceholderHeight] = useState(164)
    const name = reference.title || reference.path.split(/[\\/]/).pop() || t('visualization.name')
    const mounted = near || expanded || confirming

    useEffect(() => {
        if (typeof IntersectionObserver === 'undefined') {
            setNear(true)
            return
        }
        if (!element.current) return
        const observer = new IntersectionObserver(([entry]) => setNear(entry.isIntersecting), { rootMargin: '256px 0px' })
        observer.observe(element.current)
        return () => observer.disconnect()
    }, [])

    useLayoutEffect(() => {
        if (!mounted || !element.current) return
        const container = element.current
        const measure = () => setPlaceholderHeight(container.getBoundingClientRect().height)
        measure()
        if (typeof ResizeObserver === 'undefined') return
        const observer = new ResizeObserver(measure)
        observer.observe(container)
        return () => observer.disconnect()
    }, [mounted])

    return <span ref={element} data-hapi-share-exclude="true"
        className={cn('my-3 block w-full min-w-0 max-w-full', reference.mode === 'wide' ? 'mx-auto max-w-[1024px]' : 'max-w-[736px]')}>
        {mounted
            ? <VisualizationPreview reference={reference} stateScope={stateScope} name={name} expanded={expanded} setExpanded={setExpanded}
                inlineHeight={inlineHeight} setInlineHeight={setInlineHeight} setConfirming={setConfirming} />
            : <span aria-hidden="true" className="block" style={{ height: placeholderHeight }} />}
    </span>
}

export function InlineVisualization({ reference, children }: { reference: VisualizationReference; children?: ReactNode }) {
    const chat = useOptionalHappyChatContext()
    if (!chat) return <>{children}</>

    const native = chat.metadata?.nativeCodex ?? parseCodexNativeSessionId(chat.sessionId)
    const scope = chat.api.getConversationCacheScope()
    const key = JSON.stringify([scope.key, chat.sessionId, native?.endpointId, native?.threadId, reference.path])
    return <ObservedVisualization key={key} reference={reference} stateScope={{ key, persistent: scope.persistent }} />
}
