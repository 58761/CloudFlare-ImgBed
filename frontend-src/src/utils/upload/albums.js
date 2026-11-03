import axios from '@/utils/axios'
import { getFileTypeCategory, resolveFileType } from '@/utils/mimeTypes'
import { unicodeOrigin } from '@/utils/unicodeOrigin'

const HISTORY_KEY = 'image-albums-v1'

export function albumShareUrl(album, origin = window.location.origin) {
    return `${unicodeOrigin(origin)}${new URL(album.shareUrl).pathname}`
}

export const albumHeaders = album => album ? {
    'X-Album-Id': album.id,
    'X-Album-Key': album.manageKey,
} : {}

export function loadAlbums() {
    try {
        const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]')
        return Array.isArray(value) ? value.filter(a => a?.id && a?.manageKey).slice(0, 100) : []
    } catch { return [] }
}

export function saveAlbums(albums) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(albums.slice(0, 100))) } catch { /* Private browsing / full storage. */ }
}

export async function createImageBatch(entries) {
    const images = entries.filter(({ file }) => getFileTypeCategory(resolveFileType(file.name, file.type)) === 'image')
    if (images.length < 2) return null
    const { data: album } = await axios.post('/api/albums', {}, { withAuthCode: true })
    for (const { file } of images) file.album = album
    return album
}

export async function updateAlbum(album, changes) {
    const { data } = await axios.patch('/api/albums', changes, { headers: albumHeaders(album), withAuthCode: true })
    return { ...data, manageKey: album.manageKey }
}
