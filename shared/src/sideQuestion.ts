import { z } from 'zod'

export const SideQuestionClientIdSchema = z.string().min(1).max(200)
export const SideQuestionRequestSchema = z.object({
    clientId: SideQuestionClientIdSchema,
    question: z.string().trim().min(1).max(8_000)
}).strict()
export const SideQuestionCancelRequestSchema = z.object({ clientId: SideQuestionClientIdSchema }).strict()
export const SideQuestionResponseSchema = z.object({ text: z.string().trim().min(1).max(32_768) }).strict()
export const SideQuestionCancelResponseSchema = z.object({ canceled: z.boolean() })

export type SideQuestionRequest = z.infer<typeof SideQuestionRequestSchema>
export type SideQuestionResponse = z.infer<typeof SideQuestionResponseSchema>
export type SideQuestionCancelResponse = z.infer<typeof SideQuestionCancelResponseSchema>

export const SIDE_QUESTION_PROMPT = 'Answer the user’s side question briefly in their language. Use only the conversation already available, including tool results already received. If the context does not answer the question, say so. Do not perform work, run tools, or change the main conversation.'

export class SideQuestionConflict extends Error {}

type Run = {
    state: 'running' | 'canceled' | 'finished'
    expiresAt: number
    controller?: AbortController
    question?: string
    promise?: Promise<SideQuestionResponse>
}

const RETAIN_MS = 5 * 60_000
const MAX_REQUESTS = 256

/** Track requests in memory, independently of the main conversation and its queue. */
export class SideQuestions {
    private readonly requests = new Map<string, Run>()
    private readonly active = new Map<string, Run>()
    private disposed = false

    private prune(): void {
        const now = Date.now()
        for (const [key, run] of this.requests) {
            if (run.state !== 'running' && run.expiresAt <= now) this.requests.delete(key)
        }
    }

    private reserve(): void {
        if (this.requests.size < MAX_REQUESTS) return
        for (const [key, run] of this.requests) {
            if (run.controller) continue
            this.requests.delete(key)
            return
        }
        throw new SideQuestionConflict('Too many side questions are running. Try again shortly.')
    }

    async ask(
        sourceId: string,
        { clientId, question }: SideQuestionRequest,
        generate: (signal: AbortSignal) => Promise<SideQuestionResponse>
    ): Promise<SideQuestionResponse> {
        this.prune()
        if (this.disposed) throw new SideQuestionConflict('The side question session has closed.')
        const key = JSON.stringify([sourceId, clientId])
        const existing = this.requests.get(key)
        if (existing?.state === 'canceled') throw new SideQuestionConflict('Side question was canceled.')
        if (existing?.promise) {
            if (existing.question !== question) throw new SideQuestionConflict('This side question ID was already used.')
            return existing.promise
        }
        if (this.active.has(sourceId)) throw new SideQuestionConflict('A side question is already running.')
        this.reserve()
        const controller = new AbortController()
        const run: Run = { state: 'running', expiresAt: Infinity, controller, question }
        this.requests.set(key, run)
        this.active.set(sourceId, run)
        run.promise = Promise.resolve()
            .then(() => {
                controller.signal.throwIfAborted()
                return generate(controller.signal)
            })
            .then(result => {
                controller.signal.throwIfAborted()
                return SideQuestionResponseSchema.parse(result)
            })
            .catch(error => {
                if (controller.signal.aborted) throw new SideQuestionConflict('Side question was canceled.')
                throw error
            })
            .finally(() => {
                run.state = controller.signal.aborted ? 'canceled' : 'finished'
                run.controller = undefined
                run.expiresAt = Date.now() + RETAIN_MS
                if (this.active.get(sourceId) === run) this.active.delete(sourceId)
            })
        return run.promise
    }

    cancel(sourceId: string, clientId: string): SideQuestionCancelResponse {
        this.prune()
        if (this.disposed) return { canceled: false }
        const key = JSON.stringify([sourceId, clientId])
        const run = this.requests.get(key)
        if (run?.state === 'finished') return { canceled: false }
        if (run) {
            run.state = 'canceled'
            run.controller?.abort()
            // The helper cleans up independently. A new question can start immediately.
            if (this.active.get(sourceId) === run) this.active.delete(sourceId)
        } else {
            // A cancel can reach the runner or hub before the corresponding start.
            this.reserve()
            this.requests.set(key, { state: 'canceled', expiresAt: Date.now() + RETAIN_MS })
        }
        return { canceled: true }
    }

    dispose(): void {
        this.disposed = true
        for (const run of this.requests.values()) run.controller?.abort()
        this.active.clear()
        this.requests.clear()
    }
}
