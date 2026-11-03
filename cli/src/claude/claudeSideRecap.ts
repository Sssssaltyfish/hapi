import { query } from './sdk/query'

/** Read the current transcript through a non-persistent native fork, without tools. */
export async function createClaudeSideRecap(options: {
    sessionId: string
    cwd: string
    model?: string
    signal: AbortSignal
}): Promise<string> {
    const timeout = AbortSignal.timeout(60_000)
    const stream = query({
        prompt: 'Give a concise recap of this conversation: the user goal, completed work, current state, unresolved questions, and next steps. Use only the conversation already available. Do not run tools or perform new work.',
        options: {
            cwd: options.cwd,
            resume: options.sessionId,
            forkSession: true,
            model: options.model,
            abort: AbortSignal.any([options.signal, timeout]),
            maxTurns: 1,
            permissionMode: 'default',
            strictMcpConfig: true,
            mcpServers: {},
            additionalArgs: ['--tools', '', '--no-session-persistence', '--disable-slash-commands',
                '--settings', '{"disableAllHooks":true}']
        }
    })
    let text = ''
    for await (const message of stream) {
        if (message.type === 'result') {
            if (message.subtype !== 'success') throw new Error('Claude could not complete the isolated recap')
            if (typeof message.result === 'string') text = message.result
        }
    }
    if (!text.trim()) throw new Error('Claude returned no recap text')
    return text
}
