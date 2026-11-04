import { usePWAInstall } from '@/hooks/usePWAInstall'
import { usePlatform } from '@/hooks/usePlatform'
import { useTranslation } from '@/lib/use-translation'
import { PWAInstallGuide } from '@/components/PWAInstallGuide'
import { SettingsSection } from './SettingsPrimitives'

export function PWAInstallSettings() {
    const { t } = useTranslation()
    const { isTelegram } = usePlatform()
    const { canPromptInstall, installState, isStandalone, isIOS, isMacSafari, isSecureContext, promptInstall } = usePWAInstall()
    const installed = isStandalone || installState === 'installed'

    return (
        <SettingsSection title={t('install.title')} description={t('install.settings.description')}>
            <div className="space-y-3 px-3 py-3">
                {installed ? (
                    <p className="text-sm text-[var(--app-hint)]" role="status">{t('install.installed')}</p>
                ) : isTelegram ? (
                    <p className="text-sm text-[var(--app-hint)]">{t('install.externalBrowser')}</p>
                ) : (
                    <>
                        {canPromptInstall || installState === 'installing' ? (
                            <button
                                type="button"
                                disabled={installState === 'installing'}
                                onClick={() => { void promptInstall() }}
                                className="rounded-lg bg-[var(--app-fg)] px-4 py-2 text-sm font-medium text-[var(--app-bg)] disabled:opacity-50"
                            >
                                {t(installState === 'installing' ? 'install.installing' : 'install.button')}
                            </button>
                        ) : null}
                        {!isSecureContext ? <p className="text-sm text-[var(--app-hint)]">{t('install.https')}</p> : null}
                        <PWAInstallGuide platform={isIOS ? 'ios' : isMacSafari ? 'mac-safari' : 'other'} />
                        <p className="text-xs text-[var(--app-hint)]">{t('install.availability')}</p>
                    </>
                )}
            </div>
        </SettingsSection>
    )
}
