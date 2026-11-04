import { useEffect, useState } from 'react'
import { usePWAInstall } from '@/hooks/usePWAInstall'
import { usePlatform } from '@/hooks/usePlatform'
import { CloseIcon } from '@/components/icons'
import { PWAInstallGuide } from '@/components/PWAInstallGuide'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/lib/use-translation'

export function InstallPrompt() {
    const { t } = useTranslation()
    const { canInstall, canInstallIOS, promptInstall, dismissInstall, isStandalone } = usePWAInstall()
    const { isTelegram, haptic } = usePlatform()
    const [showIOSGuide, setShowIOSGuide] = useState(false)
    const showFloatingPrompt = !isTelegram && !isStandalone && ((canInstallIOS && !showIOSGuide) || canInstall)

    useEffect(() => {
        const root = document.documentElement
        if (!root) return

        if (showFloatingPrompt) {
            root.style.setProperty('--app-floating-bottom-offset', '112px')
        } else {
            root.style.removeProperty('--app-floating-bottom-offset')
        }

        return () => {
            root.style.removeProperty('--app-floating-bottom-offset')
        }
    }, [showFloatingPrompt])

    if (isTelegram || isStandalone) {
        return null
    }

    // iOS Safari install guide
    if (canInstallIOS) {
        if (showIOSGuide) {
            return (
                <Dialog open={showIOSGuide} onOpenChange={setShowIOSGuide}>
                    <DialogContent className="top-auto bottom-0 translate-y-0 rounded-b-none p-5 pb-8 space-y-4">
                        <DialogHeader>
                            <DialogTitle>{t('install.title')}</DialogTitle>
                            <DialogDescription>{t('install.description')}</DialogDescription>
                        </DialogHeader>

                        <PWAInstallGuide platform="ios" />

                        <button
                            onClick={() => {
                                setShowIOSGuide(false)
                                dismissInstall()
                            }}
                            className="w-full py-3 text-sm text-[var(--app-hint)] active:opacity-60"
                        >
                            {t('button.dismiss')}
                        </button>
                    </DialogContent>
                </Dialog>
            )
        }

        return (
            <div className="fixed bottom-4 left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-[var(--app-fg)]">
                            {t('install.title')}
                        </p>
                        <p className="text-xs text-[var(--app-hint)] mt-0.5">
                            {t('install.description')}
                        </p>
                    </div>
                    <button
                        onClick={() => {
                            haptic.impact('light')
                            setShowIOSGuide(true)
                        }}
                        className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80"
                    >
                        {t('install.button')}
                    </button>
                    <button
                        onClick={() => {
                            haptic.impact('light')
                            dismissInstall()
                        }}
                        className="shrink-0 p-2 text-[var(--app-hint)] active:opacity-60"
                        aria-label={t('button.dismiss')}
                    >
                        <CloseIcon className="w-4 h-4" />
                    </button>
                </div>
            </div>
        )
    }

    // Chrome/Edge install prompt
    if (!canInstall) {
        return null
    }

    const handleInstall = async () => {
        haptic.impact('light')
        const success = await promptInstall()
        if (success) {
            haptic.notification('success')
        }
    }

    return (
        <div className="fixed bottom-4 left-4 right-4 bg-[var(--app-secondary-bg)] border border-[var(--app-border)] rounded-lg p-4 shadow-lg z-50">
            <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-[var(--app-fg)]">
                        {t('install.title')}
                    </p>
                    <p className="text-xs text-[var(--app-hint)] mt-0.5">
                        {t('install.description')}
                    </p>
                </div>
                <button
                    onClick={handleInstall}
                    className="shrink-0 px-4 py-2 bg-[var(--app-fg)] text-[var(--app-bg)] rounded-lg text-sm font-medium active:opacity-80"
                >
                    {t('install.button')}
                </button>
                <button
                    onClick={() => {
                        haptic.impact('light')
                        dismissInstall()
                    }}
                    className="shrink-0 p-2 text-[var(--app-hint)] active:opacity-60"
                    aria-label={t('button.dismiss')}
                >
                    <CloseIcon className="w-4 h-4" />
                </button>
            </div>
        </div>
    )
}
