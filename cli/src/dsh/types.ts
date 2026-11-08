import type { QueuedSkillReference } from '@/utils/queuedSkillReference'

export type DshMode = {
    /** Local queue ownership; a same-name project command must bypass native dispatch. */
    customSlash?: true
    /** Explicit skill reference in one isolated, attachment-formatted prompt. */
    skillReference?: QueuedSkillReference
    /** Opaque ACP config-option value (dsh: JSON-encoded provider+model tuple).
     * null = explicit reset to the server default ("Default" in the picker);
     * undefined = no preference (keep whatever the backend is running). */
    model?: string | null
    /** Exact runtime option values captured when this message was queued. */
    configOptions?: Record<string, string>
}

/** Mode attached to an outgoing turn. The session preference is three-state:
 *  undefined = nothing requested yet (ordinary turns carry no model field at
 *  all), null = the picker's explicit "Default" reset, string = a concrete
 *  model. Collapsing undefined into null would make every ordinary turn look
 *  like a reset request when no model is known. */
export function dshModeForPreference(model: string | null | undefined, configOptions?: Record<string, string>): DshMode {
    return { ...(model === undefined ? {} : { model }), ...(configOptions ? { configOptions: { ...configOptions } } : {}) }
}
