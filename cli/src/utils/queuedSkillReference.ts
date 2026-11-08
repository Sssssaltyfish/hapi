import type { AttachmentMetadata } from '@/api/types'
import { listSkills } from '@/modules/common/skills'
import { formatMessageWithAttachments } from './attachmentFormatter'

export type QueuedSkillReference = { name: string; offset: number }

export function formatQueuedSkillMessage(text: string, attachments?: AttachmentMetadata[]) {
    const match = /^(\s*)\$([a-z0-9][a-z0-9_.-]{0,127})(?=\s|$)/i.exec(text)
    const message = formatMessageWithAttachments(text, attachments)
    // The ordinary attachment formatter prepends references. Keep the original
    // token position so a queued turn or retry can resolve the same invocation.
    const skillReference: QueuedSkillReference | undefined = match
        ? { name: match[2]!, offset: message.length - text.length + match[1]!.length }
        : undefined
    return { message, skillReference }
}

export async function hasQueuedSkill(
    reference: QueuedSkillReference, directory: string, flavor: 'dsh' | 'agy'
): Promise<boolean> {
    const skills = await listSkills(directory, { flavor }).catch(() => [])
    return skills.some(skill => skill.name === reference.name)
}
