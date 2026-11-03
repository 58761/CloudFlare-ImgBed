<template>
    <section class="album-settings" v-loading="loading">
        <h2 class="first-title">{{ $t('albumSharing.title') }}</h2>
        <el-alert v-if="error" :title="error" type="error" :closable="false" />
        <el-form label-position="top" class="policy-form">
            <el-form-item :label="$t('albumSharing.globalEnabled')"><el-switch v-model="settings.enabled" /></el-form-item>
            <el-form-item :label="$t('albumSharing.defaultExpiry')">
                <el-input v-model="settings.defaultExpire" :placeholder="$t('albumSharing.customHint')" />
            </el-form-item>
            <el-form-item :label="$t('albumSharing.recordIp')"><el-switch v-model="settings.recordIp" /></el-form-item>
            <p>{{ $t('albumSharing.retentionHint') }}</p>
            <el-button type="primary" :disabled="!ready" :loading="saving" @click="saveSettings">{{ $t('albumSharing.save') }}</el-button>
        </el-form>
        <div class="list-header"><h3>{{ $t('albumSharing.folders') }}</h3><el-button :disabled="loading" @click="loadAlbums(false)">{{ $t('albums.refresh') }}</el-button></div>
        <el-table :data="albums" stripe>
            <el-table-column prop="name" :label="$t('albumSharing.folderName')" min-width="160" />
            <el-table-column :label="$t('albumSharing.createdAt')" min-width="170"><template #default="{ row }">{{ date(row.createdAt) }}</template></el-table-column>
            <el-table-column :label="$t('albumSharing.expiresAt')" min-width="170"><template #default="{ row }">{{ date(row.expiresAt) }}</template></el-table-column>
            <el-table-column :label="$t('albumSharing.status')" min-width="120"><template #default="{ row }">{{ $t('albumSharing.' + row.state) }}</template></el-table-column>
            <el-table-column :label="$t('albumSharing.actions')" min-width="370">
                <template #default="{ row }">
                    <div class="row-actions">
                        <el-button size="small" @click="copy(row)">{{ $t('albums.copy') }}</el-button>
                        <el-button size="small" :disabled="busy === row.id" @click="editExpiry(row)">{{ $t('albumSharing.editExpiry') }}</el-button>
                        <el-button size="small" :disabled="busy === row.id" @click="toggle(row)">{{ $t(row.adminDisabled || !row.enabled ? 'albums.enable' : 'albums.disable') }}</el-button>
                        <el-button size="small" @click="openVisits(row)">{{ $t('albumSharing.visits') }}</el-button>
                    </div>
                </template>
            </el-table-column>
        </el-table>
        <el-button v-if="cursor" :loading="loading" @click="loadAlbums(true)">{{ $t('albums.more') }}</el-button>
        <el-dialog v-model="visitsVisible" :title="$t('albumSharing.visits') + ' · ' + (visitAlbum?.name || '')" width="min(90vw, 640px)">
            <p>{{ $t('albumSharing.retentionHint') }}</p>
            <el-alert v-if="visitError" :title="visitError" type="error" :closable="false" />
            <el-table :data="visits" v-loading="visitsLoading">
                <el-table-column prop="ip" label="IP" min-width="180" />
                <el-table-column :label="$t('albumSharing.lastVisitedAt')" min-width="180"><template #default="{ row }">{{ date(row.lastVisitedAt) }}</template></el-table-column>
            </el-table>
            <el-button :disabled="visitsLoading" @click="loadVisits(false)">{{ $t('albums.refresh') }}</el-button>
            <el-button v-if="visitCursor" :loading="visitsLoading" @click="loadVisits(true)">{{ $t('albums.more') }}</el-button>
        </el-dialog>
    </section>
</template>

<script>
import axios from '@/utils/axios'

const endpoint = '/api/manage/album-shares'
export default {
    data: () => ({
        settings: { enabled: true, defaultExpire: '3d', recordIp: false }, ready: false,
        albums: [], cursor: null, loading: false, saving: false, busy: '', error: '',
        visitsVisible: false, visits: [], visitCursor: null, visitAlbum: null, visitsLoading: false, visitError: '',
    }),
    async mounted() {
        this.loading = true
        try {
            this.settings = (await axios.get(endpoint, { params: { action: 'settings' } })).data
            this.ready = true
            await this.loadAlbums(false)
        } catch { this.error = this.$t('albums.loadFailed') }
        finally { this.loading = false }
    },
    methods: {
        date(value) { return value === null ? this.$t('albumSharing.forever') : new Date(value).toLocaleString() },
        async loadAlbums(append) {
            this.loading = true; this.error = ''
            try {
                const { data } = await axios.get(endpoint, { params: { cursor: append ? this.cursor : undefined } })
                this.albums = append ? [...this.albums, ...data.albums] : data.albums
                this.cursor = data.cursor
            } catch { this.error = this.$t('albums.loadFailed') }
            finally { this.loading = false }
        },
        async saveSettings() {
            this.saving = true
            try {
                this.settings = (await axios.patch(endpoint, this.settings, { params: { action: 'settings' } })).data
                this.$message.success(this.$t('albumSharing.saved'))
                await this.loadAlbums(false)
            } catch (error) { this.$message.error(error.response?.data?.error || this.$t('albums.actionFailed')) }
            finally { this.saving = false }
        },
        async copy(album) {
            try { await navigator.clipboard.writeText(album.shareUrl); this.$message.success(this.$t('albums.copied')) }
            catch { this.$message.error(this.$t('albums.copyFailed')) }
        },
        async change(album, changes) {
            this.busy = album.id
            try {
                const { data } = await axios.patch(endpoint, { id: album.id, ...changes })
                this.albums = this.albums.map(a => a.id === album.id ? data : a)
            } catch (error) { this.$message.error(error.response?.data?.error || this.$t('albums.actionFailed')) }
            finally { this.busy = '' }
        },
        async toggle(album) {
            const adminDisabled = !(album.adminDisabled || !album.enabled)
            try {
                await this.$confirm(this.$t(adminDisabled ? 'albumSharing.disableConfirm' : 'albumSharing.enableConfirm'), album.name)
                await this.change(album, { adminDisabled })
            } catch { /* Cancelled. */ }
        },
        async editExpiry(album) {
            try {
                const { value } = await this.$prompt(this.$t('albumSharing.editHint'), this.$t('albumSharing.editExpiry'), { inputValue: '3d', inputValidator: value => value === 'forever' || /^[1-9]\d{0,5}[mhd]$/.test(value) })
                await this.change(album, { expire: value })
            } catch { /* Cancelled. */ }
        },
        openVisits(album) {
            this.visitAlbum = album; this.visits = []; this.visitCursor = null; this.visitsVisible = true
            this.loadVisits(false)
        },
        async loadVisits(append) {
            const id = this.visitAlbum.id
            this.visitsLoading = true; this.visitError = ''
            try {
                const { data } = await axios.get(endpoint, { params: { action: 'visits', id, cursor: append ? this.visitCursor : undefined } })
                if (id !== this.visitAlbum.id) return
                this.visits = append ? [...this.visits, ...data.visits] : data.visits
                this.visitCursor = data.cursor
            } catch { if (id === this.visitAlbum.id) this.visitError = this.$t('albums.loadFailed') }
            finally { if (id === this.visitAlbum.id) this.visitsLoading = false }
        },
    },
}
</script>

<style scoped>
.album-settings { color: var(--el-text-color-primary); }
.policy-form { max-width: 640px; padding: 20px; border: 1px solid var(--el-border-color); border-radius: 12px; background: var(--el-bg-color); }
.policy-form p { font-size: 13px; line-height: 1.6; color: var(--el-text-color-secondary); }
.list-header { display: flex; align-items: center; justify-content: space-between; margin-top: 24px; }
.row-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.row-actions .el-button { margin: 0; }
</style>
