import { expect, it } from 'vitest'
import { parseScheduledMessage } from './scheduledMessage'

const trigger = '<heartbeat>\r\n  <automation_id>daily</automation_id>\r\n  <current_time_iso>2026-11-01T00:59:27.543Z</current_time_iso>\r\n  <instructions>Check both hosts.\nKeep quiet when unchanged.</instructions>\r\n</heartbeat>'

it('reads Desktop scheduled inputs and quiet or notifying results', () => {
    expect(parseScheduledMessage(trigger)).toEqual({ kind: 'trigger', automationId: 'daily', time: '2026-11-01T00:59:27.543Z', text: 'Check both hosts.\nKeep quiet when unchanged.' })
    for (const decision of ['NOTIFY', 'DONT_NOTIFY']) {
        expect(parseScheduledMessage(`<heartbeat><automation_id>daily</automation_id><decision>${decision}</decision><message>Result with [details](/file).</message></heartbeat>`))
            .toEqual({ kind: 'result', automationId: 'daily', decision, text: 'Result with [details](/file).' })
    }
})

it('keeps examples, incomplete or unknown envelopes as ordinary text', () => {
    for (const text of [
        `Example: ${trigger}`, `\`\`\`xml\n${trigger}\n\`\`\``, `${trigger}\nExtra user text`,
        trigger.slice(0, -12), trigger.replace('2026-11-01T00:59:27.543Z', 'invalid'),
        trigger.replace('</heartbeat>', '<unexpected>Keep this</unexpected></heartbeat>'),
        trigger.replace('</heartbeat>', '<automation_id>duplicate</automation_id></heartbeat>'),
    ]) expect(parseScheduledMessage(text)).toBeNull()
})
