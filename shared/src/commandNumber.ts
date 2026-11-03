/** Format command metrics without losing precision from decimal-string inputs. */
export function commandNumber(value: string | number, options: { prefix?: string; suffix?: string; locale?: string } = {}): string {
    const raw = String(value)
    if (!/^[+-]?\d+(?:\.\d*)?(?:e[+-]?\d+)?$/i.test(raw)) return raw
    const formatter = new Intl.NumberFormat(options.locale, { maximumFractionDigits: 2 })
    // ECMA-402 accepts exact decimal strings; TypeScript still declares number | bigint.
    const format = (input: string | number) => formatter.format(input as number)
    const prefix = options.prefix ?? ''
    const suffix = options.suffix ?? ''
    const amount = (input: string | number) => `${prefix}${format(input)}${suffix}`
    const nonzero = /[1-9]/.test(raw.split(/[eE]/)[0])
    if (nonzero && Math.abs(Number(raw)) < 0.01) {
        return raw.startsWith('-') ? `−${amount(0.01)} < x < ${amount(0)}` : `<${amount(0.01)}`
    }
    return amount(nonzero ? raw : 0)
}
