import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'

type SideQuestion = {
    question: string
    text?: string
    error?: string
    pending: boolean
    canceling: boolean
}
type SideRequest = {
    clientId: string
    cancel: () => Promise<{ canceled: boolean }>
    cancelResult?: Promise<{ canceled: boolean }>
}

/** A side answer belongs to this mounted conversation, never to its transcript. */
export function useSideQuestion(api: ApiClient, sessionId: string) {
    const [open, setOpen] = useState(false)
    const [visible, setVisible] = useState(true)
    const [result, setResult] = useState<SideQuestion | null>(null)
    const active = useRef<SideRequest | null>(null)
    const scope = `${api.getConversationCacheScope().key}:${sessionId}`

    useEffect(() => {
        setOpen(false)
        setVisible(true)
        setResult(null)
        return () => {
            const previous = active.current
            active.current = null
            void previous?.cancel().catch(() => {})
        }
    }, [scope])

    const ask = useCallback((question: string) => {
        const text = question.trim()
        setOpen(true)
        setVisible(true)
        if (!text) return true
        // A second /btw opens the existing request and keeps the new composer
        // draft intact. The provider may allow only one helper per source.
        if (active.current) return false
        const clientId = crypto.randomUUID()
        const request: SideRequest = { clientId, cancel: () => api.cancelSideQuestion(sessionId, clientId) }
        active.current = request
        setResult({ question: text, pending: true, canceling: false })
        void api.askSideQuestion(sessionId, { clientId, question: text }).then(async answer => {
            await request.cancelResult?.catch(() => {})
            if (active.current !== request) return
            active.current = null
            setResult({ question: text, text: answer.text, pending: false, canceling: false })
        }, async error => {
            await request.cancelResult?.catch(() => {})
            if (active.current !== request) return
            active.current = null
            setResult({ question: text, error: error instanceof Error ? error.message : String(error), pending: false, canceling: false })
        })
        return true
    }, [api, sessionId])

    const cancel = useCallback(async () => {
        const request = active.current
        if (!request || request.cancelResult) return
        setResult(previous => previous && { ...previous, canceling: true })
        try {
            request.cancelResult = request.cancel().then(response => {
                if (response.canceled && active.current === request) {
                    active.current = null
                    setResult(previous => previous && { ...previous, pending: false, canceling: false })
                }
                return response
            })
            const response = await request.cancelResult
            if (response.canceled) return
            if (active.current !== request) return
            request.cancelResult = undefined
            setResult(previous => previous && { ...previous, canceling: false })
        } catch (error) {
            request.cancelResult = undefined
            if (active.current === request) setResult(previous => previous && {
                ...previous, canceling: false, error: error instanceof Error ? error.message : String(error),
            })
        }
    }, [])

    const close = useCallback(() => {
        if (active.current) setVisible(false)
        else { setOpen(false); setResult(null) }
    }, [])

    return { open, visible, result, ask, cancel, close, show: () => setVisible(true), hide: () => setVisible(false) }
}
