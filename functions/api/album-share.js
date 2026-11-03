import { albumResponse, sharedAlbum, listAlbumImages } from '../utils/albums.js';
import { fetchSecurityConfig } from '../utils/sysConfig.js';
import { recordAlbumVisit } from '../utils/albumVisits.js';

export async function onRequest(context) {
    const { request, env } = context;
    if (request.method !== 'GET') return albumResponse({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor.length > 2048) return albumResponse({ error: 'Invalid cursor' }, 400);
    try {
        const album = await sharedAlbum(env, url.searchParams.get('share'), true);
        if (!album) return albumResponse({ error: 'Album not found or sharing disabled' }, 404);
        if (album.state === 'expired') return albumResponse({ error: 'Share expired', code: 'expired' }, 410);
        if (album.state !== 'active') return albumResponse({ error: 'Sharing unavailable', code: album.state }, 404);
        const security = await fetchSecurityConfig(env);
        const page = await listAlbumImages(env, album, cursor, security.access?.whiteListMode);
        if (album.recordIp && !cursor) {
            const recording = recordAlbumVisit(context, album).catch(() => console.error('Album visit recording failed'));
            if (context.waitUntil) context.waitUntil(recording);
            else await recording;
        }
        return albumResponse({ name: album.name, createdAt: album.createdAt, expiresAt: album.expiresAt, ...page });
    } catch (error) {
        console.error('Album listing failed', error);
        return albumResponse({ error: 'Album service unavailable' }, 503);
    }
}
