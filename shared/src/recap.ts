/** Match Claude Code's human-facing session recap, rather than a work report. */
export const SESSION_RECAP_MAX_CHARACTERS = 400
export const SESSION_RECAP_PROMPT = 'In the user’s language, recap what just happened in this conversation and what is next. Output one short plain-text line, at most 400 characters, without a title, list, preface, or Markdown. Use only the conversation already available; do not run tools, perform new work, or invent next steps.'

export function normalizeSessionRecap(value: string): string {
    const text = value.trim().replace(/\s+/gu, ' ')
    if (text.length <= SESSION_RECAP_MAX_CHARACTERS) return text
    // A UTF-16 length cap also stays within 400 visible Unicode characters.
    const head = text.slice(0, SESSION_RECAP_MAX_CHARACTERS - 1).replace(/[\uD800-\uDBFF]$/u, '')
    return head.trimEnd() + '…'
}
