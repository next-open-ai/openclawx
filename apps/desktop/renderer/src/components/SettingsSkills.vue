<template>
  <div class="settings-skills">
    <h2 class="tab-title">{{ t('settings.skillsTab') }}</h2>

    <!-- 子 Tab：系统技能 | 全局技能 -->
    <div class="skills-sub-tabs">
      <button
        class="sub-tab-btn"
        :class="{ active: skillsSubTab === 'system' }"
        @click="skillsSubTab = 'system'"
      >
        {{ t('skills.sources.system') }}
      </button>
      <button
        class="sub-tab-btn"
        :class="{ active: skillsSubTab === 'global' }"
        @click="skillsSubTab = 'global'"
      >
        {{ t('skills.sources.global') }}
      </button>
    </div>

    <!-- 系统技能：只读列表 + 详情 -->
    <div v-show="skillsSubTab === 'system'" class="skills-panel">
      <p class="panel-desc">{{ t('skills.sources.systemDesc') }}</p>
      <div v-if="systemLoading" class="loading-state"><div class="spinner"></div><p>{{ t('common.loading') }}</p></div>
      <div v-else-if="systemSkills.length === 0" class="empty-state">
        <p>{{ t('skills.noSkills') }}</p>
      </div>
      <div v-else class="skills-grid">
        <SkillCard
          v-for="s in systemSkills"
          :key="s.name"
          :skill="s"
          @click="openDetail(s)"
        />
      </div>
    </div>

    <!-- 全局技能：列表 + 手动安装 + 智能安装 + 删除 + 详情 -->
    <div v-show="skillsSubTab === 'global'" class="skills-panel">
      <div class="panel-toolbar">
        <p class="panel-desc">{{ t('skills.sources.globalDesc') }}</p>
        <div class="panel-actions">
          <button type="button" class="btn-secondary" @click="openSmartInstall">{{ t('agents.installSmart') }}</button>
          <button type="button" class="btn-secondary" @click="showLocalInstallModal = true">{{ t('agents.installLocal') }}</button>
          <button v-if="false" type="button" class="btn-primary" @click="openManualInstall">{{ t('agents.installManual') }}</button>
        </div>
      </div>
      <div v-if="globalLoading" class="loading-state"><div class="spinner"></div><p>{{ t('common.loading') }}</p></div>
      <div v-else-if="globalSkills.length === 0" class="empty-state">
        <p>{{ t('skills.noSkills') }}</p>
        <div class="empty-actions">
          <button class="btn-secondary" @click="openSmartInstall">{{ t('agents.installSmart') }}</button>
          <button class="btn-secondary" @click="showLocalInstallModal = true">{{ t('agents.installLocal') }}</button>
          <button v-if="false" class="btn-primary" @click="openManualInstall">{{ t('agents.installManual') }}</button>
        </div>
      </div>
      <div v-else class="skills-grid">
        <div
          v-for="s in globalSkills"
          :key="s.name"
          class="skill-card-wrap"
        >
          <SkillCard :skill="s" @click="openDetail(s)" />
          <button type="button" class="link-btn danger skill-delete" @click.stop="confirmDelete(s)">{{ t('common.delete') }}</button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗（共用） -->
    <transition name="fade">
      <div v-if="detailSkill" class="modal-backdrop" @click.self="detailSkill = null">
        <div class="modal-content card-glass skill-detail-modal">
          <div class="modal-header">
            <h2>{{ detailSkill.name }}</h2>
            <button type="button" class="close-btn" @click="detailSkill = null">✕</button>
          </div>
          <div class="modal-body">
            <div v-if="detailContent" class="skill-documentation markdown-body" v-html="detailContentRendered"></div>
            <div v-else class="no-content">{{ t('skills.noDocumentation') }}</div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 手动安装弹窗 -->
    <transition name="fade">
      <div v-if="showManualModal" class="modal-backdrop" @click.self="showManualModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('agents.installManual') }}</h2>
            <button type="button" class="close-btn" @click="showManualModal = false">✕</button>
          </div>
          <div class="modal-body">
            <p class="form-hint">{{ t('agents.installManualHint') }}</p>
            <div class="form-group">
              <label>{{ t('agents.skillGitUrl') }}</label>
              <input v-model="manualUrl" type="text" class="input" :placeholder="t('agents.skillGitUrlPlaceholder')" />
            </div>
            <p v-if="installError" class="form-error">{{ installError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showManualModal = false">{{ t('common.close') }}</button>
              <button type="button" class="btn-primary" :disabled="manualSaving" @click="doManualInstall">{{ manualSaving ? t('common.loading') : t('agents.installConfirm') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 删除确认 -->
    <transition name="fade">
      <div v-if="deleteTarget" class="modal-backdrop" @click.self="deleteTarget = null">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('common.delete') }}</h2>
            <button type="button" class="close-btn" @click="deleteTarget = null">✕</button>
          </div>
          <div class="modal-body">
            <p>{{ t('agents.deleteSkillConfirm') }}</p>
            <p class="delete-target-name">{{ deleteTarget?.name }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="deleteTarget = null">{{ t('common.close') }}</button>
              <button type="button" class="btn-danger" :disabled="deleteSaving" @click="doDelete">{{ deleteSaving ? t('common.loading') : t('common.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 智能安装弹窗：复用 Agent 智能安装，传 targetAgentId=global 安装到全局 skills 目录 -->
    <SmartInstallDialog
      v-if="showSmartModal"
      target-agent-id="global"
      session-id="skill-install-global"
      :dialog-title="smartInstallDialogTitle"
      @close="closeSmartInstall"
      @installed="loadAllSkills"
    />
    <!-- 本地文件安装：选择目录安装到全局 -->
    <LocalInstallSkillDialog
      :show="showLocalInstallModal"
      scope="global"
      @close="showLocalInstallModal = false"
      @installed="onLocalInstalled"
    />
    <!-- 本地安装成功提示 -->
    <transition name="fade">
      <div v-if="installSuccessPayload" class="modal-backdrop" @click.self="installSuccessPayload = null">
        <div class="modal-content card-glass install-success-modal">
          <div class="modal-header">
            <h2>{{ t('agents.installSuccess') }}</h2>
            <button type="button" class="close-btn" @click="installSuccessPayload = null">✕</button>
          </div>
          <div class="modal-body">
            <p v-if="installSuccessPayload?.name" class="install-success-row">
              <span class="label">{{ t('agents.installSuccessName') }}:</span>
              <span class="value">{{ installSuccessPayload.name }}</span>
            </p>
            <p class="install-success-row install-success-dir">
              <span class="label">{{ t('agents.installSuccessDir') }}:</span>
              <span class="value dir" :title="installSuccessPayload?.installDir">{{ installSuccessPayload?.installDir }}</span>
            </p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-primary" @click="installSuccessPayload = null">{{ t('common.confirm') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed, watch, onMounted } from 'vue';
import { useI18n } from '@/composables/useI18n';
import { useAgentStore } from '@/store/modules/agent';
import { skillsAPI } from '@/api';
import { marked } from 'marked';
import SkillCard from '@/components/SkillCard.vue';
import SmartInstallDialog from '@/components/SmartInstallDialog.vue';
import LocalInstallSkillDialog from '@/components/LocalInstallSkillDialog.vue';

export default {
  name: 'SettingsSkills',
  components: { SkillCard, SmartInstallDialog, LocalInstallSkillDialog },
  setup() {
    const { t } = useI18n();
    const agentStore = useAgentStore();

    const skillsSubTab = ref('system');
    const allSkills = ref([]);
    const systemLoading = ref(false);
    const globalLoading = ref(false);
    const detailSkill = ref(null);
    const detailContent = ref('');
    const showManualModal = ref(false);
    const manualUrl = ref('');
    const installError = ref('');
    const manualSaving = ref(false);
    const deleteTarget = ref(null);
    const deleteSaving = ref(false);
    const showSmartModal = ref(false);
    const showLocalInstallModal = ref(false);
    const installSuccessPayload = ref(null);

    const systemSkills = computed(() => allSkills.value.filter((s) => (s.source || 'system') === 'system'));
    const globalSkills = computed(() => allSkills.value.filter((s) => (s.source || 'global') === 'global'));
    const detailContentRendered = computed(() => (detailContent.value ? marked(detailContent.value) : ''));
    const smartInstallDialogTitle = computed(() => `${t('agents.installSmart')} (${t('skills.sources.global')})`);

    async function loadAllSkills() {
      systemLoading.value = true;
      globalLoading.value = true;
      try {
        const res = await skillsAPI.getSkills();
        allSkills.value = res.data?.data ?? [];
      } catch (e) {
        allSkills.value = [];
      } finally {
        systemLoading.value = false;
        globalLoading.value = false;
      }
    }

    async function loadGlobalOnly() {
      globalLoading.value = true;
      try {
        const res = await skillsAPI.getSkills(undefined, 'global');
        const global = res.data?.data ?? [];
        allSkills.value = [...allSkills.value.filter((s) => (s.source || '') !== 'global'), ...global];
      } catch (e) {
        // keep previous
      } finally {
        globalLoading.value = false;
      }
    }

    function openDetail(skill) {
      detailSkill.value = skill;
      detailContent.value = '';
      skillsAPI.getSkillContent(skill.name).then((r) => { detailContent.value = r.data?.data?.content ?? ''; }).catch(() => {});
    }

    function onLocalInstalled(payload) {
      loadAllSkills();
      installSuccessPayload.value = payload && (payload.installDir || payload.name) ? payload : null;
    }

    function openManualInstall() {
      manualUrl.value = '';
      installError.value = '';
      showManualModal.value = true;
    }

    async function doManualInstall() {
      const url = (manualUrl.value || '').trim();
      if (!url) {
        installError.value = t('agents.skillGitUrl');
        return;
      }
      installError.value = '';
      manualSaving.value = true;
      try {
        await skillsAPI.installSkill(url, { scope: 'global' });
        showManualModal.value = false;
        manualUrl.value = '';
        await loadAllSkills();
      } catch (e) {
        installError.value = e.response?.data?.message || e.message || t('agents.installFailed');
      } finally {
        manualSaving.value = false;
      }
    }

    function confirmDelete(skill) {
      deleteTarget.value = skill;
    }

    async function doDelete() {
      if (!deleteTarget.value) return;
      deleteSaving.value = true;
      try {
        await skillsAPI.deleteSkill(undefined, deleteTarget.value.name, 'global');
        deleteTarget.value = null;
        await loadAllSkills();
      } catch (e) {
        console.error(e);
      } finally {
        deleteSaving.value = false;
      }
    }

    function openSmartInstall() {
      agentStore.clearCurrentSession();
      showSmartModal.value = true;
    }

    function closeSmartInstall() {
      showSmartModal.value = false;
    }

    watch(skillsSubTab, (tab) => {
      if (tab === 'global') loadGlobalOnly();
    });
    onMounted(() => {
      loadAllSkills();
    });

    return {
      t,
      skillsSubTab,
      systemSkills,
      globalSkills,
      systemLoading,
      globalLoading,
      detailSkill,
      detailContent,
      detailContentRendered,
      openDetail,
      showManualModal,
      manualUrl,
      installError,
      manualSaving,
      openManualInstall,
      doManualInstall,
      deleteTarget,
      deleteSaving,
      confirmDelete,
      doDelete,
      showSmartModal,
      showLocalInstallModal,
      installSuccessPayload,
      onLocalInstalled,
      openSmartInstall,
      closeSmartInstall,
      smartInstallDialogTitle,
    };
  },
};
</script>

<style scoped>
.install-success-modal {
  max-width: 520px;
}
.install-success-row {
  margin: var(--spacing-sm) 0;
}
.install-success-row .label {
  color: var(--color-text-secondary);
  margin-right: var(--spacing-sm);
}
.install-success-row .value.dir {
  word-break: break-all;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}
.install-success-dir {
  margin-top: var(--spacing-md);
}

.settings-skills {
  padding-bottom: var(--spacing-2xl);
}
.tab-title {
  font-size: var(--font-size-2xl);
  font-weight: 600;
  margin-bottom: var(--spacing-xl);
  color: var(--color-text-primary);
}
.skills-sub-tabs {
  display: flex;
  gap: 4px;
  margin-bottom: var(--spacing-xl);
  border-bottom: 1px solid var(--glass-border);
}
.sub-tab-btn {
  padding: var(--spacing-sm) var(--spacing-lg);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-base);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color 0.15s, border-color 0.15s;
}
.sub-tab-btn:hover {
  color: var(--color-text-primary);
}
.sub-tab-btn.active {
  color: var(--color-accent-primary);
  font-weight: 600;
  border-bottom-color: var(--color-accent-primary);
}
.panel-desc {
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-lg);
}
.panel-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-lg);
}
.panel-toolbar .panel-desc {
  margin-bottom: 0;
}
.panel-actions {
  display: flex;
  gap: var(--spacing-sm);
}
.loading-state, .empty-state {
  padding: var(--spacing-2xl);
  text-align: center;
  color: var(--color-text-secondary);
}
.spinner {
  width: 36px;
  height: 36px;
  border: 3px solid var(--color-bg-elevated);
  border-top-color: var(--color-accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto var(--spacing-md);
}
@keyframes spin { to { transform: rotate(360deg); } }
.empty-actions {
  margin-top: var(--spacing-md);
  display: flex;
  gap: var(--spacing-sm);
  justify-content: center;
}
.skills-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: var(--spacing-lg);
}
.skill-card-wrap {
  position: relative;
}
.skill-card-wrap .skill-delete {
  position: absolute;
  bottom: var(--spacing-sm);
  right: var(--spacing-sm);
  font-size: var(--font-size-xs);
}
.link-btn.danger {
  color: var(--color-error, #e53e3e);
}
.btn-primary, .btn-secondary {
  padding: var(--spacing-sm) var(--spacing-lg);
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
}
.btn-primary {
  background: var(--color-accent-primary);
  color: white;
  border: none;
}
.btn-secondary {
  background: transparent;
  border: 1px solid var(--glass-border);
  color: var(--color-text-primary);
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: var(--spacing-lg);
}
.modal-content {
  background: var(--color-bg-primary);
  border-radius: var(--radius-xl);
  border: 1px solid var(--glass-border);
  max-width: 560px;
  width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.skill-detail-modal {
  max-width: 900px;
  max-height: 85vh;
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
}
.close-btn {
  background: none;
  border: none;
  font-size: 1.25rem;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.modal-body {
  padding: var(--spacing-lg);
  overflow-y: auto;
}
.skill-documentation :deep(h1) { font-size: 1.5em; margin: 0 0 0.5em 0; }
.skill-documentation :deep(h2) { font-size: 1.25em; margin: 1em 0 0.5em 0; }
.skill-documentation :deep(p) { margin-bottom: 0.75em; }
.skill-documentation :deep(pre) { background: var(--color-bg-tertiary); padding: var(--spacing-md); border-radius: var(--radius-md); overflow-x: auto; }
.form-group { margin-bottom: var(--spacing-md); }
.form-group label { display: block; font-size: var(--font-size-sm); color: var(--color-text-secondary); margin-bottom: var(--spacing-xs); }
.input { width: 100%; padding: var(--spacing-md); border: 1px solid var(--glass-border); border-radius: var(--radius-md); background: var(--color-bg-primary); color: var(--color-text-primary); }
.form-error { color: var(--color-error, #e53e3e); font-size: var(--font-size-sm); margin: 0 0 var(--spacing-md) 0; }
.modal-footer-actions { display: flex; justify-content: flex-end; gap: var(--spacing-md); margin-top: var(--spacing-lg); }
.btn-danger { padding: var(--spacing-sm) var(--spacing-lg); background: var(--color-error, #e53e3e); color: white; border: none; border-radius: var(--radius-md); cursor: pointer; }
.delete-target-name { font-weight: 600; margin-top: var(--spacing-sm); }

.fade-enter-active, .fade-leave-active { transition: opacity 0.2s ease; }
.fade-enter-from, .fade-leave-to { opacity: 0; }
</style>
