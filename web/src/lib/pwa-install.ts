interface BeforeInstallPromptEvent extends Event {
    prompt: () => Promise<void>
    userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type InstallState = 'idle' | 'available' | 'installing' | 'installed'
const INSTALL_DISMISSED_KEY = 'pwa_install_dismissed'

export function createPWAInstallController(browser: Window) {
    const navigator = browser.navigator as Navigator & { standalone?: boolean }
    const ua = navigator.userAgent
    // iPadOS uses a desktop Safari user agent when requesting desktop websites.
    const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    const isSafari = /WebKit/.test(ua) && !/Chrome|Chromium|CriOS|FxiOS|Edg|OPR|OPiOS/.test(ua)
    const displayMode = browser.matchMedia('(display-mode: standalone)')
    let dismissed = false
    try { dismissed = browser.localStorage.getItem(INSTALL_DISMISSED_KEY) === 'true' } catch { /* Storage is optional. */ }
    let deferredPrompt: BeforeInstallPromptEvent | null = null
    let isStandalone = displayMode.matches || navigator.standalone === true
    let installState: InstallState = isStandalone ? 'installed' : 'idle'
    const listeners = new Set<() => void>()
    const makeSnapshot = () => ({
        installState, dismissed, isStandalone, isIOS,
        isIOSSafari: isIOS && isSafari,
        isMacSafari: !isIOS && /Mac/.test(ua) && isSafari,
        isSecureContext: browser.isSecureContext === true,
        canPromptInstall: deferredPrompt !== null && installState === 'available' && !isStandalone,
    })
    let snapshot = makeSnapshot()
    const publish = () => {
        snapshot = makeSnapshot()
        listeners.forEach(listener => listener())
    }
    const beforeInstall = (event: Event) => {
        if (isStandalone || installState === 'installed') return
        event.preventDefault()
        deferredPrompt = event as BeforeInstallPromptEvent
        installState = 'available'
        publish()
    }
    const installed = () => {
        deferredPrompt = null
        installState = 'installed'
        publish()
    }
    const displayChanged = () => {
        isStandalone = displayMode.matches || navigator.standalone === true
        if (isStandalone) {
            deferredPrompt = null
            installState = 'installed'
        }
        publish()
    }
    browser.addEventListener('beforeinstallprompt', beforeInstall)
    browser.addEventListener('appinstalled', installed)
    displayMode.addEventListener('change', displayChanged)

    return {
        getSnapshot: () => snapshot,
        subscribe: (listener: () => void) => {
            listeners.add(listener)
            return () => { listeners.delete(listener) }
        },
        promptInstall: async () => {
            if (!deferredPrompt) return false
            const prompt = deferredPrompt
            deferredPrompt = null // The browser event can only be prompted once, across all consumers.
            installState = 'installing'
            publish()
            try {
                await prompt.prompt()
                const { outcome } = await prompt.userChoice
                // Only appinstalled or standalone display confirms installation, not accepting the dialog.
                if (snapshot.installState !== 'installed') installState = 'idle'
                publish()
                return outcome === 'accepted'
            } catch {
                if (snapshot.installState !== 'installed') installState = 'idle'
                publish()
                return false
            }
        },
        dismissInstall: () => {
            dismissed = true
            try { browser.localStorage.setItem(INSTALL_DISMISSED_KEY, 'true') } catch { /* Storage is optional. */ }
            publish()
        },
        dispose: () => {
            browser.removeEventListener('beforeinstallprompt', beforeInstall)
            browser.removeEventListener('appinstalled', installed)
            displayMode.removeEventListener('change', displayChanged)
            listeners.clear()
        },
    }
}

let controller: ReturnType<typeof createPWAInstallController> | undefined
export function getPWAInstallController() {
    return controller ??= createPWAInstallController(window)
}

export function initializePWAInstall() {
    // Capture browser events before authentication or async bootstrap mounts any install UI.
    getPWAInstallController()
}
