/** Extract common source locations without treating a Windows drive as a line. */
export function parseFileReferenceLocation(value: string): { path: string; line?: number } {
    let decoded = value
    try { decoded = decodeURIComponent(value) } catch { /* Preserve literal paths. */ }
    const match = /^(.*?)(?::([1-9]\d*)(?::\d+)?|#L?([1-9]\d*)(?:C\d+)?(?:-L?\d+)?)$/.exec(decoded)
    if (!match) return { path: decoded }
    const line = Number(match[2] ?? match[3])
    return Number.isSafeInteger(line) ? { path: match[1], line } : { path: decoded }
}
