import { useTranslation } from '@/lib/use-translation'

export function PWAInstallGuide({ platform }: { platform: 'ios' | 'mac-safari' | 'other' }) {
    const { t } = useTranslation()
    const steps = platform === 'ios'
        ? [t('install.ios.share'), t('install.ios.add'), t('install.ios.confirm')]
        : platform === 'mac-safari'
            ? [t('install.mac.add'), t('install.mac.confirm')]
            : [t('install.browser.menu'), t('install.browser.confirm')]

    return (
        <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--app-fg)]">
            {steps.map(step => <li key={step}>{step}</li>)}
        </ol>
    )
}
