<template>
  <div class="settings-tags">
    <h2 class="tab-title">{{ t('settings.tagsManagement') }}</h2>
    <p class="panel-desc">{{ t('settings.tagsManagementDesc') }}</p>

    <div class="tag-form-row">
      <input
        v-model="newTagName"
        type="text"
        class="input tag-input"
        :placeholder="t('settings.tagNamePlaceholder')"
        @keydown.enter="addTag"
      />
      <button type="button" class="btn-primary" :disabled="!newTagName.trim() || saving" @click="addTag">
        {{ t('settings.addTag') }}
      </button>
    </div>
    <p v-if="tagError" class="form-error">{{ tagError }}</p>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>{{ t('common.loading') }}</p>
    </div>
    <div v-else-if="tags.length === 0" class="empty-state">
      <p>{{ t('settings.noTags') }}</p>
    </div>
    <ul v-else class="tag-list">
      <li v-for="tag in tags" :key="tag.id" class="tag-item card-glass">
        <template v-if="editingId === tag.id">
          <input
            v-model="editName"
            type="text"
            class="input tag-edit-input"
            @keydown.enter="saveEdit"
            @keydown.esc="editingId = null"
          />
          <button type="button" class="btn-secondary btn-sm" @click="saveEdit">{{ t('common.save') }}</button>
          <button type="button" class="btn-secondary btn-sm" @click="editingId = null">{{ t('common.cancel') }}</button>
        </template>
        <template v-else>
          <span class="tag-name">{{ tag.name }}</span>
          <button type="button" class="link-btn" @click="startEdit(tag)">{{ t('settings.editTag') }}</button>
          <button type="button" class="link-btn danger" @click="confirmDelete(tag)">{{ t('common.delete') }}</button>
        </template>
      </li>
    </ul>

    <transition name="fade">
      <div v-if="deleteTarget" class="modal-backdrop" @click.self="deleteTarget = null">
        <div class="modal-content card-glass delete-confirm-modal">
          <div class="modal-header">
            <h2>{{ t('common.delete') }}</h2>
            <button type="button" class="close-btn" @click="deleteTarget = null">✕</button>
          </div>
          <div class="modal-body">
            <p>{{ t('settings.deleteTagConfirm') }}</p>
            <p class="delete-target-name">{{ deleteTarget?.name }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="deleteTarget = null">{{ t('common.close') }}</button>
              <button type="button" class="btn-danger" :disabled="deleteSaving" @click="doDelete">{{ t('common.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, onMounted } from 'vue';
import { useI18n } from '@/composables/useI18n';
import { tagsAPI } from '@/api';

export default {
  name: 'SettingsTags',
  setup() {
    const { t } = useI18n();
    const tags = ref([]);
    const loading = ref(false);
    const saving = ref(false);
    const newTagName = ref('');
    const tagError = ref('');
    const editingId = ref(null);
    const editName = ref('');
    const deleteTarget = ref(null);
    const deleteSaving = ref(false);

    async function loadTags() {
      loading.value = true;
      tagError.value = '';
      try {
        const res = await tagsAPI.list();
        tags.value = res.data?.data ?? [];
      } catch (e) {
        tags.value = [];
        tagError.value = e.response?.data?.message || e.message || '加载失败';
      } finally {
        loading.value = false;
      }
    }

    async function addTag() {
      const name = newTagName.value?.trim();
      if (!name || saving.value) return;
      saving.value = true;
      tagError.value = '';
      try {
        await tagsAPI.create({ name });
        newTagName.value = '';
        await loadTags();
      } catch (e) {
        tagError.value = e.response?.data?.message || e.message || '添加失败';
      } finally {
        saving.value = false;
      }
    }

    function startEdit(tag) {
      editingId.value = tag.id;
      editName.value = tag.name;
    }

    async function saveEdit() {
      const id = editingId.value;
      const name = editName.value?.trim();
      if (!id || !name) {
        editingId.value = null;
        return;
      }
      saving.value = true;
      tagError.value = '';
      try {
        await tagsAPI.update(id, { name });
        editingId.value = null;
        await loadTags();
      } catch (e) {
        tagError.value = e.response?.data?.message || e.message || '保存失败';
      } finally {
        saving.value = false;
      }
    }

    function confirmDelete(tag) {
      deleteTarget.value = tag;
    }

    async function doDelete() {
      const tag = deleteTarget.value;
      if (!tag || deleteSaving.value) return;
      deleteSaving.value = true;
      try {
        await tagsAPI.delete(tag.id);
        deleteTarget.value = null;
        await loadTags();
      } catch (e) {
        tagError.value = e.response?.data?.message || e.message || '删除失败';
      } finally {
        deleteSaving.value = false;
      }
    }

    onMounted(loadTags);

    return {
      t,
      tags,
      loading,
      saving,
      newTagName,
      tagError,
      editingId,
      editName,
      deleteTarget,
      deleteSaving,
      addTag,
      startEdit,
      saveEdit,
      confirmDelete,
      doDelete,
    };
  },
};
</script>

<style scoped>
.settings-tags {
  padding-bottom: var(--spacing-2xl);
}
.tab-title {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  margin-bottom: var(--spacing-md);
  color: var(--color-text-primary);
}
.panel-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-lg);
}
.tag-form-row {
  display: flex;
  gap: var(--spacing-md);
  align-items: center;
  margin-bottom: var(--spacing-md);
}
.tag-input {
  flex: 1;
  max-width: 280px;
}
.tag-list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.tag-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  margin-bottom: var(--spacing-sm);
  border-radius: var(--radius-md);
}
.tag-name {
  flex: 1;
  font-weight: 500;
}
.tag-edit-input {
  flex: 1;
  max-width: 200px;
}
.btn-sm {
  padding: var(--spacing-xs) var(--spacing-md);
  font-size: var(--font-size-sm);
}
.link-btn {
  background: none;
  border: none;
  color: var(--color-accent-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
}
.link-btn:hover {
  text-decoration: underline;
}
.link-btn.danger {
  color: var(--color-danger, #e5534b);
}
.delete-target-name {
  font-weight: 600;
  margin: var(--spacing-sm) 0;
}
.modal-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-md);
  margin-top: var(--spacing-lg);
}
.loading-state,
.empty-state {
  padding: var(--spacing-2xl);
  text-align: center;
  color: var(--color-text-secondary);
}
.form-error {
  color: var(--color-danger, #e5534b);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-md);
}
</style>
