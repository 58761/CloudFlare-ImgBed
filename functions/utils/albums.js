import { getDatabase } from './databaseAdapter.js';
import { isExpired } from './fileExpiryHelpers.js';
import { getFileTypeCategory, resolveFileType } from './mimeTypes.js';
import { unicodeOrigin } from './unicodeOrigin.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const recordKey = id => `manage@album@${id}`;

export function albumResponse(body, status = 200) {
    return Response.json(body, { status, headers: {
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
    } });
}

export async function hashAlbumKey(key) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function readAlbum(env, id) {
    if (!UUID.test(id || '')) return null;
    const value = await getDatabase(env).get(recordKey(id));
    return value ? JSON.parse(value) : null;
}

export async function saveAlbum(env, album) {
    await getDatabase(env).put(recordKey(album.id), JSON.stringify(album));
}

export function albumView(album, origin) {
    return {
        id: album.id, name: album.name, directory: album.directory,
        createdAt: album.createdAt, enabled: album.enabled,
        shareUrl: `${unicodeOrigin(origin)}/album/${album.id}.${album.shareKey}`,
    };
}

export async function createAlbum(env, name = '') {
    const id = crypto.randomUUID();
    const manageKey = crypto.randomUUID();
    const createdAt = Date.now();
    const day = new Date(createdAt).toISOString().slice(0, 10);
    const album = {
        id, name: name.trim() || day, createdAt,
        directory: `albums/${day}-${id}/`,
        shareKey: crypto.randomUUID(), enabled: true,
        manageKeyHash: await hashAlbumKey(manageKey),
    };
    await saveAlbum(env, album);
    return { album, manageKey };
}

export async function ownedAlbum(env, request) {
    const album = await readAlbum(env, request.headers.get('X-Album-Id'));
    const key = request.headers.get('X-Album-Key') || '';
    if (!album || !UUID.test(key) || await hashAlbumKey(key) !== album.manageKeyHash) return null;
    return album;
}

export async function sharedAlbum(env, share) {
    const parts = (share || '').split('.');
    if (parts.length !== 2 || !UUID.test(parts[1])) return null;
    const album = await readAlbum(env, parts[0]);
    return album?.enabled && album.shareKey === parts[1] ? album : null;
}

// Called only after the normal upload authentication and blocked-IP checks.
export async function prepareAlbumUpload(context) {
    const album = await ownedAlbum(context.env, context.request);
    if (!album) return albumResponse({ error: 'Album not found or invalid management key' }, 403);
    context.album = album;
    context.url.searchParams.set('uploadFolder', album.directory);
    context.url.searchParams.set('uploadChannel', 'cfr2');
    context.url.searchParams.set('autoRetry', 'false');
    context.url.searchParams.set('uploadNameType', 'default');
    context.url.searchParams.delete('channelName');
    return null;
}

export function isAlbumImage(metadata, whiteListMode = false) {
    return getFileTypeCategory(resolveFileType(metadata.FileName, metadata.FileType)) === 'image'
        && !isExpired(metadata)
        && metadata.ListType !== 'Block'
        && (metadata.ListType === 'White' || (!whiteListMode && metadata.Label !== 'adult'));
}

// Read file records directly: no shared manifest updates during concurrent uploads,
// no dependence on a delayed index merge, and a bounded database page per request.
export async function listAlbumImages(env, album, cursor, whiteListMode) {
    const page = await getDatabase(env).list({ prefix: album.directory, limit: 60, cursor: cursor || undefined });
    const files = (page.keys || []).filter(({ name, metadata = {} }) =>
        name.startsWith(album.directory) && metadata.Directory === album.directory && isAlbumImage(metadata, whiteListMode)
    ).map(({ name, metadata }) => ({
        id: name, name: metadata.FileName,
        url: `/file/${name.split('/').map(encodeURIComponent).join('/')}`,
        width: metadata.Width, height: metadata.Height,
    }));
    return { files, cursor: page.list_complete ? null : (page.cursor || null) };
}
