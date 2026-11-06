import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPWAInstallController } from './pwa-install'

const controllers: ReturnType<typeof createPWAInstallController>[] = []
function createController() {
    const controller = createPWAInstallController(window)
    controllers.push(controller)
    return controller
}

function offer(choice: Promise<{ outcome: 'accepted' | 'dismissed' }> = Promise.resolve({ outcome: 'dismissed' })) {
    const event = new Event('beforeinstallprompt', { cancelable: true })
    const prompt = vi.fn().mockResolvedValue(undefined)
    Object.assign(event, { prompt, userChoice: choice })
    window.dispatchEvent(event)
    return { event, prompt }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => {
    controllers.splice(0).forEach(controller => controller.dispose())
    vi.restoreAllMocks()
})

describe('PWA browser install lifecycle', () => {
    it('discards an offer created before a manifest change and waits for a fresh browser offer', async () => {
        const controller = createController()
        const stale = offer()
        controller.invalidatePrompt()
        expect(controller.getSnapshot().canPromptInstall).toBe(false)
        expect(await controller.promptInstall()).toBe(false)
        expect(stale.prompt).not.toHaveBeenCalled()
        const fresh = offer()
        await controller.promptInstall()
        expect(fresh.prompt).toHaveBeenCalledTimes(1)
    })
    it('keeps a browser offer received before login UI subscribes, including after floating dismissal', async () => {
        const controller = createController()
        const { event, prompt } = offer()
        controller.dismissInstall()
        const listener = vi.fn()
        const unsubscribe = controller.subscribe(listener)

        expect(event.defaultPrevented).toBe(true)
        expect(controller.getSnapshot()).toMatchObject({ dismissed: true, canPromptInstall: true })
        expect(await controller.promptInstall()).toBe(false)
        expect(prompt).toHaveBeenCalledTimes(1)
        expect(listener).toHaveBeenCalled()
        expect(controller.getSnapshot().canPromptInstall).toBe(false)
        unsubscribe()
    })

    it('shares a one-shot prompt across simultaneous controls and waits for installation confirmation', async () => {
        const controller = createController()
        let choose!: (choice: { outcome: 'accepted' }) => void
        const { prompt } = offer(new Promise(resolve => { choose = resolve }))
        const pending = controller.promptInstall()
        expect(await controller.promptInstall()).toBe(false)
        expect(prompt).toHaveBeenCalledTimes(1)
        expect(controller.getSnapshot().installState).toBe('installing')
        choose({ outcome: 'accepted' })
        expect(await pending).toBe(true)
        expect(controller.getSnapshot().installState).toBe('idle')
        window.dispatchEvent(new Event('appinstalled'))
        expect(controller.getSnapshot()).toMatchObject({ installState: 'installed', canPromptInstall: false })
    })

    it('preserves appinstalled when it arrives before userChoice settles', async () => {
        const controller = createController()
        let choose!: (choice: { outcome: 'accepted' }) => void
        offer(new Promise(resolve => { choose = resolve }))
        const pending = controller.promptInstall()
        window.dispatchEvent(new Event('appinstalled'))
        choose({ outcome: 'accepted' })
        await pending
        expect(controller.getSnapshot().installState).toBe('installed')
    })

    it('recovers from a rejected prompt and accepts a new browser offer', async () => {
        const controller = createController()
        const { prompt } = offer()
        prompt.mockRejectedValueOnce(new Error('Browser rejected the prompt'))
        expect(await controller.promptInstall()).toBe(false)
        expect(controller.getSnapshot().installState).toBe('idle')
        offer()
        expect(controller.getSnapshot().canPromptInstall).toBe(true)
    })

    it('detects iPadOS desktop Safari and reacts when standalone mode begins', () => {
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15')
        vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel')
        Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true })
        const media = new EventTarget() as MediaQueryList
        Object.assign(media, { matches: false })
        vi.spyOn(window, 'matchMedia').mockReturnValue(media)
        const controller = createController()
        expect(controller.getSnapshot()).toMatchObject({ isIOS: true, isIOSSafari: true, isMacSafari: false })
        offer()
        Object.assign(media, { matches: true })
        media.dispatchEvent(new Event('change'))
        expect(controller.getSnapshot()).toMatchObject({ isStandalone: true, installState: 'installed', canPromptInstall: false })
        Reflect.deleteProperty(navigator, 'maxTouchPoints')
    })
})
