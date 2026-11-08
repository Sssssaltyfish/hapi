import type { MessageStatus } from '@/types/api'
import { LazyRainbowText } from '@/components/LazyRainbowText'
import { cn } from '@/lib/utils'
import { parseNativeQuestionReply } from '@/lib/nativeQuestionReply'
import { splitCodexInputContext } from '@/lib/codexInputContext'
import { parseScheduledMessage } from '@/lib/scheduledMessage'
import { ScheduledMessageCard } from './ScheduledMessageCard'
import { UserInputContext } from './UserInputContext'
import { DirectiveChip } from './DirectiveChip'
import { nativeSkillReferenceAtStart } from '@/codex-native/skillReferences'

export { formatDirectiveLabel } from './DirectiveChip'

const LEADING_DIRECTIVE_REGEX = /^([$\/][a-z0-9][\w-]*)(?=\s|$)/i

export function getUserBubbleClassName(status?: MessageStatus) {
    return cn(
        'happy-user-bubble happy-chat-text ml-auto w-fit min-w-0 max-w-[92%] rounded-2xl bg-[var(--app-chat-user-surface-bg)] px-4 py-2.5 text-[var(--app-chat-user-fg)] shadow-none',
        status === 'queued' && 'opacity-60'
    )
}

export function shouldShowMessageStatus(status?: MessageStatus): boolean {
    return status === 'queued' || status === 'sending' || status === 'failed'
}

export function extractLeadingDirectives(text: string, nativeSkillLinks = false): { directives: string[]; body: string } {
    let rest = text.trimStart()
    const directives: string[] = []

    while (rest.length > 0) {
        const reference = nativeSkillLinks ? nativeSkillReferenceAtStart(rest) : null
        if (reference && (reference.length === rest.length || /\s/.test(rest.charAt(reference.length)))) {
            directives.push(reference.value)
            rest = rest.slice(reference.length).trimStart()
            continue
        }
        const match = rest.match(LEADING_DIRECTIVE_REGEX)
        if (!match) break

        directives.push(match[1])
        rest = rest.slice(match[0].length).trimStart()
    }

    return {
        directives,
        body: rest,
    }
}

export function UserBubbleContent(props: { text: string; nativeSkillLinks?: boolean }) {
    const scheduled = parseScheduledMessage(props.text)
    if (scheduled) return <ScheduledMessageCard message={scheduled} />
    const replies = parseNativeQuestionReply(props.text)
    if (replies) return <div className="flex min-w-0 flex-col gap-3" data-testid="question-reply-content">
        {replies.map((reply, index) => <div key={`${reply.questionItemId}:${index}`} className="min-w-0">
            <div className="mb-1 text-xs text-[var(--app-hint)] whitespace-pre-wrap break-words">{reply.question}</div>
            <LazyRainbowText text={reply.answer} preserveSingleLineBreaks />
        </div>)}
    </div>
    const annotated = splitCodexInputContext(props.text)
    if (annotated.sections.length > 0 || annotated.references.length > 0) return <div className="flex min-w-0 flex-col gap-2">
        <UserInputContext sections={annotated.sections} />
        {annotated.body.trim() ? <UserBubbleText {...props} text={annotated.body} /> : null}
    </div>
    return <UserBubbleText {...props} />
}

function UserBubbleText(props: { text: string; nativeSkillLinks?: boolean }) {
    const { directives, body } = extractLeadingDirectives(props.text, props.nativeSkillLinks)
    const hasBody = body.trim().length > 0
    const shouldRenderInline = directives.length > 0 && hasBody && !/[\r\n]/.test(body)

    if (shouldRenderInline) {
        return (
            <div className="happy-chat-text min-w-0">
                <div className="inline-flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1.5 align-top">
                    {directives.map((directive, index) => <DirectiveChip key={index} value={directive} />)}
                    <LazyRainbowText text={body} inline preserveSingleLineBreaks nativeSkillLinks={props.nativeSkillLinks} />
                </div>
            </div>
        )
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            {directives.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                    {directives.map((directive, index) => <DirectiveChip key={index} value={directive} />)}
                </div>
            ) : null}
            {hasBody ? <LazyRainbowText text={body} preserveSingleLineBreaks nativeSkillLinks={props.nativeSkillLinks} /> : null}
        </div>
    )
}
