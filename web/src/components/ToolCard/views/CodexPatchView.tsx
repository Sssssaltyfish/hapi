import type { ToolViewProps } from '@/components/ToolCard/views/_all'
import { CodeBlock } from '@/components/CodeBlock'
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
                const display = resolveDisplayPath(file, props.metadata)
                const diff = isObject(change) ? change.diff ?? change.unified_diff : null
                const movePath = isObject(change) && isObject(change.kind) ? change.kind.move_path : null
                return (
                    <div key={file} className="min-w-0 space-y-1">
                        <div className="text-sm text-[var(--app-fg)] font-mono break-all">
                            {display}
                            {typeof movePath === 'string' && ` → ${resolveDisplayPath(movePath, props.metadata)}`}
                        </div>
                        {typeof diff === 'string' && diff.length > 0 && (
                            <CodeBlock code={diff} language="diff" scrollY size="comfortable" />
                        )}
                    </div>
                )
            })}
        </div>
    )
}
