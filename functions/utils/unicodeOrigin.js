import punycode from 'punycode/punycode.js';

// Format after parsing: URL.href would re-encode the Unicode hostname.
export function unicodeOrigin(origin) {
    try {
        const url = new URL(origin);
        if (!['http:', 'https:'].includes(url.protocol)) return origin;
        return `${url.protocol}//${punycode.toUnicode(url.hostname)}${url.port ? `:${url.port}` : ''}`;
    } catch {
        return origin;
    }
}
