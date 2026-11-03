<template>
    <section class="album-batches" :aria-label="$t('albums.recent')">
        <p class="album-hint">{{ $t('albums.hint') }}</p>
        <details v-if="albums.length" open>
            <summary>{{ $t('albums.recent') }} ({{ albums.length }})</summary>
            <article v-for="album in albums" :key="album.id" class="album-row">
                <div class="album-info">
                    <strong>{{ album.name }}</strong>
                    <small v-if="progress(album.id).total">{{ $t('albums.progress', progress(album.id)) }}</small>
                    <small v-else>{{ new Date(album.createdAt).toLocaleString() }}</small>
                    <small v-if="!album.enabled">{{ $t('albums.disabled') }}</small>
                </div>
                <div class="album-actions">
                    <el-button size="small" :disabled="!album.enabled || busy === album.id" @click="copy(album)">{{ $t('albums.copy') }}</el-button>
                    <a v-if="album.enabled" :href="shareUrl(album)" target="_blank" rel="noopener noreferrer">{{ $t('albums.view') }}</a>
                    <el-button size="small" :disabled="busy === album.id" @click="rename(album)">{{ $t('albums.rename') }}</el-button>
                    <el-button size="small" :disabled="busy === album.id" @click="change(album, { enabled: !album.enabled })">{{ $t(album.enabled ? 'albums.disable' : 'albums.enable') }}</el-button>
                    <el-button size="small" :disabled="busy === album.id" @click="rotate(album)">{{ $t('albums.rotate') }}</el-button>
                </div>
            </article>
            <p class="album-hint">{{ $t('albums.historyHint') }}</p>
        </details>
    </section>
</template>

<script>
import { updateAlbum, albumShareUrl } from '@/utils/upload/albums'

export default {
    props: { albums: { type: Array, default: () => [] }, files: { type: Array, default: () => [] } },
    emits: ['updated'],
    data: () => ({ busy: null }),
    methods: {
        shareUrl(album) { return albumShareUrl(album) },
        progress(id) {
            const files = this.files.filter(file => file.album?.id === id)
            return { total: files.length, success: files.filter(f => ['done', 'success'].includes(f.status)).length, failed: files.filter(f => f.status === 'exception').length }
        },
        async copy(album) {
            try {
                await navigator.clipboard.writeText(this.shareUrl(album))
                this.$message.success(this.$t('albums.copied'))
            } catch { this.$message.error(this.$t('albums.copyFailed')) }
        },
        async change(album, changes) {
            this.busy = album.id
            try { this.$emit('updated', await updateAlbum(album, changes)) }
            catch { this.$message.error(this.$t('albums.actionFailed')) }
            finally { this.busy = null }
        },
        async rename(album) {
            try {
                const { value } = await this.$prompt(this.$t('albums.name'), this.$t('albums.rename'), {
                    inputValue: album.name, inputValidator: value => !!value?.trim() && value.trim().length <= 120,
                })
                await this.change(album, { name: value })
            } catch { /* Dialog cancelled. */ }
        },
        async rotate(album) {
            try {
                await this.$confirm(this.$t('albums.rotateConfirm'), this.$t('albums.rotate'))
                await this.change(album, { rotate: true })
            } catch { /* Dialog cancelled. */ }
        },
    },
}
</script>

<style scoped>
.album-batches { width: 55vw; box-sizing: border-box; margin: 14px 0; padding: 12px 16px; border-radius: 14px; border: 1px solid var(--glass-border); background: var(--glass-bg); backdrop-filter: blur(20px); text-align: left; color: var(--el-text-color-primary); }
details { max-height: 340px; overflow-y: auto; }
@media (max-width: 768px) { .album-batches { width: 70vw; padding: 10px; } }
.album-hint { color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.6; }
summary { cursor: pointer; padding: 8px 0; font-weight: 600; }
.album-row { border: 1px solid var(--el-border-color); border-radius: 12px; padding: 14px; margin-top: 8px; background: var(--el-bg-color); display: flex; gap: 12px; justify-content: space-between; flex-wrap: wrap; }
.album-info { display: grid; gap: 5px; min-width: 0; overflow-wrap: anywhere; }
.album-info small { color: var(--el-text-color-secondary); }
.album-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
.album-actions .el-button { margin: 0; }
.album-actions a { color: var(--el-color-primary); font-size: 13px; }
</style>
