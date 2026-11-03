import { z } from 'zod'
import type { ThreadGoal } from './schemas'
import { MAX_CODEX_GOAL_OBJECTIVE_CHARS } from './codexThreadCommands'

export const CodexGoalControlRequestSchema = z.discriminatedUnion('action', [
    z.object({ action: z.enum(['show', 'pause', 'resume', 'clear']) }).strict(),
    z.object({ action: z.literal('set'), objective: z.string().trim().min(1)
        .refine(value => [...value].length <= MAX_CODEX_GOAL_OBJECTIVE_CHARS, 'Goal objective is too long') }).strict(),
    z.object({ action: z.literal('edit'), objective: z.string().trim().min(1)
        .refine(value => [...value].length <= MAX_CODEX_GOAL_OBJECTIVE_CHARS, 'Goal objective is too long'),
        expectedObjective: z.string().min(1) }).strict(),
])
export type CodexGoalControlRequest = z.infer<typeof CodexGoalControlRequestSchema>
export type CodexGoalControlResult = { goal: ThreadGoal | null; cleared?: boolean }
