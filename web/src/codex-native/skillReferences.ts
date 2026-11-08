import { splitCodexInputContext } from '@/lib/codexInputContext'
import { nativeText, record } from './presentation'

const SKILL_LINK = /\[(\$[^\s\]\\]+)\]\(((?:\\.|[^\\)\r\n])*)\)/g
const SKILL_NAME = /^\$[^\s\[\]\\]+$/

function isSkillPath(path: string): boolean {
    return /^(?:\/(?!\/)|[a-z]:[\\/]|\\\\)/i.test(path) && /[\\/]SKILL\.md$/i.test(path)
}

function skillPath(value: string): string {
    return value.replace(/\\([\\)])/g, '$1').replace(/\?(?:label|icon)=.*$/, '')
}

function referenceKey(value: string, path: string): string {
    const normalizedPath = /^[a-z]:[\\/]|^\\\\/i.test(path) ? path.replaceAll('\\', '/').toLowerCase() : path
    return `${value}\0${normalizedPath}`
}

export function nativeSkillReferenceAtStart(text: string): { value: string; length: number } | null {
    if (!text.startsWith('[$')) return null
    const match = text.matchAll(SKILL_LINK).next().value
    if (!match || match.index !== 0 || !isSkillPath(skillPath(match[2]))) return null
    return { value: match[1], length: match[0].length }
}

function formatReference(value: string, path: unknown): string {
    return typeof path === 'string' && isSkillPath(path)
        ? `[${value}](${path.replace(/[\\)]/g, '\\$&')})`
        : value
}

function typedSkill(part: ReturnType<typeof record>) {
    if (part.type !== 'skill' || typeof part.name !== 'string') return null
    const value = `$${part.name}`
    if (!SKILL_NAME.test(value)) return null
    return {
        value,
        reference: formatReference(value, part.path),
        key: typeof part.path === 'string' ? referenceKey(value, part.path) : null,
    }
}

/** Present structured skill parts from older Native records using Desktop's link spelling. */
export function projectNativeUserText(content: unknown): string {
    if (!Array.isArray(content)) return nativeText(content)
    const parts = content.map(record)
    const visibleReferences = new Map<string, number>()
    for (const part of parts) {
        if (typeof part.text !== 'string') continue
        for (const match of part.text.matchAll(SKILL_LINK)) {
            const path = skillPath(match[2])
            if (!isSkillPath(path)) continue
            const key = referenceKey(match[1], path)
            visibleReferences.set(key, (visibleReferences.get(key) ?? 0) + 1)
        }
    }

    // Annotated Native requests used a single text part followed by detached
    // skill parts. The body already contains the original $name in that case.
    const firstText = parts[0]?.text
    const detached = typeof firstText === 'string' && parts.length > 1 && parts.slice(1).every(typedSkill)
    const body = detached ? splitCodexInputContext(firstText).body : ''
    if (detached && body !== firstText && firstText.endsWith(body)) {
        let index = 0
        let text = firstText.slice(0, firstText.length - body.length)
        const skills = parts.slice(1).map(part => typedSkill(part)!)
        for (const match of body.matchAll(/(^|\s)(\$[^\s]+)(?=\s|$)/g)) {
            if (match[2] !== skills[0]?.value) continue
            const start = match.index + match[1].length
            text += body.slice(index, start) + skills.shift()!.reference
            index = start + match[2].length
        }
        if (index > 0 && skills.length === 0) return text + body.slice(index)
    }

    let text = ''
    let previousWasSkill = false
    for (const part of parts) {
        const skill = typedSkill(part)
        const visible = skill?.key ? visibleReferences.get(skill.key) : undefined
        if (skill?.key && visible) {
            visibleReferences.set(skill.key, visible - 1)
            continue
        }
        const value = skill?.reference ?? (
            typeof part.text === 'string' ? part.text
                : part.type === 'image' ? '[Image]'
                : part.type === 'localImage' ? `[Image: ${String(part.path ?? '')}]`
                : part.type && part.type !== 'mention' ? `[${String(part.type)}: ${String(part.path ?? part.name ?? '')}]`
                : ''
        )
        if (!value) continue
        if (text) {
            if (!previousWasSkill && !skill) text += '\n'
            else if (!/\s$/.test(text) && !/^\s/.test(value)) text += ' '
        }
        text += value
        previousWasSkill = skill !== null
    }
    return text
}
