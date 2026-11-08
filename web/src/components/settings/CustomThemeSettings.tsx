import { useEffect, useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
    applySavedTheme, changeThemeBackground, deleteTheme, previewBackgroundAdjustment, renameTheme,
    restoreBackgroundPreview, saveTheme, useThemeLibrary, type ThemeBackground,
} from '@/hooks/themeLibrary'
import { getStoredColorTheme } from '@/hooks/useColorTheme'
import { getStoredThemeColors } from '@/hooks/useThemeColors'
import { downloadFileBlob } from '@/lib/file-download'
import {
    BACKGROUND_IMAGE_ACCEPT, BLUR_RANGE, BRIGHTNESS_RANGE, THEME_NAME_LIMIT,
    exportTheme, importTheme, readThemeBackground,
} from '@/lib/theme-transfer'
import { useTranslation } from '@/lib/use-translation'
import { SettingsFieldLabel, SettingsRow } from './SettingsPrimitives'

const actionClass = 'rounded-lg px-2.5 py-1.5 text-sm hover:bg-[var(--app-subtle-bg)] disabled:opacity-40'
const primaryClass = 'rounded-lg bg-[var(--app-button)] px-3 py-2 text-sm text-[var(--app-button-text)] disabled:opacity-40'
const inputClass = 'min-w-0 rounded-lg border border-[var(--app-border)] bg-[var(--app-bg)] px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-[var(--app-link)]'
const prefix = 'settings.display.customTheme.'

function BackgroundRange({ name, label, value, range, commit }: {
    name: 'brightness' | 'blur'
    label: string
    value: number
    range: { min: number; max: number }
    commit: (value: number) => Promise<boolean>
}) {
    const input = useRef<HTMLInputElement>(null)
    const [preview, setPreview] = useState(value)

    useEffect(() => setPreview(value), [value])
    useEffect(() => {
        const slider = input.current
        if (!slider) return
        // Native change fires once the user releases the slider, while input previews each step.
        const onChange = () => { void commit(slider.valueAsNumber).then(saved => { if (!saved) setPreview(value) }) }
        slider.addEventListener('change', onChange)
        return () => slider.removeEventListener('change', onChange)
    }, [commit, value])

    return (
        <label className="flex items-center gap-3 text-sm">
            <span className="min-w-20">{label}</span>
            <input ref={input} type="range" min={range.min} max={range.max} value={preview}
                onChange={event => {
                    const next = event.currentTarget.valueAsNumber
                    setPreview(next)
                    previewBackgroundAdjustment(name, next)
                }}
                className="min-w-0 flex-1 accent-[var(--app-link)]" />
            <span aria-hidden="true" className="w-12 text-right text-xs tabular-nums text-[var(--app-hint)]">{preview}{name === 'blur' ? ' px' : '%'}</span>
        </label>
    )
}

export function CustomThemeSettings() {
    const { t } = useTranslation()
    const { current: { background }, schemes, ready, storageError } = useThemeLibrary()
    const imageInput = useRef<HTMLInputElement>(null)
    const importInput = useRef<HTMLInputElement>(null)
    const [selectedId, setSelectedId] = useState('')
    const [editor, setEditor] = useState<{ mode: 'save' | 'rename'; name: string } | null>(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const selected = schemes.find(scheme => scheme.id === selectedId)
    const disabled = busy || !ready

    useEffect(() => restoreBackgroundPreview, [])

    async function run(action: () => Promise<void>, failureKey = 'storageError') {
        setBusy(true)
        setError(null)
        try {
            await action()
        } catch {
            setError(failureKey)
        } finally {
            setBusy(false)
        }
    }

    async function chooseImage(file: File) {
        let image: ThemeBackground
        try {
            image = await readThemeBackground(file)
        } catch {
            setError('imageError')
            return
        }
        await changeThemeBackground(previous => previous ? { ...previous, image: image.image, imageId: image.imageId } : image)
    }

    async function importFile(file: File) {
        let theme: Awaited<ReturnType<typeof importTheme>>
        try {
            theme = await importTheme(file)
        } catch {
            setError('importError')
            return
        }
        setSelectedId(await saveTheme(theme.name, theme))
    }

    async function adjust(key: 'brightness' | 'blur', value: number): Promise<boolean> {
        setError(null)
        try {
            await changeThemeBackground(previous => previous && previous.imageId === background?.imageId
                ? { ...previous, [key]: value }
                : previous)
            return true
        } catch {
            restoreBackgroundPreview()
            setError('storageError')
            return false
        }
    }

    function submitName() {
        if (!editor || disabled) return
        const name = editor.name.trim()
        if (!name) return
        void run(async () => {
            if (editor.mode === 'rename') {
                if (!selected) return
                await renameTheme(selected.id, name)
            } else {
                setSelectedId(await saveTheme(name, { preset: getStoredColorTheme(), colors: getStoredThemeColors(), background }))
            }
            setEditor(null)
        })
    }

    return (
        <>
            <div>
                <SettingsRow label={t(prefix + 'background')} trailing={
                    <div className="flex items-center gap-1">
                        {background ? <button type="button" className={actionClass} disabled={disabled} onClick={() => void run(() => changeThemeBackground(() => null))}>{t(prefix + 'removeImage')}</button> : null}
                        <button type="button" className={`${actionClass} bg-[var(--app-subtle-bg)]`} disabled={disabled} onClick={() => imageInput.current?.click()}>{t(prefix + (background ? 'replaceImage' : 'chooseImage'))}</button>
                    </div>
                } />
                <input ref={imageInput} type="file" accept={BACKGROUND_IMAGE_ACCEPT} className="hidden" onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) void run(() => chooseImage(file))
                }} />
                {background ? (
                    <div key={background.imageId} className="space-y-2 px-3 pb-3">
                        <div aria-hidden="true" className="custom-background-preview h-24 rounded-lg" />
                        <BackgroundRange name="brightness" label={t(prefix + 'brightness')} value={background.brightness} range={BRIGHTNESS_RANGE} commit={value => adjust('brightness', value)} />
                        <BackgroundRange name="blur" label={t(prefix + 'blur')} value={background.blur} range={BLUR_RANGE} commit={value => adjust('blur', value)} />
                    </div>
                ) : null}
            </div>
            <div className="px-3 py-3">
                <SettingsFieldLabel>{t(prefix + 'schemes')}</SettingsFieldLabel>
                <div className="flex flex-wrap items-center gap-2">
                    <button type="button" className={primaryClass} disabled={disabled} onClick={() => { setError(null); setEditor({ mode: 'save', name: '' }) }}>{t(prefix + 'saveCurrent')}</button>
                    <button type="button" className={actionClass} disabled={disabled} onClick={() => importInput.current?.click()}>{t(prefix + 'import')}</button>
                </div>
                <input ref={importInput} type="file" accept=".json,application/json" className="hidden" onChange={event => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    if (file) void run(() => importFile(file))
                }} />
                {schemes.length > 0 ? (
                    <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <select aria-label={t(prefix + 'schemes')} value={selected?.id ?? ''} onChange={event => setSelectedId(event.currentTarget.value)} disabled={disabled} className={`${inputClass} max-w-full flex-1`}>
                            <option value="" disabled>{t(prefix + 'select')}</option>
                            {schemes.map(theme => <option key={theme.id} value={theme.id}>{theme.name}</option>)}
                        </select>
                        {selected ? (
                            <div className="flex flex-wrap gap-1">
                                <button type="button" className={actionClass} disabled={disabled} onClick={() => void run(() => applySavedTheme(selected))}>{t(prefix + 'apply')}</button>
                                <button type="button" className={actionClass} disabled={disabled} onClick={() => { setError(null); setEditor({ mode: 'rename', name: selected.name }) }}>{t(prefix + 'rename')}</button>
                                <button type="button" className={actionClass} disabled={disabled} onClick={() => void run(async () => {
                                    const filename = selected.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').slice(0, THEME_NAME_LIMIT)
                                    downloadFileBlob(`${filename}.hapi-theme.json`, await exportTheme(selected.name, selected))
                                }, 'exportError')}>{t(prefix + 'export')}</button>
                                <button type="button" className={actionClass} disabled={disabled} onClick={() => void run(() => deleteTheme(selected.id))}>{t(prefix + 'delete')}</button>
                            </div>
                        ) : null}
                    </div>
                ) : null}
                {error || storageError ? <p role="alert" className="mt-2 text-sm text-red-600 dark:text-red-400">{t(prefix + (error ?? 'storageError'))}</p> : null}
            </div>
            <Dialog open={editor !== null} onOpenChange={open => { if (!open && !busy) setEditor(null) }}>
                <DialogContent className="max-w-sm" aria-describedby={undefined}>
                    <DialogHeader><DialogTitle>{t(prefix + (editor?.mode === 'rename' ? 'rename' : 'saveCurrent'))}</DialogTitle></DialogHeader>
                    <form className="space-y-4" onSubmit={event => { event.preventDefault(); submitName() }}>
                        <input autoFocus aria-label={t(prefix + 'name')} placeholder={t(prefix + 'name')} className={`${inputClass} w-full`} maxLength={THEME_NAME_LIMIT} value={editor?.name ?? ''} onChange={event => {
                            const name = event.currentTarget.value
                            setEditor(previous => previous && { ...previous, name })
                        }} />
                        {error ? <p role="alert" className="text-sm text-red-600 dark:text-red-400">{t(prefix + error)}</p> : null}
                        <div className="flex justify-end gap-2">
                            <button type="button" className={actionClass} disabled={busy} onClick={() => setEditor(null)}>{t('button.cancel')}</button>
                            <button type="submit" className={primaryClass} disabled={disabled || !editor?.name.trim()}>{t('button.save')}</button>
                        </div>
                    </form>
                </DialogContent>
            </Dialog>
        </>
    )
}
