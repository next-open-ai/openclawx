<template>
  <div class="agents-view">
    <div class="agents-header card-glass">
      <div class="header-left">
        <h1 class="view-title">{{ t('agents.title') }}</h1>
        <p class="text-secondary">{{ t('agents.subtitle') }}</p>
        <p class="text-secondary agents-hint">{{ t('agents.defaultWorkHint') }}</p>
      </div>
      <button type="button" class="btn-add-agent" @click="showCreateModal = true">
        <span class="btn-icon">+</span>
        {{ t('agents.addAgent') }}
      </button>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>{{ t('common.loading') }}</p>
    </div>
    <div v-else-if="agents.length === 0" class="empty-state">
      <div class="empty-icon">✨</div>
      <p>{{ t('agents.noAgents') }}</p>
      <p class="text-secondary">{{ t('agents.noAgentsHint') }}</p>
      <button class="btn-primary mt-4" @click="showCreateModal = true">
        {{ t('agents.addAgent') }}
      </button>
    </div>
    <div v-else class="agents-grid">
      <router-link
        v-for="agent in agents"
        :key="agent.id"
        :to="`/agents/${agent.id}`"
        class="agent-card card-glass"
      >
        <div class="card-icon-wrap">
          <span class="card-icon" :aria-label="getAgentIconEmoji(agent.icon)">{{ getAgentIconEmoji(agent.icon) }}</span>
        </div>
        <h3 class="card-name">
          {{ agent.name }}
          <span v-if="agent.isDefault" class="card-badge">{{ t('agents.defaultBadge') }}</span>
        </h3>
        <p class="card-workspace">
          <span class="ws-label">{{ t('agents.workspace') }}:</span>
          <code>{{ agent.workspace }}</code>
        </p>
        <p v-if="agent.provider || agent.model" class="card-llm text-secondary">
          {{ agent.provider || '-' }} / {{ agent.model || '-' }}
        </p>
        <span class="card-arrow">→</span>
      </router-link>
    </div>

    <!-- 新增智能体弹窗 -->
    <transition name="fade">
      <div v-if="showCreateModal" class="modal-backdrop" @click.self="showCreateModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('agents.createAgent') }}</h2>
            <button type="button" class="close-btn" @click="showCreateModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('agents.agentIcon') }}</label>
              <div class="icon-picker">
                <button
                  v-for="opt in agentIconOptions"
                  :key="opt.id"
                  type="button"
                  class="icon-picker-btn"
                  :class="{ active: createForm.icon === opt.id }"
                  :title="opt.label"
                  @click="createForm.icon = opt.id"
                >
                  {{ opt.emoji }}
                </button>
              </div>
            </div>
            <div class="form-group">
              <label>{{ t('agents.displayName') }}</label>
              <input
                v-model="createForm.name"
                type="text"
                class="form-input"
                :placeholder="t('agents.displayNamePlaceholder')"
              />
            </div>
            <div class="form-group">
              <label>{{ t('agents.workspaceName') }}</label>
              <input
                v-model="createForm.workspace"
                type="text"
                class="form-input"
                :placeholder="t('agents.workspaceNamePlaceholder')"
              />
              <p class="form-hint">{{ t('agents.workspaceNameHint') }}</p>
            </div>
            <div class="form-group">
              <label>{{ t('agents.defaultModel') }}</label>
              <select v-model="createForm.defaultModelKey" class="form-input">
                <option value="">— {{ t('agents.defaultModelCreateHint') }} —</option>
                <option
                  v-for="item in createModelOptions"
                  :key="optionValueFor(item)"
                  :value="optionValueFor(item)"
                >
                  {{ getModelOptionLabel(item) }}
                </option>
              </select>
              <p class="form-hint">{{ t('agents.modelConfigHint') }}</p>
            </div>
            <div class="form-group">
              <label>{{ t('agents.agentDescription') }}</label>
              <textarea
                v-model="createForm.systemPrompt"
                class="form-input form-textarea"
                :placeholder="t('agents.agentDescriptionPlaceholder')"
                rows="4"
              />
              <p class="form-hint">{{ t('agents.agentDescriptionHint') }}</p>
            </div>
            <p v-if="createError" class="form-error">{{ createError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showCreateModal = false">
                {{ t('common.close') }}
              </button>
              <button type="button" class="btn-primary" :disabled="createSaving" @click="doCreate">
                {{ createSaving ? t('common.loading') : t('agents.create') }}
              </button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed, onMounted, watch } from 'vue';
import { useRouter } from 'vue-router';
import { useI18n } from '@/composables/useI18n';
import { agentConfigAPI, configAPI } from '@/api';
import { AGENT_ICONS, AGENT_ICON_DEFAULT, getAgentIconEmoji } from '@/constants/agent-icons';

/** 主智能体（default）前端兜底，接口失败或返回空时至少显示此项 */
const FALLBACK_DEFAULT_AGENT = {
  id: 'default',
  name: '主智能体',
  workspace: 'default',
  isDefault: true,
};

function keyFor(provider, modelId) {
  return (provider || '') + '::' + (modelId || '');
}

export default {
  name: 'Agents',
  setup() {
    const { t } = useI18n();
    const router = useRouter();
    const agents = ref([]);
    const loading = ref(true);
    const showCreateModal = ref(false);
    const config = ref(null);
    const agentIconOptions = AGENT_ICONS;
    const createForm = ref({
      name: '',
      workspace: '',
      defaultModelKey: '',
      systemPrompt: '',
      icon: AGENT_ICON_DEFAULT,
    });
    const createError = ref('');
    const createSaving = ref(false);

    const createModelOptions = computed(() => {
      const list = config.value?.configuredModels ?? [];
      return Array.isArray(list) ? list : [];
    });

    function optionValueFor(item) {
      if (!item) return '';
      if (item.modelItemCode) return item.modelItemCode;
      return keyFor(item.provider, item.modelId);
    }

    function getModelOptionLabel(item) {
      if (!item) return '';
      const prov = item.provider || item.providerName || '';
      const model = item.modelId || item.model || '';
      return prov && model ? `${prov} / ${model}` : model || prov || '—';
    }

    function ensureMainAgentFirst(list) {
      const rest = (Array.isArray(list) ? list : []).filter((a) => a && a.id !== 'default');
      const mainFromList = (Array.isArray(list) ? list : []).find((a) => a && a.id === 'default');
      const main = mainFromList ? { ...mainFromList, isDefault: true } : { ...FALLBACK_DEFAULT_AGENT };
      return [main, ...rest];
    }

    async function loadAgents() {
      loading.value = true;
      try {
        const res = await agentConfigAPI.listAgents();
        const list = res.data?.data ?? [];
        agents.value = ensureMainAgentFirst(list.length > 0 ? list : [FALLBACK_DEFAULT_AGENT]);
      } catch (e) {
        console.error('List agents failed', e);
        agents.value = [FALLBACK_DEFAULT_AGENT];
      } finally {
        loading.value = false;
      }
    }

    async function doCreate() {
      const name = (createForm.value.name || '').trim();
      const workspace = (createForm.value.workspace || '').trim();
      if (!workspace) {
        createError.value = t('agents.workspaceNameRequired');
        return;
      }
      if (workspace.toLowerCase() === 'default') {
        createError.value = t('agents.workspaceReservedForDefault');
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(workspace)) {
        createError.value = t('agents.workspaceNameFormat');
        return;
      }
      createError.value = '';
      createSaving.value = true;
      try {
        const body = {
          name: name || workspace,
          workspace,
          systemPrompt: (createForm.value.systemPrompt || '').trim() || undefined,
          icon: createForm.value.icon || undefined,
        };
        const key = (createForm.value.defaultModelKey || '').trim();
        const list = config.value?.configuredModels ?? [];
        if (key && Array.isArray(list) && list.length > 0) {
          const byCode = list.find((m) => m.modelItemCode === key);
          const byKey = list.find((m) => keyFor(m.provider, m.modelId) === key);
          const item = byCode || byKey;
          if (item) {
            body.provider = item.provider;
            body.model = item.modelId;
            body.modelItemCode = item.modelItemCode;
          }
        }
        if (!body.provider && (config.value?.defaultProvider || config.value?.defaultModel)) {
          body.provider = config.value.defaultProvider;
          body.model = config.value.defaultModel;
          body.modelItemCode = config.value.defaultModelItemCode;
        }
        const res = await agentConfigAPI.createAgent(body);
        const agent = res.data?.data;
        showCreateModal.value = false;
        createForm.value = { name: '', workspace: '', defaultModelKey: '', systemPrompt: '', icon: AGENT_ICON_DEFAULT };
        await loadAgents();
        if (agent) router.push(`/agents/${agent.id}`);
      } catch (e) {
        const msg = e.response?.data?.message || e.message || 'Create failed';
        createError.value = typeof msg === 'string' ? msg : JSON.stringify(msg);
      } finally {
        createSaving.value = false;
      }
    }

    async function loadConfig() {
      try {
        const res = await configAPI.getConfig();
        config.value = res.data?.data ?? res.data ?? null;
      } catch (_) {
        config.value = null;
      }
    }

    watch(showCreateModal, (visible) => {
      if (visible) loadConfig();
    });

    onMounted(loadAgents);

    return {
      t,
      agents,
      loading,
      showCreateModal,
      createForm,
      createError,
      createSaving,
      createModelOptions,
      agentIconOptions,
      getAgentIconEmoji,
      optionValueFor,
      getModelOptionLabel,
      doCreate,
    };
  },
};
</script>

<style scoped>
.agents-view {
  width: 100%;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: var(--spacing-lg);
  overflow: hidden;
}

.agents-header {
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

.agents-hint {
  font-size: var(--font-size-sm);
  margin-top: var(--spacing-xs);
  opacity: 0.9;
}

.btn-add-agent {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-accent-primary);
  background: transparent;
  border: 1px solid var(--color-accent-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.btn-add-agent:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-color: var(--color-accent-secondary);
}

.btn-primary {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-accent-primary);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
  transition: var(--transition-fast);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.icon-picker {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.icon-picker-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 1.25rem;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.icon-picker-btn:hover {
  background: var(--color-bg-elevated);
  border-color: var(--color-text-tertiary);
}

.icon-picker-btn.active {
  background: rgba(102, 126, 234, 0.2);
  border-color: var(--color-accent-primary);
}

.btn-primary:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-icon {
  font-size: 1.25rem;
  line-height: 1;
}

.agents-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-lg);
  overflow-y: auto;
}

.agent-card {
  display: flex;
  flex-direction: column;
  padding: var(--spacing-xl);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  text-decoration: none;
  color: inherit;
  transition: var(--transition-fast);
  position: relative;
}

.agent-card:hover {
  border-color: var(--color-accent-primary);
  box-shadow: var(--shadow-md);
}

.card-icon-wrap {
  width: 48px;
  height: 48px;
  border-radius: var(--radius-lg);
  background: var(--color-bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--spacing-md);
}

.card-icon {
  font-size: 1.75rem;
}

.card-name {
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin: 0 0 var(--spacing-sm) 0;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  flex-wrap: wrap;
}

.card-badge {
  font-size: var(--font-size-xs);
  font-weight: 500;
  padding: 0.15em 0.5em;
  border-radius: var(--radius-sm);
  background: var(--color-accent-primary);
  color: white;
  opacity: 0.9;
}

.card-workspace {
  font-size: var(--font-size-sm);
  margin: 0 0 var(--spacing-xs) 0;
  color: var(--color-text-secondary);
}

.card-workspace code {
  background: var(--color-bg-tertiary);
  padding: 0.1em 0.4em;
  border-radius: var(--radius-sm);
  font-size: 0.9em;
}

.ws-label {
  margin-right: var(--spacing-xs);
}

.card-llm {
  font-size: var(--font-size-xs);
  margin: 0;
}

.card-arrow {
  position: absolute;
  top: var(--spacing-lg);
  right: var(--spacing-lg);
  font-size: 1.25rem;
  color: var(--color-text-tertiary);
}

.agent-card:hover .card-arrow {
  color: var(--color-accent-primary);
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

.mt-4 {
  margin-top: var(--spacing-lg);
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
  to {
    transform: rotate(360deg);
  }
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
  max-width: 420px;
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

.form-group {
  margin-bottom: var(--spacing-lg);
}

.form-group label {
  display: block;
  margin-bottom: var(--spacing-xs);
  font-weight: 500;
  color: var(--color-text-primary);
}

.form-input {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
}

.form-input.form-textarea {
  min-height: 88px;
  resize: vertical;
}

.form-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
  margin: var(--spacing-xs) 0 0 0;
}

.form-error {
  color: var(--color-error);
  font-size: var(--font-size-sm);
  margin-bottom: var(--spacing-md);
}

.modal-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
}

.btn-secondary {
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--color-bg-elevated);
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
