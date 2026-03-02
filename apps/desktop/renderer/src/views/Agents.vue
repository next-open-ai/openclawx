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
        @click="openCreateProxyModal"
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
            <div
              v-for="agent in localAgents"
              :key="agent.id"
              class="agent-card-wrap"
            >
              <router-link :to="`/agents/${agent.id}`" class="agent-card card-glass">
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
              <button
                v-if="!agent.isDefault"
                type="button"
                class="agent-card-delete"
                :title="t('agents.deleteAgent')"
                @click.stop="openDeleteConfirm(agent)"
              >
                ✕
              </button>
            </div>
          </div>
        </template>
        <template v-else>
          <!-- 支持的代理类型卡片 + 新增按钮 -->
          <div class="proxy-types-section card-glass">
            <div class="proxy-types-cards">
              <button
                v-for="opt in proxyTypeOptions"
                :key="opt.id"
                type="button"
                class="proxy-type-card"
                @click="openCreateProxyWithType(opt.id)"
              >
                <span class="proxy-type-card-icon">{{ opt.icon }}</span>
                <span class="proxy-type-card-name">{{ t(opt.labelKey) }}</span>
                <span class="proxy-type-card-brief">{{ t(opt.briefKey) }}</span>
              </button>
            </div>
            <button type="button" class="btn-add-proxy" @click="openCreateProxyModal">
              <span class="btn-icon">+</span>
              {{ t('agents.addProxyAgent') }}
            </button>
          </div>

          <div v-if="proxyAgents.length === 0" class="empty-state proxy-empty">
            <div class="empty-icon">🔗</div>
            <p>{{ t('agents.noProxyAgents') }}</p>
            <p class="text-secondary">{{ t('agents.noProxyAgentsHint') }}</p>
          </div>
          <div v-else class="agents-grid">
            <div
              v-for="agent in proxyAgents"
              :key="agent.id"
              class="agent-card-wrap"
            >
              <router-link :to="`/agents/${agent.id}?tab=proxy`" class="agent-card card-glass agent-card-proxy">
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
              <button
                v-if="!agent.isDefault"
                type="button"
                class="agent-card-delete"
                :title="t('agents.deleteAgent')"
                @click.stop="openDeleteConfirm(agent)"
              >
                ✕
              </button>
            </div>
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

    <!-- 新增代理智能体弹窗：先选类型再填配置 -->
    <transition name="fade">
      <div v-if="showCreateProxyModal" class="modal-backdrop" @click.self="closeCreateProxyModal">
        <div class="modal-content card-glass modal-content-wide">
          <div class="modal-header">
            <h2>{{ proxyCreateStep === 'type' ? t('agents.chooseProxyType') : t('agents.createProxyAgent') }}</h2>
            <button type="button" class="close-btn" @click="closeCreateProxyModal">✕</button>
          </div>
          <div class="modal-body">
            <!-- 步骤 1：选择代理类型 -->
            <template v-if="proxyCreateStep === 'type'">
              <p class="modal-step-hint">{{ t('agents.chooseProxyTypeHint') }}</p>
              <div class="proxy-type-select-grid">
                <button
                  v-for="opt in proxyTypeOptions"
                  :key="opt.id"
                  type="button"
                  class="proxy-type-select-card"
                  @click="selectProxyTypeAndGoConfig(opt.id)"
                >
                  <span class="proxy-type-select-icon">{{ opt.icon }}</span>
                  <span class="proxy-type-select-name">{{ t(opt.labelKey) }}</span>
                  <span class="proxy-type-select-brief">{{ t(opt.briefKey) }}</span>
                </button>
              </div>
            </template>

            <!-- 步骤 2：填写配置 -->
            <template v-else>
              <div class="modal-step-bar">
                <span class="modal-step-label">{{ t('agents.runnerType') }}:</span>
                <span class="modal-step-value">{{ proxyTypeLabelByKey(proxyCreateForm.runnerType) }}</span>
                <button type="button" class="link-btn modal-step-back" @click="proxyCreateStep = 'type'">
                  {{ t('agents.changeProxyType') }}
                </button>
              </div>
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
            <template v-if="proxyCreateForm.runnerType === 'claude_code'">
              <div class="form-group">
                <label>{{ t('agents.claudeCodeWorkingDirectory') }}</label>
                <div class="form-input-with-btn">
                  <input
                    v-model="proxyCreateForm.claudeCode.workingDirectory"
                    type="text"
                    class="form-input"
                    :placeholder="t('agents.claudeCodeWorkingDirectoryPlaceholder')"
                  />
                  <button
                    v-if="hasElectronFolderPicker"
                    type="button"
                    class="btn-secondary btn-pick-folder"
                    @click="pickClaudeCodeWorkingDirectory"
                  >
                    {{ t('agents.claudeCodeSelectFolder') }}
                  </button>
                </div>
              </div>
            </template>
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
            <template v-if="proxyCreateForm.runnerType === 'opencode'">
              <p class="form-hint">{{ t('agents.opencodeHint') }}</p>
              <div class="form-group">
                <label>{{ t('agents.opencodeMode') }}</label>
                <div class="form-radio-group">
                  <label class="form-radio">
                    <input v-model="proxyCreateForm.opencode.mode" type="radio" value="local" />
                    <span>{{ t('agents.opencodeModeLocal') }}</span>
                  </label>
                  <label class="form-radio">
                    <input v-model="proxyCreateForm.opencode.mode" type="radio" value="remote" />
                    <span>{{ t('agents.opencodeModeRemote') }}</span>
                  </label>
                </div>
              </div>
              <template v-if="proxyCreateForm.opencode.mode === 'local'">
                <p class="form-hint">{{ t('agents.opencodeLocalHint') }}</p>
                <div class="form-group">
                  <label>{{ t('agents.opencodePortLocalLabel') }}</label>
                  <input
                    v-model.number="proxyCreateForm.opencode.port"
                    type="number"
                    min="1"
                    max="65535"
                    class="form-input"
                    :placeholder="t('agents.opencodePortPlaceholder')"
                  />
                </div>
                <div class="form-group">
                  <label>{{ t('agents.opencodeModel') }}</label>
                  <select v-model="proxyCreateForm.opencode.model" class="form-input">
                    <option value="">{{ t('agents.opencodeUseLocalDefault') }}</option>
                    <option v-for="m in opencodeFreeModels" :key="m.id" :value="m.id">
                      {{ m.label }}{{ m.free ? ' (Free)' : '' }}
                    </option>
                  </select>
                </div>
                <div class="form-group">
                  <label>{{ t('agents.opencodeWorkingDirectory') }}</label>
                  <div class="form-input-with-btn">
                    <input
                      v-model="proxyCreateForm.opencode.workingDirectory"
                      type="text"
                      class="form-input"
                      :placeholder="t('agents.opencodeWorkingDirectoryPlaceholder')"
                    />
                    <button
                      v-if="hasElectronFolderPicker"
                      type="button"
                      class="btn-secondary btn-pick-folder"
                      @click="pickOpencodeWorkingDirectory"
                    >
                      {{ t('agents.opencodeSelectFolder') }}
                    </button>
                  </div>
                </div>
              </template>
              <template v-else>
                <p class="form-hint">{{ t('agents.opencodeRemoteHint') }}</p>
                <div class="form-group">
                  <label>{{ t('agents.opencodeAddress') }}</label>
                  <input
                    v-model="proxyCreateForm.opencode.address"
                    type="text"
                    class="form-input"
                    :placeholder="t('agents.opencodeAddressPlaceholder')"
                  />
                </div>
                <div class="form-group">
                  <label>{{ t('agents.opencodePort') }}</label>
                  <input
                    v-model.number="proxyCreateForm.opencode.port"
                    type="number"
                    min="1"
                    max="65535"
                    class="form-input"
                    :placeholder="t('agents.opencodePortPlaceholder')"
                  />
                </div>
                <div class="form-group">
                  <label>{{ t('agents.opencodePassword') }}</label>
                  <input
                    v-model="proxyCreateForm.opencode.password"
                    type="password"
                    class="form-input"
                    :placeholder="t('agents.opencodePasswordPlaceholder')"
                    autocomplete="off"
                  />
                </div>
                <div class="form-group">
                  <label>{{ t('agents.opencodeModel') }}</label>
                  <select v-model="proxyCreateForm.opencode.model" class="form-input">
                    <option value="">{{ t('agents.opencodeUseServerDefault') }}</option>
                    <option v-for="m in opencodeFreeModels" :key="m.id" :value="m.id">
                      {{ m.label }}{{ m.free ? ' (Free)' : '' }}
                    </option>
                  </select>
                </div>
              </template>
            </template>
            <p v-if="proxyCreateError" class="form-error">{{ proxyCreateError }}</p>
            <div v-if="proxyCreateStep === 'config'" class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="closeCreateProxyModal">
                {{ t('common.close') }}
              </button>
              <button type="button" class="btn-primary" :disabled="proxyCreateSaving" @click="doCreateProxy">
                {{ proxyCreateSaving ? t('common.loading') : t('agents.create') }}
              </button>
            </div>
            </template>
          </div>
        </div>
      </div>
    </transition>

    <!-- 删除智能体确认弹窗 -->
    <transition name="fade">
      <div v-if="showDeleteConfirm" class="modal-backdrop" @click.self="showDeleteConfirm = false">
        <div class="modal-content card-glass modal-confirm">
          <p class="modal-confirm-text">{{ t('agents.deleteAgentConfirm') }}</p>
          <p v-if="deleteTargetAgent" class="modal-confirm-name">{{ deleteTargetAgent.name }}</p>
          <label class="modal-confirm-checkbox">
            <input type="checkbox" v-model="deleteWorkspaceDir" />
            <span>{{ t('agents.deleteAgentAlsoDeleteDir') }}</span>
          </label>
          <div class="modal-footer-actions">
            <button type="button" class="btn-secondary" @click="showDeleteConfirm = false">
              {{ t('common.cancel') }}
            </button>
            <button type="button" class="btn-primary danger" :disabled="deleteAgentSaving" @click="doDeleteAgent">
              {{ deleteAgentSaving ? t('common.loading') : t('agents.deleteAgent') }}
            </button>
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

/** 支持的代理类型（用于卡片展示与弹窗选择） */
const PROXY_TYPE_OPTIONS = [
  { id: 'coze', labelKey: 'agents.runnerTypeCoze', briefKey: 'agents.proxyTypeBriefCoze', icon: '🤖' },
  { id: 'openclawx', labelKey: 'agents.runnerTypeOpenclawx', briefKey: 'agents.proxyTypeBriefOpenclawx', icon: '🔗' },
  { id: 'opencode', labelKey: 'agents.runnerTypeOpencode', briefKey: 'agents.proxyTypeBriefOpencode', icon: '⚡' },
  { id: 'claude_code', labelKey: 'agents.runnerTypeClaudeCode', briefKey: 'agents.proxyTypeBriefClaudeCode', icon: '⌘' },
];

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
    const proxyCreateStep = ref('type');
    const proxyCreateSelectedType = ref(null);
    const proxyTypeOptions = PROXY_TYPE_OPTIONS;
    const showDeleteConfirm = ref(false);
    const deleteTargetAgent = ref(null);
    const deleteAgentSaving = ref(false);
    const deleteWorkspaceDir = ref(false);
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
      opencode: { mode: 'local', address: '', port: 4096, username: '', password: '', model: '', workingDirectory: '' },
      claudeCode: { workingDirectory: '' },
    });
    const opencodeFreeModels = ref([]);
    const proxyCreateError = ref('');
    const proxyCreateSaving = ref(false);

    const localAgents = computed(() => {
      const list = Array.isArray(agents.value) ? agents.value : [];
      return list.filter((a) => {
        const rt = a?.runnerType;
        return rt !== 'coze' && rt !== 'openclawx' && rt !== 'opencode' && rt !== 'claude_code';
      });
    });

    const proxyAgents = computed(() => {
      const list = Array.isArray(agents.value) ? agents.value : [];
      return list.filter((a) => {
        const rt = a?.runnerType;
        return rt === 'coze' || rt === 'openclawx' || rt === 'opencode' || rt === 'claude_code';
      });
    });

    function proxyTypeLabel(agent) {
      const rt = agent?.runnerType;
      return proxyTypeLabelByKey(rt);
    }
    function proxyTypeLabelByKey(runnerType) {
      if (runnerType === 'coze') return t('agents.runnerTypeCoze');
      if (runnerType === 'openclawx') return t('agents.runnerTypeOpenclawx');
      if (runnerType === 'opencode') return t('agents.runnerTypeOpencode');
      if (runnerType === 'claude_code') return t('agents.runnerTypeClaudeCode');
      return runnerType || '—';
    }
    function openCreateProxyModal() {
      proxyCreateStep.value = 'type';
      proxyCreateSelectedType.value = null;
      showCreateProxyModal.value = true;
    }
    function openCreateProxyWithType(typeId) {
      proxyCreateSelectedType.value = typeId;
      proxyCreateStep.value = 'config';
      proxyCreateForm.value.runnerType = typeId;
      showCreateProxyModal.value = true;
    }
    function selectProxyTypeAndGoConfig(typeId) {
      proxyCreateForm.value.runnerType = typeId;
      proxyCreateStep.value = 'config';
    }
    function closeCreateProxyModal() {
      showCreateProxyModal.value = false;
      proxyCreateStep.value = 'type';
      proxyCreateSelectedType.value = null;
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
        const defaultForm = {
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
          opencode: { mode: 'local', address: '', port: 4096, username: '', password: '', model: '', workingDirectory: '' },
          claudeCode: { workingDirectory: '' },
        };
        proxyCreateForm.value = { ...defaultForm };
        if (proxyCreateSelectedType.value) {
          proxyCreateStep.value = 'config';
          proxyCreateForm.value.runnerType = proxyCreateSelectedType.value;
        } else {
          proxyCreateStep.value = 'type';
        }
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
        } else if (runnerType === 'opencode') {
          const oc = proxyCreateForm.value.opencode;
          const portNum = typeof oc?.port === 'number' ? oc.port : parseInt(String(oc?.port || ''), 10);
          const mode = oc?.mode === 'local' ? 'local' : 'remote';
          updateBody.opencode = {
            mode,
            address: mode === 'remote' ? (oc?.address || '').trim() : undefined,
            port: Number.isFinite(portNum) && portNum > 0 ? portNum : 4096,
            password: (oc?.password || '').trim() || undefined,
            model: (oc?.model || '').trim() || undefined,
            workingDirectory: (oc?.workingDirectory || '').trim() || undefined,
          };
        } else if (runnerType === 'claude_code') {
          const wd = (proxyCreateForm.value.claudeCode?.workingDirectory ?? '').trim();
          updateBody.claudeCode = wd ? { workingDirectory: wd } : undefined;
        }
        await agentConfigAPI.updateAgent(id, updateBody);
        closeCreateProxyModal();
        await loadAgents();
        router.push(`/agents/${id}?tab=proxy`);
      } catch (e) {
        const msg = e.response?.data?.message || e.message || 'Create failed';
        proxyCreateError.value = typeof msg === 'string' ? msg : JSON.stringify(msg);
      } finally {
        proxyCreateSaving.value = false;
      }
    }

    async function fetchOpencodeFreeModels() {
      if (opencodeFreeModels.value.length > 0) return;
      try {
        const res = await configAPI.getOpencodeFreeModels();
        if (res?.data?.success && Array.isArray(res.data.data)) opencodeFreeModels.value = res.data.data;
      } catch (_) {}
    }
    const hasElectronFolderPicker = computed(() => typeof window !== 'undefined' && !!window.electronAPI?.showOpenDirectoryDialog);
    async function pickOpencodeWorkingDirectory() {
      if (!window.electronAPI?.showOpenDirectoryDialog) return;
      const path = await window.electronAPI.showOpenDirectoryDialog({ title: '选择 OpenCode 工作目录' });
      if (path) proxyCreateForm.value.opencode.workingDirectory = path;
    }
    async function pickClaudeCodeWorkingDirectory() {
      if (!window.electronAPI?.showOpenDirectoryDialog) return;
      const path = await window.electronAPI.showOpenDirectoryDialog({ title: t('agents.claudeCodeSelectFolderTitle') });
      if (path) proxyCreateForm.value.claudeCode.workingDirectory = path;
    }
    watch(
      () => proxyCreateForm.value.runnerType === 'opencode',
      (isOpencode) => { if (isOpencode) fetchOpencodeFreeModels(); },
      { immediate: true }
    );

    function openDeleteConfirm(agent) {
      if (agent?.isDefault) return;
      deleteTargetAgent.value = agent;
      deleteWorkspaceDir.value = false;
      showDeleteConfirm.value = true;
    }
    async function doDeleteAgent() {
      const agent = deleteTargetAgent.value;
      if (!agent?.id || agent.isDefault) {
        showDeleteConfirm.value = false;
        deleteTargetAgent.value = null;
        return;
      }
      deleteAgentSaving.value = true;
      try {
        const params = deleteWorkspaceDir.value ? { deleteWorkspaceDir: 'true' } : {};
        await agentConfigAPI.deleteAgent(agent.id, params);
        showDeleteConfirm.value = false;
        deleteTargetAgent.value = null;
        await loadAgents();
      } catch (e) {
        console.error('Delete agent failed', e);
      } finally {
        deleteAgentSaving.value = false;
      }
    }

    onMounted(loadAgents);

    return {
      t,
      opencodeFreeModels,
      hasElectronFolderPicker,
      pickOpencodeWorkingDirectory,
      pickClaudeCodeWorkingDirectory,
      showDeleteConfirm,
      deleteTargetAgent,
      deleteAgentSaving,
      deleteWorkspaceDir,
      openDeleteConfirm,
      doDeleteAgent,
      agents,
      loading,
      agentTab,
      localAgents,
      proxyAgents,
      proxyTypeLabel,
      showCreateModal,
      showCreateProxyModal,
      proxyCreateStep,
      proxyCreateSelectedType,
      proxyTypeOptions,
      openCreateProxyModal,
      openCreateProxyWithType,
      selectProxyTypeAndGoConfig,
      closeCreateProxyModal,
      proxyTypeLabelByKey,
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
  gap: var(--spacing-md);
  padding: var(--spacing-md) var(--spacing-lg);
  font-size: var(--font-size-base);
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
  font-size: 1.35rem;
  line-height: 1;
}

.agents-tab-btn .tab-label {
  flex: 1;
  font-size: var(--font-size-base);
  font-weight: 500;
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

/* 代理类型卡片区 + 新增按钮 */
.proxy-types-section {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-lg);
  padding: var(--spacing-lg);
  margin-bottom: var(--spacing-lg);
  border-radius: var(--radius-lg);
  border: 1px solid var(--glass-border);
  background: var(--color-bg-secondary);
}
.proxy-types-cards {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  flex: 1;
  min-width: 0;
}
.proxy-type-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 100px;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-elevated);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast), transform var(--transition-fast);
  text-align: center;
}
.proxy-type-card:hover {
  border-color: var(--color-accent-primary);
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.15);
}
.proxy-type-card.selected {
  border-color: var(--color-accent-primary);
  background: rgba(102, 126, 234, 0.08);
  box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.2);
}
.proxy-type-card-icon {
  font-size: 1.5rem;
  line-height: 1;
}
.proxy-type-card-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}
.proxy-type-card-brief {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.2;
}
.btn-add-proxy {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-lg);
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: white;
  background: var(--color-accent-primary);
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  flex-shrink: 0;
  transition: filter var(--transition-fast);
}
.btn-add-proxy:hover {
  filter: brightness(1.08);
}
.btn-add-proxy .btn-icon {
  font-size: 1.1rem;
  line-height: 1;
}
.proxy-empty {
  margin-top: var(--spacing-md);
}

/* 弹窗：选择类型步骤 */
.modal-step-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: 0 0 var(--spacing-lg) 0;
  line-height: 1.5;
}
.proxy-type-select-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: var(--spacing-md);
}
.proxy-type-select-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-lg);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
  text-align: center;
}
.proxy-type-select-card:hover {
  border-color: var(--color-accent-primary);
  background: rgba(102, 126, 234, 0.06);
}
.proxy-type-select-icon {
  font-size: 1.75rem;
  line-height: 1;
}
.proxy-type-select-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}
.proxy-type-select-brief {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  line-height: 1.2;
}

/* 弹窗：配置步骤顶部类型栏 */
.modal-step-bar {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
}
.modal-step-label {
  color: var(--color-text-secondary);
}
.modal-step-value {
  font-weight: 600;
  color: var(--color-text-primary);
}
.modal-step-back {
  margin-left: auto;
  font-size: var(--font-size-sm);
  color: var(--color-accent-primary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
.modal-step-back:hover {
  text-decoration: underline;
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

.agent-card-wrap {
  position: relative;
}

.agent-card-delete {
  position: absolute;
  top: var(--spacing-sm);
  right: var(--spacing-sm);
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 0.9rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.agent-card-delete:hover {
  background: var(--color-danger-bg, rgba(220, 53, 69, 0.15));
  color: var(--color-danger, #dc3545);
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

.modal-content.modal-confirm {
  max-width: 360px;
}
.modal-confirm .modal-confirm-text {
  margin: 0 0 var(--spacing-sm) 0;
  color: var(--color-text-primary);
  padding: var(--spacing-lg) var(--spacing-lg) 0;
}
.modal-confirm .modal-confirm-name {
  margin: 0 0 var(--spacing-lg) 0;
  padding: 0 var(--spacing-lg);
  font-weight: 600;
  color: var(--color-text-secondary);
}
.modal-confirm .modal-confirm-checkbox {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin: 0 0 var(--spacing-md) 0;
  padding: 0 var(--spacing-lg);
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 0.9em;
}
.modal-confirm .modal-footer-actions {
  padding: var(--spacing-lg);
  border-top: 1px solid var(--glass-border);
}
.btn-primary.danger {
  background: var(--color-danger, #dc3545);
  color: white;
}
.btn-primary.danger:hover:not(:disabled) {
  filter: brightness(1.1);
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

.form-radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
}
.form-radio {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  cursor: pointer;
  font-weight: 400;
}
.form-radio input { margin: 0; }

.form-input-with-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}
.form-input-with-btn .form-input {
  flex: 1;
  min-width: 0;
}
.form-input-with-btn .btn-pick-folder {
  flex-shrink: 0;
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
