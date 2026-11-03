<template>
    <main class="shared-album">
        <header>
            <p class="eyebrow">{{ $t('albums.gallery') }}</p>
            <h1>{{ name || $t('albums.gallery') }}</h1>
            <p>{{ $t('albums.loaded', { count: files.length }) }}</p>
        </header>
        <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon />
        <p v-if="!busy && !error && !files.length && !cursor" class="empty">{{ $t('albums.empty') }}</p>
        <section class="photo-grid" :aria-label="$t('albums.gallery')">
            <figure v-for="(file, index) in files" :key="file.id">
                <el-image :src="file.url" :alt="file.name" fit="cover" loading="lazy" :preview-src-list="previewUrls" :initial-index="index" preview-teleported>
                    <template #error><span class="image-error">{{ $t('albums.imageUnavailable') }}</span></template>
                </el-image>
                <figcaption><span>{{ file.name }}</span><a :href="file.url" target="_blank" rel="noopener noreferrer">{{ $t('albums.original') }}</a></figcaption>
            </figure>
        </section>
        <div class="gallery-actions">
            <el-button v-if="cursor || busy" :loading="busy" @click="load()">{{ $t('albums.more') }}</el-button>
            <el-button v-if="error && !unavailable" @click="load()">{{ $t('albums.retry') }}</el-button>
            <el-button v-if="!busy" @click="refresh()">{{ $t('albums.refresh') }}</el-button>
        </div>
    </main>
</template>

<script>
import axios from '@/utils/axios'

export default {
    data: () => ({ name: '', files: [], cursor: null, busy: false, error: '', unavailable: false, generation: 0 }),
    computed: { previewUrls() { return this.files.map(file => file.url) } },
    watch: { '$route.params.share': { immediate: true, handler() { this.refresh() } } },
    beforeUnmount() { this.generation++ },
    methods: {
        refresh() {
            this.generation++
            this.files = []; this.cursor = null; this.name = ''; this.busy = false
            this.load()
        },
        async load() {
            if (this.busy) return
            const generation = this.generation
            this.busy = true; this.error = ''; this.unavailable = false
            try {
                const { data } = await axios.get('/api/album-share', { params: { share: this.$route.params.share, cursor: this.cursor || undefined } })
                if (generation !== this.generation) return
                this.name = data.name
                const seen = new Set(this.files.map(file => file.id))
                // Use the application's backend prefix in the local development proxy.
                const prefix = process.env.NODE_ENV === 'production' ? '' : '/api'
                this.files.push(...data.files.filter(file => !seen.has(file.id)).map(file => ({ ...file, url: prefix + file.url })))
                this.cursor = data.cursor
            } catch (error) {
                if (generation !== this.generation) return
                this.unavailable = error.response?.status === 404
                if (this.unavailable) { this.files = []; this.cursor = null; this.name = '' }
                this.error = this.$t(this.unavailable ? 'albums.unavailable' : 'albums.loadFailed')
            } finally { if (generation === this.generation) this.busy = false }
        },
    },
}
</script>

<style scoped>
.shared-album { max-width: 1200px; margin: auto; padding: 48px 24px; color: var(--el-text-color-primary); }
.eyebrow { color: var(--el-color-primary); letter-spacing: .12em; font-size: 12px; }
h1 { font-size: clamp(26px, 5vw, 42px); margin: 12px 0; overflow-wrap: anywhere; }
header > p:last-child { color: var(--el-text-color-secondary); }
.photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 20px; margin-top: 28px; }
figure { margin: 0; border: 1px solid var(--el-border-color); border-radius: 14px; overflow: hidden; background: var(--el-bg-color); }
.el-image { width: 100%; aspect-ratio: 1; display: flex; cursor: zoom-in; }
figcaption { display: flex; gap: 10px; justify-content: space-between; padding: 14px; font-size: 13px; }
figcaption span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
figcaption a { flex-shrink: 0; color: var(--el-color-primary); }
.gallery-actions { display: flex; justify-content: center; gap: 12px; margin-top: 28px; }
.empty { text-align: center; padding: 60px 0; color: var(--el-text-color-secondary); }
.image-error { margin: auto; color: var(--el-text-color-secondary); }
@media (max-width: 540px) { .shared-album { padding: 28px 16px; } .photo-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; } figcaption { flex-direction: column; padding: 10px; } }
</style>
