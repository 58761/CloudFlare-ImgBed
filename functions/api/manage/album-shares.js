import { albumResponse, albumView, readAlbum, saveAlbum } from '../../utils/albums.js';
import { getAlbumPolicy, validateAlbumPolicy, ALBUM_POLICY_KEY, albumDuration, effectiveAlbum, albumState } from '../../utils/albumPolicy.js';
import { listAlbumVisits, cleanupAlbumVisits } from '../../utils/albumVisits.js';
import { getDatabase } from '../../utils/databaseAdapter.js';

// Protected by /api/manage/_middleware.js (ADMIN scope, manage permission).
export async function onRequest({ request, env }) {
    const url = new URL(request.url);
    const db = getDatabase(env);
    const policy = await getAlbumPolicy(env);
    const cursor = url.searchParams.get('cursor') || '';
    if (cursor.length > 2048) return albumResponse({ error: 'Invalid cursor' }, 400);
    if (request.method === 'POST' && url.searchParams.get('action') === 'cleanup') {
        await cleanupAlbumVisits(env);
        return albumResponse({ success: true });
    }
    if (request.method === 'GET') {
        await cleanupAlbumVisits(env);
        if (url.searchParams.get('action') === 'settings') return albumResponse(policy);
        if (url.searchParams.get('action') === 'visits') {
            const album = await readAlbum(env, url.searchParams.get('id'));
            if (!album) return albumResponse({ error: 'Album not found' }, 404);
            return albumResponse(await listAlbumVisits(env, album.id, cursor));
        }
        const page = await db.list({ prefix: 'manage@album@', limit: 20, cursor: cursor || undefined });
        const albums = [];
        for (const item of page.keys) {
            const raw = item.value ?? await db.get(item.name);
            if (!raw) continue;
            const base = JSON.parse(raw);
            const controls = JSON.parse(await db.get(`manage@albumControl@${base.id}`) || '{}');
            const album = effectiveAlbum({ ...base, ...controls }, policy);
            albums.push({ ...albumView(album, url.origin), state: albumState(album, policy) });
        }
        return albumResponse({ albums, cursor: page.list_complete ? null : page.cursor });
    }
    if (request.method !== 'PATCH') return albumResponse({ error: 'Method not allowed' }, 405);
    let body;
    try {
        const text = await request.text();
        if (text.length > 2048) return albumResponse({ error: 'Request too large' }, 413);
        body = JSON.parse(text);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid body');
        if (url.searchParams.get('action') === 'settings') {
            const settings = validateAlbumPolicy(body);
            await db.put(ALBUM_POLICY_KEY, JSON.stringify(settings));
            return albumResponse({ ...settings, upgradedAt: policy.upgradedAt });
        }
        const album = await readAlbum(env, body.id);
        if (!album) return albumResponse({ error: 'Album not found' }, 404);
        if (body.adminDisabled !== undefined) {
            if (typeof body.adminDisabled !== 'boolean') throw new Error('Invalid sharing state');
            album.adminDisabled = body.adminDisabled;
            if (!body.adminDisabled) album.enabled = true;
        }
        if (body.expire !== undefined) {
            album.expiresAt = body.expire === 'forever' ? null : Date.now() + albumDuration(body.expire);
        }
        // Separate administrator controls from owner writes: a concurrent rename/rotation
        // must never overwrite a revocation or restore an old expiry.
        await db.put(`manage@albumControl@${album.id}`, JSON.stringify({
            adminDisabled: !!album.adminDisabled, expiresAt: album.expiresAt,
        }));
        if (body.adminDisabled === false) await saveAlbum(env, album);
        return albumResponse({ ...albumView(album, url.origin), state: albumState(album, policy) });
    } catch (error) {
        return albumResponse({ error: error.message }, 400);
    }
}
