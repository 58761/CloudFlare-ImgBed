import { userAuthCheck } from '../utils/auth/userAuth.js';
import { albumResponse, albumView, createAlbum, ownedAlbum, saveAlbum } from '../utils/albums.js';

export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);
    if (!['GET', 'POST', 'PATCH'].includes(request.method)) {
        return albumResponse({ error: 'Method not allowed' }, 405);
    }
    if (!await userAuthCheck(env, url, request, 'upload')) {
        return albumResponse({ error: 'Upload authentication required' }, 401);
    }
    try {
        let body = {};
        if (request.method !== 'GET') {
            const text = await request.text();
            if (text.length > 2048) return albumResponse({ error: 'Request too large' }, 413);
            try { body = JSON.parse(text); } catch { return albumResponse({ error: 'Invalid JSON' }, 400); }
            if (!body || typeof body !== 'object' || Array.isArray(body)) return albumResponse({ error: 'Invalid body' }, 400);
            if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim().length > 120)) {
                return albumResponse({ error: 'Name must be at most 120 characters' }, 400);
            }
        }
        if (request.method === 'POST') {
            if (!env.img_r2) return albumResponse({ error: 'R2 binding img_r2 is required' }, 503);
            const { album, manageKey } = await createAlbum(env, body.name);
            return albumResponse({ ...albumView(album, url.origin), manageKey }, 201);
        }
        const album = await ownedAlbum(env, request);
        if (!album) return albumResponse({ error: 'Album not found or invalid management key' }, 403);
        if (request.method === 'PATCH') {
            if (body.enabled !== undefined && typeof body.enabled !== 'boolean') return albumResponse({ error: 'Invalid enabled value' }, 400);
            if (body.rotate !== undefined && typeof body.rotate !== 'boolean') return albumResponse({ error: 'Invalid rotate value' }, 400);
            if (body.name !== undefined) {
                if (!body.name.trim()) return albumResponse({ error: 'Name cannot be empty' }, 400);
                album.name = body.name.trim();
            }
            if (body.enabled !== undefined) album.enabled = body.enabled;
            if (body.rotate) album.shareKey = crypto.randomUUID();
            await saveAlbum(env, album);
        }
        return albumResponse(albumView(album, url.origin));
    } catch (error) {
        console.error('Album management failed', error);
        return albumResponse({ error: 'Album service unavailable' }, 503);
    }
}
