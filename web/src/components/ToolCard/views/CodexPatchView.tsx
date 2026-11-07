import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { DiffView } from '@/components/DiffView'
import { isObject } from '@hapi/protocol'
import { resolveDisplayPath } from '@/utils/path'

export function CodexPatchView(props: ToolViewProps) {
    const input = props.block.tool.input
    if (!isObject(input) || !isObject(input.changes)) return null

    const files = Object.entries(input.changes)
    if (files.length === 0) return null

    return (
        <div className="flex flex-col gap-2">
            {files.map(([file, change]) => {
                const details = isObject(change) ? change : {}
                const kind = isObject(details.kind) ? details.kind : null
                const type = kind?.type ?? details.type ?? details.kind
                const movePath = kind?.move_path ?? details.move_path
                const source = resolveDisplayPath(file, props.metadata)
                const filePath = typeof movePath === 'string' && movePath
                    ? `${source} → ${resolveDisplayPath(movePath, props.metadata)}` : source
                const viewProps = { filePath, variant: 'inline', scrollY: true, size: 'comfortable' } as const
                if (typeof details.unified_diff === 'string' && details.unified_diff) {
                    return <DiffView key={file} {...viewProps} unifiedDiff={details.unified_diff} />
                }
                if (type === 'add' || type === 'delete') {
                    const content = details.content ?? details.diff
                    if (typeof content === 'string') {
                        return <DiffView key={file} {...viewProps} oldString={type === 'delete' ? content : ''} newString={type === 'add' ? content : ''} />
                    }
                }
                if (typeof details.diff === 'string' && details.diff) {
                    return <DiffView key={file} {...viewProps} unifiedDiff={details.diff} />
                }
                return (
                    <div key={file} className="text-sm text-[var(--app-fg)] font-mono break-all">
                        {filePath}
                    </div>
                )
            })}
        </div>
    )
}
