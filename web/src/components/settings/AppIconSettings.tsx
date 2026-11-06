import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useAppContext } from '@/lib/app-context'
import { useTranslation } from '@/lib/use-translation'
import { drawIconCrop, exportIconCrop, refreshAppIconLinks, type IconCrop } from '@/lib/app-icon'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { SettingsRow } from './SettingsPrimitives'

const buttonClass = 'rounded-lg px-3 py-2 text-sm hover:bg-[var(--app-subtle-bg)] disabled:opacity-40'
const initialCrop: IconCrop = { x: 0.5, y: 0.5, zoom: 1 }
const clamp = (value: number) => Math.max(0, Math.min(1, value))

export function AppIconSettings() {
    const { api } = useAppContext()
    const { t } = useTranslation()
    const queryClient = useQueryClient()
    const queryKey = ['app-icon', api.getConversationCacheScope().key]
    const { data } = useQuery({ queryKey, queryFn: () => api.getAppIcon() })
    const input = useRef<HTMLInputElement>(null)
    const canvas = useRef<HTMLCanvasElement>(null)
    const drag = useRef<{ x: number; y: number; crop: IconCrop } | null>(null)
    const [source, setSource] = useState<{ image: HTMLImageElement; url: string } | null>(null)
    const [crop, setCrop] = useState<IconCrop>(initialCrop)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    useEffect(() => () => { if (source) URL.revokeObjectURL(source.url) }, [source])
    const setCanvas = useCallback((element: HTMLCanvasElement | null) => {
        canvas.current = element
        if (element && source) drawIconCrop(element, source.image, crop)
    }, [source, crop])

    async function choose(file: File | undefined) {
        if (!file) return
        setError(null)
        if (!file.type.startsWith('image/')) { setError(t('settings.display.appIcon.imageError')); return }
        const url = URL.createObjectURL(file)
        try {
            const image = new Image()
            image.src = url
            await image.decode()
            setCrop(initialCrop)
            setSource({ image, url })
        } catch { URL.revokeObjectURL(url); setError(t('settings.display.appIcon.imageError')) }
    }

    async function save(reset = false) {
        setBusy(true)
        setError(null)
        try {
            const result = reset ? await api.resetAppIcon() : await api.setAppIcon(await exportIconCrop(canvas.current!))
            queryClient.setQueryData(queryKey, result)
            const revision = result.revision ?? `default-${Date.now()}`
            refreshAppIconLinks(api.getAppIconUrl(revision, 'image', 64), result.type, api.getAppIconUrl(revision, 'apple-touch'))
            setSource(null)
        } catch { setError(t('settings.display.appIcon.saveError')) }
        finally { setBusy(false) }
    }

    return <>
        <SettingsRow label={t('settings.display.appIcon.title')} description={t('settings.display.appIcon.description')} trailing={
            <div className="flex items-center gap-2">
                <img src={api.getAppIconUrl(data?.revision, 'image', 64)} className="h-10 w-10 rounded-lg" alt="" />
                <button type="button" className={`${buttonClass} bg-[var(--app-subtle-bg)]`} disabled={!data?.canEdit || busy} onClick={() => input.current?.click()}>{t('settings.display.appIcon.choose')}</button>
            </div>
        }>
            {data?.revision && data.canEdit ? <button type="button" className="mt-1 text-xs text-[var(--app-link)]" disabled={busy} onClick={() => void save(true)}>{t('settings.display.appIcon.reset')}</button> : null}
        </SettingsRow>
        <input ref={input} type="file" accept="image/*" className="hidden" onChange={(event) => { void choose(event.target.files?.[0]); event.target.value = '' }} />
        <p className="px-3 py-2 text-xs text-[var(--app-hint)]">{t('settings.display.appIcon.installHint')}</p>
        {error && !source ? <p role="alert" className="px-3 py-2 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
        <Dialog open={source !== null} onOpenChange={(open) => { if (!open && !busy) setSource(null) }}>
            <DialogContent className="max-w-sm max-h-[90dvh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t('settings.display.appIcon.crop')}</DialogTitle>
                    <DialogDescription>{t('settings.display.appIcon.cropHint')}</DialogDescription>
                </DialogHeader>
                <canvas ref={setCanvas} width={512} height={512} tabIndex={0} role="img" aria-label={t('settings.display.appIcon.cropHint')}
                    className="mx-auto my-4 aspect-square w-full max-w-64 cursor-move touch-none rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]"
                    onKeyDown={(event) => {
                        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
                        event.preventDefault()
                        const step = event.shiftKey ? 0.1 : 0.02
                        setCrop((current) => ({ ...current, x: clamp(current.x + (event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0)), y: clamp(current.y + (event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0)) }))
                    }}
                    onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); drag.current = { x: event.clientX, y: event.clientY, crop } }}
                    onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }}
                    onPointerMove={(event) => {
                        if (!drag.current || !source) return
                        const start = drag.current
                        const side = Math.min(source.image.naturalWidth, source.image.naturalHeight) / start.crop.zoom
                        const ratio = side / event.currentTarget.clientWidth
                        const width = source.image.naturalWidth - side
                        const height = source.image.naturalHeight - side
                        setCrop({ ...start.crop, x: width ? clamp(start.crop.x - (event.clientX - start.x) * ratio / width) : 0.5, y: height ? clamp(start.crop.y - (event.clientY - start.y) * ratio / height) : 0.5 })
                    }} />
                <label className="flex items-center gap-3 text-sm">{t('settings.display.appIcon.zoom')}<input type="range" min="1" max="4" step="0.01" value={crop.zoom} onChange={(event) => setCrop((current) => ({ ...current, zoom: Number(event.target.value) }))} className="min-w-0 flex-1 accent-[var(--app-link)]" /></label>
                {error ? <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p> : null}
                <div className="mt-4 flex justify-end gap-2">
                    <button type="button" className={buttonClass} disabled={busy} onClick={() => setSource(null)}>{t('button.cancel')}</button>
                    <button type="button" className="rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm text-[var(--app-button-text)] disabled:opacity-40" disabled={busy} onClick={() => void save()}>{t('button.save')}</button>
                </div>
            </DialogContent>
        </Dialog>
    </>
}
