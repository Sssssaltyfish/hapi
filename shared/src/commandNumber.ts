/** Format command metrics without losing precision from decimal-string inputs. */
export function commandNumber(value: string | number, options: { prefix?: string; suffix?: string; locale?: string } = {}): string {
    const raw = String(value)
    const parts = /^[+-]?(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(raw)
    if (!parts) return raw
    const formatter = new Intl.NumberFormat(options.locale, { maximumFractionDigits: 2 })
    // ECMA-402 accepts exact decimal strings; TypeScript still declares number | bigint.
    const format = (input: string | number) => formatter.format(input as number)
    const prefix = options.prefix ?? ''
    const suffix = options.suffix ?? ''
    const amount = (input: string | number) => `${prefix}${format(input)}${suffix}`
    // Compare the first significant digit's decimal place before rounding.
    const first = (parts[1] + (parts[2] ?? '')).search(/[1-9]/)
    const nonzero = first >= 0
    if (nonzero && parts[1].length - first + Number(parts[3] ?? 0) < -1) {
        return raw.startsWith('-') ? `−${amount(0.01)} < x < ${amount(0)}` : `<${amount(0.01)}`
    }
    return amount(nonzero ? raw : 0)
}
