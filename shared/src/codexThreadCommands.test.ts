import { expect, it } from 'bun:test'
import { parseCodexThreadCommand } from './codexThreadCommands'

it('keeps all plan and goal arguments as literal content', () => {
    expect(parseCodexThreadCommand('/plan')).toEqual({ command: 'plan', mode: 'plan' })
    expect(parseCodexThreadCommand('/goal')).toEqual({ command: 'goal', action: 'show' })
    for (const argument of ['off', 'default', 'exit', 'disable', 'pause', 'resume', 'clear', 'show', 'First line\nSecond line']) {
        expect(parseCodexThreadCommand(`/plan ${argument}`)).toEqual({ command: 'plan', mode: 'plan', prompt: argument })
        expect(parseCodexThreadCommand(`/goal ${argument}`)).toEqual({ command: 'goal', action: 'set', objective: argument })
    }
    expect(parseCodexThreadCommand('Explain /plan')).toBeNull()
    expect(parseCodexThreadCommand('/planning')).toBeNull()
})

it('recognizes management commands without accepting unsupported extra arguments', () => {
    for (const command of ['compact', 'recap', 'usage'] as const) {
        expect(parseCodexThreadCommand(`/${command}`)).toEqual({ command })
        expect(parseCodexThreadCommand(`/${command} ignored`)).toBeNull()
    }
    expect(parseCodexThreadCommand('/approve')).toEqual({ command: 'approve', action: 'show' })
    expect(parseCodexThreadCommand('/approve review-123')).toEqual({ command: 'approve', action: 'retry', reviewId: 'review-123' })
    expect(parseCodexThreadCommand('/approve review-123 ignored')).toBeNull()
})
