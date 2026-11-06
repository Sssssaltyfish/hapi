import type { CodexInputFileReference } from '@hapi/protocol'
import { useOptionalHappyChatContext } from '@/components/AssistantChat/context'
import { FileIcon } from '@/components/FileIcon'
import { FilePathAnchor } from '@/components/assistant-ui/markdown-text'

/** Desktop file context uses the same file viewer and line navigation as chat links. */
export function UserFileReferences({ files }: { files: readonly CodexInputFileReference[] }) {
    const chat = useOptionalHappyChatContext()
    return <div className="flex min-w-0 flex-wrap gap-2" data-testid="user-file-references">
        {files.map((file, index) => {
            const location = file.startLine === undefined ? '' : file.endLine === file.startLine
                ? `:${file.startLine}` : `:${file.startLine}-${file.endLine}`
            const title = `${file.path}${location}`
            const content = <><FileIcon fileName={file.path} size={16} /><span className="truncate">{file.label}{location}</span></>
            const className = 'inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-[var(--app-chat-user-chip-bg)] px-2 py-1 text-sm'
            return chat ? <FilePathAnchor key={index} filePath={file.path} sessionId={chat.sessionId}
                href={file.startLine === undefined ? file.path : `${file.path}#L${file.startLine}`}
                title={title} className={className}>{content}</FilePathAnchor>
                : <span key={index} title={title} className={className}>{content}</span>
        })}
    </div>
}
