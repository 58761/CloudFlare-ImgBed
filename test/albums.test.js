import assert from 'node:assert/strict';
import { loadFunction, memoryDatabase } from './helpers/loadFunction.js';
import { sqliteDatabase } from './helpers/database.js';
import { albumDuration } from '../functions/utils/albumPolicy.js';
import { recordAlbumVisit } from '../functions/utils/albumVisits.js';
import * as albums from '../functions/utils/albums.js';

describe('image folders', () => {
    it('returns Unicode share domains without changing the album path or port', () => {
        const album = { id: 'id', shareKey: 'key' };
        for (const [origin, expected] of [
            ['https://xn--fsqu00a.xn--0zwm56d', 'https://例子.测试'],
            ['https://photos.xn--fiqs8s:8443', 'https://photos.中国:8443'],
            ['https://例子.测试', 'https://例子.测试'],
            ['http://localhost:8787', 'http://localhost:8787'],
            ['http://[::1]:8787', 'http://[::1]:8787'],
        ]) {
            const link = albums.albumView(album, origin).shareUrl;
            assert.equal(link, `${expected}/album/id.key`);
            assert.equal(new URL(link).origin, new URL(origin).origin);
        }
    });
    let env, manage, publicRoute, authorized;
    beforeEach(async () => {
        env = { img_url: memoryDatabase(), img_r2: {} };
        authorized = true;
        manage = await loadFunction('functions/api/albums.js', {
            ...albums, albumDuration, userAuthCheck: async (_env, _url, _request, permission) => authorized && permission === 'upload',
        });
        publicRoute = await loadFunction('functions/api/album-share.js', {
            ...albums, recordAlbumVisit, fetchSecurityConfig: async () => ({ access: {} }),
        });
    });
    const headers = album => ({ 'X-Album-Id': album.id, 'X-Album-Key': album.manageKey });
    const share = album => new URL(album.shareUrl).pathname.split('/').pop();
    async function request(method, body, extraHeaders = {}) {
        return manage.onRequest({ env, request: new Request('https://images.test/api/albums', {
            method, headers: extraHeaders, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }) });
    }
    async function create() {
        const response = await request('POST', { name: 'Holiday <photos>' });
        assert.equal(response.status, 201);
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
        return response.json();
    }
    async function listing(album, extra = '') {
        return publicRoute.onRequest({ env, request: new Request(`https://images.test/api/album-share?share=${share(album)}${extra}`) });
    }
    async function put(album, name, changes = {}) {
        await env.img_url.put(`${album.directory}${name}`, '', { metadata: {
            Directory: album.directory, FileName: name, FileType: 'image/png', ListType: 'None', ...changes,
        } });
    }

    it('requires upload authentication and an R2 binding to create folders', async () => {
        authorized = false;
        assert.equal((await request('POST', {})).status, 401);
        authorized = true; delete env.img_r2;
        assert.equal((await request('POST', {})).status, 503);
        assert.equal(env.img_url.records.size, 0);
    });
    it('creates independent folders and stores only a hash of the management credential', async () => {
        const [a, b] = await Promise.all([create(), create()]);
        assert.notEqual(a.directory, b.directory);
        assert.notEqual(a.shareUrl, b.shareUrl);
        const stored = await albums.readAlbum(env, a.id);
        assert.ok(stored.manageKeyHash);
        assert.ok(!JSON.stringify(stored).includes(a.manageKey));
        assert.equal((await request('GET', undefined, headers(a))).status, 200);
    });
    it('rejects invalid JSON, names, state types and unsupported methods', async () => {
        assert.equal((await request('POST', { name: 'a'.repeat(121) })).status, 400);
        assert.equal((await request('POST', [])).status, 400);
        const a = await create();
        assert.equal((await request('PATCH', { enabled: 'false' }, headers(a))).status, 400);
        assert.equal((await request('PATCH', { name: '' }, headers(a))).status, 400);
        assert.equal((await request('DELETE')).status, 405);
        const response = await manage.onRequest({ env, request: new Request('https://images.test/api/albums', { method: 'POST', body: '{' }) });
        assert.equal(response.status, 400);
    });
    it('does not let a share credential or another folder key manage a folder', async () => {
        const a = await create(), b = await create();
        for (const key of [share(a).split('.')[1], b.manageKey, '']) {
            assert.equal((await request('PATCH', { enabled: false }, { ...headers(a), 'X-Album-Key': key })).status, 403);
        }
        assert.equal((await listing(a)).status, 200);
    });
    it('renames, revokes, re-enables and rotates shares without changing directory or files', async () => {
        const a = await create(); await put(a, 'photo.png');
        await request('PATCH', { name: 'New name', enabled: false }, headers(a));
        assert.equal((await listing(a)).status, 404);
        const enabled = await (await request('PATCH', { enabled: true }, headers(a))).json();
        assert.equal((await (await listing(enabled)).json()).files.length, 1);
        const rotated = await (await request('PATCH', { rotate: true }, headers(a))).json();
        assert.equal(rotated.directory, a.directory);
        assert.equal(rotated.name, 'New name');
        assert.equal((await listing(a)).status, 404);
        assert.equal((await listing(rotated)).status, 200);
    });
    it('limits anonymous listings to the shared directory and never leaks private metadata', async () => {
        const a = await create(), b = await create();
        await put(a, 'photo.png', { UploadIP: 'private', TgBotToken: 'secret' });
        await put(b, 'other.png');
        await put(a, 'blocked.png', { ListType: 'Block' });
        await put(a, 'adult.png', { Label: 'adult' });
        await put(a, 'expired.png', { ExpiresAt: Date.now() - 1000 });
        await put(a, 'document.pdf', { FileType: 'application/pdf' });
        await put(a, 'nested/photo.png', { Directory: a.directory + 'nested/' });
        const response = await listing(a, '&dir=' + encodeURIComponent(b.directory));
        const data = await response.json();
        assert.equal(data.files.length, 1);
        assert.equal(data.files[0].name, 'photo.png');
        assert.ok(!JSON.stringify(data).includes('secret'));
        assert.ok(!JSON.stringify(data).includes(a.manageKey));
        assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
        await env.img_url.delete(a.directory + 'photo.png');
        assert.equal((await (await listing(a)).json()).files.length, 0);
    });
    it('respects whitelist mode and encodes image URLs', async () => {
        const a = await create();
        await put(a, '普通图.png'); await put(a, 'white #?.png', { ListType: 'White', Label: 'adult' });
        const page = await albums.listAlbumImages(env, a, '', true);
        assert.equal(page.files.length, 1);
        assert.ok(page.files[0].url.endsWith('white%20%23%3F.png'));
    });
    it('overrides user-supplied folder and fallback channel only for authenticated album uploads', async () => {
        const a = await create();
        const context = { env, request: new Request('https://images.test/upload', { headers: headers(a) }), url: new URL('https://images.test/upload?uploadFolder=elsewhere&uploadChannel=telegram&autoRetry=true') };
        assert.equal(await albums.prepareAlbumUpload(context), null);
        assert.equal(context.url.searchParams.get('uploadFolder'), a.directory);
        assert.equal(context.url.searchParams.get('uploadChannel'), 'cfr2');
        assert.equal(context.url.searchParams.get('autoRetry'), 'false');
        context.request = new Request('https://images.test/upload', { headers: { ...headers(a), 'X-Album-Key': crypto.randomUUID() } });
        assert.equal((await albums.prepareAlbumUpload(context)).status, 403);
    });
    it('supports D1 settings storage and bounded cursor pagination with the real database adapter', async () => {
        const { sqlite, db } = await sqliteDatabase();
        try {
            const d1env = { img_d1: sqlite };
            const { album } = await albums.createAlbum(d1env, 'D1');
            for (let i = 0; i < 125; i++) {
                await db.put(`${album.directory}${String(i).padStart(3, '0')}.png`, '', { metadata: { Directory: album.directory, FileName: `${i}.png`, FileType: 'image/png' } });
            }
            assert.equal((await albums.readAlbum(d1env, album.id)).name, 'D1');
            const first = await albums.listAlbumImages(d1env, album, '', false);
            const second = await albums.listAlbumImages(d1env, album, first.cursor, false);
            const third = await albums.listAlbumImages(d1env, album, second.cursor, false);
            assert.deepEqual([first.files.length, second.files.length, third.files.length], [60, 60, 5]);
            assert.equal(third.cursor, null);
            assert.equal(new Set([...first.files, ...second.files, ...third.files].map(f => f.id)).size, 125);
            await db.put('literal_%/photo.png', '', { metadata: {} });
            await db.put('literal_X/other.png', '', { metadata: {} });
            assert.deepEqual((await db.list({ prefix: 'literal_%/' })).keys.map(f => f.name), ['literal_%/photo.png']);
        } finally { sqlite.db.close(); }
    });
});
