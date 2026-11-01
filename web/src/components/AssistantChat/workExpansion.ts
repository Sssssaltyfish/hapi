/** Session-local choices survive virtual row recycling and reset on chat exit. */
export function createWorkExpansionState() {
    const expanded = new Set<string>()
    const listeners = new Set<() => void>()
    return {
        get: (turnId: string) => expanded.has(turnId),
        set(turnId: string, open: boolean) {
            if (expanded.has(turnId) === open) return
            if (open) expanded.add(turnId)
            else expanded.delete(turnId)
            for (const listener of listeners) listener()
        },
        subscribe(listener: () => void) {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
    }
}
