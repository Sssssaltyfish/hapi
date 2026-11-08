import { expect, it } from 'vitest'
import { encodeWidgetState, readVisualizationMessage, VISUALIZATION_CHANNEL } from './bridge'

it('requires the iframe WindowProxy and the assigned bridge id', () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    try {
        const source = iframe.contentWindow!
        const data = { channel: VISUALIZATION_CHANNEL, bridgeId: 'expected', type: 'followup' }
        const event = (sender: Window, payload = data) => new MessageEvent('message', { source: sender, data: payload })
        expect(readVisualizationMessage(event(window), source, 'expected')).toBeNull()
        expect(readVisualizationMessage(event(source, { ...data, bridgeId: 'other' }), source, 'expected')).toBeNull()
        expect(readVisualizationMessage(event(source), source, 'expected')).toEqual(data)
    } finally {
        iframe.remove()
    }
})

it('normalizes omitted state fields and rejects non-JSON or oversized state', () => {
    expect(encodeWidgetState({ modelContent: { count: 2 } })).toBe('{"modelContent":{"count":2},"privateContent":null}')
    expect(encodeWidgetState({ modelContent: new Map([['count', 2]]) })).toBeNull()
    expect(encodeWidgetState({ privateContent: '汉'.repeat(5500) })).toBeNull()
})
