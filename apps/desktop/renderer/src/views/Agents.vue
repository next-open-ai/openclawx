<template>
  <div class="agents-view">
    <div class="agents-header card-glass">
      <div class="header-left">
        <h1 class="view-title">{{ t('agents.title') }}</h1>
        <p class="text-secondary">{{ t('agents.subtitle') }}</p>
      </div>
      <button
        v-if="agentTab === 'local'"
        type="button"
        class="btn-add-agent"
        @click="showCreateModal = true"
      >
        <span class="btn-icon">+</span>
        {{ t('agents.addAgent') }}
      </button>
      <button
        v-else
        type="button"
        class="btn-add-agent"
        @click="showCreateProxyModal = true"
      >
        <span class="btn-icon">+</span>
        {{ t('agents.addProxyAgent') }}
      </button>
    </div>

    <div class="agents-layout">
      <nav class="agents-sidebar card-glass">
        <button
          type="button"
          class="agents-tab-btn"
          :class="{ active: agentTab === 'local' }"
          @click="agentTab = 'local'"
        >
          <span class="tab-icon">✨</span>
          <span class="tab-label">{{ t('agents.localAgents') }}</span>
        </button>
        <button
          type="button"
          class="agents-tab-btn"
          :class="{ active: agentTab === 'proxy' }"
          @click="agentTab = 'proxy'"
        >
          <span class="tab-icon">🔗</span>
          <span class="tab-label">{{ t('agents.proxyAgents') }}</span>
        </button>
      </nav>
      <div class="agents-main">
        <p class="tab-hint text-secondary">
          {{ agentTab === 'local' ? t('agents.localAgentsHint') : t('agents.proxyAgentsHint') }}
        </p>
        <div class="agents-content">
        <div v-if="loading" class="loading-state">
          <div class="spinner"></div>
          <p>{{ t('common.loading') }}</p>
        </div>
        <template v-else-if="agentTab === 'local'">
          <div v-if="localAgents.length === 0" class="empty-state">
            <div class="empty-icon">✨</div>
            <p>{{ t('agents.noAgents') }}</p>
            <p class="text-secondary">{{ t('agents.noAgentsHint') }}</p>
            <button class="btn-primary mt-4" @click="showCreateModal = true">
              {{ t('agents.addAgent') }}
            </button>
          </div>
          <div v-else class="agents-grid">
            <router-link
              v-for="agent in localAgents"
              :key="agent.id"
              :to="`/agents/${agent.id}`"
              class="agent-card card-glass"
            >
              <div class="card-icon-wrap">
                <span class="card-icon" :aria-label="getAgentIconEmoji(agent.icon)">{{ getAgentIconEmoji(agent.icon) }}</span>
              </div>
              <h3 class="card-name">
                {{ agent.name }}
                <span v-if="agent.isDefault" class="card-badge card-badge-default">{{ t('agents.defaultBadge') }}</span>
              </h3>
              <p class="card-workspace">
                <span class="ws-label">{{ t('agents.workspace') }}:</span>
                <code>{{ agent.workspace }}</code>
              </p>
              <p class="card-llm text-secondary">
                {{ (agent.provider && agent.model) ? `${agent.provider} / ${agent.model}` : t('agents.runnerTypeLocalShort') }}
              </p>
              <span class="card-arrow" aria-hidden="true">→</span>
            </router-link>
          </div>
        </template>
        <template v-else>
          <div v-if="proxyAgents.length === 0" class="empty-state">
            <div class="empty-icon">🔗</div>
            <p>{{ t('agents.noProxyAgents') }}</p>
            <p class="text-secondary">{{ t('agents.noProxyAgentsHint') }}</p>
            <button class="btn-primary mt-4" @click="showCreateProxyModal = true">
              {{ t('agents.addProxyAgent') }}
            </button>
          </div>
          <div v-else class="agents-grid">
            <router-link
              v-for="agent in proxyAgents"
              :key="agent.id"
              :to="`/agents/${agent.id}?tab=proxy`"
              class="agent-card card-glass agent-card-proxy"
            >
              <div class="card-icon-wrap card-icon-wrap-proxy">
                <span class="card-icon">🔗</span>
              </div>
              <h3 class="card-name">
                {{ agent.name }}
                <span class="card-badge proxy-badge">{{ proxyTypeLabel(agent) }}</span>
              </h3>
              <p class="card-workspace">
                <span class="ws-label">{{ t('agents.workspace') }}:</span>
                <code>{{ agent.workspace }}</code>
              </p>
              <p class="card-llm text-secondary">
                {{ proxyTypeLabel(agent) }}
              </p>
              <span class="card-arrow" aria-hidden="true">→</span>
            </router-link>
          </div>
        </template>
        </div>
      </div>
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

    <!-- 新增代理智能体弹窗 -->
    <transition name="fade">
      <div v-if="showCreateProxyModal" class="modal-backdrop" @click.self="showCreateProxyModal = false">
        <div class="modal-content card-glass modal-content-wide">
          <div class="modal-header">
            <h2>{{ t('agents.createProxyAgent') }}</h2>
            <button type="button" class="close-btn" @click="showCreateProxyModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('agents.displayName') }}</label>
              <input
                v-model="proxyCreateForm.name"
                type="text"
                class="form-input"
                :placeholder="t('agents.displayNamePlaceholder')"
              />
            </div>
            <div class="form-group">
              <label>{{ t('agents.workspaceName') }}</label>
              <input
                v-model="proxyCreateForm.workspace"
                type="text"
                class="form-input"
                :placeholder="t('agents.workspaceNamePlaceholder')"
              />
              <p class="form-hint">{{ t('agents.workspaceNameHint') }}</p>
            </div>
            <div class="form-group">
              <label>{{ t('agents.runnerType') }}</label>
              <select v-model="proxyCreateForm.runnerType" class="form-input">
                <option value="coze">{{ t('agents.runnerTypeCoze') }}</option>
                <option value="openclawx">{{ t('agents.runnerTypeOpenclawx') }}</option>
              </select>
            </div>
            <template v-if="proxyCreateForm.runnerType === 'coze'">
              <div class="form-group">
                <label>{{ t('agents.cozeRegion') }}</label>
                <select v-model="proxyCreateForm.coze.region" class="form-input">
                  <option value="com">{{ t('agents.cozeRegionCom') }}</option>
                  <option value="cn">{{ t('agents.cozeRegionCn') }}</option>
                </select>
                <p class="form-hint">{{ t('agents.cozeRegionHint') }}</p>
                <p class="form-hint">{{ t('agents.cozeTokenTypesHint') }}</p>
              </div>
              <template v-if="proxyCreateForm.coze.region === 'cn'">
                <div class="form-group">
                  <label>{{ t('agents.cozeBotId') }}（{{ t('agents.cozeRegionCn') }}）</label>
                  <input
                    v-model="proxyCreateForm.coze.cn.botId"
                    type="text"
                    class="form-input"
                    :placeholder="t('agents.cozeBotIdPlaceholder')"
                  />
                  <p class="form-hint">{{ t('agents.cozeBotIdHint') }}</p>
                </div>
                <div class="form-group">
                  <label>{{ t('agents.cozeApiKey') }}（{{ t('agents.cozeRegionCn') }}）</label>
                  <input
                    v-model="proxyCreateForm.coze.cn.apiKey"
                    type="password"
                    class="form-input"
                    :placeholder="t('agents.cozeApiKeyPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="form-hint">{{ t('agents.cozeAccessTokenHint') }}</p>
                </div>
              </template>
              <template v-if="proxyCreateForm.coze.region === 'com'">
                <div class="form-group">
                  <label>{{ t('agents.cozeBotId') }}（{{ t('agents.cozeRegionCom') }}）</label>
                  <input
                    v-model="proxyCreateForm.coze.com.botId"
                    type="text"
                    class="form-input"
                    :placeholder="t('agents.cozeBotIdPlaceholder')"
                  />
                  <p class="form-hint">{{ t('agents.cozeBotIdHint') }}</p>
                </div>
                <div class="form-group">
                  <label>{{ t('agents.cozeApiKey') }}（{{ t('agents.cozeRegionCom') }}）</label>
                  <input
                    v-model="proxyCreateForm.coze.com.apiKey"
                    type="password"
                    class="form-input"
                    :placeholder="t('agents.cozeApiKeyPlaceholder')"
                    autocomplete="off"
                  />
                  <p class="form-hint">{{ t('agents.cozeAccessTokenHint') }}</p>
                </div>
              </template>
            </template>
            <template v-if="proxyCreateForm.runnerType === 'openclawx'">
              <div class="form-group">
                <label>{{ t('agents.openclawxBaseUrl') }}</label>
                <input
                  v-model="proxyCreateForm.openclawx.baseUrl"
                  type="text"
                  class="form-input"
                  :placeholder="t('agents.openclawxBaseUrlPlaceholder')"
                />
              </div>
              <div class="form-group">
                <label>{{ t('agents.openclawxApiKey') }}</label>
                <input
                  v-model="proxyCreateForm.openclawx.apiKey"
                  type="password"
                  class="form-input"
                  :placeholder="t('agents.openclawxApiKeyPlaceholder')"
                  autocomplete="off"
                />
              </div>
            </template>
            <p v-if="proxyCreateError" class="form-error">{{ proxyCreateError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showCreateProxyModal = false">
                {{ t('common.close') }}
              </button>
              <button type="button" class="btn-primary" :disabled="proxyCreateSaving" @click="doCreateProxy">
                {{ proxyCreateSaving ? t('common.loading') : t('agents.create') }}
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
    const agentTab = ref('local');
    const showCreateModal = ref(false);
    const showCreateProxyModal = ref(false);
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

    const proxyCreateForm = ref({
      name: '',
      workspace: '',
      runnerType: 'coze',
      coze: {
        region: 'com',
        cn: { botId: '', apiKey: '' },
        com: { botId: '', apiKey: '' },
        endpoint: '',
      },
      openclawx: { baseUrl: '', apiKey: '' },
    });
    const proxyCreateError = ref('');
    const proxyCreateSaving = ref(false);

    const localAgents = computed(() => {
      const list = Array.isArray(agents.value) ? agents.value : [];
      return list.filter((a) => {
        const rt = a?.runnerType;
        return rt !== 'coze' && rt !== 'openclawx';
      });
    });

    const proxyAgents = computed(() => {
      const list = Array.isArray(agents.value) ? agents.value : [];
      return list.filter((a) => {
        const rt = a?.runnerType;
        return rt === 'coze' || rt === 'openclawx';
      });
    });

    function proxyTypeLabel(agent) {
      const rt = agent?.runnerType;
      if (rt === 'coze') return t('agents.runnerTypeCoze');
      if (rt === 'openclawx') return t('agents.runnerTypeOpenclawx');
      return rt || '—';
    }

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

    watch(showCreateProxyModal, (visible) => {
      if (visible) {
        proxyCreateError.value = '';
        proxyCreateForm.value = {
          name: '',
          workspace: '',
          runnerType: 'coze',
          coze: {
            region: 'com',
            cn: { botId: '', apiKey: '' },
            com: { botId: '', apiKey: '' },
            endpoint: '',
          },
          openclawx: { baseUrl: '', apiKey: '' },
        };
      }
    });

    async function doCreateProxy() {
      const name = (proxyCreateForm.value.name || '').trim();
      const workspace = (proxyCreateForm.value.workspace || '').trim();
      if (!workspace) {
        proxyCreateError.value = t('agents.workspaceNameRequired');
        return;
      }
      if (workspace.toLowerCase() === 'default') {
        proxyCreateError.value = t('agents.workspaceReservedForDefault');
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(workspace)) {
        proxyCreateError.value = t('agents.workspaceNameFormat');
        return;
      }
      proxyCreateError.value = '';
      proxyCreateSaving.value = true;
      try {
        const body = {
          name: name || workspace,
          workspace,
        };
        const res = await agentConfigAPI.createAgent(body);
        const created = res.data?.data;
        const id = created?.id;
        if (!id) {
          proxyCreateError.value = t('common.error') || 'Create failed';
          return;
        }
        const runnerType = proxyCreateForm.value.runnerType;
        const updateBody = { runnerType };
        if (runnerType === 'coze') {
          const c = proxyCreateForm.value.coze;
          updateBody.coze = {
            region: c?.region === 'cn' ? 'cn' : 'com',
            cn: {
              botId: (c?.cn?.botId ?? '').trim(),
              apiKey: (c?.cn?.apiKey ?? '').trim(),
            },
            com: {
              botId: (c?.com?.botId ?? '').trim(),
              apiKey: (c?.com?.apiKey ?? '').trim(),
            },
            endpoint: undefined,
          };
        } else if (runnerType === 'openclawx') {
          updateBody.openclawx = {
            baseUrl: (proxyCreateForm.value.openclawx?.baseUrl || '').trim() || undefined,
            apiKey: (proxyCreateForm.value.openclawx?.apiKey || '').trim() || undefined,
          };
        }
        await agentConfigAPI.updateAgent(id, updateBody);
        showCreateProxyModal.value = false;
        await loadAgents();
        router.push(`/agents/${id}?tab=proxy`);
      } catch (e) {
        const msg = e.response?.data?.message || e.message || 'Create failed';
        proxyCreateError.value = typeof msg === 'string' ? msg : JSON.stringify(msg);
      } finally {
        proxyCreateSaving.value = false;
      }
    }

    onMounted(loadAgents);

    return {
      t,
      agents,
      loading,
      agentTab,
      localAgents,
      proxyAgents,
      proxyTypeLabel,
      showCreateModal,
      showCreateProxyModal,
      proxyCreateForm,
      proxyCreateError,
      proxyCreateSaving,
      doCreateProxy,
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

.agents-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  gap: var(--spacing-lg);
  overflow: hidden;
}

.agents-sidebar {
  flex-shrink: 0;
  width: 200px;
  padding: var(--spacing-sm);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.agents-tab-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-secondary);
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.agents-tab-btn .tab-icon {
  font-size: 1.25rem;
  line-height: 1;
}

.agents-tab-btn .tab-label {
  flex: 1;
}

.agents-tab-btn.active {
  color: var(--color-accent-primary);
  font-weight: 600;
  background: var(--color-bg-elevated);
  box-shadow: inset 3px 0 0 0 var(--color-accent-primary);
}

.agents-tab-btn:hover:not(.active) {
  background: var(--color-bg-secondary);
}

.agents-main {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0 var(--spacing-md);
}

.tab-hint {
  font-size: var(--font-size-sm);
  margin: 0 0 var(--spacing-lg) 0;
  flex-shrink: 0;
  color: var(--color-text-secondary);
  line-height: 1.5;
}

.agents-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.modal-content-wide {
  max-width: 480px;
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
  gap: var(--spacing-xl);
  overflow-y: auto;
}

.agent-card {
  display: flex;
  flex-direction: column;
  min-height: 180px;
  padding: var(--spacing-xl);
  border-radius: var(--radius-xl);
  border: 1px solid var(--glass-border);
  text-decoration: none;
  color: inherit;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
  position: relative;
  background: var(--color-bg-primary);
}

.agent-card:hover {
  border-color: var(--color-accent-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08);
  transform: translateY(-2px);
}

.card-icon-wrap {
  width: 52px;
  height: 52px;
  border-radius: var(--radius-lg);
  background: var(--color-bg-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--spacing-md);
}

.card-icon-wrap-proxy {
  background: rgba(102, 126, 234, 0.1);
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
  line-height: 1.35;
}

.card-badge {
  font-size: var(--font-size-xs);
  font-weight: 500;
  padding: 0.2em 0.6em;
  border-radius: var(--radius-sm);
  background: var(--color-accent-primary);
  color: white;
  flex-shrink: 0;
}

.card-badge-default {
  background: linear-gradient(135deg, var(--color-accent-primary), #7c8cf5);
}

.card-workspace {
  font-size: var(--font-size-sm);
  margin: 0 0 var(--spacing-sm) 0;
  color: var(--color-text-secondary);
}

.card-workspace code {
  background: var(--color-bg-tertiary);
  padding: 0.15em 0.5em;
  border-radius: var(--radius-sm);
  font-size: 0.875em;
  font-family: var(--font-mono, ui-monospace, monospace);
}

.ws-label {
  margin-right: var(--spacing-xs);
  color: var(--color-text-tertiary);
}

.card-llm {
  font-size: var(--font-size-xs);
  margin: 0;
  margin-top: auto;
  padding-top: var(--spacing-sm);
  color: var(--color-text-tertiary);
}

.card-arrow {
  position: absolute;
  top: var(--spacing-lg);
  right: var(--spacing-lg);
  font-size: 1.25rem;
  color: var(--color-text-tertiary);
  transition: color var(--transition-fast);
}

.agent-card:hover .card-arrow {
  color: var(--color-accent-primary);
}

.proxy-badge {
  margin-left: 0;
  background: rgba(102, 126, 234, 0.15);
  color: var(--color-accent-primary);
  border: 1px solid rgba(102, 126, 234, 0.35);
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
