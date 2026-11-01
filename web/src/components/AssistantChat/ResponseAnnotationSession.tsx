import { createContext, useContext, useMemo, useRef, type ReactNode } from 'react'
import type { AnnotationNavigationTarget, ResponseAnnotationResolver } from '@/lib/responseAnnotationResolver'
import type { ResponseAnnotation } from '@/lib/responseAnnotations'

type Navigator = (target: AnnotationNavigationTarget) => Promise<boolean>
type AnnotationSession = {
    resolver: ResponseAnnotationResolver
    setNavigator: (navigator: Navigator | undefined) => void
    navigate: (annotation: ResponseAnnotation, signal?: AbortSignal) => Promise<void>
}
const Context = createContext<AnnotationSession | null>(null)
export const useResponseAnnotationSession = () => useContext(Context)

export function ResponseAnnotationSessionProvider({ resolver, children }: { resolver: ResponseAnnotationResolver; children: ReactNode }) {
    const navigator = useRef<Navigator | undefined>(undefined)
    const value = useMemo<AnnotationSession>(() => ({
        resolver,
        setNavigator: value => { navigator.current = value },
        navigate: async (annotation, signal) => {
            const target = await resolver.resolve(annotation, signal)
            signal?.throwIfAborted()
            if (!navigator.current || !await navigator.current(target)) throw new Error('The original text could not be displayed.')
        },
    }), [resolver])
    return <Context.Provider value={value}>{children}</Context.Provider>
}
