import assert from 'node:assert/strict';

// Run against an isolated wrangler dev --local instance with D1/KV + R2.
// Never run this smoke test against production: it creates test folders/files.
const origin = new URL(process.argv[2] || 'http://127.0.0.1:8787');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname), 'Only a local test server is allowed');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
async function json(path, options = {}, status = 200) {
    const response = await fetch(new URL(path, origin), options);
    const body = await response.text();
    assert.equal(response.status, status, body);
    return JSON.parse(body);
}
const album = await json('/api/albums', { method: 'POST', body: JSON.stringify({ name: 'Local folder smoke test' }) }, 201);
const headers = { 'X-Album-Id': album.id, 'X-Album-Key': album.manageKey };
const upload = async () => {
    const form = new FormData();
    form.set('file', new Blob([png], { type: 'image/png' }), 'same.png');
    return (await json('/upload?uploadFolder=wrong&uploadChannel=telegram', { method: 'POST', headers, body: form }))[0].src;
};
const paths = await Promise.all([upload(), upload()]);
assert.notEqual(paths[0], paths[1]);
for (const path of paths) {
    assert.ok(path.startsWith('/file/' + album.directory));
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
}
const shareQuery = `/api/album-share?share=${new URL(album.shareUrl).pathname.split('/').pop()}`;
assert.equal((await json(shareQuery)).files.length, 2);
assert.equal((await fetch(new URL('/api/albums', origin), { headers: { ...headers, 'X-Album-Key': crypto.randomUUID() } })).status, 403);

// Exercise the same multipart protocol as the UI, using actual local R2 parts.
const init = new FormData();
init.set('originalFileName', 'large.png'); init.set('originalFileType', 'image/png'); init.set('totalChunks', '2');
const { uploadId } = await json('/upload?initChunked=true', { method: 'POST', headers, body: init });
const firstPart = Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024 - png.length)]);
for (const [index, bytes] of [firstPart, png].entries()) {
    const form = new FormData();
    form.set('uploadId', uploadId); form.set('originalFileName', 'large.png'); form.set('originalFileType', 'image/png');
    form.set('totalChunks', '2'); form.set('chunkIndex', String(index)); form.set('file', new Blob([bytes]), `part${index}`);
    await json('/upload?chunked=true', { method: 'POST', headers, body: form });
}
const merge = new FormData();
merge.set('uploadId', uploadId); merge.set('originalFileName', 'large.png'); merge.set('originalFileType', 'image/png'); merge.set('totalChunks', '2');
const merged = await json('/upload?chunked=true&merge=true', { method: 'POST', headers, body: merge });
assert.ok(merged[0].src.startsWith('/file/' + album.directory));
const mergedFile = await fetch(new URL(merged[0].src, origin));
assert.deepEqual(Buffer.from(await mergedFile.arrayBuffer()), Buffer.concat([firstPart, png]));
assert.equal((await json(shareQuery)).files.length, 3);

await json('/api/albums', { method: 'PATCH', headers, body: JSON.stringify({ enabled: false }) });
assert.equal((await fetch(new URL(shareQuery, origin))).status, 404);
const rotated = await json('/api/albums', { method: 'PATCH', headers, body: JSON.stringify({ enabled: true, rotate: true, name: 'Renamed folder' }) });
assert.equal((await fetch(new URL(shareQuery, origin))).status, 404);
const newShare = `/api/album-share?share=${new URL(rotated.shareUrl).pathname.split('/').pop()}`;
const page = await json(newShare);
assert.equal(page.name, 'Renamed folder'); assert.equal(page.files.length, 3);
console.log('Local Worker folders passed: concurrent uploads, multipart R2 bytes, directory listing, authentication, rename, revocation and rotation.');
