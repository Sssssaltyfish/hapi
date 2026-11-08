import { useEffect, useSyncExternalStore } from 'react'
import type { ColorThemePreset } from './useColorTheme'
import type { StoredThemeColors } from './useThemeColors'

export type ThemePaletteSnapshot = {
    preset: ColorThemePreset
    colors: StoredThemeColors
}

export type ThemeBackground = {
    image: Blob
    imageId: string
    brightness: number
    blur: number
}

export type ThemeSchemeSnapshot = ThemePaletteSnapshot & { background: ThemeBackground | null }

type CurrentTheme = {
    kind: 'current'
    palette?: ThemePaletteSnapshot
    background: ThemeBackground | null
}

export type SavedTheme = ThemeSchemeSnapshot & { kind: 'saved'; id: string; name: string }

type Record = CurrentTheme | SavedTheme
type Library = {
    ready: boolean
    storageError: boolean
    current: CurrentTheme
    schemes: SavedTheme[]
}

const STORE = 'themes'
const EMPTY_CURRENT: CurrentTheme = { kind: 'current', background: null }
const EMPTY_LIBRARY: Library = { ready: false, storageError: false, current: EMPTY_CURRENT, schemes: [] }
const listeners = new Set<() => void>()
let snapshot = EMPTY_LIBRARY
let connection: Promise<IDBDatabase> | undefined
let channel: BroadcastChannel | undefined
let refreshVersion = 0
let initialized = false
let visibleImageId: string | undefined
let visibleImageUrl: string | undefined

export function newThemeId(): string {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')
}

function openLibrary(): Promise<IDBDatabase> {
    if (!connection) {
        connection = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('hapi-theme-library', 1)
            request.onupgradeneeded = () => request.result.createObjectStore(STORE)
            request.onerror = () => reject(request.error)
            request.onsuccess = () => {
                const db = request.result
                db.onversionchange = () => {
                    db.close()
                    connection = undefined
                }
                resolve(db)
            }
        }).catch(error => {
            connection = undefined
            throw error
        })
    }
    return connection
}

function applyBackground(background: ThemeBackground | null): void {
    const root = document.documentElement
    if (visibleImageId !== background?.imageId) {
        const nextUrl = background ? URL.createObjectURL(background.image) : undefined
        if (visibleImageUrl) URL.revokeObjectURL(visibleImageUrl)
        visibleImageId = background?.imageId
        visibleImageUrl = nextUrl
    }
    root.toggleAttribute('data-custom-background', Boolean(background))
    if (background && visibleImageUrl) {
        root.style.setProperty('--hapi-background-image', `url("${visibleImageUrl}")`)
        root.style.setProperty('--hapi-background-brightness', `${background.brightness}%`)
        root.style.setProperty('--hapi-background-blur', `${background.blur}px`)
    } else {
        root.style.removeProperty('--hapi-background-image')
        root.style.removeProperty('--hapi-background-brightness')
        root.style.removeProperty('--hapi-background-blur')
    }
}

function publish(next: Library): void {
    const paletteChanged = JSON.stringify(snapshot.current.palette) !== JSON.stringify(next.current.palette)
    applyBackground(next.current.background)
    snapshot = next
    if (paletteChanged) {
        window.dispatchEvent(new CustomEvent('hapi-color-theme-change', { detail: next.current.palette?.preset }))
    }
    for (const listener of listeners) listener()
}

async function refreshLibrary(): Promise<void> {
    const version = ++refreshVersion
    try {
        const db = await openLibrary()
        const records = await new Promise<Record[]>((resolve, reject) => {
            const request = db.transaction(STORE).objectStore(STORE).getAll()
            request.onerror = () => reject(request.error)
            request.onsuccess = () => resolve(request.result)
        })
        if (version !== refreshVersion) return
        publish({
            ready: true,
            storageError: false,
            current: records.find(record => record.kind === 'current') ?? EMPTY_CURRENT,
            schemes: records.filter(record => record.kind === 'saved').sort((a, b) => a.name.localeCompare(b.name)),
        })
    } catch {
        if (version === refreshVersion) publish({ ...snapshot, ready: true, storageError: true })
    }
}

export function initializeThemeLibrary(): void {
    if (initialized || typeof window === 'undefined') return
    initialized = true
    if (typeof BroadcastChannel !== 'undefined') {
        channel = new BroadcastChannel('hapi-theme-library')
        channel.onmessage = () => { void refreshLibrary() }
    }
    void refreshLibrary()
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => listeners.delete(listener)
}

export function useThemeLibrary(): Library {
    useEffect(initializeThemeLibrary, [])
    return useSyncExternalStore(subscribe, () => snapshot, () => EMPTY_LIBRARY)
}

async function updateRecord<T extends Record>(key: string, change: (record: T | undefined) => T | undefined): Promise<void> {
    const db = await openLibrary()
    await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE, 'readwrite')
        const store = transaction.objectStore(STORE)
        const request = store.get(key)
        transaction.oncomplete = () => resolve()
        transaction.onabort = () => reject(transaction.error)
        request.onsuccess = () => {
            const next = change(request.result)
            if (next) store.put(next, key)
            else store.delete(key)
        }
    })
    channel?.postMessage('changed')
    await refreshLibrary()
}

export function getActiveThemePalette(): ThemePaletteSnapshot | undefined {
    return snapshot.current.palette
}

export function editActiveThemePalette(change: (palette: ThemePaletteSnapshot) => ThemePaletteSnapshot): boolean {
    const active = getActiveThemePalette()
    if (!active) return false
    void updateRecord<CurrentTheme>('current', current => ({
        ...(current ?? EMPTY_CURRENT),
        palette: change(current?.palette ?? active),
    })).catch(() => publish({ ...snapshot, storageError: true }))
    return true
}

export function changeThemeBackground(change: (background: ThemeBackground | null) => ThemeBackground | null): Promise<void> {
    return updateRecord<CurrentTheme>('current', current => ({
        ...(current ?? EMPTY_CURRENT),
        background: change(current?.background ?? null),
    }))
}

export function previewBackgroundAdjustment(key: 'brightness' | 'blur', value: number): void {
    document.documentElement.style.setProperty(`--hapi-background-${key}`, `${value}${key === 'blur' ? 'px' : '%'}`)
}

export function restoreBackgroundPreview(): void {
    applyBackground(snapshot.current.background)
}

export async function saveTheme(name: string, scheme: ThemeSchemeSnapshot): Promise<string> {
    const id = newThemeId()
    await updateRecord<SavedTheme>(`saved:${id}`, () => ({ ...scheme, kind: 'saved', id, name }))
    return id
}

export function renameTheme(id: string, name: string): Promise<void> {
    return updateRecord<SavedTheme>(`saved:${id}`, theme => theme && { ...theme, name })
}

export function deleteTheme(id: string): Promise<void> {
    return updateRecord<SavedTheme>(`saved:${id}`, () => undefined)
}

export function applySavedTheme({ preset, colors, background }: ThemeSchemeSnapshot): Promise<void> {
    return updateRecord<CurrentTheme>('current', () => ({ kind: 'current', palette: { preset, colors }, background }))
}
