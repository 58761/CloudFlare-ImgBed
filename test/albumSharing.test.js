import assert from 'node:assert/strict';
import { memoryDatabase, loadFunction } from './helpers/loadFunction.js';
import { sqliteDatabase } from './helpers/database.js';
import * as albums from '../functions/utils/albums.js';
import * as policy from '../functions/utils/albumPolicy.js';
import * as visits from '../functions/utils/albumVisits.js';
import { onRequest as admin } from '../functions/api/manage/album-shares.js';

describe('folder share expiry and visitor retention', () => {
    let env, user, publicApi;
    beforeEach(async () => {
        env = { img_url: memoryDatabase(), img_r2: {} };
        user = await loadFunction('functions/api/albums.js', { ...albums, ...policy, userAuthCheck: async () => true });
        publicApi = await loadFunction('functions/api/album-share.js', { ...albums, ...visits, fetchSecurityConfig: async () => ({ access: {} }) });
    });
    const headers = value => ({ 'X-Album-Id': value.album.id, 'X-Album-Key': value.manageKey });
    const req = (path, method = 'GET', body, extra = {}) => new Request('https://test' + path, {
        method, headers: extra, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const settings = (changes = {}) => admin({ env, request: req('/api/manage/album-shares?action=settings', 'PATCH', {
        enabled: true, defaultExpire: '3d', recordIp: false, ...changes,
    }) });
    const update = (album, changes) => admin({ env, request: req('/api/manage/album-shares', 'PATCH', { id: album.id, ...changes }) });
    const listing = (album, suffix = '', extra = {}) => publicApi.onRequest({ env, request: req(`/api/album-share?share=${album.id}.${album.shareKey}${suffix}`, 'GET', undefined, extra) });

    it('uses 72h by default; configured defaults affect only future shares', async () => {
        const a = await albums.createAlbum(env);
        assert.equal(a.album.expiresAt - a.album.createdAt, 3 * policy.DAY);
        assert.equal((await settings({ defaultExpire: '7d' })).status, 200);
        const b = await albums.createAlbum(env);
        const c = await albums.createAlbum(env, '', '90m');
        assert.equal(b.album.expiresAt - b.album.createdAt, 7 * policy.DAY);
        assert.equal(c.album.expiresAt - c.album.createdAt, 90 * 60000);
        assert.equal((await albums.readAlbum(env, a.album.id)).expiresAt, a.album.expiresAt);
    });
    it('rejects invalid and permanent durations from users and global defaults', async () => {
        for (const expire of ['forever', '0d', '-1d', '1.5d', '366d', null, 3, '1e5d', '']) {
            assert.equal((await user.onRequest({ env, request: req('/api/albums', 'POST', { expire }) })).status, 400, String(expire));
        }
        assert.equal((await settings({ defaultExpire: 'forever' })).status, 400);
        assert.equal((await settings({ recordIp: 'true' })).status, 400);
    });
    it('enforces expiry exactly at the boundary, including pagination, without touching files', async () => {
        const { album } = await albums.createAlbum(env);
        const file = album.directory + 'photo.png';
        await env.img_url.put(file, 'image');
        album.expiresAt = Date.now(); await albums.saveAlbum(env, album);
        assert.equal(policy.albumState(album, { enabled: true }, album.expiresAt), 'expired');
        assert.equal((await listing(album)).status, 410);
        assert.equal((await listing(album, '&cursor=next')).status, 410);
        assert.equal(await env.img_url.get(file), 'image');
    });
    it('pauses all shares without resetting lifetime, and keeps administrator revocation independent', async () => {
        const value = await albums.createAlbum(env), { album } = value;
        await settings({ enabled: false });
        assert.equal((await listing(album)).status, 404);
        await settings();
        assert.equal((await listing(album)).status, 200);
        await update(album, { adminDisabled: true });
        assert.equal((await listing(album)).status, 404);
        const response = await user.onRequest({ env, request: req('/api/albums', 'PATCH', { enabled: true }, headers(value)) });
        assert.equal(response.status, 403);
        await update(album, { adminDisabled: false });
        assert.equal((await listing(album)).status, 200);
        assert.equal((await albums.readAlbum(env, album.id)).expiresAt, album.expiresAt);
    });
    it('only administrators can renew or grant permanent access; rotation never renews', async () => {
        const value = await albums.createAlbum(env), { album } = value;
        for (const body of [{ expire: '3d' }, { expiresAt: null }, { adminDisabled: false }]) {
            assert.equal((await user.onRequest({ env, request: req('/api/albums', 'PATCH', body, headers(value)) })).status, 403);
        }
        const rotated = await user.onRequest({ env, request: req('/api/albums', 'PATCH', { rotate: true }, headers(value)) });
        assert.equal((await rotated.json()).expiresAt, album.expiresAt);
        await update(album, { expire: 'forever' });
        assert.equal((await albums.readAlbum(env, album.id)).expiresAt, null);
        const before = Date.now(); await update(album, { expire: '1h' });
        assert.ok((await albums.readAlbum(env, album.id)).expiresAt >= before + 3600000);
    });
    it('does not allow a stale owner write to undo administrator revocation or renewal', async () => {
        const { album } = await albums.createAlbum(env);
        const stale = { ...album, name: 'Concurrent rename' };
        await update(album, { adminDisabled: true, expire: '1h' });
        const controlled = await albums.readAlbum(env, album.id);
        await albums.saveAlbum(env, stale);
        const current = await albums.readAlbum(env, album.id);
        assert.equal(current.adminDisabled, true);
        assert.equal(current.expiresAt, controlled.expiresAt);
        assert.equal((await listing(album)).status, 404);
    });
    it('uses a single persisted upgrade epoch for all legacy folders, unaffected by later settings', async () => {
        const a = (await albums.createAlbum(env)).album, b = (await albums.createAlbum(env)).album;
        delete a.expiresAt; delete b.expiresAt;
        await albums.saveAlbum(env, a); await albums.saveAlbum(env, b);
        const epoch = (await policy.getAlbumPolicy(env)).upgradedAt;
        await settings({ defaultExpire: '30d' });
        assert.equal((await albums.readAlbum(env, a.id)).expiresAt, epoch + 3 * policy.DAY);
        assert.equal((await albums.readAlbum(env, b.id)).expiresAt, epoch + 3 * policy.DAY);
        assert.equal((await policy.getAlbumPolicy(env)).upgradedAt, epoch);
    });
    it('records only successful first-page visits when enabled; off and pagination produce no records', async () => {
        const { album } = await albums.createAlbum(env);
        const ipHeaders = { 'CF-Connecting-IP': '203.0.113.7' };
        await listing(album, '', ipHeaders);
        assert.equal((await visits.listAlbumVisits(env, album.id)).visits.length, 0);
        await settings({ recordIp: true });
        await listing(album, '&cursor=next', ipHeaders);
        assert.equal((await visits.listAlbumVisits(env, album.id)).visits.length, 0);
        await listing(album, '', ipHeaders); await listing(album, '', ipHeaders);
        assert.equal((await visits.listAlbumVisits(env, album.id)).visits.length, 1);
        await settings();
        await listing(album, '', { 'CF-Connecting-IP': '203.0.113.8' });
        assert.equal((await visits.listAlbumVisits(env, album.id)).visits.length, 1);
        await update(album, { adminDisabled: true }); await settings({ recordIp: true });
        await listing(album, '', { 'CF-Connecting-IP': '203.0.113.9' });
        assert.equal((await visits.listAlbumVisits(env, album.id)).visits.length, 1);
        const publicBody = await (await listing(album)).text();
        assert.ok(!publicBody.includes('203.0.113'));
    });
    it('uses KV TTL and hides records at exactly 24h; ignores untrusted forwarded headers', async () => {
        const { album } = await albums.createAlbum(env);
        const originalPut = env.img_url.put; let ttl;
        env.img_url.put = async (key, value, options) => { ttl = options.expirationTtl; await originalPut(key, value, options); };
        const now = Date.now();
        await visits.recordAlbumVisit({ env, request: req('/', 'GET', undefined, { 'CF-Connecting-IP': '2001:db8::1' }) }, album, now);
        assert.equal(ttl, 86400);
        assert.equal((await visits.listAlbumVisits(env, album.id, '', now + policy.DAY - 1)).visits.length, 1);
        assert.equal((await visits.listAlbumVisits(env, album.id, '', now + policy.DAY)).visits.length, 0);
        await visits.recordAlbumVisit({ env: { ...env, SERVER_RUNTIME: 'node' }, request: req('/', 'GET', undefined, { 'X-Forwarded-For': '203.0.113.9', 'CF-Connecting-IP': '203.0.113.9' }) }, album, now);
        assert.equal((await visits.listAlbumVisits(env, album.id)).visits.length, 1);
    });
    it('does not break sharing when visitor storage fails', async () => {
        const { album } = await albums.createAlbum(env); await settings({ recordIp: true });
        const put = env.img_url.put;
        env.img_url.put = async (key, ...args) => { if (key.startsWith('manage@albumVisit@')) throw new Error('offline'); return put(key, ...args); };
        assert.equal((await listing(album, '', { 'CF-Connecting-IP': '203.0.113.1' })).status, 200);
    });
    it('paginates administrative shares and visits with D1; cleans expired records without new visits', async () => {
        const { sqlite, db } = await sqliteDatabase();
        try {
            env = { img_d1: sqlite };
            const epochs = await Promise.all(Array.from({ length: 5 }, () => policy.getAlbumPolicy(env)));
            assert.equal(new Set(epochs.map(p => p.upgradedAt)).size, 1);
            let firstAlbum;
            for (let i = 0; i < 32; i++) {
                const { album } = await albums.createAlbum(env); firstAlbum ||= album;
            }
            const page = await (await admin({ env, request: req('/api/manage/album-shares') })).json();
            assert.equal(page.albums.length, 20); assert.ok(page.cursor);
            const next = await (await admin({ env, request: req('/api/manage/album-shares?cursor=' + encodeURIComponent(page.cursor)) })).json();
            assert.equal(next.albums.length, 12);
            assert.ok(!JSON.stringify(page).includes('manageKey'));
            const now = Date.now();
            for (let i = 0; i < 52; i++) {
                await visits.recordAlbumVisit({ env, request: req('/', 'GET', undefined, { 'CF-Connecting-IP': `203.0.113.${i}` }) }, firstAlbum, now);
            }
            const first = await visits.listAlbumVisits(env, firstAlbum.id, '', now);
            const last = await visits.listAlbumVisits(env, firstAlbum.id, first.cursor, now);
            assert.deepEqual([first.visits.length, last.visits.length], [50, 2]);
            const context = { env, request: req('/', 'GET', undefined, { 'CF-Connecting-IP': '203.0.113.1' }) };
            await visits.recordAlbumVisit(context, firstAlbum, now + 100);
            await visits.recordAlbumVisit(context, firstAlbum, now);
            assert.equal(JSON.parse(await db.get(`manage@albumVisit@${firstAlbum.id}@203.0.113.1`)).lastVisitedAt, now + 100);
            await visits.cleanupAlbumVisits(env, now + policy.DAY);
            assert.equal((await db.list({ prefix: 'manage@albumVisit@' })).keys.length, 1);
            await visits.cleanupAlbumVisits(env, now + policy.DAY + 100);
            assert.equal((await db.list({ prefix: 'manage@albumVisit@' })).keys.length, 0);
            assert.ok(await albums.readAlbum(env, firstAlbum.id));
        } finally { sqlite.db.close(); }
    });
});
