import { isObject } from '@hapi/protocol'
import type { ChatToolCall } from '@/chat/types'
import type { ToolPresentation } from './knownTools'
import { getInputStringAny } from '@/lib/toolInputUtils'

const FILE_OPERATIONS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'LS', 'Glob', 'Grep', 'NotebookRead', 'NotebookEdit'])

function oneLine(value: string): string {
    return value.replace(/\r\n?|\n/g, ' ↵ ').trim()
}

/** Preview invocation data before narration, using the shared tool presentation as fallback. */
export function getMinimalToolPreview(tool: Pick<ChatToolCall, 'name' | 'input'>, presentation: Pick<ToolPresentation, 'title' | 'subtitle'>): string {
    const command = getInputStringAny(tool.input, ['command', 'cmd', 'commandLine', 'command_line'])
    if (command?.trim()) return oneLine(command)
    if (isObject(tool.input)) {
        for (const key of ['command', 'cmd']) {
            const argv = tool.input[key]
            if (Array.isArray(argv) && argv.length > 0 && argv.every(part => typeof part === 'string')) {
                const preview = oneLine(argv.join(' '))
                if (preview) return preview
            }
        }
    }

    const path = getInputStringAny(tool.input, ['file_path', 'path', 'filePath', 'file', 'notebook_path'])
    const query = getInputStringAny(tool.input, ['pattern', 'query'])
    const detail = path && query ? `${query} · ${path}` : path ?? query
        ?? getInputStringAny(tool.input, ['url', 'objective', 'description', 'task', 'name', 'prompt', 'message', 'text'])
        ?? presentation.subtitle
    const operation = (FILE_OPERATIONS.has(tool.name) ? tool.name : presentation.title) || tool.name
    return oneLine(detail && detail !== operation ? `${operation} · ${detail}` : operation)
}
