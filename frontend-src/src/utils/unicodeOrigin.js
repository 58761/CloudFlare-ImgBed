import punycode from 'punycode/punycode.js'

// Do not pass the result through URL.href again: it re-encodes IDN hostnames.
export function unicodeOrigin(origin) {
    try {
        const url = new URL(origin)
        if (!['http:', 'https:'].includes(url.protocol)) return origin
        return `${url.protocol}//${punycode.toUnicode(url.hostname)}${url.port ? `:${url.port}` : ''}`
    } catch {
        return origin
    }
}
