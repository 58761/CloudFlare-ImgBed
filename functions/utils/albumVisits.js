import { getDatabase } from './databaseAdapter.js';
import { DAY } from './albumPolicy.js';

const PREFIX = 'manage@albumVisit@';

// KV expires records natively; D1 reuses settings and is swept by the scheduled job.
export async function cleanupAlbumVisits(env, now = Date.now()) {
    if (!env.img_url && env.img_d1) {
        await env.img_d1.prepare("DELETE FROM settings WHERE key GLOB 'manage@albumVisit@*' AND json_extract(value, '$.lastVisitedAt') <= ?")
            .bind(now - DAY).run();
    }
}

function visitorIp(context) {
    const { request, env } = context;
    // The Node adapter injects a socket-derived address into this private header.
    const ip = env.SERVER_RUNTIME === 'node'
        ? request.headers.get('x-album-client-ip')
        : request.headers.get('CF-Connecting-IP');
    if (!ip || ip.length > 45 || !/^[0-9a-fA-F:.]+$/.test(ip)) return null;
    return ip.toLowerCase();
}

export async function recordAlbumVisit(context, album, now = Date.now()) {
    const ip = visitorIp(context);
    if (!ip) return;
    const db = getDatabase(context.env);
    const key = `${PREFIX}${album.id}@${ip}`;
    const value = JSON.stringify({ ip, lastVisitedAt: now });
    if (!context.env.img_url && context.env.img_d1) {
        // Concurrent writes must not move the last-visit timestamp backwards.
        await context.env.img_d1.prepare(`INSERT INTO settings (key, value, category) VALUES (?, ?, 'albumVisit')
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
            WHERE json_extract(excluded.value, '$.lastVisitedAt') > json_extract(settings.value, '$.lastVisitedAt')`)
            .bind(key, value).run();
        await cleanupAlbumVisits(context.env, now);
    } else {
        await db.put(key, value, { expirationTtl: DAY / 1000, metadata: { ip, lastVisitedAt: now } });
    }
}

export async function listAlbumVisits(env, id, cursor = '', now = Date.now()) {
    await cleanupAlbumVisits(env, now);
    const db = getDatabase(env);
    const page = await db.list({ prefix: `${PREFIX}${id}@`, limit: 50, cursor: cursor || undefined });
    const visits = [];
    for (const item of page.keys) {
        // KV list metadata avoids one KV read per visitor on this admin page.
        const raw = item.value ?? (item.metadata?.lastVisitedAt
            ? JSON.stringify(item.metadata) : await db.get(item.name));
        if (!raw) continue;
        const visit = JSON.parse(raw);
        if (visit.lastVisitedAt > now - DAY) visits.push(visit);
    }
    return { visits, cursor: page.list_complete ? null : page.cursor };
}
