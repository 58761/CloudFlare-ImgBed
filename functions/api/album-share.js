import { albumResponse, sharedAlbum, listAlbumImages } from '../utils/albums.js';
import { fetchSecurityConfig } from '../utils/sysConfig.js';

export async function onRequest({ request, env }) {
    if (request.method !== 'GET') return albumResponse({ error: 'Method not allowed' }, 405);
    const url = new URL(request.url);
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor.length > 2048) return albumResponse({ error: 'Invalid cursor' }, 400);
    try {
        const album = await sharedAlbum(env, url.searchParams.get('share'));
        if (!album) return albumResponse({ error: 'Album not found or sharing disabled' }, 404);
        const security = await fetchSecurityConfig(env);
        const page = await listAlbumImages(env, album, cursor, security.access?.whiteListMode);
        return albumResponse({ name: album.name, createdAt: album.createdAt, ...page });
    } catch (error) {
        console.error('Album listing failed', error);
        return albumResponse({ error: 'Album service unavailable' }, 503);
    }
}
