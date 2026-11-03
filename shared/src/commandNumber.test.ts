import { expect, test } from 'bun:test'
import { commandNumber } from './commandNumber'

test('rounds command metrics half up and preserves exact large integers', () => {
    expect(commandNumber('12345678901234567890.9999', { locale: 'en-US' })).toBe('12,345,678,901,234,567,891')
    expect(commandNumber(1.239)).toBe('1.24')
    expect(commandNumber('1.005')).toBe('1.01')
    expect(commandNumber('0.009', { suffix: '%' })).toBe('<0.01%')
    expect(commandNumber('0.00999999999999999999')).toBe('<0.01')
    expect(commandNumber('0.0100')).toBe('0.01')
    expect(commandNumber(1e-8, { prefix: '$' })).toBe('<$0.01')
    expect(commandNumber('0.000', { prefix: '$' })).toBe('$0')
    expect(commandNumber('-0.009')).toBe('−0.01 < x < 0')
    expect(commandNumber('-1.239')).toBe('-1.24')
    expect(commandNumber('1.2e3', { locale: 'en-US' })).toBe('1,200')
    expect(commandNumber('1234.567', { locale: 'de-DE' })).toBe('1.234,57')
    expect(commandNumber('1.239', { locale: 'ru-RU' })).toBe('1,24')
    expect(commandNumber('1e-999', { prefix: '$' })).toBe('<$0.01')
})
