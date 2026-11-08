import { query } from './sdk/query'
import type { QueryPrompt, SDKUserMessage } from './sdk/types'
import { SESSION_RECAP_PROMPT } from '@hapi/protocol/recap'
import { SIDE_QUESTION_PROMPT } from '@hapi/protocol/sideQuestion'

type SideResponseOptions = {
    sessionId: string
    cwd: string
    model?: string
    signal: AbortSignal
}

/** Read the current transcript through a non-persistent native fork, without tools. */
async function createClaudeSideResponse(options: SideResponseOptions, prompt: QueryPrompt, task: string): Promise<string> {
    options.signal.throwIfAborted()
    const timeout = AbortSignal.timeout(60_000)
    const stream = query({
        prompt,
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
            if (message.subtype !== 'success') throw new Error(`Claude could not complete the isolated ${task}`)
            if (typeof message.result === 'string') text = message.result
        }
    }
    if (!text.trim()) throw new Error(`Claude returned no ${task} text`)
    return text.trim()
}

export function createClaudeSideRecap(options: SideResponseOptions): Promise<string> {
    return createClaudeSideResponse(options, SESSION_RECAP_PROMPT, 'recap')
}

export function createClaudeSideQuestion(options: SideResponseOptions, question: string): Promise<string> {
    // Use stdin so the side question never appears in command-line arguments.
    async function* prompt(): AsyncGenerator<SDKUserMessage> {
        yield { type: 'user', message: { role: 'user', content: `${SIDE_QUESTION_PROMPT}\n\nQuestion: ${question}` } }
    }
    return createClaudeSideResponse(options, prompt(), 'side question')
}
