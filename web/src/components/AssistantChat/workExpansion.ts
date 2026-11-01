/** Session-local choices survive virtual row recycling and reset on chat exit. */
export function createWorkExpansionState() {
    const choices = new Map<string, boolean>()
    const listeners = new Set<() => void>()
    return {
        get: (turnId: string) => choices.get(turnId),
        set(turnId: string, open: boolean | undefined) {
            if (choices.get(turnId) === open) return
            choices.delete(turnId)
            if (open !== undefined) choices.set(turnId, open)
            while (choices.size > 2048) choices.delete(choices.keys().next().value!)
            for (const listener of listeners) listener()
        },
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
    }
}
