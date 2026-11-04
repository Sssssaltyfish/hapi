/** HAPI adapter extension; the upstream DSH ACP protocol remains serial. */
export const DSH_STEERING_CAPABILITY = 'hapi.dshSteering'
export const DSH_STEERING_METHOD = '_hapi/dsh/steer'

export function hasDshSteeringCapability(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false
    const capability = value as Record<string, unknown>
    return capability.version === 1 && capability.method === DSH_STEERING_METHOD
}

export function isDshSteerReceipt(value: unknown, requestId: string): boolean {
    if (!value || typeof value !== 'object') return false
    const receipt = value as Record<string, unknown>
    return receipt.accepted === true && receipt.requestId === requestId
        && receipt.delivery === 'native-steer'
}
