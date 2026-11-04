import { useSyncExternalStore } from 'react'
import { getPWAInstallController } from '@/lib/pwa-install'

export function usePWAInstall() {
    const controller = getPWAInstallController()
    const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot)
    return {
        ...snapshot,
        canInstall: snapshot.canPromptInstall && !snapshot.dismissed,
        canInstallIOS: snapshot.isIOSSafari && !snapshot.isStandalone && snapshot.installState !== 'installed' && !snapshot.dismissed,
        promptInstall: controller.promptInstall,
        dismissInstall: controller.dismissInstall,
    }
}
