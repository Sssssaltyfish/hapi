import { newThemeId, type ThemeBackground, type ThemeSchemeSnapshot } from '@/hooks/themeLibrary'
import { getColorThemeOptions, parseColorTheme } from '@/hooks/useColorTheme'
import { sanitizeThemeColors } from '@/hooks/useThemeColors'
import { base64FileBlob } from './file-download'

const FORMAT = 'hapi-theme'
const MAX_IMAGE_BYTES = 12 * 1024 * 1024
const MAX_IMAGE_PIXELS = 48_000_000
const MAX_BASE64_LENGTH = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif', 'image/gif']
export const BACKGROUND_IMAGE_ACCEPT = IMAGE_TYPES.join(',')
export const THEME_NAME_LIMIT = 60
export const BRIGHTNESS_RANGE = { min: 20, max: 160 }
export const BLUR_RANGE = { min: 0, max: 24 }

export async function readThemeBackground(image: Blob): Promise<ThemeBackground> {
    if (image.size === 0 || image.size > MAX_IMAGE_BYTES || !IMAGE_TYPES.includes(image.type)) {
        throw new Error('Unsupported background image')
    }
    const url = URL.createObjectURL(image)
    try {
        const decoded = new Image()
        decoded.src = url
        await decoded.decode()
        if (!decoded.naturalWidth || !decoded.naturalHeight || decoded.naturalWidth * decoded.naturalHeight > MAX_IMAGE_PIXELS) {
            throw new Error('Unsupported background dimensions')
        }
    } finally {
        URL.revokeObjectURL(url)
    }
    return { image, imageId: newThemeId(), brightness: 100, blur: 0 }
}

function objectValue(input: unknown): { [key: string]: unknown } {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('Invalid theme')
    return input as { [key: string]: unknown }
}

function validRange(value: unknown, { min, max }: { min: number; max: number }): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
}

export async function importTheme(file: Blob): Promise<ThemeSchemeSnapshot & { name: string }> {
    if (file.size > MAX_BASE64_LENGTH + 4096) throw new Error('Theme file is too large')
    const data = objectValue(JSON.parse(await file.text()))
    const name = typeof data.name === 'string' ? data.name.trim() : ''
    if (data.format !== FORMAT || data.version !== 1 || !name || name.length > THEME_NAME_LIMIT ||
        !getColorThemeOptions().some(option => option.value === data.preset)) {
        throw new Error('Unsupported theme file')
    }
    const rawColors = objectValue(data.colors)
    const colors = sanitizeThemeColors(rawColors)
    for (const [scheme, group] of Object.entries(rawColors)) {
        if (scheme !== 'light' && scheme !== 'dark' && scheme !== 'oled') throw new Error('Invalid theme scheme')
        if (Object.keys(objectValue(group)).length !== Object.keys(colors[scheme] ?? {}).length) throw new Error('Invalid theme colors')
    }
    let background: ThemeBackground | null = null
    if (data.background !== null) {
        const { image, brightness, blur } = objectValue(data.background)
        if (typeof image !== 'string' || !validRange(brightness, BRIGHTNESS_RANGE) || !validRange(blur, BLUR_RANGE)) {
            throw new Error('Invalid theme background')
        }
        const match = /^data:(image\/[a-z]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(image)
        if (!match || !IMAGE_TYPES.includes(match[1]!) || match[2]!.length > MAX_BASE64_LENGTH) throw new Error('Invalid theme image')
        background = { ...await readThemeBackground(base64FileBlob(match[2]!, match[1]!)), brightness, blur }
    }
    return { name, preset: parseColorTheme(data.preset as string), colors, background }
}

function readDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(reader.result as string)
        reader.onerror = () => reject(reader.error)
        reader.readAsDataURL(blob)
    })
}

export async function exportTheme(name: string, { preset, colors, background }: ThemeSchemeSnapshot): Promise<Blob> {
    return new Blob([JSON.stringify({
        format: FORMAT,
        version: 1,
        name,
        preset,
        colors,
        background: background ? { image: await readDataUrl(background.image), brightness: background.brightness, blur: background.blur } : null,
    }, null, 2)], { type: 'application/json' })
}
