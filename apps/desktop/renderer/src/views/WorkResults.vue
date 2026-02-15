<template>
  <div class="work-results-view">
    <div class="results-header card-glass">
      <div class="header-left">
        <h1 class="view-title">{{ t('workResults.title') }}</h1>
        <p class="text-secondary">
          {{ t('workResults.currentWorkspace') }}: <strong>{{ currentWorkspace }}</strong>
        </p>
      </div>
      <button class="btn-primary" @click="showSwitchModal = true">
        {{ t('workResults.switchWorkspace') }}
      </button>
    </div>

    <div class="results-layout">
      <aside class="results-sidebar card-glass">
        <nav class="results-nav">
          <button
            type="button"
            class="nav-item"
            :class="{ active: activeTab === 'documents' }"
            @click="activeTab = 'documents'"
          >
            <span class="nav-icon">📂</span>
            {{ t('workResults.documentsTab') }}
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ active: activeTab === 'bookmarks' }"
            @click="activeTab = 'bookmarks'; loadBookmarks()"
          >
            <span class="nav-icon">🔖</span>
            {{ t('workResults.bookmarks') }}
          </button>
          <button
            type="button"
            class="nav-item"
            :class="{ active: activeTab === 'news' }"
            @click="activeTab = 'news'"
          >
            <span class="nav-icon">📰</span>
            {{ t('workResults.news') }}
          </button>
        </nav>
      </aside>

      <main class="results-main">
    <!-- 文档 Tab -->
    <div v-show="activeTab === 'documents'" class="tab-panel documents-panel">
      <div class="doc-toolbar">
        <nav class="breadcrumb">
          <button class="breadcrumb-item" @click="docPath = ''">{{ currentWorkspace }}</button>
          <span v-for="(part, i) in docPathParts" :key="i" class="breadcrumb-chunk">
            <span class="breadcrumb-sep">/</span>
            <button class="breadcrumb-item" @click="docPath = docPathParts.slice(0, i + 1).join('/')">
              {{ part }}
            </button>
          </span>
        </nav>
        <div class="doc-view-toggle">
          <button
            type="button"
            class="toggle-btn"
            :class="{ active: docViewMode === 'list' }"
            @click="docViewMode = 'list'"
          >
            {{ t('workResults.viewList') }}
          </button>
          <button
            type="button"
            class="toggle-btn"
            :class="{ active: docViewMode === 'cards' }"
            @click="docViewMode = 'cards'"
          >
            {{ t('workResults.viewCards') }}
          </button>
        </div>
      </div>
      <div v-if="docLoading" class="loading-state">
        <div class="spinner"></div>
        <p>{{ t('common.loading') }}</p>
      </div>
      <div v-else-if="filteredDocuments.length === 0" class="empty-state">
        <div class="empty-icon">📂</div>
        <p>{{ t('workspace.emptyDocs') }}</p>
      </div>
      <template v-else>
        <!-- 卡片视图：仅图片文件以卡片展示 -->
        <div v-if="docViewMode === 'cards'" class="doc-cards-view">
          <div v-if="imageFiles.length > 0" class="image-cards-grid">
            <div
              v-for="item in imageFiles"
              :key="item.path"
              class="image-card"
              @click="openPreview(item)"
            >
              <img :src="fileServeUrl(item.path, false)" :alt="item.name" class="image-card-thumb" loading="lazy" />
              <span class="image-card-name">{{ item.name }}</span>
            </div>
          </div>
          <div v-else class="empty-state small">
            <p>{{ t('workResults.noImagesHere') }}</p>
          </div>
          <div v-if="nonImageItems.length > 0" class="other-files-section">
            <p class="other-files-label">{{ t('workResults.otherFiles') }}</p>
            <div class="doc-list">
              <div
                v-for="item in nonImageItems"
                :key="item.path"
                class="doc-item"
                :class="{ folder: item.isDirectory }"
              >
                <template v-if="item.isDirectory">
                  <span class="doc-icon">📁</span>
                  <button class="doc-name" @click="docPath = item.path">{{ item.name }}</button>
                </template>
                <template v-else>
                  <span class="doc-icon">📄</span>
                  <span class="doc-name">{{ item.name }}</span>
                  <span class="doc-actions">
                    <a :href="fileServeUrl(item.path, true)" download class="link-btn">{{ t('workspace.download') }}</a>
                  </span>
                </template>
              </div>
            </div>
          </div>
        </div>
        <!-- 列表视图 -->
        <div v-else class="doc-list">
          <div
            v-for="item in filteredDocuments"
            :key="item.path"
            class="doc-item"
            :class="{ folder: item.isDirectory }"
          >
            <template v-if="item.isDirectory">
              <span class="doc-icon">📁</span>
              <button class="doc-name" @click="docPath = item.path">{{ item.name }}</button>
              <span class="doc-actions">
                <button type="button" class="link-btn danger" @click="confirmDelete(item)">{{ t('common.delete') }}</button>
              </span>
            </template>
            <template v-else>
              <span class="doc-icon">📄</span>
              <span class="doc-name">{{ item.name }}</span>
              <span class="doc-actions">
                <template v-if="isPreviewable(item.name)">
                  <button type="button" class="link-btn" @click="openPreview(item)">
                    {{ t('workspace.preview') }}
                  </button>
                  <span class="sep">|</span>
                </template>
                <a :href="fileServeUrl(item.path, true)" download class="link-btn">{{ t('workspace.download') }}</a>
                <span class="sep">|</span>
                <button type="button" class="link-btn danger" @click="confirmDelete(item)">{{ t('common.delete') }}</button>
              </span>
            </template>
          </div>
        </div>
      </template>
    </div>

    <!-- 收藏 Tab -->
    <div v-show="activeTab === 'bookmarks'" class="tab-panel bookmarks-panel">
      <div v-if="bookmarksLoading" class="loading-state">
        <div class="spinner"></div>
        <p>{{ t('common.loading') }}</p>
      </div>
      <div v-else class="bookmarks-content">
        <div v-if="downloadMessage" class="bookmark-download-message" :class="downloadMessageError ? 'error' : ''">
          {{ downloadMessage }}
        </div>
        <div class="bookmark-tag-filter">
          <span class="filter-label">{{ t('workResults.filterByTag') }}:</span>
          <button
            type="button"
            class="tag-pill filter-all"
            :class="{ active: isAllTagSelected }"
            @click="setBookmarkTagFilter('')"
          >
            {{ t('workResults.filterAll') }}
          </button>
          <button
            v-for="tag in bookmarkTags"
            :key="tag.id"
            type="button"
            class="tag-pill"
            :class="{ active: isTagSelected(tag) }"
            @click="setBookmarkTagFilter(tag.id)"
          >
            {{ tag.name }}
          </button>
        </div>
        <div class="bookmarks-list-wrap">
          <ul v-if="bookmarks.length > 0" class="bookmarks-list">
          <li v-for="item in bookmarks" :key="item.id" class="bookmark-item card-glass">
          <div class="bookmark-main">
            <div class="bookmark-thumb-row">
              <template v-if="isImageBookmarkUrl(item.url)">
                <img
                  :src="bookmarkImageSrc(item.url)"
                  :alt="item.title || item.url"
                  class="bookmark-thumb"
                  loading="lazy"
                  @error="(e) => (e.target.style.display = 'none')"
                />
              </template>
              <div v-else class="bookmark-thumb bookmark-thumb-placeholder" :title="item.url">
                <span class="bookmark-thumb-icon">🔗</span>
              </div>
              <div class="bookmark-text">
                <a :href="item.url" target="_blank" rel="noopener noreferrer" class="bookmark-title">
                  {{ item.title || item.url }}
                </a>
                <p v-if="item.title && item.url !== item.title" class="bookmark-url">{{ item.url }}</p>
                <div v-if="item.tagNames?.length" class="bookmark-tags">
                  <span v-for="tag in item.tagNames" :key="tag" class="tag-pill">{{ tag }}</span>
                </div>
              </div>
            </div>
          </div>
          <div class="bookmark-actions">
            <button
              type="button"
              class="link-btn"
              :disabled="downloadingId === item.id"
              @click="downloadBookmarkToWorkspace(item)"
            >
              {{ downloadingId === item.id ? t('common.loading') : t('workResults.downloadToWorkspace') }}
            </button>
            <button type="button" class="link-btn" @click="openBookmarkPreview(item)">
              {{ isImageBookmarkUrl(item.url) ? t('workResults.viewFullImage') : t('workResults.preview') }}
            </button>
            <a :href="item.url" target="_blank" rel="noopener noreferrer" class="link-btn">
              {{ t('workResults.openLink') }}
            </a>
            <button type="button" class="link-btn danger" @click="confirmDeleteBookmark(item)">
              {{ t('common.delete') }}
            </button>
          </div>
        </li>
          </ul>
          <div v-else class="bookmarks-empty-inline">
            <div class="empty-icon">🔖</div>
            <p>{{ bookmarkTagFilter ? t('workResults.noBookmarksInTag') : t('workResults.noBookmarks') }}</p>
            <p class="text-secondary">{{ t('workResults.noBookmarksHint') }}</p>
          </div>
        </div>
      </div>
      <!-- 收藏预览弹窗：图片大图 或 远端网页 -->
      <transition name="fade">
        <div v-if="previewBookmarkItem" class="modal-backdrop preview-backdrop" @click.self="closeBookmarkPreview">
          <div class="modal-content preview-modal card-glass bookmark-preview-modal" @click.self="closeBookmarkPreview">
            <div class="modal-header">
              <h2 class="preview-title">{{ previewBookmarkItem.title || previewBookmarkItem.url }}</h2>
              <div class="preview-actions">
                <button
                  type="button"
                  class="link-btn"
                  :disabled="downloadingId === previewBookmarkItem.id"
                  @click="downloadBookmarkFromPreview"
                >
                  {{ downloadingId === previewBookmarkItem.id ? t('common.loading') : t('workResults.downloadToWorkspace') }}
                </button>
                <a
                  v-if="!isImageBookmarkUrl(previewBookmarkItem.url)"
                  :href="previewBookmarkItem.url"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="link-btn"
                >
                  {{ t('workResults.openInNewWindow') }}
                </a>
                <button type="button" class="close-btn" @click="closeBookmarkPreview">✕</button>
              </div>
            </div>
            <div class="preview-body">
              <template v-if="isImageBookmarkUrl(previewBookmarkItem.url)">
                <img :src="bookmarkPreviewImageSrc" alt="" class="preview-image" />
              </template>
              <template v-else>
                <iframe :src="previewBookmarkItem.url" class="preview-iframe bookmark-web-iframe" title="Preview" />
              </template>
            </div>
          </div>
        </div>
      </transition>

      <transition name="fade">
        <div v-if="deleteBookmarkTarget" class="modal-backdrop" @click.self="deleteBookmarkTarget = null">
          <div class="modal-content card-glass delete-confirm-modal">
            <div class="modal-header">
              <h2>{{ t('common.delete') }}</h2>
              <button type="button" class="close-btn" @click="deleteBookmarkTarget = null">✕</button>
            </div>
            <div class="modal-body">
              <p>{{ t('workResults.deleteBookmarkConfirm') }}</p>
              <p class="delete-target-name">{{ deleteBookmarkTarget?.title || deleteBookmarkTarget?.url }}</p>
              <div class="modal-footer-actions">
                <button type="button" class="btn-secondary" @click="deleteBookmarkTarget = null">{{ t('common.close') }}</button>
                <button type="button" class="btn-danger" @click="doDeleteBookmark">{{ t('common.delete') }}</button>
              </div>
            </div>
          </div>
        </div>
      </transition>
    </div>

    <!-- 新闻 Tab -->
    <div v-show="activeTab === 'news'" class="tab-panel news-panel">
      <div class="empty-state">
        <div class="empty-icon">📰</div>
        <p>{{ t('workResults.noNews') }}</p>
        <p class="text-secondary">{{ t('workResults.noNewsHint') }}</p>
      </div>
    </div>

      </main>
    </div>

    <!-- Preview modal -->
    <transition name="fade">
      <div v-if="showPreviewModal" class="modal-backdrop preview-backdrop" @click.self="closePreview">
        <div class="modal-content preview-modal card-glass">
          <div class="modal-header">
            <h2 class="preview-title">{{ previewItem?.name }}</h2>
            <div class="preview-actions">
              <a
                v-if="previewItem && !previewItem.isDirectory"
                :href="fileServeUrl(previewItem.path, true)"
                download
                class="link-btn"
              >
                {{ t('workspace.download') }}
              </a>
              <button type="button" class="close-btn" @click="closePreview">✕</button>
            </div>
          </div>
          <div class="preview-body">
            <template v-if="previewType === 'image'">
              <img :src="previewUrl" :alt="previewItem?.name" class="preview-image" />
            </template>
            <template v-else-if="previewType === 'pdf'">
              <iframe :src="previewUrl" class="preview-iframe" title="PDF" />
            </template>
            <template v-else-if="previewType === 'html'">
              <iframe v-if="previewHtmlContent" :srcdoc="previewHtmlContent" class="preview-iframe" title="HTML" />
              <div v-else class="loading-state"><div class="spinner"></div></div>
            </template>
            <template v-else-if="previewType === 'text'">
              <pre v-if="previewTextContent !== null" class="preview-text">{{ previewTextContent }}</pre>
              <div v-else class="loading-state"><div class="spinner"></div></div>
            </template>
          </div>
        </div>
      </div>
    </transition>

    <!-- Delete confirm modal -->
    <transition name="fade">
      <div v-if="deleteTarget" class="modal-backdrop" @click.self="deleteTarget = null">
        <div class="modal-content card-glass delete-confirm-modal">
          <div class="modal-header">
            <h2>{{ t('common.delete') }}</h2>
            <button type="button" class="close-btn" @click="deleteTarget = null">✕</button>
          </div>
          <div class="modal-body">
            <p>{{ deleteTarget?.isDirectory ? t('workspace.deleteFolderConfirm') : t('workspace.deleteConfirm') }}</p>
            <p class="delete-target-name">{{ deleteTarget?.name }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="deleteTarget = null">{{ t('common.close') }}</button>
              <button type="button" class="btn-danger" @click="doDelete">{{ t('common.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- Switch Workspace Modal -->
    <transition name="fade">
      <div v-if="showSwitchModal" class="modal-backdrop" @click.self="showSwitchModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('workResults.selectWorkspace') }}</h2>
            <button class="close-btn" @click="showSwitchModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="workspaces.length === 0" class="empty-state">
              <p>{{ t('workspace.emptyDocs') }}</p>
            </div>
            <ul class="workspace-list">
              <li
                v-for="name in workspaces"
                :key="name"
                class="workspace-option"
                :class="{ active: name === currentWorkspace }"
                @click="switchWorkspace(name)"
              >
                <span class="ws-icon">📁</span>
                <span class="ws-name">{{ name }}</span>
              </li>
            </ul>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from '@/composables/useI18n';
import apiClient from '@/api';
import { workspaceAPI, configAPI, savedItemsAPI, tagsAPI } from '@/api';
import { useSettingsStore } from '@/store/modules/settings';

const PREVIEW_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg', 'pdf', 'txt', 'html', 'htm', 'md', 'json']);

export default {
  name: 'WorkResults',
  setup() {
    const { t } = useI18n();
    const settingsStore = useSettingsStore();

    const activeTab = ref('documents');
    const currentWorkspace = ref('default');
    const workspaces = ref([]);
    const showSwitchModal = ref(false);
    const docPath = ref('');
    const documents = ref([]);
    const docLoading = ref(false);
    const docViewMode = ref('list');
    const previewItem = ref(null);
    const previewTextContent = ref(null);
    const previewHtmlContent = ref(null);
    const deleteTarget = ref(null);
    const bookmarks = ref([]);
    const bookmarksLoading = ref(false);
    const bookmarkTagFilter = ref('');
    const bookmarkTags = ref([]);
    const deleteBookmarkTarget = ref(null);
    const previewBookmarkItem = ref(null);
    const downloadingId = ref(null);
    const downloadMessage = ref('');
    const downloadMessageError = ref(false);

    const docPathParts = computed(() =>
      docPath.value ? docPath.value.split('/').filter(Boolean) : []
    );

    const HIDDEN_DIR_NAMES = new Set(['skills', '.skills']);
    const filteredDocuments = computed(() =>
      documents.value.filter(
        (item) => !item.isDirectory || !HIDDEN_DIR_NAMES.has(item.name)
      )
    );
    const imageFiles = computed(() =>
      filteredDocuments.value.filter(
        (item) => !item.isDirectory && getPreviewType(item.name) === 'image'
      )
    );
    const nonImageItems = computed(() =>
      filteredDocuments.value.filter(
        (item) => item.isDirectory || getPreviewType(item.name) !== 'image'
      )
    );

    const showPreviewModal = computed(() => !!previewItem.value);
    const previewType = computed(() => (previewItem.value ? getPreviewType(previewItem.value.name) : ''));
    const previewUrl = computed(() =>
      previewItem.value && !previewItem.value.isDirectory
        ? fileServeUrl(previewItem.value.path, false)
        : ''
    );

    function fileServeUrl(relativePath, download) {
      const base = apiClient.defaults.baseURL || '/server-api';
      const params = new URLSearchParams({
        workspace: currentWorkspace.value,
        path: relativePath,
      });
      if (download) params.set('download', '1');
      return `${base}/workspace/files/serve?${params.toString()}`;
    }

    function isPreviewable(filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      return PREVIEW_EXTS.has(ext);
    }

    function getPreviewType(filename) {
      const ext = filename.split('.').pop()?.toLowerCase() || '';
      if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'].includes(ext)) return 'image';
      if (ext === 'pdf') return 'pdf';
      if (['html', 'htm'].includes(ext)) return 'html';
      if (['txt', 'md', 'json'].includes(ext)) return 'text';
      return '';
    }

    async function openPreview(item) {
      if (item.isDirectory) return;
      previewItem.value = item;
      const type = getPreviewType(item.name);
      previewTextContent.value = null;
      previewHtmlContent.value = null;
      if (type === 'text') {
        try {
          const url = fileServeUrl(item.path, false);
          const res = await fetch(url);
          previewTextContent.value = await res.text();
        } catch (e) {
          previewTextContent.value = '';
        }
      } else if (type === 'html') {
        try {
          const url = fileServeUrl(item.path, false);
          const res = await fetch(url);
          previewHtmlContent.value = await res.text();
        } catch (e) {
          previewHtmlContent.value = '';
        }
      }
    }

    function closePreview() {
      previewItem.value = null;
      previewTextContent.value = null;
      previewHtmlContent.value = null;
    }

    function confirmDelete(item) {
      deleteTarget.value = item;
    }

    async function doDelete() {
      if (!deleteTarget.value) return;
      const item = deleteTarget.value;
      deleteTarget.value = null;
      try {
        await workspaceAPI.deleteDocument(currentWorkspace.value, item.path);
        loadDocuments();
      } catch (e) {
        console.error('Delete failed', e);
      }
    }

    async function loadWorkspaces() {
      try {
        const res = await workspaceAPI.listWorkspaces();
        workspaces.value = res.data?.data ?? [];
      } catch (e) {
        console.error('List workspaces failed', e);
      }
    }

    async function loadCurrentWorkspace() {
      try {
        const res = await workspaceAPI.getCurrentWorkspace();
        currentWorkspace.value = res.data?.data ?? 'default';
      } catch (e) {
        currentWorkspace.value = settingsStore.config?.defaultAgentId ?? 'default';
      }
    }

    async function loadDocuments() {
      docLoading.value = true;
      try {
        const res = await workspaceAPI.listDocuments(currentWorkspace.value, docPath.value);
        documents.value = res.data?.data ?? [];
      } catch (e) {
        console.error('List documents failed', e);
        documents.value = [];
      } finally {
        docLoading.value = false;
      }
    }

    async function loadBookmarkTags() {
      try {
        const res = await tagsAPI.list();
        bookmarkTags.value = res.data?.data ?? [];
      } catch (e) {
        console.error('List tags failed', e);
        bookmarkTags.value = [];
      }
    }

    async function loadBookmarks() {
      bookmarksLoading.value = true;
      try {
        await loadBookmarkTags();
        const params = {};
        if (bookmarkTagFilter.value) params.tagId = bookmarkTagFilter.value;
        const res = await savedItemsAPI.list(params);
        bookmarks.value = res.data?.data ?? [];
      } catch (e) {
        console.error('List bookmarks failed', e);
        bookmarks.value = [];
      } finally {
        bookmarksLoading.value = false;
      }
    }

    function setBookmarkTagFilter(tagId) {
      bookmarkTagFilter.value = tagId != null && tagId !== '' ? String(tagId) : '';
      loadBookmarks();
    }

    const isAllTagSelected = computed(() => !bookmarkTagFilter.value);

    function isTagSelected(tag) {
      if (!tag || bookmarkTagFilter.value === '') return false;
      return String(bookmarkTagFilter.value) === String(tag.id);
    }

    function isImageBookmarkUrl(url) {
      if (!url || typeof url !== 'string') return false;
      const path = url.split('?')[0].toLowerCase();
      return /\.(jpg|jpeg|png|gif|webp|svg|bmp)$/i.test(path) || path.includes('/image/');
    }

    function imageProxyUrl(url) {
      const base = apiClient.defaults.baseURL || '/server-api';
      return `${base}/saved-items/image-proxy?url=${encodeURIComponent(url)}`;
    }

    function bookmarkImageSrc(url) {
      return isImageBookmarkUrl(url) ? imageProxyUrl(url) : '';
    }

    const bookmarkPreviewImageSrc = computed(() =>
      previewBookmarkItem.value && isImageBookmarkUrl(previewBookmarkItem.value.url)
        ? imageProxyUrl(previewBookmarkItem.value.url)
        : ''
    );

    function openBookmarkPreview(item) {
      previewBookmarkItem.value = item;
    }

    function closeBookmarkPreview() {
      previewBookmarkItem.value = null;
    }

    function clearDownloadMessage() {
      downloadMessage.value = '';
      downloadMessageError.value = false;
    }

    async function downloadBookmarkToWorkspace(item) {
      if (downloadingId.value) return;
      downloadingId.value = item.id;
      clearDownloadMessage();
      let targetDir = null;
      if (typeof window !== 'undefined' && window.electronAPI?.showOpenDirectoryDialog) {
        try {
          targetDir = await window.electronAPI.showOpenDirectoryDialog();
        } catch (e) {
          console.error('Open directory dialog failed', e);
        }
      }
      try {
        const body = { workspace: currentWorkspace.value };
        if (targetDir) body.targetDir = targetDir;
        const res = await savedItemsAPI.downloadToWorkspace(item.id, body);
        const data = res.data?.data;
        if (data?.absolutePath) {
          downloadMessage.value = t('workResults.downloadSuccess') + ': ' + data.absolutePath;
        } else if (data?.relativePath) {
          downloadMessage.value = t('workResults.downloadSuccess') + ' .favorite/' + (data.relativePath || '').replace(/^\.favorite\/?/, '');
        } else {
          downloadMessage.value = t('workResults.downloadSuccess');
        }
        downloadMessageError.value = false;
        if (activeTab.value === 'documents') loadDocuments();
        setTimeout(clearDownloadMessage, 3000);
      } catch (e) {
        console.error('Download to workspace failed', e);
        downloadMessage.value = (e.response?.data?.message || e.message) || t('workResults.downloadFailed');
        downloadMessageError.value = true;
        setTimeout(clearDownloadMessage, 4000);
      } finally {
        downloadingId.value = null;
      }
    }

    async function downloadBookmarkFromPreview() {
      if (previewBookmarkItem.value) await downloadBookmarkToWorkspace(previewBookmarkItem.value);
    }

    function confirmDeleteBookmark(item) {
      deleteBookmarkTarget.value = item;
    }

    async function doDeleteBookmark() {
      if (!deleteBookmarkTarget.value) return;
      const id = deleteBookmarkTarget.value.id;
      deleteBookmarkTarget.value = null;
      try {
        await savedItemsAPI.delete(id);
        loadBookmarks();
      } catch (e) {
        console.error('Delete bookmark failed', e);
      }
    }

    async function switchWorkspace(name) {
      try {
        await configAPI.updateConfig({ defaultAgentId: name });
        currentWorkspace.value = name;
        showSwitchModal.value = false;
        await settingsStore.loadConfig();
        if (activeTab.value === 'documents') loadDocuments();
      } catch (e) {
        console.error('Switch workspace failed', e);
      }
    }

    watch([currentWorkspace, docPath], loadDocuments);
    onMounted(async () => {
      await loadCurrentWorkspace();
      await loadWorkspaces();
      loadDocuments();
    });

    return {
      t,
      activeTab,
      currentWorkspace,
      workspaces,
      showSwitchModal,
      docPath,
      docPathParts,
      docViewMode,
      documents,
      filteredDocuments,
      imageFiles,
      nonImageItems,
      docLoading,
      bookmarks,
      bookmarksLoading,
      bookmarkTagFilter,
      bookmarkTags,
      setBookmarkTagFilter,
      isAllTagSelected,
      isTagSelected,
      deleteBookmarkTarget,
      previewBookmarkItem,
      downloadingId,
      downloadMessage,
      downloadMessageError,
      isImageBookmarkUrl,
      imageProxyUrl,
      bookmarkImageSrc,
      bookmarkPreviewImageSrc,
      openBookmarkPreview,
      closeBookmarkPreview,
      downloadBookmarkToWorkspace,
      downloadBookmarkFromPreview,
      previewItem,
      previewType,
      previewUrl,
      previewTextContent,
      previewHtmlContent,
      showPreviewModal,
      deleteTarget,
      fileServeUrl,
      isPreviewable,
      openPreview,
      closePreview,
      confirmDelete,
      doDelete,
      loadBookmarks,
      confirmDeleteBookmark,
      doDeleteBookmark,
      switchWorkspace,
    };
  },
};
</script>

<style scoped>
.work-results-view {
  width: 100%;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  overflow: hidden;
}

.results-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-lg);
  margin-bottom: var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}

.view-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  margin: 0 0 var(--spacing-xs) 0;
  color: var(--color-text-primary);
}

.results-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: var(--spacing-lg);
  overflow: hidden;
}

.results-sidebar {
  width: 200px;
  flex-shrink: 0;
  padding: var(--spacing-md);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}

.results-nav {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.results-nav .nav-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  width: 100%;
  padding: var(--spacing-md);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  text-align: left;
  cursor: pointer;
  transition: var(--transition-fast);
}

.results-nav .nav-item:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.results-nav .nav-item.active {
  background: var(--color-accent-primary);
  color: white;
}

.results-nav .nav-icon {
  font-size: 1.1rem;
}

.results-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tab-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--color-bg-secondary);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  padding: var(--spacing-lg);
}

.doc-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-md);
}

.doc-view-toggle {
  display: flex;
  gap: 2px;
}

.doc-view-toggle .toggle-btn {
  padding: var(--spacing-xs) var(--spacing-md);
  font-size: var(--font-size-sm);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: var(--transition-fast);
}

.doc-view-toggle .toggle-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
}

.doc-view-toggle .toggle-btn.active {
  background: var(--color-accent-primary);
  color: white;
  border-color: var(--color-accent-primary);
}

.doc-cards-view {
  flex: 1;
  overflow-y: auto;
}

.image-cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: var(--spacing-lg);
  margin-bottom: var(--spacing-xl);
}

.image-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--spacing-sm);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  cursor: pointer;
  transition: var(--transition-fast);
}

.image-card:hover {
  border-color: var(--color-accent-primary);
  background: var(--color-bg-elevated);
}

.image-card-thumb {
  width: 100%;
  aspect-ratio: 1;
  object-fit: cover;
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-xs);
}

.image-card-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  text-align: center;
  word-break: break-all;
  line-height: 1.3;
}

.other-files-section {
  margin-top: var(--spacing-xl);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--glass-border);
}

.other-files-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
  margin: 0 0 var(--spacing-md);
}

/* Bookmarks panel */
.bookmarks-panel .bookmarks-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.bookmark-tag-filter {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  margin-bottom: var(--spacing-md);
  flex-shrink: 0;
}
.bookmark-tag-filter .filter-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-right: var(--spacing-xs);
}
.bookmark-tag-filter .tag-pill {
  padding: var(--spacing-xs) var(--spacing-sm);
  border-radius: var(--radius-full);
  border: 2px solid var(--glass-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, box-shadow 0.15s, transform 0.1s;
}
.bookmark-tag-filter .tag-pill:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-text-tertiary, var(--color-text-secondary));
}
.bookmark-tag-filter .tag-pill.active {
  background: var(--color-accent-primary);
  border-color: var(--color-accent-primary);
  color: var(--color-bg-primary);
  font-weight: 600;
  box-shadow: 0 0 0 2px var(--color-bg-primary), 0 0 0 4px var(--color-accent-primary);
}
.bookmark-tag-filter .tag-pill.active:hover {
  background: var(--color-accent-primary);
  border-color: var(--color-accent-primary);
  color: var(--color-bg-primary);
  filter: brightness(1.1);
}
.bookmarks-list-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
}
.bookmarks-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.bookmarks-empty-inline {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl);
  min-height: 120px;
  color: var(--color-text-secondary);
  text-align: center;
}
.bookmarks-empty-inline .empty-icon {
  font-size: 2.5rem;
  opacity: 0.6;
  margin-bottom: var(--spacing-sm);
}
.bookmarks-empty-inline p {
  margin: 0 0 var(--spacing-xs);
}
.bookmarks-empty-inline p.text-secondary {
  font-size: var(--font-size-sm);
}
.bookmark-item {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  margin-bottom: var(--spacing-md);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
}
.bookmark-main {
  flex: 1;
  min-width: 0;
}
.bookmark-thumb-row {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
}
.bookmark-thumb {
  width: 80px;
  height: 80px;
  object-fit: cover;
  border-radius: var(--radius-md);
  flex-shrink: 0;
  background: var(--color-bg-tertiary);
}
.bookmark-thumb-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-tertiary);
}
.bookmark-thumb-icon {
  font-size: 2rem;
  opacity: 0.7;
}
.bookmark-download-message {
  padding: var(--spacing-sm) var(--spacing-md);
  margin-bottom: var(--spacing-md);
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  color: var(--color-accent-primary);
  font-size: var(--font-size-sm);
}
.bookmark-download-message.error {
  color: var(--color-error, #e53e3e);
  background: rgba(229, 62, 62, 0.1);
}
.bookmark-text {
  flex: 1;
  min-width: 0;
}
.bookmark-title {
  font-weight: 500;
  color: var(--color-accent-primary);
  text-decoration: none;
  word-break: break-all;
  display: block;
  margin-bottom: var(--spacing-xs);
}
.bookmark-title:hover {
  text-decoration: underline;
}
.bookmark-url {
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
  margin: 0 0 var(--spacing-sm);
  word-break: break-all;
}
.bookmark-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}
.tag-pill {
  font-size: var(--font-size-xs);
  padding: 2px var(--spacing-sm);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
  color: var(--color-text-secondary);
}
.bookmark-actions {
  display: flex;
  gap: var(--spacing-sm);
  flex-shrink: 0;
}

.empty-state.small {
  padding: var(--spacing-lg);
}

.breadcrumb {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
}

.breadcrumb-item {
  background: none;
  border: none;
  color: var(--color-accent-primary);
  cursor: pointer;
  padding: 0;
  font-size: var(--font-size-base);
}

.breadcrumb-item:hover {
  text-decoration: underline;
}

.breadcrumb-chunk {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.breadcrumb-sep {
  color: var(--color-text-tertiary);
}

.doc-list {
  flex: 1;
  overflow-y: auto;
}

.doc-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-sm) var(--spacing-md);
  border-radius: var(--radius-md);
}

.doc-item:hover {
  background: var(--color-bg-tertiary);
}

.doc-item.folder .doc-name {
  cursor: pointer;
  color: var(--color-accent-primary);
}

.doc-item.folder .doc-name:hover {
  text-decoration: underline;
}

.doc-icon {
  font-size: 1.25rem;
}

.doc-name {
  flex: 1;
  text-align: left;
  border: none;
  background: none;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
}

.doc-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
}

.sep {
  color: var(--color-text-tertiary);
}

.link-btn {
  color: var(--color-accent-primary);
  text-decoration: none;
  font-size: var(--font-size-sm);
}

.link-btn:hover {
  text-decoration: underline;
}

.link-btn.danger {
  color: var(--color-error, #e53e3e);
}

.preview-backdrop {
  align-items: center;
  justify-content: center;
}

.preview-modal {
  max-width: 90vw;
  max-height: 90vh;
  width: 900px;
  display: flex;
  flex-direction: column;
}

.preview-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 60%;
}

.preview-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.preview-body {
  flex: 1;
  min-height: 200px;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-tertiary);
}

.preview-image {
  max-width: 100%;
  max-height: 70vh;
  object-fit: contain;
}

.preview-iframe {
  width: 100%;
  height: 70vh;
  border: none;
}
.bookmark-preview-modal .preview-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}
.bookmark-web-iframe {
  width: 100%;
  height: 70vh;
  min-height: 400px;
  border: none;
  background: var(--color-bg-primary);
}

.preview-text {
  width: 100%;
  margin: 0;
  padding: var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-family: var(--font-family-mono, monospace);
  white-space: pre-wrap;
  word-break: break-all;
  text-align: left;
  color: var(--color-text-primary);
}

.delete-confirm-modal {
  max-width: 420px;
}

.delete-target-name {
  font-weight: 600;
  color: var(--color-text-primary);
  margin-top: var(--spacing-sm);
}

.modal-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
}

.btn-danger {
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-error, #e53e3e);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
}

.btn-danger:hover {
  filter: brightness(1.1);
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-2xl);
  color: var(--color-text-secondary);
}

.empty-icon {
  font-size: 3rem;
  margin-bottom: var(--spacing-md);
  opacity: 0.6;
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-bg-elevated);
  border-top-color: var(--color-accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--spacing-md);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: var(--z-modal, 1000);
  padding: var(--spacing-lg);
}

.modal-content {
  background: var(--color-bg-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--glass-border);
  max-width: 480px;
  width: 100%;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--glass-border);
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-xl);
  color: var(--color-text-primary);
}

.close-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  padding: var(--spacing-xs);
}

.close-btn:hover {
  color: var(--color-text-primary);
}

.modal-body {
  padding: var(--spacing-lg);
  overflow-y: auto;
}

.workspace-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.workspace-option {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: var(--transition-fast);
}

.workspace-option:hover,
.workspace-option.active {
  background: var(--color-bg-tertiary);
  color: var(--color-accent-primary);
}

.ws-icon {
  font-size: 1.25rem;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
