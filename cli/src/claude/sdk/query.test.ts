import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

const spawnMock = vi.fn()
const killProcessMock = vi.fn(async (child: any) => {
    child.killed = true
    child.stdout.end()
    child.emit('close', 0)
})

vi.mock('node:child_process', () => ({
    ...require('node:child_process'),
    spawn: spawnMock
}))

vi.mock('@/utils/process', () => ({
    isProcessAlive: () => false,
    isWindows: () => false,
    killProcess: async () => true,
    killProcessByChildProcess: killProcessMock
}))

vi.mock('@/utils/bunRuntime', () => ({
    withBunRuntimeEnv: (env: NodeJS.ProcessEnv) => env
}))

vi.mock('../utils/mcpConfig', () => ({
    appendMcpConfigArg: () => null
}))

function createFakeChild() {
    const child = new EventEmitter() as EventEmitter & {
        stdin: PassThrough
        stdout: PassThrough
        stderr: PassThrough
        killed: boolean
    }

    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    return child
}

afterEach(() => {
    vi.clearAllMocks()
    delete process.env.HAPI_CLAUDE_PATH
})

describe('Query', () => {
    it('discovers the native catalog with a control request and no user message', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'
        const writes: Array<{ type: string; request_id: string; request?: unknown }> = []
        child.stdin.on('data', chunk => {
            const message = JSON.parse(String(chunk)) as typeof writes[number]
            writes.push(message)
            child.stdout.write(JSON.stringify({ type: 'control_response', response: {
                request_id: message.request_id,
                subtype: 'success',
                response: {
                    commands: [{ name: 'hapi-visualize', description: 'Make a visualization', argumentHint: '' }]
                }
            } }) + '\n')
        })

        const { extractSDKMetadata } = await import('./metadataExtractor')
        await expect(extractSDKMetadata({
            cwd: '/workspace', claudeArgs: ['--plugin-dir', '/plugins/example', '--settings=preferences.json', '--resume', 'ignored']
        })).resolves.toMatchObject({ slashCommands: ['hapi-visualize'] })

        const [command, args, options] = spawnMock.mock.calls[0]!
        expect(command).toBe('claude')
        expect(args).toEqual([
            '--output-format', 'stream-json', '--verbose', '--plugin-dir', '/plugins/example', '--settings=preferences.json',
            '--no-session-persistence', '--permission-mode', 'default', '--input-format', 'stream-json'
        ])
        expect(options.cwd).toBe('/workspace')
        expect(writes).toEqual([{
            type: 'control_request', request_id: expect.any(String), request: { subtype: 'initialize' }
        }])
        expect(killProcessMock).toHaveBeenCalledOnce()
    })

    it('answers and cancels native side questions while a main turn waits for approval', async () => {
        const { Query } = await import('./query')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const writes: Array<{ type: string; request_id: string; request?: unknown }> = []
        stdin.on('data', chunk => writes.push(JSON.parse(String(chunk))))
        let exit!: () => void
        let approvalStarted!: () => void
        const approval = new Promise<void>(resolve => { approvalStarted = resolve })
        const query = new Query(stdin, stdout, new Promise<void>(resolve => { exit = resolve }),
            async (_, __, { signal }) => {
                approvalStarted()
                await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
                return { behavior: 'deny', message: 'closed' }
            })
        const write = (message: unknown) => stdout.write(JSON.stringify(message) + '\n')
        try {
            write({ type: 'control_request', request_id: 'main-approval', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } })
            await approval
            const answer = query.askSideQuestion('What has been checked?', new AbortController().signal)
            const first = writes[0]!
            expect(first.request).toEqual({ subtype: 'side_question', question: 'What has been checked?' })
            write({ type: 'system', subtype: 'control_request_progress', request_id: first.request_id })
            write({ type: 'control_response', response: {
                subtype: 'success', request_id: first.request_id, response: { response: 'The existing tests.', synthetic: false }
            } })
            await expect(answer).resolves.toBe('The existing tests.')

            const cancel = new AbortController()
            const canceled = query.askSideQuestion('Another question', cancel.signal)
            const second = writes[1]!
            cancel.abort(new Error('canceled by user'))
            await expect(canceled).rejects.toThrow('canceled by user')
            expect(writes.slice(2)).toEqual([{ type: 'control_cancel_request', request_id: second.request_id }])
            write({ type: 'system', subtype: 'status' })
            await expect(query.next()).resolves.toMatchObject({ value: { type: 'system', subtype: 'status' } })
        } finally {
            stdout.end(); exit()
        }
    })

    it('writes priority input on the existing stream and proves closed input was not dispatched', async () => {
        const { Query } = await import('./query')
        const { ClaudeInputUnavailableError } = await import('./types')
        const stdin = new PassThrough()
        const stdout = new PassThrough()
        const lines: string[] = []
        stdin.on('data', data => lines.push(String(data)))
        let exit!: () => void
        const query = new Query(stdin, stdout, new Promise<void>(resolve => { exit = resolve }))
        const input = { type: 'user' as const, uuid: 'wire-id', priority: 'next' as const, message: { role: 'user' as const, content: 'soft input' } }
        await query.sendUserMessage(input)
        expect(lines).toEqual([JSON.stringify(input) + '\n'])
        query.setError(new Error('connection ended'))
        await expect(query.sendUserMessage(input)).rejects.toBeInstanceOf(ClaudeInputUnavailableError)
        expect(lines).toHaveLength(1)
        stdout.end(); exit()
    })
    it('preserves externally set errors even if the process exits cleanly', async () => {
        const { Query } = await import('./query')
        const stdout = new PassThrough()
        const query = new Query(null, stdout, Promise.resolve())

        query.setError(new Error('prompt failed'))
        stdout.end()

        await expect(query.next()).rejects.toThrow('prompt failed')
    })

    it('propagates prompt stream failures through query()', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('fails fast after cleanup timeout when prompt cleanup hangs', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        killProcessMock.mockReturnValueOnce(new Promise<void>(() => {}))
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        const prompt = {
            async *[Symbol.asyncIterator]() {
                yield { type: 'user', message: { role: 'user', content: 'hello' } }
                throw new Error('prompt failed')
            }
        }

        const result = query({ prompt, options: { promptFailureCleanupTimeoutMs: 10 } })

        await expect(result.next()).rejects.toThrow('prompt failed')
    })

    it('places additional launch arguments before HAPI settings', async () => {
        const child = createFakeChild()
        spawnMock.mockReturnValueOnce(child)
        process.env.HAPI_CLAUDE_PATH = 'claude'

        const { query } = await import('./query')
        query({
            prompt: 'hello',
            options: {
                additionalArgs: ['--plugin-dir', '/tmp/plugin'],
                settingsPath: '/tmp/hapi-settings.json'
            }
        })

        const args = spawnMock.mock.calls[0][1] as string[]
        expect(args.indexOf('--plugin-dir')).toBeLessThan(args.indexOf('--settings'))
        child.stdout.end()
        child.emit('close', 0)
    })
})
