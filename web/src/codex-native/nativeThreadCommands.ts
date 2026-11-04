import { ApiError } from '@/api/client'
export type { NativeGoal, NativeCommandState, NativeCommandRequest, NativeCommandResult } from '@hapi/protocol/codexThreadCommands'

export function isNativeCommandSubmissionUnconfirmed(error: unknown): boolean {
    if (!(error instanceof ApiError) || !error.body) return false
    try { return (JSON.parse(error.body) as { submission?: { outcome?: string } }).submission?.outcome === 'unconfirmed' }
    catch { return false }
}
export function nativeCommandErrorMessage(error: unknown): string {
    if (error instanceof ApiError && error.body) {
        try { const body = JSON.parse(error.body) as { error?: unknown }; if (typeof body.error === 'string') return body.error }
        catch { /* A non-JSON proxy error still has a useful message. */ }
    }
    return error instanceof Error ? error.message : String(error)
}
