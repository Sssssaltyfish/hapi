export type ScheduledMessage = {
    automationId: string
} & ({
    kind: 'trigger'
    time: string
    text: string
} | {
    kind: 'result'
    decision: 'NOTIFY' | 'DONT_NOTIFY'
    text: string
})

/** Only complete, standalone Desktop heartbeat envelopes are presentation data. */
export function parseScheduledMessage(text: string): ScheduledMessage | null {
    const envelope = /^\s*<heartbeat>\s*([\s\S]*?)\s*<\/heartbeat>\s*$/.exec(text)
    if (!envelope) return null
    const fields: Record<string, string> = {}
    let rest = envelope[1]
    while (rest.trim()) {
        const field = /^\s*<(automation_id|current_time_iso|instructions|decision|message)>([\s\S]*?)<\/\1>/.exec(rest)
        if (!field || Object.hasOwn(fields, field[1])) return null
        fields[field[1]] = field[2].trim()
        rest = rest.slice(field[0].length)
    }
    if (!fields.automation_id || Object.keys(fields).length !== 3) return null
    if (fields.instructions && fields.current_time_iso && Number.isFinite(Date.parse(fields.current_time_iso))) {
        return { kind: 'trigger', automationId: fields.automation_id, time: fields.current_time_iso, text: fields.instructions }
    }
    if (fields.message && (fields.decision === 'NOTIFY' || fields.decision === 'DONT_NOTIFY')) {
        return { kind: 'result', automationId: fields.automation_id, decision: fields.decision, text: fields.message }
    }
    return null
}
