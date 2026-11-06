// If-None-Match uses weak comparison for GET requests.
export function ifNoneMatchMatches(header: string | undefined, etag: string): boolean {
    if (!header) return false
    const normalized = etag.replace(/^W\//, '')
    return header.split(',').some((candidate) => {
        const trimmed = candidate.trim()
        return trimmed === '*' || trimmed.replace(/^W\//, '') === normalized
    })
}
