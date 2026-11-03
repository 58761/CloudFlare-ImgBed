import { getDatabase } from './databaseAdapter.js';

export const ALBUM_POLICY_KEY = 'manage@sysConfig@albumShare';
const UPGRADE_KEY = 'manage@albumShareUpgrade';
export const DAY = 86400000;

// A finite duration only. Permanent shares are an explicit administrator operation.
export function albumDuration(value) {
    const match = typeof value === 'string' && /^([1-9]\d{0,5})(m|h|d)$/.exec(value);
    if (!match) throw new Error('Use a positive duration such as 1h or 3d (maximum 365d)');
    const ms = Number(match[1]) * { m: 60000, h: 3600000, d: DAY }[match[2]];
    if (ms > 365 * DAY) throw new Error('Maximum share duration is 365d');
    return ms;
}

export async function getAlbumPolicy(env) {
    const db = getDatabase(env);
    let upgradedAt = Number(await db.get(UPGRADE_KEY));
    if (!upgradedAt) {
        const now = Date.now();
        if (!env.img_url && env.img_d1) {
            // All concurrent requests use the same upgrade epoch; never extend it on restart.
            await env.img_d1.prepare('INSERT OR IGNORE INTO settings (key, value, category) VALUES (?, ?, ?)')
                .bind(UPGRADE_KEY, String(now), 'albumShare').run();
        } else {
            await db.put(UPGRADE_KEY, String(now));
        }
        upgradedAt = Number(await db.get(UPGRADE_KEY));
        if (!upgradedAt) throw new Error('Cannot initialize album share upgrade');
    }
    const stored = JSON.parse(await db.get(ALBUM_POLICY_KEY) || '{}');
    const policy = { enabled: true, defaultExpire: '3d', recordIp: false, ...stored, upgradedAt };
    albumDuration(policy.defaultExpire);
    return policy;
}

export function validateAlbumPolicy(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || typeof body.enabled !== 'boolean' || typeof body.recordIp !== 'boolean') {
        throw new Error('Invalid sharing settings');
    }
    albumDuration(body.defaultExpire);
    return { enabled: body.enabled, defaultExpire: body.defaultExpire, recordIp: body.recordIp };
}

export function effectiveAlbum(album, policy) {
    return { ...album, expiresAt: album.expiresAt === undefined ? policy.upgradedAt + 3 * DAY : album.expiresAt };
}

export function albumState(album, policy, now = Date.now()) {
    if (!policy.enabled) return 'paused';
    if (album.adminDisabled || !album.enabled) return 'disabled';
    if (album.expiresAt !== null && album.expiresAt <= now) return 'expired';
    return 'active';
}
