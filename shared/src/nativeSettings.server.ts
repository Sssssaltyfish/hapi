import { isDeepStrictEqual } from 'node:util'

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown> : {}
}

/** Native updates are asynchronous; an unrelated notification is not our ACK. */
export function settingsMatch(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
    return Object.entries(expected).every(([key, value]) => {
        if (key === 'threadId') return true
        // null selects native built-ins, whose effective snapshot contains expanded text.
        if (key === 'developer_instructions' && value === null) return true
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
            return settingsMatch(record(actual[key]), record(value))
        }
        return isDeepStrictEqual(actual[key], value)
    })
}
