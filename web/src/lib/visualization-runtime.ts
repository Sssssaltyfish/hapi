export type VisualizationGlobals = {
    theme: 'light' | 'dark'
    styles: Record<string, string>
    widgetState: unknown
}

type WidgetState = { modelContent?: unknown; privateContent?: unknown }
type Request =
    | { type: 'state'; state: WidgetState }
    | { type: 'followup'; prompt: string; title?: string }
    | { type: 'open'; href: string }

type HostMessage =
    | { type: 'globals'; globals: VisualizationGlobals }
    | { type: 'result'; requestId: number; error?: string }

// This function is serialized into srcdoc. Its only external dependencies are browser globals.
export function startVisualizationRuntime(): void {
    const configElement = document.getElementById('hapi-visualization-config')!
    const { bridgeId, globals, icons } = JSON.parse(configElement.textContent!) as {
        bridgeId: string
        globals: VisualizationGlobals
        icons: boolean
    }
    configElement.remove()
    document.currentScript?.remove()

    const root = document.documentElement
    const host = window.parent
    const postToHost = host.postMessage.bind(host)
    const channel = 'hapi-visualize'
    const pending = new Map<number, { resolve: () => void; reject: (error: Error) => void }>()
    let requestId = 0
    let theme = globals.theme
    let styles: Record<string, string> = {}
    let state = globals.widgetState

    const request = (message: Request): Promise<void> => new Promise((resolve, reject) => {
        const id = ++requestId
        pending.set(id, { resolve, reject })
        postToHost({ channel, bridgeId, requestId: id, ...message }, '*')
    })

    const api = {
        get theme() { return theme },
        get visualizationTheme() { return theme },
        get visualizationStyleVariables() { return styles },
        get widgetState() { return state },
        async setWidgetState(next: WidgetState): Promise<void> {
            if (next === null || typeof next !== 'object' || Array.isArray(next)) {
                throw new TypeError('Widget state must be a JSON object')
            }
            const snapshot = JSON.stringify({
                modelContent: next.modelContent ?? null,
                privateContent: next.privateContent ?? null,
            }, (_key, value: unknown) => {
                if (value === undefined || typeof value === 'function' || typeof value === 'symbol'
                    || (typeof value === 'number' && !Number.isFinite(value))) {
                    throw new TypeError('Widget state must contain only JSON values')
                }
                return value
            })
            if (new TextEncoder().encode(snapshot).length > 16 * 1024) {
                throw new TypeError('Widget state must be at most 16 KiB')
            }
            const parsed = JSON.parse(snapshot) as WidgetState
            state = parsed
            const result = request({ type: 'state', state: parsed })
            announceGlobals()
            return result
        },
        async sendFollowUpMessage({ prompt, title }: { prompt: string; title?: string }): Promise<void> {
            if (navigator.userActivation?.isActive !== true) {
                throw new Error('A user interaction is required for a follow-up')
            }
            if (typeof prompt !== 'string' || !prompt.trim() || (title !== undefined && typeof title !== 'string')) {
                throw new TypeError('A follow-up requires a prompt and an optional title')
            }
            return request({ type: 'followup', prompt, title })
        },
        async openExternal({ href }: { href: string }): Promise<void> {
            if (navigator.userActivation?.isActive !== true) {
                throw new Error('A user interaction is required to open a link')
            }
            if (typeof href !== 'string' || !href.trim()) {
                throw new TypeError('An external link requires a URL')
            }
            return request({ type: 'open', href })
        },
    }
    Object.defineProperty(window, 'openai', { value: api })

    const announceGlobals = () => {
        window.dispatchEvent(new CustomEvent('openai:set_globals', { detail: { globals: { ...api } } }))
    }

    const applyGlobals = (next: VisualizationGlobals) => {
        theme = next.theme
        state = next.widgetState
        root.dataset.theme = theme
        for (const key of Object.keys(styles)) root.style.removeProperty(key)
        styles = {}
        for (const [key, value] of Object.entries(next.styles)) {
            if (/^--[\w-]+$/.test(key) && typeof value === 'string') {
                root.style.setProperty(key, value)
                styles[key] = value
            }
        }
    }

    const getMessageSource = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'source')!.get!
    const getMessageData = Object.getOwnPropertyDescriptor(MessageEvent.prototype, 'data')!.get!
    const apply = Reflect.apply
    const stopMessage = Event.prototype.stopImmediatePropagation
    window.addEventListener('message', (event) => {
        if (!event.isTrusted || apply(getMessageSource, event, []) !== host) return
        const data = apply(getMessageData, event, []) as (HostMessage & { channel: string; bridgeId: string }) | null
        if (data?.channel !== channel || data.bridgeId !== bridgeId) return
        apply(stopMessage, event, [])
        if (data.type === 'globals') {
            applyGlobals(data.globals)
            announceGlobals()
        } else if (data.type === 'result') {
            const result = pending.get(data.requestId)
            if (!result) return
            pending.delete(data.requestId)
            if (data.error !== undefined) result.reject(new Error(data.error))
            else result.resolve()
        }
    }, { capture: true })

    const targetElement = (event: Event): Element | null => event.target instanceof Element ? event.target : null

    const handleLink = (event: MouseEvent) => {
        if (event.defaultPrevented) return
        const href = targetElement(event)?.closest('a[href]')?.getAttribute('href')?.trim()
        if (href == null) return
        event.preventDefault()
        if (!event.isTrusted) return
        if (href.startsWith('#')) {
            try {
                const id = decodeURIComponent(href.slice(1))
                const target = id ? document.getElementById(id) : root
                target?.scrollIntoView({ block: 'nearest' })
            } catch {
                // An invalid fragment identifier has no target.
            }
        } else {
            void api.openExternal({ href }).catch(() => {})
        }
    }
    document.addEventListener('click', handleLink)
    document.addEventListener('auxclick', handleLink)

    const tabSelector = '.nav-pills[role="tablist"] .nav-link[role="tab"]'
    const tabsFor = (tab: Element) => {
        const list = tab.closest('[role="tablist"]')
        return Array.from(list?.querySelectorAll<HTMLButtonElement>(tabSelector) ?? [])
            .filter((item) => item.closest('[role="tablist"]') === list)
    }
    const enabled = (tab: HTMLButtonElement) => !tab.disabled && tab.getAttribute('aria-disabled') !== 'true'

    document.addEventListener('click', (event) => {
        const tab = targetElement(event)?.closest<HTMLButtonElement>(tabSelector)
        if (event.defaultPrevented || !tab || !enabled(tab)) return
        const selectedPanel = tab.getAttribute('aria-controls')
        for (const item of tabsFor(tab)) {
            const selected = item === tab
            item.classList.toggle('active', selected)
            item.setAttribute('aria-selected', String(selected))
            const panelId = item.getAttribute('aria-controls')
            const panel = panelId ? document.getElementById(panelId) : null
            if (panel) {
                panel.hidden = panelId !== selectedPanel
                if (selected && tab.id) panel.setAttribute('aria-labelledby', tab.id)
            }
        }
    })
    document.addEventListener('keydown', (event) => {
        const tab = targetElement(event)?.closest<HTMLButtonElement>(tabSelector)
        if (event.defaultPrevented || !tab) return
        const tabs = tabsFor(tab).filter(enabled)
        const index = tabs.indexOf(tab)
        if (index < 0) return
        const vertical = tab.closest('[role="tablist"]')?.getAttribute('aria-orientation') === 'vertical'
        const rtl = !vertical && getComputedStyle(tab).direction === 'rtl'
        const nextKey = vertical ? 'ArrowDown' : 'ArrowRight'
        const previousKey = vertical ? 'ArrowUp' : 'ArrowLeft'
        let next: HTMLButtonElement
        if (event.key === 'Home') next = tabs[0]
        else if (event.key === 'End') next = tabs[tabs.length - 1]
        else if (event.key === nextKey) next = tabs[(index + (rtl ? -1 : 1) + tabs.length) % tabs.length]
        else if (event.key === previousKey) next = tabs[(index + (rtl ? 1 : -1) + tabs.length) % tabs.length]
        else return
        event.preventDefault()
        next.focus()
        next.click()
    })

    let tooltip: HTMLElement | null = null
    let tooltipTrigger: Element | null = null
    const tooltipId = `hapi-visualization-tip-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`
    const hideTooltip = () => {
        if (!tooltip || !tooltipTrigger) return
        const description = (tooltipTrigger.getAttribute('aria-describedby') ?? '')
            .split(/\s+/).filter((id) => id && id !== tooltipId).join(' ')
        if (description) tooltipTrigger.setAttribute('aria-describedby', description)
        else tooltipTrigger.removeAttribute('aria-describedby')
        tooltip.remove()
        tooltip = null
        tooltipTrigger = null
    }
    const showTooltip = (trigger: Element) => {
        const label = trigger.getAttribute('data-tooltip')
        if (!label || trigger === tooltipTrigger) return
        hideTooltip()
        tooltipTrigger = trigger
        tooltip = document.createElement('span')
        tooltip.id = tooltipId
        tooltip.className = 'tooltip'
        tooltip.role = 'tooltip'
        tooltip.textContent = label
        trigger.setAttribute('aria-describedby', [trigger.getAttribute('aria-describedby'), tooltipId].filter(Boolean).join(' '))
        document.body.append(tooltip)
        const anchor = trigger.getBoundingClientRect()
        const { width, height } = tooltip.getBoundingClientRect()
        const gap = 6
        const centerX = anchor.left + (anchor.width - width) / 2
        const centerY = anchor.top + (anchor.height - height) / 2
        const above = anchor.top - height - gap
        const below = anchor.bottom + gap
        const before = anchor.left - width - gap
        const after = anchor.right + gap
        const placement = trigger.getAttribute('data-tooltip-placement')
        let x = centerX
        let y = above >= gap ? above : below
        if (placement === 'bottom') y = below + height <= window.innerHeight - gap ? below : above
        if (placement === 'left' || placement === 'right') {
            x = placement === 'left' ? (before >= gap ? before : after) : (after + width <= window.innerWidth - gap ? after : before)
            y = centerY
        }
        tooltip.style.left = `${Math.max(gap, Math.min(x, window.innerWidth - width - gap))}px`
        tooltip.style.top = `${Math.max(gap, Math.min(y, window.innerHeight - height - gap))}px`
    }
    const tooltipTarget = (event: Event) => targetElement(event)?.closest('[data-tooltip]')
    document.addEventListener('pointerover', (event) => {
        const trigger = tooltipTarget(event)
        if (trigger && event.pointerType !== 'touch') showTooltip(trigger)
    })
    document.addEventListener('pointerout', (event) => {
        if (tooltipTrigger && event.pointerType !== 'touch' && tooltipTarget(event) === tooltipTrigger
            && !(event.relatedTarget instanceof Node && tooltipTrigger.contains(event.relatedTarget))) hideTooltip()
    })
    document.addEventListener('focusin', (event) => {
        const trigger = tooltipTarget(event)
        if (trigger) showTooltip(trigger)
    })
    document.addEventListener('focusout', hideTooltip)
    document.addEventListener('pointerup', (event) => {
        if (event.pointerType !== 'touch') return
        const trigger = tooltipTarget(event)
        if (trigger) showTooltip(trigger)
        else hideTooltip()
    })
    window.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !event.isTrusted || event.defaultPrevented || event.isComposing) return
        if (tooltip) {
            event.preventDefault()
            hideTooltip()
            return
        }
        if (event.repeat || document.querySelector(':is(dialog:modal, :popover-open)')) return
        // Give any remaining widget listeners a chance to consume Escape.
        setTimeout(() => {
            if (!event.defaultPrevented) postToHost({ channel, bridgeId, type: 'escape' }, '*')
        }, 0)
    })
    window.addEventListener('resize', hideTooltip)

    applyGlobals(globals)

    document.addEventListener('DOMContentLoaded', () => {
        const body = document.body
        let lastHeight = 0
        let frame = 0
        const measure = () => {
            if (frame) return
            frame = requestAnimationFrame(() => {
                frame = 0
                // Body is a flow root. The viewport can be taller than its natural height.
                const height = Math.max(1, Math.ceil(body.getBoundingClientRect().height))
                if (height === lastHeight) return
                lastHeight = height
                postToHost({ channel, bridgeId, type: 'height', height }, '*')
            })
        }
        postToHost({ channel, bridgeId, type: 'ready' }, '*')
        new ResizeObserver(measure).observe(body)
        measure()
    }, { once: true })

    if (icons) {
        type IconWindow = Window & { lucide?: { createIcons(options: { attrs: { width: number; height: number } }): void } }
        const initIcons = () => (window as IconWindow).lucide?.createIcons({ attrs: { width: 16, height: 16 } })
        const script = document.createElement('script')
        script.src = 'https://unpkg.com/lucide@1.17.0/dist/umd/lucide.js'
        script.async = true
        script.addEventListener('load', initIcons, { once: true })
        document.addEventListener('DOMContentLoaded', initIcons, { once: true })
        document.head.append(script)
    }
}
