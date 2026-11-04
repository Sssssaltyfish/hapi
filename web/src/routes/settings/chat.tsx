import { useTranslation } from '@/lib/use-translation'
import { getComposerEnterBehaviorOptions, useComposerEnterBehavior } from '@/hooks/useComposerEnterBehavior'
import { getTerminalToolDisplayModeOptions, useTerminalToolDisplayMode } from '@/hooks/useTerminalToolDisplayMode'
import { useToolGroupCollapse } from '@/hooks/useToolGroupCollapse'
import { useReasoningCollapse } from '@/hooks/useReasoningCollapse'
import { DISCLOSURE_DURATIONS, setDisclosureDuration, useDisclosureDuration } from '@/hooks/useDisclosureDuration'
import {
    getChatSurfaceColorPickerValue,
    getChatSurfaceColorPresetOptions,
    toCustomChatSurfaceColorPreference,
    toPresetChatSurfaceColorPreference,
    useChatSurfaceColors,
    type ChatSurfaceColorPreference,
    type ChatSurfaceColorPreset,
} from '@/hooks/useChatSurfaceColors'
import { SettingsChoiceGroup, SettingsFieldLabel, SettingsPageContent, SettingsSection, SettingsSwitch } from '@/components/settings/SettingsPrimitives'
import { ComposerToolbarLayoutControl } from '@/components/settings/ComposerToolbarLayoutControl'
import { useComposerSendMode } from '@/hooks/useComposerSendMode'
import { getColorThemePreview, useColorTheme } from '@/hooks/useColorTheme'

function ChatSurfaceColorControl(props: {
    label: string
    preference: ChatSurfaceColorPreference
    onPresetChange: (preset: ChatSurfaceColorPreset) => void
    onCustomChange: (value: string) => void
}) {
    const { t } = useTranslation()
    const pickerValue = getChatSurfaceColorPickerValue(props.preference)
    const { colorTheme } = useColorTheme()
    const defaultPreview = getColorThemePreview(colorTheme)
    return (
        <div className="px-3 py-3">
            <SettingsFieldLabel>{props.label}</SettingsFieldLabel>
            <div role="radiogroup" aria-label={props.label} className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {getChatSurfaceColorPresetOptions().map((option) => {
                    const preference = toPresetChatSurfaceColorPreference(option.value)
                    const selected = props.preference === preference
                    return (
                        <button key={option.value} type="button" role="radio" aria-checked={selected} onClick={() => props.onPresetChange(option.value)} className={`flex min-w-0 items-center gap-2 rounded-lg border px-2.5 py-2 text-sm ${selected ? 'border-[var(--app-link)] bg-[var(--app-subtle-bg)] text-[var(--app-link)]' : 'border-[var(--app-border)] text-[var(--app-fg)]'}`}>
                            <span aria-hidden="true" className="relative h-4 w-4 shrink-0 overflow-hidden rounded-full border border-[var(--app-border)]" style={{ backgroundColor: option.value === 'default' ? defaultPreview.light : getChatSurfaceColorPickerValue(preference) }}>
                                {option.value === 'default' ? <span className="absolute inset-y-0 right-0 w-1/2" style={{ backgroundColor: defaultPreview.dark }} /> : null}
                            </span>
                            <span className="whitespace-normal break-words">{t(option.labelKey)}</span>
                        </button>
                    )
                })}
            </div>
            <label className="mt-3 flex items-center justify-between gap-3 text-sm text-[var(--app-hint)]">
                {t('settings.chat.surfaceColor.custom')}
                <input type="color" value={pickerValue} onChange={(event) => props.onCustomChange(event.target.value)} className="h-9 w-12 cursor-pointer border-0 bg-transparent p-0" />
            </label>
        </div>
    )
}

export default function SettingsChatPage() {
    const { t } = useTranslation()
    const { composerEnterBehavior, setComposerEnterBehavior } = useComposerEnterBehavior()
    const { composerSendMode, setComposerSendMode } = useComposerSendMode()
    const { terminalToolDisplayMode, setTerminalToolDisplayMode } = useTerminalToolDisplayMode()
    const { toolGroupsCollapsed, setToolGroupsCollapsed } = useToolGroupCollapse()
    const { reasoningCollapsed, setReasoningCollapsed } = useReasoningCollapse()
    const disclosureDuration = useDisclosureDuration()
    const { toolGroupBackground, userMessageBackground, setToolGroupBackground, setUserMessageBackground } = useChatSurfaceColors()
    return (
        <SettingsPageContent>
            <SettingsSection title={t('settings.chat.input')}>
                <SettingsChoiceGroup
                    label={t('settings.chat.enterBehavior')}
                    value={composerEnterBehavior}
                    options={getComposerEnterBehaviorOptions().map((option) => ({ value: option.value, label: t(option.labelKey) }))}
                    onChange={setComposerEnterBehavior}
                />
                <ComposerToolbarLayoutControl />
                <SettingsChoiceGroup label={t('settings.chat.sendMode')} value={composerSendMode}
                    options={[{ value: 'queue', label: t('settings.chat.sendMode.queue') }, { value: 'steer', label: t('settings.chat.sendMode.steer'), description: t('settings.chat.sendMode.steer.fallback') }]}
                    onChange={setComposerSendMode} />
                <p className="px-3 pb-3 text-xs text-[var(--app-hint)]">{t('settings.chat.sendMode.description')}</p>
            </SettingsSection>
            <SettingsSection title={t('settings.chat.tools')}>
                <SettingsChoiceGroup
                    label={t('settings.chat.terminalToolDisplay')}
                    value={terminalToolDisplayMode}
                    options={getTerminalToolDisplayModeOptions().map((option) => ({ value: option.value, label: t(option.labelKey), description: t(`${option.labelKey}.desc`) }))}
                    onChange={setTerminalToolDisplayMode}
                    columns={3}
                />
                <SettingsSwitch
                    label={t('settings.chat.toolGroupsCollapsed')}
                    checked={toolGroupsCollapsed}
                    onChange={setToolGroupsCollapsed}
                />
                <SettingsSwitch
                    label={t('settings.chat.reasoningCollapsed')}
                    checked={reasoningCollapsed}
                    onChange={setReasoningCollapsed}
                />
                <SettingsChoiceGroup
                    label={t('settings.chat.disclosureDuration')}
                    value={disclosureDuration}
                    options={DISCLOSURE_DURATIONS.map(value => ({
                        value,
                        label: value === 0 ? t('settings.chat.disclosureDuration.off') : t('settings.chat.disclosureDuration.ms', { ms: value }),
                    }))}
                    onChange={setDisclosureDuration}
                    columns={4}
                />
            </SettingsSection>
            <SettingsSection title={t('settings.chat.colors')}>
                <ChatSurfaceColorControl label={t('settings.chat.groupedToolBackground')} preference={toolGroupBackground} onPresetChange={(preset) => setToolGroupBackground(toPresetChatSurfaceColorPreference(preset))} onCustomChange={(value) => setToolGroupBackground(toCustomChatSurfaceColorPreference(value))} />
                <ChatSurfaceColorControl label={t('settings.chat.userMessageBackground')} preference={userMessageBackground} onPresetChange={(preset) => setUserMessageBackground(toPresetChatSurfaceColorPreference(preset))} onCustomChange={(value) => setUserMessageBackground(toCustomChatSurfaceColorPreference(value))} />
            </SettingsSection>
        </SettingsPageContent>
    )
}
