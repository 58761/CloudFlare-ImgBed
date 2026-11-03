import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/utils/axios', () => ({ default: Object.assign(vi.fn(), { post: vi.fn(), patch: vi.fn(), get: vi.fn() }) }))
vi.mock('image-conversion', () => ({ compressAccurately: vi.fn() }))
import axios from '@/utils/axios'
import { albumHeaders, albumShareUrl, createImageBatch, loadAlbums, saveAlbums, updateAlbum } from '@/utils/upload/albums'
import AlbumBatches from '@/components/upload/AlbumBatches.vue'
import { ensureFileType } from '@/utils/mimeTypes'
import UploadForm from '@/components/upload/UploadForm.vue'
import AlbumShare from '@/views/AlbumShare.vue'

describe('image folders', () => {
    const album = { id: 'folder-id', manageKey: 'private-key', directory: 'albums/batch/', shareUrl: 'https://test/album/share', enabled: true }
    const entries = () => [new File(['a'], 'a.png'), new File(['b'], 'b.jpg'), new File(['doc'], 'notes.txt')].map(file => ({ file, relativePath: file.name }))
    beforeEach(() => { vi.clearAllMocks(); localStorage.clear(); axios.post.mockResolvedValue({ data: { ...album } }) })

    it.each([
        ['https://xn--fsqu00a.xn--0zwm56d', 'https://例子.测试'],
        ['https://photos.xn--fiqs8s:8443', 'https://photos.中国:8443'],
        ['https://例子.测试', 'https://例子.测试'],
        ['http://localhost:8787', 'http://localhost:8787'],
        ['http://[::1]:8787', 'http://[::1]:8787'],
    ])('formats share links for %s while preserving their navigable URL', (origin, expected) => {
        const link = albumShareUrl(album, origin)
        expect(link).toBe(expected + '/album/share')
        expect(new URL(link).origin).toBe(new URL(origin).origin)
    })
    it('copies the Unicode link without re-serializing it to Punycode', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined)
        vi.stubGlobal('navigator', { clipboard: { writeText } })
        const vm = { shareUrl: a => albumShareUrl(a, 'https://xn--fsqu00a.xn--0zwm56d'), $message: { success: vi.fn(), error: vi.fn() }, $t: key => key }
        await AlbumBatches.methods.copy.call(vm, album)
        expect(writeText).toHaveBeenCalledWith('https://例子.测试/album/share')
        expect(vm.$message.error).not.toHaveBeenCalled()
    })

    it('creates one folder for a selection of images, leaving non-images and single uploads alone', async () => {
        const batch = entries()
        await createImageBatch(batch)
        expect(axios.post).toHaveBeenCalledTimes(1)
        expect(batch[0].file.album).toEqual(album)
        expect(batch[1].file.album).toEqual(album)
        expect(batch[2].file.album).toBeUndefined()
        expect(await createImageBatch([batch[0]])).toBeNull()
        expect(axios.post).toHaveBeenCalledTimes(1)
    })
    it('keeps simultaneous selections independent and does not silently upload when folder creation fails', async () => {
        axios.post.mockResolvedValueOnce({ data: album }).mockResolvedValueOnce({ data: { ...album, id: 'second' } })
        const first = entries(), second = entries()
        await Promise.all([createImageBatch(first), createImageBatch(second)])
        expect(first[0].file.album.id).not.toBe(second[0].file.album.id)
        axios.post.mockRejectedValueOnce(new Error('offline'))
        const vm = { $message: { error: vi.fn() }, $t: key => key, beforeUpload: vi.fn(), uploadFile: vi.fn() }
        await UploadForm.methods.uploadLocalEntries.call(vm, entries())
        expect(vm.beforeUpload).not.toHaveBeenCalled()
        expect(vm.uploadFile).not.toHaveBeenCalled()
        expect(vm.$message.error).toHaveBeenCalled()
    })
    it('preserves album credentials through MIME completion and image conversion path copies', () => {
        const file = entries()[0].file
        file.album = album
        const completed = ensureFileType(file)
        expect(completed.type).toBe('image/png')
        expect(completed.album).toEqual(album)
        const converted = new File(['webp'], 'a.webp', { type: 'image/webp' })
        UploadForm.methods.copyUploadPath.call({ uploadFolder: '' }, completed, converted)
        expect(converted.album).toEqual(album)
        expect(albumHeaders(converted.album)).toEqual({ 'X-Album-Id': album.id, 'X-Album-Key': album.manageKey })
    })
    it('uses the captured batch for retries and keeps R2 selected even when global settings change', async () => {
        const file = new File(['a'], 'a.png', { type: 'image/png' }); file.uid = 'f'
        const item = { uid: 'f', album, uploadChannel: 'cfr2', uploadFolder: album.directory }
        axios.mockResolvedValue({ data: [{ src: '/file/photo.png' }] })
        const vm = { fileList: [item], uploadChannel: 'telegram', autoRetry: true, channelName: 'telegram-only', uploadNameType: 'origin', abortControllers: new Map(), getFileUploadFolder: () => album.directory, onUploadComplete: vi.fn() }
        const req = { file, onSuccess: vi.fn(), onProgress: vi.fn(), onError: vi.fn() }
        await UploadForm.methods.uploadSingleFile.call(vm, req)
        await Promise.resolve()
        await UploadForm.methods.uploadSingleFile.call(vm, req)
        for (const [config] of axios.mock.calls) {
            expect(config.headers).toEqual(albumHeaders(album))
            expect(config.url).toContain('uploadChannel=cfr2')
            expect(config.url).toContain('autoRetry=false')
            expect(config.url).not.toContain('channelName=')
        }
    })
    it('persists management history and sends credentials only in headers', async () => {
        saveAlbums([album]); expect(loadAlbums()).toEqual([album])
        axios.patch.mockResolvedValue({ data: { ...album, manageKey: undefined, name: 'Renamed' } })
        const changed = await updateAlbum(album, { name: 'Renamed' })
        expect(changed.manageKey).toBe(album.manageKey)
        expect(axios.patch).toHaveBeenCalledWith('/api/albums', { name: 'Renamed' }, expect.objectContaining({ headers: albumHeaders(album) }))
    })
    it('includes the album credential when cleaning up a failed multipart upload', async () => {
        axios.mockResolvedValue({ data: { success: true } })
        await UploadForm.methods.cleanupUploadResources.call({}, 'session', 2, album)
        expect(axios).toHaveBeenCalledWith(expect.objectContaining({
            url: '/upload?cleanup=true&uploadId=session&totalChunks=2', headers: albumHeaders(album),
        }))
    })
    it('paginates without duplicate images and clears previously loaded images when sharing is revoked', async () => {
        const vm = { ...AlbumShare.data(), $route: { params: { share: 'share' } }, $t: key => key }
        const photo = { id: 'a', name: 'a.png', url: '/file/a.png' }
        axios.get.mockResolvedValueOnce({ data: { name: 'Photos', files: [photo], cursor: 'next' } })
            .mockResolvedValueOnce({ data: { name: 'Photos', files: [photo, { ...photo, id: 'b' }], cursor: null } })
        await AlbumShare.methods.load.call(vm)
        await AlbumShare.methods.load.call(vm)
        expect(vm.files).toHaveLength(2)
        expect(axios.get.mock.calls[1][1].params.cursor).toBe('next')
        axios.get.mockRejectedValueOnce({ response: { status: 404 } })
        await AlbumShare.methods.load.call(vm)
        expect(vm.files).toHaveLength(0)
        expect(vm.error).toBe('albums.unavailable')
    })
})
