import type { CodexInputContextSection } from '@hapi/protocol'
import { ResponseAnnotationCards } from '@/components/AssistantChat/ResponseAnnotationCards'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { useTranslation } from '@/lib/use-translation'
import { UserFileReferences } from './UserFileReferences'

/** Keep context in its original order while reusing the existing quote and file controls. */
export function UserInputContext({ sections }: { sections: readonly CodexInputContextSection[] }) {
    return <>{sections.map((section, index) => {
        if (section.kind === 'annotations') return <ResponseAnnotationCards key={index} annotations={section.annotations} />
        if (section.kind === 'files') return <UserFileReferences key={index} files={section.files} />
        return <AdditionalContext key={index} section={section} />
    })}</>
}

function AdditionalContext({ section }: { section: Exclude<CodexInputContextSection, { kind: 'annotations' | 'files' }> }) {
    const { t } = useTranslation()
    if (section.kind === 'pasted') return <div className="flex min-w-0 flex-col gap-1" data-testid="pasted-input-context">
        <div className="text-xs text-[var(--app-hint)]">{t('message.contextPasted')}</div>
        <UserFileReferences files={section.files} />
        {section.containsRequest && <div className="text-xs text-[var(--app-hint)]">{t('message.contextPastedRequest')}</div>}
    </div>
    if (section.kind === 'ide') return <details className="min-w-0 text-sm" data-testid="ide-input-context">
        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">{t('message.contextIde', { count: section.tabs.length + (section.activeFile ? 1 : 0) })}</summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
            {section.activeFile && <div className="min-w-0"><div className="mb-1 text-xs text-[var(--app-hint)]">{t('message.contextActiveFile')}</div><UserFileReferences files={[section.activeFile]} /></div>}
            {section.tabs.length > 0 && <div className="min-w-0"><div className="mb-1 text-xs text-[var(--app-hint)]">{t('message.contextOpenTabs')}</div><UserFileReferences files={section.tabs} /></div>}
        </div>
    </details>
    return <details className="min-w-0 text-sm" data-testid="worktree-input-context">
        <summary className="cursor-pointer text-xs text-[var(--app-hint)]">{t('message.contextWorktree')}</summary>
        <div className="mt-2 min-w-0 border-s-2 border-[var(--app-md-quote-border)] ps-2"><LazyRainbowText text={section.instructions} preserveSingleLineBreaks /></div>
    </details>
}
