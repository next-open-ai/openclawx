<template>
  <div class="settings-view">
    <div class="settings-layout card-glass">
      <!-- Sidebar Navigation -->
      <div class="settings-sidebar">
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'general' }"
          @click="activeTab = 'general'"
        >
          <span class="nav-icon">⚙️</span>
          {{ t('settings.general') }}
        </div>
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'agent' }"
          @click="activeTab = 'agent'"
        >
          <span class="nav-icon">🤖</span>
          {{ t('settings.agent') }}
        </div>
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'models' }"
          @click="activeTab = 'models'"
        >
          <span class="nav-icon">🧠</span>
          {{ t('settings.modelsNav') }}
        </div>
        <div 
          v-if="false"
          class="nav-item" 
          :class="{ active: activeTab === 'knowledge' }"
          @click="activeTab = 'knowledge'; initKnowledgeTab()"
        >
          <span class="nav-icon">📚</span>
          {{ t('settings.knowledge') }}
        </div>
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'users' }"
          @click="activeTab = 'users'"
        >
          <span class="nav-icon">👤</span>
          {{ t('settings.users') }}
        </div>
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'skills' }"
          @click="activeTab = 'skills'"
        >
          <span class="nav-icon">🎯</span>
          {{ t('nav.skills') }}
        </div>
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'channels' }"
          @click="activeTab = 'channels'; initChannelsTab()"
        >
          <span class="nav-icon">📡</span>
          {{ t('settings.channels') }}
        </div>
        <div 
          class="nav-item" 
          :class="{ active: activeTab === 'about' }"
          @click="activeTab = 'about'"
        >
          <span class="nav-icon">ℹ️</span>
          {{ t('settings.about') }}
        </div>
      </div>

      <!-- Main Content Area -->
      <div class="settings-content">
        <!-- General Tab -->
        <div v-show="activeTab === 'general'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.general') }}</h2>
          
          <div class="settings-group">
            <h3>{{ t('settings.language') }}</h3>
            <div class="form-group">
              <label>{{ t('settings.languageDescription') }}</label>
              <select v-model="currentLocale" class="input select-input">
                <option value="zh">简体中文</option>
                <option value="en">English (US)</option>
              </select>
            </div>
          </div>

          <div class="settings-group">
            <h3>{{ t('settings.theme') }}</h3>
            <div class="form-group">
              <label>{{ t('settings.themeDescription') }}</label>
              <div class="theme-options">
                <button 
                  class="theme-card" 
                  :class="{ active: config.theme === 'light' }"
                  @click="setTheme('light')"
                >
                  <div class="theme-preview light"></div>
                  <span>{{ t('settings.light') }}</span>
                </button>
                <button 
                  class="theme-card" 
                  :class="{ active: config.theme === 'dark' }"
                  @click="setTheme('dark')"
                >
                  <div class="theme-preview dark"></div>
                  <span>{{ t('settings.dark') }}</span>
                </button>
                <button 
                  class="theme-card" 
                  :class="{ active: config.theme === 'cosmic' }"
                  @click="setTheme('cosmic')"
                >
                  <div class="theme-preview cosmic"></div>
                  <span>{{ t('settings.cosmic') }}</span>
                </button>
                <button 
                  class="theme-card" 
                  :class="{ active: config.theme === 'neon' }"
                  @click="setTheme('neon')"
                >
                  <div class="theme-preview neon"></div>
                  <span>{{ t('settings.neon') }}</span>
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- Agent Tab (Merged Configuration)：不含模型配置（在「模型配置」Tab）、不含用户密码 -->
        <div v-show="activeTab === 'agent'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.agentConfig') }}</h2>

          <div class="settings-group">
            <h3>{{ t('settings.workspace') }}</h3>
            <div class="form-group">
              <label>{{ t('settings.defaultAgent') }}</label>
              <select v-model="localConfig.defaultAgentId" class="input select-input">
                <option
                  v-for="a in defaultAgentOptions"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name || a.id }}
                </option>
              </select>
              <p class="form-hint">{{ t('settings.defaultAgentHint') }}</p>
            </div>
          </div>

          <div class="settings-group">
            <h3>{{ t('settings.sessionsLimit') }}</h3>
            <div class="form-group">
              <label>{{ t('settings.maxAgentSessions') }}</label>
              <input v-model.number="localConfig.maxAgentSessions" type="number" min="1" max="50" class="input" />
              <p class="form-hint">{{ t('settings.maxAgentSessionsHint') }}</p>
            </div>
          </div>

          <!-- Memory 记忆库配置 -->
          <div class="settings-group">
            <h3>{{ t('settings.memoryConfig') }}</h3>
            <p class="form-hint">{{ t('settings.memoryConfigHint') }}</p>
            <div class="form-group">
              <label>{{ t('settings.embeddingModel') }}</label>
              <select v-model="localConfig.memory.embeddingModelItemCode" class="input select-input">
                <option value="">{{ t('settings.memoryEmbeddingNone') }}</option>
                <option
                  v-for="m in configuredEmbeddingModels"
                  :key="m.modelItemCode"
                  :value="m.modelItemCode"
                >
                  {{ m.alias || m.modelId }} ({{ m.provider }})
                </option>
              </select>
              <p v-if="configuredEmbeddingModels.length === 0" class="form-hint form-hint-warn">{{ t('settings.memoryNoEmbeddingModels') }}</p>
            </div>
          </div>

          <div class="actions">
            <button @click="saveAgentConfig" class="btn-primary">
              {{ t('common.save') }}
            </button>
            <button @click="resetAgentConfig" class="btn-secondary">
              {{ t('common.reset') }}
            </button>
          </div>
        </div>

        <!-- 模型配置 Tab（顶部子 Tab：Provider 配置 / 模型配置） -->
        <div v-show="activeTab === 'models'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.modelsNav') }}</h2>
          <div class="model-config-tabs">
            <button
              class="model-config-tab"
              :class="{ active: modelConfigSubTab === 'provider' }"
              @click="modelConfigSubTab = 'provider'"
            >
              {{ t('settings.providerConfig') }}
            </button>
            <button
              class="model-config-tab"
              :class="{ active: modelConfigSubTab === 'default' }"
              @click="modelConfigSubTab = 'default'; onDefaultProviderChange(config.defaultProvider || localDefaultProvider)"
            >
              {{ t('settings.defaultModelConfig') }}
            </button>
          </div>

          <!-- Provider 配置：新增供应商按钮 + 弹窗；已配置列表卡片展示 -->
          <div v-show="modelConfigSubTab === 'provider'" class="settings-group provider-config-group">
            <div class="settings-hint-block">
              <span class="settings-hint-icon">ℹ️</span>
              <p class="settings-hint-text">{{ t('settings.providerConfigHint') }}</p>
            </div>
            <div class="provider-configured-list">
              <div class="subsection-header">
                <h4 class="subsection-title">{{ t('settings.configuredProvidersList') }}</h4>
                <button type="button" class="btn-primary btn-add-provider" @click="openAddProviderModal">
                  {{ t('settings.addProvider') }}
                </button>
              </div>
              <p v-if="configuredProviders.length === 0" class="form-hint empty-hint">{{ t('settings.noConfiguredProviderList') }}</p>
              <div v-else class="provider-cards">
                <div v-for="prov in configuredProviders" :key="prov" class="provider-card" :class="{ 'is-editing': editingProvider === prov }">
                  <div class="provider-card-header">
                    <span class="provider-name">{{ getProviderDisplayName(prov) }}</span>
                    <span class="provider-badge">{{ t('settings.apiKeyConfigured') }}</span>
                    <template v-if="editingProvider !== prov">
                      <button type="button" class="link-btn" @click="startEditProvider(prov)">{{ t('common.edit') }}</button>
                      <button type="button" class="link-btn danger provider-delete" @click="removeProvider(prov)">{{ t('common.delete') }}</button>
                    </template>
                  </div>
                  <template v-if="editingProvider === prov">
                    <div class="provider-card-body">
                      <div class="form-group">
                        <label>{{ t('settings.providerAlias') }}</label>
                        <input
                          v-model="localProviderConfig[prov].alias"
                          type="text"
                          class="input"
                          :placeholder="t('settings.providerAliasPlaceholder')"
                        />
                      </div>
                      <div class="form-group">
                        <label>{{ t('settings.apiKey') }}</label>
                        <input
                          v-model="localProviderConfig[prov].apiKey"
                          type="password"
                          class="input"
                          :placeholder="t('settings.apiKeyPlaceholder')"
                          autocomplete="off"
                        />
                      </div>
                      <div class="form-group">
                        <label>{{ t('settings.baseUrl') }} ({{ t('settings.optional') }})</label>
                        <input
                          v-model="localProviderConfig[prov].baseUrl"
                          type="text"
                          class="input"
                          :placeholder="t('settings.baseUrlPlaceholder')"
                        />
                      </div>
                      <div class="provider-card-actions">
                        <button type="button" class="btn-secondary" @click="cancelEditProvider">{{ t('common.cancel') }}</button>
                        <button type="button" class="btn-primary" @click="saveEditProvider">{{ t('common.save') }}</button>
                      </div>
                    </div>
                  </template>
                  <template v-else>
                    <div class="provider-readonly">
                      <p class="provider-readonly-line"><span class="label">{{ t('settings.apiKey') }}:</span> ••••••••</p>
                      <p v-if="localProviderConfig[prov].baseUrl" class="provider-readonly-line"><span class="label">{{ t('settings.baseUrl') }}:</span> {{ localProviderConfig[prov].baseUrl }}</p>
                    </div>
                  </template>
                </div>
              </div>
              <p v-if="configuredProviders.length > 0 && !editingProvider" class="form-hint action-hint">{{ t('settings.editProviderHint') }}</p>
            </div>
          </div>

          <!-- 新增供应商弹窗 -->
          <transition name="fade">
            <div v-if="showAddProviderModal" class="modal-backdrop" @click.self="showAddProviderModal = false">
              <div class="modal-content card-glass modal-add-provider">
                <div class="modal-header">
                  <h2>{{ t('settings.addProviderTitle') }}</h2>
                  <button type="button" class="close-btn" @click="showAddProviderModal = false">✕</button>
                </div>
                <div class="modal-body">
                  <div class="form-group">
                    <label>{{ t('settings.selectProvider') }}</label>
                    <select v-model="addProviderForm.provider" class="input select-input" @change="onAddProviderSelect">
                      <option value="">—</option>
                      <option v-for="p in supportedProviders" :key="p" :value="p">{{ providerSupport[p]?.name || p }}</option>
                    </select>
                  </div>
                  <div class="form-group">
                    <label>{{ t('settings.providerAlias') }}</label>
                    <input
                      v-model="addProviderForm.alias"
                      type="text"
                      class="input"
                      :placeholder="t('settings.providerAliasPlaceholder')"
                    />
                  </div>
                  <div class="form-group">
                    <label>{{ t('settings.apiKey') }}</label>
                    <input
                      v-model="addProviderForm.apiKey"
                      type="password"
                      class="input"
                      :placeholder="t('settings.apiKeyPlaceholder')"
                      autocomplete="off"
                    />
                  </div>
                  <div class="form-group">
                    <label>{{ t('settings.baseUrl') }} ({{ t('settings.optional') }})</label>
                    <input
                      v-model="addProviderForm.baseUrl"
                      type="text"
                      class="input"
                      :placeholder="t('settings.baseUrlPlaceholder')"
                    />
                  </div>
                  <div class="modal-footer-actions">
                    <button type="button" class="btn-secondary" @click="showAddProviderModal = false">{{ t('common.close') }}</button>
                    <button type="button" class="btn-primary" :disabled="!addProviderForm.provider || !addProviderForm.apiKey?.trim()" @click="submitAddProvider">
                      {{ t('common.save') }}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </transition>

          <!-- 模型配置：已配置的模型列表，从有效 Provider 添加（选类型），从列表中选缺省 -->
          <div v-show="modelConfigSubTab === 'default'" class="settings-group model-config-group">
            <div class="settings-hint-block">
              <span class="settings-hint-icon">ℹ️</span>
              <p class="settings-hint-text">{{ t('settings.defaultModelHint') }}</p>
            </div>
            <p v-if="configuredProviders.length === 0" class="form-hint form-hint-warn model-config-warn">
              {{ t('settings.noConfiguredProvider') }}
            </p>
            <template v-else>
              <div class="subsection-header">
                <h4 class="subsection-title">{{ t('settings.configuredModelsList') }}</h4>
                <button type="button" class="btn-primary btn-add-provider" @click="openAddModelModal">{{ t('settings.addModel') }}</button>
              </div>
              <p v-if="configuredModelsList.length === 0" class="form-hint empty-hint">{{ t('settings.noConfiguredModels') }}</p>
              <div v-else class="configured-models-list">
                <div v-for="(item, idx) in configuredModelsList" :key="idx" class="configured-model-row">
                  <span class="model-row-provider">{{ getProviderDisplayName(item.provider) }}</span>
                  <span class="model-row-sep">/</span>
                  <span class="model-row-name">{{ getModelAlias(item) }}</span>
                  <span class="model-row-type">{{ item.type }}</span>
                  <span v-if="defaultModelIndex === idx" class="model-row-default-badge">{{ t('settings.defaultModelLabel') }}</span>
                  <span class="model-row-actions">
                    <button type="button" class="link-btn" @click="openEditModel(idx)">{{ t('common.edit') }}</button>
                    <button v-if="defaultModelIndex !== idx" type="button" class="link-btn" @click="setDefaultFromConfigured(item)">{{ t('settings.setAsDefaultModel') }}</button>
                    <button type="button" class="link-btn danger" @click="confirmRemoveConfiguredModel(idx)">{{ t('common.delete') }}</button>
                  </span>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 新增/编辑模型配置弹窗 -->
        <transition name="fade">
          <div v-if="showAddModelModal" class="modal-backdrop" @click.self="closeAddModelModal">
            <div class="modal-content card-glass">
              <div class="modal-header">
                <h2>{{ editingModelIndex >= 0 ? t('settings.editModelTitle') : t('settings.addModelTitle') }}</h2>
                <button type="button" class="close-btn" @click="closeAddModelModal">✕</button>
              </div>
              <div class="modal-body">
                <div class="form-group">
                  <label>{{ t('settings.selectProvider') }}</label>
                  <select v-model="addModelForm.provider" class="input select-input" :disabled="editingModelIndex >= 0" @change="onAddModelProviderOrTypeChange">
                    <option value="">—</option>
                    <option v-for="p in configuredProviders" :key="p" :value="p">{{ getProviderDisplayName(p) }}</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>{{ t('settings.modelType') }}</label>
                  <select v-model="addModelForm.type" class="input select-input" :disabled="editingModelIndex >= 0" @change="onAddModelProviderOrTypeChange">
                    <option value="llm">{{ t('settings.modelTypeLlm') }}</option>
                    <option value="embedding">{{ t('settings.modelTypeEmbedding') }}</option>
                    <option value="image">{{ t('settings.modelTypeImage') }}</option>
                  </select>
                </div>
                <div class="form-group">
                  <label>{{ t('settings.model') }}</label>
                  <input
                    v-if="isOpenAiCustomProvider"
                    v-model="addModelForm.modelId"
                    type="text"
                    class="input"
                    :placeholder="t('settings.modelIdCustomPlaceholder')"
                  />
                  <template v-else>
                    <select
                      v-model="addModelForm.modelId"
                      class="input select-input"
                      :disabled="!addModelForm.provider || editingModelIndex >= 0"
                    >
                      <option value="">—</option>
                      <option v-for="m in addModelOptions" :key="m.id" :value="m.id">{{ m.name }}</option>
                    </select>
                    <p class="form-hint form-hint-inline">{{ t('settings.modelCustomHint') }}</p>
                    <input
                      v-model="addModelForm.customModelId"
                      type="text"
                      class="input model-custom-input"
                      :placeholder="t('settings.modelCustomPlaceholder')"
                      :disabled="!addModelForm.provider || editingModelIndex >= 0"
                    />
                  </template>
                </div>
                <div class="form-group">
                  <label>{{ t('settings.modelAlias') }}</label>
                  <input
                    v-model="addModelForm.alias"
                    type="text"
                    class="input"
                    :placeholder="t('settings.modelAliasPlaceholder')"
                  />
                </div>
                <div class="form-group">
                  <label class="checkbox-label">
                    <input v-model="addModelForm.reasoning" type="checkbox" />
                    {{ t('settings.modelReasoning') }}
                  </label>
                </div>
                <div v-if="addModelForm.cost" class="form-group cost-fields">
                  <label>{{ t('settings.modelCost') }}</label>
                  <div class="cost-row">
                    <span class="cost-item"><input v-model.number="addModelForm.cost.input" type="number" min="0" step="0.0001" class="input cost-input" /> input</span>
                    <span class="cost-item"><input v-model.number="addModelForm.cost.output" type="number" min="0" step="0.0001" class="input cost-input" /> output</span>
                    <span class="cost-item"><input v-model.number="addModelForm.cost.cacheRead" type="number" min="0" step="0.0001" class="input cost-input" /> cacheRead</span>
                    <span class="cost-item"><input v-model.number="addModelForm.cost.cacheWrite" type="number" min="0" step="0.0001" class="input cost-input" /> cacheWrite</span>
                  </div>
                </div>
                <div class="modal-footer-actions">
                  <button type="button" class="btn-secondary" @click="closeAddModelModal">{{ t('common.close') }}</button>
                  <button type="button" class="btn-primary" :disabled="!addModelForm.provider || !effectiveAddModelId" @click="submitAddModel">{{ t('common.save') }}</button>
                </div>
              </div>
            </div>
          </div>
        </transition>

        <!-- 知识库 Tab：向量模型 + 向量库 -->
        <div v-show="showRagTab && activeTab === 'knowledge'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.knowledgeTitle') }}</h2>
          <div class="settings-hint-block">
            <span class="settings-hint-icon">ℹ️</span>
            <p class="settings-hint-text">{{ t('settings.knowledgeHint') }}</p>
          </div>

          <!-- 向量模型 -->
          <div class="settings-group">
            <h3>{{ t('settings.vectorModelSection') }}</h3>
            <p class="form-hint">{{ t('settings.vectorModelSectionHint') }}</p>
            <div class="form-group knowledge-radio-group">
              <label class="radio-label">
                <input v-model="localRag.embeddingSource" type="radio" value="local" />
                {{ t('settings.vectorModelLocal') }}
              </label>
              <label class="radio-label">
                <input v-model="localRag.embeddingSource" type="radio" value="online" />
                {{ t('settings.vectorModelOnline') }}
              </label>
            </div>
            <div v-if="localRag.embeddingSource === 'local'" class="form-group">
              <label>{{ t('settings.localModelPath') }}</label>
              <input
                v-model="localRag.localModelPath"
                type="text"
                class="input"
                :placeholder="t('settings.localModelPathPlaceholder')"
              />
            </div>
            <template v-if="localRag.embeddingSource === 'online'">
              <div class="form-group">
                <label>{{ t('settings.embeddingModelItemCode') }}</label>
                <select v-model="localRag.embeddingModelItemCode" class="input select-input">
                  <option value="">— {{ t('settings.optional') }} —</option>
                  <option
                    v-for="m in configuredEmbeddingModels"
                    :key="m.modelItemCode || m.provider + ':' + m.modelId"
                    :value="m.modelItemCode || m.provider + ':' + m.modelId"
                  >
                    {{ getProviderDisplayName(m.provider) }} / {{ getModelAlias(m) }}
                  </option>
                </select>
                <p v-if="configuredEmbeddingModels.length === 0" class="form-hint form-hint-warn">{{ t('settings.noConfiguredEmbeddingModels') }}</p>
              </div>
            </template>
          </div>

          <!-- 向量库 -->
          <div class="settings-group">
            <h3>{{ t('settings.vectorStoreSection') }}</h3>
            <p class="form-hint">{{ t('settings.vectorStoreSectionHint') }}</p>
            <div class="form-group knowledge-radio-group">
              <label class="radio-label">
                <input v-model="localRag.vectorStore" type="radio" value="local" />
                {{ t('settings.vectorStoreLocal') }}
              </label>
              <label class="radio-label">
                <input v-model="localRag.vectorStore" type="radio" value="qdrant" />
                {{ t('settings.vectorStoreQdrant') }}
              </label>
            </div>
            <template v-if="localRag.vectorStore === 'qdrant'">
              <div class="form-group">
                <label>{{ t('settings.qdrantUrl') }}</label>
                <input
                  v-model="localRag.qdrant.url"
                  type="text"
                  class="input"
                  :placeholder="t('settings.qdrantUrlPlaceholder')"
                />
              </div>
              <div class="form-group">
                <label>{{ t('settings.qdrantApiKey') }}</label>
                <input
                  v-model="localRag.qdrant.apiKey"
                  type="password"
                  class="input"
                  :placeholder="t('settings.qdrantApiKeyPlaceholder')"
                  autocomplete="off"
                />
              </div>
              <div class="form-group">
                <label>{{ t('settings.qdrantCollection') }}</label>
                <input
                  v-model="localRag.qdrant.collection"
                  type="text"
                  class="input"
                  :placeholder="t('settings.qdrantCollectionPlaceholder')"
                />
              </div>
            </template>
          </div>

          <div class="actions">
            <button @click="saveKnowledgeConfig" class="btn-primary">{{ t('common.save') }}</button>
          </div>
        </div>

        <!-- 用户 Tab -->
        <div v-show="activeTab === 'users'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.users') }}</h2>

          <!-- 修改当前用户密码 -->
          <div v-if="authStore.currentUser" class="settings-group">
            <h3>{{ t('settings.changeCurrentPassword') }}</h3>
            <p class="form-hint">{{ t('settings.changeCurrentPasswordHint') }} <strong>{{ authStore.currentUser.username }}</strong>。{{ t('settings.changeCurrentPasswordHintAfter') }}</p>
            <button type="button" class="btn-secondary" @click="openChangeCurrentUserPassword">{{ t('settings.changeCurrentPassword') }}</button>
          </div>

          <div class="settings-group">
            <h3>{{ t('settings.userList') }}</h3>
            <div class="users-toolbar">
              <p class="form-hint">{{ t('settings.usersHint') }}</p>
              <button type="button" class="btn-primary" @click="openAddUser">{{ t('settings.addUser') }}</button>
            </div>
            <div v-if="usersLoading" class="loading-state">{{ t('common.loading') }}</div>
            <div v-else-if="usersList.length === 0" class="empty-state">
              <p>{{ t('settings.noUsers') }}</p>
              <button type="button" class="btn-primary" @click="openAddUser">{{ t('settings.addUser') }}</button>
            </div>
            <div v-else class="users-table-wrap">
              <table class="users-table">
                <thead>
                  <tr>
                    <th>{{ t('settings.loginUsername') }}</th>
                    <th class="th-actions">{{ t('common.details') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in usersList" :key="u.id">
                    <td><span class="username-cell">{{ u.username }}</span></td>
                    <td class="td-actions">
                      <button type="button" class="link-btn" @click="openChangePassword(u)">{{ t('settings.changePassword') }}</button>
                      <span class="sep">|</span>
                      <button type="button" class="link-btn" @click="openEditUser(u)">{{ t('settings.editUser') }}</button>
                      <span class="sep">|</span>
                      <button type="button" class="link-btn danger" @click="confirmDeleteUser(u)">{{ t('common.delete') }}</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- Skills Tab -->
        <div v-show="activeTab === 'skills'" class="tab-content">
          <SettingsSkills />
        </div>

        <!-- 通道配置 Tab -->
        <div v-show="activeTab === 'channels'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.channels') }}</h2>
          <p class="form-hint settings-channels-desc">{{ t('settings.channelsDesc') }}</p>
          <div class="settings-group">
            <h3>{{ t('settings.feishu') }}</h3>
            <div class="form-group channel-feishu-enabled">
              <label class="checkbox-label">
                <input v-model="localChannels.feishu.enabled" type="checkbox" />
                {{ t('settings.channelFeishuEnabled') }}
              </label>
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelFeishuAppId') }}</label>
              <input
                v-model="localChannels.feishu.appId"
                type="text"
                class="input"
                :placeholder="t('settings.channelFeishuAppIdPlaceholder')"
                autocomplete="off"
              />
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelFeishuAppSecret') }}</label>
              <input
                v-model="localChannels.feishu.appSecret"
                type="password"
                class="input"
                :placeholder="t('settings.channelFeishuAppSecretPlaceholder')"
                autocomplete="off"
              />
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelDefaultAgentId') }}</label>
              <select v-model="localChannels.feishu.defaultAgentId" class="input select-input">
                <option
                  v-for="a in channelFeishuDefaultAgentOptions"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name || a.id }}
                </option>
              </select>
            </div>
            <p class="form-hint">{{ t('settings.channelFeishuHint') }}</p>
          </div>
          <div class="settings-group">
            <h3>{{ t('settings.dingtalk') }}</h3>
            <div class="form-group channel-dingtalk-enabled">
              <label class="checkbox-label">
                <input v-model="localChannels.dingtalk.enabled" type="checkbox" />
                {{ t('settings.channelDingtalkEnabled') }}
              </label>
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelDingtalkClientId') }}</label>
              <input
                v-model="localChannels.dingtalk.clientId"
                type="text"
                class="input"
                :placeholder="t('settings.channelDingtalkClientIdPlaceholder')"
                autocomplete="off"
              />
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelDingtalkClientSecret') }}</label>
              <input
                v-model="localChannels.dingtalk.clientSecret"
                type="password"
                class="input"
                :placeholder="t('settings.channelDingtalkClientSecretPlaceholder')"
                autocomplete="off"
              />
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelDefaultAgentId') }}</label>
              <select v-model="localChannels.dingtalk.defaultAgentId" class="input select-input">
                <option
                  v-for="a in channelDingtalkDefaultAgentOptions"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name || a.id }}
                </option>
              </select>
            </div>
            <p class="form-hint">{{ t('settings.channelDingtalkHint') }}</p>
          </div>
          <div class="settings-group">
            <h3>{{ t('settings.telegram') }}</h3>
            <div class="form-group channel-telegram-enabled">
              <label class="checkbox-label">
                <input v-model="localChannels.telegram.enabled" type="checkbox" />
                {{ t('settings.channelTelegramEnabled') }}
              </label>
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelTelegramBotToken') }}</label>
              <input
                v-model="localChannels.telegram.botToken"
                type="password"
                class="input"
                :placeholder="t('settings.channelTelegramBotTokenPlaceholder')"
                autocomplete="off"
              />
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelDefaultAgentId') }}</label>
              <select v-model="localChannels.telegram.defaultAgentId" class="input select-input">
                <option
                  v-for="a in channelTelegramDefaultAgentOptions"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name || a.id }}
                </option>
              </select>
            </div>
            <p class="form-hint">{{ t('settings.channelTelegramHint') }}</p>
          </div>
          <div class="settings-group">
            <h3>{{ t('settings.wechat') }}</h3>
            <div class="form-group channel-wechat-enabled">
              <label class="checkbox-label">
                <input v-model="localChannels.wechat.enabled" type="checkbox" />
                {{ t('settings.channelWechatEnabled') }}
              </label>
            </div>
            <div class="form-group">
              <label>{{ t('settings.channelDefaultAgentId') }}</label>
              <select v-model="localChannels.wechat.defaultAgentId" class="input select-input">
                <option
                  v-for="a in channelWechatDefaultAgentOptions"
                  :key="a.id"
                  :value="a.id"
                >
                  {{ a.name || a.id }}
                </option>
              </select>
            </div>
            <div v-if="localChannels.wechat.enabled" class="form-group wechat-qrcode-section">
              <div class="wechat-status-row">
                <span class="wechat-status-dot" :class="wechatStatusClass"></span>
                <span>{{ wechatStatusText }}</span>
                <span v-if="wechatUserName" class="wechat-username">（{{ wechatUserName }}）</span>
              </div>
              <button
                v-if="wechatStatus !== 'logged_in'"
                type="button"
                class="btn-secondary"
                :disabled="wechatQrLoading"
                @click="fetchWechatQrCode"
              >
                {{ wechatQrCode ? t('settings.channelWechatRefreshQrCode') : t('settings.channelWechatGetQrCode') }}
              </button>
              <div v-if="wechatQrCode && wechatStatus !== 'logged_in'" class="wechat-qrcode-wrap">
                <p class="form-hint">{{ t('settings.channelWechatQrCodeHint') }}</p>
                <img :src="wechatQrCode" alt="WeChat QR Code" class="wechat-qrcode-img" />
              </div>
            </div>
            <p class="form-hint">{{ t('settings.channelWechatHint') }}</p>
          </div>
          <div class="actions">
            <button type="button" class="btn-primary" @click="saveChannelsConfig">
              {{ t('common.save') }}
            </button>
          </div>
        </div>

        <!-- About Tab -->
        <div v-show="activeTab === 'about'" class="tab-content">
          <h2 class="tab-title">{{ t('settings.about') }}</h2>
          
          <div class="about-card">
            <div class="logo-large">
              <img src="@/assets/logo.svg" alt="OpenClawX" />
            </div>
            <h3>OpenClawX Desktop</h3>
            <p class="version">{{ appVersion || 'v1.0.0' }}</p>
            
<div class="about-details">
            <div class="detail-row">
                <span>{{ t('settings.platform') }}:</span>
                <span>{{ platform }}</span>
              </div>
              <div class="detail-row">
                <span>Electron:</span>
                <span>{{ electronVersion }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 新增用户弹窗 -->
    <transition name="fade">
      <div v-if="showAddUserModal" class="modal-backdrop" @click.self="showAddUserModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('settings.addUser') }}</h2>
            <button type="button" class="close-btn" @click="showAddUserModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('settings.loginUsername') }}</label>
              <input v-model="addUserForm.username" type="text" class="input" :placeholder="t('settings.loginUsernamePlaceholder')" />
            </div>
            <div class="form-group">
              <label>{{ t('settings.loginPassword') }}</label>
              <input v-model="addUserForm.password" type="password" class="input" :placeholder="t('settings.loginPasswordPlaceholder')" autocomplete="new-password" />
            </div>
            <p v-if="userFormError" class="form-error">{{ userFormError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showAddUserModal = false">{{ t('common.close') }}</button>
              <button type="button" class="btn-primary" :disabled="userFormSaving" @click="submitAddUser">{{ userFormSaving ? t('common.loading') : t('common.save') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 编辑用户弹窗 -->
    <transition name="fade">
      <div v-if="showEditUserModal" class="modal-backdrop" @click.self="showEditUserModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('settings.editUser') }}</h2>
            <button type="button" class="close-btn" @click="showEditUserModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('settings.loginUsername') }}</label>
              <input v-model="editUserForm.username" type="text" class="input" />
            </div>
            <div class="form-group">
              <label>{{ t('settings.newPasswordOptional') }}</label>
              <input v-model="editUserForm.password" type="password" class="input" :placeholder="t('settings.newPasswordPlaceholder')" autocomplete="new-password" />
            </div>
            <p v-if="userFormError" class="form-error">{{ userFormError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showEditUserModal = false">{{ t('common.close') }}</button>
              <button type="button" class="btn-primary" :disabled="userFormSaving" @click="submitEditUser">{{ userFormSaving ? t('common.loading') : t('common.save') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 修改密码弹窗 -->
    <transition name="fade">
      <div v-if="showChangePasswordModal" class="modal-backdrop" @click.self="showChangePasswordModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('settings.changePassword') }}: {{ changePasswordUser?.username }}</h2>
            <button type="button" class="close-btn" @click="showChangePasswordModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('settings.newPassword') }}</label>
              <input v-model="changePasswordForm.password" type="password" class="input" autocomplete="new-password" />
            </div>
            <p v-if="userFormError" class="form-error">{{ userFormError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showChangePasswordModal = false">{{ t('common.close') }}</button>
              <button type="button" class="btn-primary" :disabled="userFormSaving" @click="submitChangePassword">{{ userFormSaving ? t('common.loading') : t('common.save') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 修改当前用户密码弹窗 -->
    <transition name="fade">
      <div v-if="showChangeCurrentPasswordModal" class="modal-backdrop" @click.self="showChangeCurrentPasswordModal = false">
        <div class="modal-content card-glass">
          <div class="modal-header">
            <h2>{{ t('settings.changeCurrentPassword') }}</h2>
            <button type="button" class="close-btn" @click="showChangeCurrentPasswordModal = false">✕</button>
          </div>
          <div class="modal-body">
            <div class="form-group">
              <label>{{ t('settings.newPassword') }}</label>
              <input v-model="currentUserPasswordForm.password" type="password" class="input" :placeholder="t('settings.newPassword')" autocomplete="new-password" />
            </div>
            <div class="form-group">
              <label>{{ t('settings.confirmNewPassword') }}</label>
              <input v-model="currentUserPasswordForm.confirm" type="password" class="input" :placeholder="t('settings.confirmNewPassword')" autocomplete="new-password" />
            </div>
            <p v-if="userFormError" class="form-error">{{ userFormError }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="showChangeCurrentPasswordModal = false">{{ t('common.close') }}</button>
              <button type="button" class="btn-primary" :disabled="userFormSaving" @click="submitChangeCurrentUserPassword">{{ userFormSaving ? t('common.loading') : t('common.save') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>

    <!-- 删除用户确认 -->
    <transition name="fade">
      <div v-if="deleteUserTarget" class="modal-backdrop" @click.self="deleteUserTarget = null">
        <div class="modal-content card-glass delete-confirm-modal">
          <div class="modal-header">
            <h2>{{ t('common.delete') }}</h2>
            <button type="button" class="close-btn" @click="deleteUserTarget = null">✕</button>
          </div>
          <div class="modal-body">
            <p>{{ t('settings.deleteUserConfirm') }}</p>
            <p class="delete-target-name">{{ deleteUserTarget?.username }}</p>
            <div class="modal-footer-actions">
              <button type="button" class="btn-secondary" @click="deleteUserTarget = null">{{ t('common.close') }}</button>
              <button type="button" class="btn-danger" :disabled="userFormSaving" @click="submitDeleteUser">{{ userFormSaving ? t('common.loading') : t('common.delete') }}</button>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { ref, computed, onMounted, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSettingsStore } from '@/store/modules/settings';
import { useLocaleStore } from '@/store/modules/locale';
import { useAuthStore } from '@/store/modules/auth';
import { useI18n } from '@/composables/useI18n';
import { usersAPI, agentConfigAPI } from '@/api';
import SettingsSkills from '@/components/SettingsSkills.vue';

const SETTINGS_TABS = ['general', 'agent', 'models', 'knowledge', 'users', 'skills', 'channels', 'about'];
    /** 是否显示 RAG/知识库 Tab */
    const showRagTab = true;

export default {
  name: 'Settings',
  components: { SettingsSkills },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const settingsStore = useSettingsStore();
    const localeStore = useLocaleStore();
    const authStore = useAuthStore();
    const { t } = useI18n();

    const tabFromQuery = () => {
      const q = route.query?.tab;
      return SETTINGS_TABS.includes(q) ? q : 'general';
    };
    const activeTab = ref(tabFromQuery());

    watch(() => route.query?.tab, (q) => {
      if (SETTINGS_TABS.includes(q)) activeTab.value = q;
    });
    watch(activeTab, async (tab) => {
      if (route.query?.tab !== tab) {
        router.replace({ path: '/settings', query: { ...route.query, tab } });
      }
      if (tab === 'users') loadUsers();
      // 打开对应配置 Tab 时先从磁盘刷新配置再初始化界面，显示最新（含 CLI 写入）
      if (tab === 'general') {
        await settingsStore.loadConfig();
        loadAgentConfig();
      }
      if (tab === 'agent') {
        await settingsStore.loadConfig();
        loadAgentConfig();
        await loadAgentList();
      }
      if (tab === 'models') {
        await settingsStore.loadConfig();
        initModelConfigTab();
      }
      if (tab === 'knowledge') {
        await settingsStore.loadConfig();
        initKnowledgeTab();
      }
      if (tab === 'channels') {
        await loadAgentList();
      }
    });
    const localConfig = ref({ memory: {} });
    const agentList = ref([]);
    const modelConfigSubTab = ref('provider');
    const localProviderConfig = ref({});
    const localDefaultProvider = ref('');
    const localDefaultModel = ref('');
    const addProviderForm = ref({ provider: '', alias: '', apiKey: '', baseUrl: '' });
    const editingProvider = ref(null);
    const showAddProviderModal = ref(false);
    const showAddModelModal = ref(false);
    /** 编辑时为已配置模型列表下标，新增时为 -1 */
    const editingModelIndex = ref(-1);
    const defaultCost = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const addModelForm = ref({
      provider: '',
      type: 'llm',
      modelId: '',
      /** 自定义模型 ID（可选）；有值时保存优先使用此项，适用于列表中没有的目标模型 */
      customModelId: '',
      alias: '',
      reasoning: false,
      cost: defaultCost(),
      contextWindow: 64000,
      maxTokens: 8192,
    });

    const usersList = ref([]);
    const usersLoading = ref(false);
    const showAddUserModal = ref(false);
    const showEditUserModal = ref(false);
    const showChangePasswordModal = ref(false);
    const addUserForm = ref({ username: '', password: '' });
    const editUserForm = ref({ id: '', username: '', password: '' });
    const changePasswordUser = ref(null);
    const changePasswordForm = ref({ password: '' });
    const deleteUserTarget = ref(null);
    const userFormError = ref('');
    const userFormSaving = ref(false);
    const showChangeCurrentPasswordModal = ref(false);
    const currentUserPasswordForm = ref({ password: '', confirm: '' });
    const localRag = ref({
      embeddingSource: 'online',
      embeddingProvider: '',
      embeddingModel: '',
      embeddingModelItemCode: '',
      localModelPath: '',
      vectorStore: 'local',
      qdrant: { url: '', apiKey: '', collection: '' },
    });
    const localChannels = ref({
      feishu: { enabled: false, appId: '', appSecret: '', defaultAgentId: 'default' },
      dingtalk: { enabled: false, clientId: '', clientSecret: '', defaultAgentId: 'default' },
      telegram: { enabled: false, botToken: '', defaultAgentId: 'default' },
      wechat: { enabled: false, puppet: '', defaultAgentId: 'default' },
    });

    /* ---------- WeChat QR code state ---------- */
    const wechatQrCode = ref(null);
    const wechatStatus = ref('logged_out');
    const wechatUserName = ref(null);
    const wechatQrLoading = ref(false);
    let wechatPollTimer = null;

    const wechatStatusClass = computed(() => ({
      'status-scanning': wechatStatus.value === 'scanning',
      'status-logged-in': wechatStatus.value === 'logged_in',
      'status-logged-out': wechatStatus.value === 'logged_out',
    }));
    const wechatStatusText = computed(() => {
      if (wechatStatus.value === 'scanning') return t('settings.channelWechatScanning');
      if (wechatStatus.value === 'logged_in') return t('settings.channelWechatLoggedIn');
      return t('settings.channelWechatLoggedOut');
    });

    async function fetchWechatQrCode() {
      wechatQrLoading.value = true;
      try {
        const rawUrl = settingsStore.config?.gatewayUrl || 'http://127.0.0.1:38080';
        const baseUrl = rawUrl.replace(/^ws(s?):\/\//, 'http$1://');
        // First try GET to see if QR code is already available
        let res = await fetch(`${baseUrl}/server-api/wechat/qrcode`);
        let data = await res.json();
        // If QR code is null (expired/not yet generated), trigger a refresh (restart bot)
        if (!data.qrcode && data.status !== 'logged_in') {
          console.log('[Settings] QR code not available, requesting refresh...');
          res = await fetch(`${baseUrl}/server-api/wechat/qrcode/refresh`, { method: 'POST' });
          data = await res.json();
        }
        wechatQrCode.value = data.qrcode || null;
        wechatStatus.value = data.status || 'logged_out';
        wechatUserName.value = data.userName || null;
        // Start polling if scanning
        if (data.status === 'scanning' && !wechatPollTimer) {
          wechatPollTimer = setInterval(pollWechatStatus, 3000);
        }
      } catch (e) {
        console.error('[Settings] fetch wechat qrcode failed:', e);
      } finally {
        wechatQrLoading.value = false;
      }
    }

    async function pollWechatStatus() {
      try {
        const rawUrl = settingsStore.config?.gatewayUrl || 'http://127.0.0.1:38080';
        const baseUrl = rawUrl.replace(/^ws(s?):\/\//, 'http$1://');
        const res = await fetch(`${baseUrl}/server-api/wechat/qrcode`);
        const data = await res.json();
        wechatQrCode.value = data.qrcode || null;
        wechatStatus.value = data.status || 'logged_out';
        wechatUserName.value = data.userName || null;
        if (data.status === 'logged_in' || data.status === 'logged_out') {
          clearInterval(wechatPollTimer);
          wechatPollTimer = null;
        }
      } catch (_e) { /* ignore */ }
    }

    const config = computed(() => settingsStore.config || {});
    const providers = computed(() => settingsStore.providers || []);
    const providerSupport = computed(() => settingsStore.providerSupport || {});
    const models = computed(() => settingsStore.models || {});
    const supportedProviders = computed(() => Array.isArray(providers.value) ? providers.value : []);
    /** 当前已选 provider 的可用模型列表（来自 provider-support），用于默认模型下拉；项为 { id, name } */
    const defaultModelOptions = computed(() => {
      const list = models.value[localDefaultProvider.value];
      if (!Array.isArray(list)) return [];
      return list.map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.name || m.id }));
    });
    const configuredProviders = computed(() => {
      const cfg = localProviderConfig.value;
      if (!cfg || typeof cfg !== 'object') return [];
      return Object.keys(cfg).filter((p) => {
        const entry = cfg[p];
        return entry && typeof entry.apiKey === 'string' && entry.apiKey.trim() !== '';
      });
    });
    /** 已配置的模型列表（备用），从 config.configuredModels 来 */
    const configuredModelsList = computed(() => {
      const list = config.value?.configuredModels;
      return Array.isArray(list) ? list : [];
    });
    /** 当前缺省模型在列表中的下标（优先按 defaultModelItemCode 匹配，否则按 provider+modelId） */
    const defaultModelIndex = computed(() => {
      const list = configuredModelsList.value;
      const code = config.value?.defaultModelItemCode;
      if (code) {
        const idx = list.findIndex((item) => item.modelItemCode === code);
        if (idx >= 0) return idx;
      }
      const p = config.value?.defaultProvider;
      const m = config.value?.defaultModel;
      if (!p || !m) return -1;
      return list.findIndex((item) => item.provider === p && item.modelId === m);
    });
    /** 已配置且 provider-support 中提供 embedding 模型的 Provider 列表 */
    const providersWithEmbedding = computed(() => {
      const support = providerSupport.value;
      return configuredProviders.value.filter((p) => {
        const models = support[p]?.models;
        return Array.isArray(models) && models.some((m) => m.types?.includes('embedding'));
      });
    });
    /** 知识库 Tab 下当前选的 Provider 的 embedding 模型列表（旧 UI 用） */
    const knowledgeEmbeddingModels = computed(() => {
      const p = localRag.value.embeddingProvider;
      if (!p) return [];
      const entry = providerSupport.value[p];
      if (!entry?.models) return [];
      return entry.models.filter((m) => m.types?.includes('embedding'));
    });
    /** 已配置的 Embedding 模型列表（供知识库「在线」下拉选择） */
    const configuredEmbeddingModels = computed(() => {
      const list = configuredModelsList.value;
      return list.filter((item) => item.type === 'embedding');
    });
    /** 是否为 OpenAI 自定义 Provider（模型 ID 允许手工录入） */
    const isOpenAiCustomProvider = computed(() => addModelForm.value.provider === 'openai-custom');
    /** 新增模型弹窗中当前 provider+type 对应的模型下拉选项（非 openai-custom 时使用） */
    const addModelOptions = computed(() => {
      const provider = addModelForm.value.provider;
      const type = addModelForm.value.type;
      if (!provider || !type || provider === 'openai-custom') return [];
      const key = `${provider}:${type}`;
      const list = settingsStore.models[key] || models.value[key];
      if (!Array.isArray(list)) return [];
      return list.map((m) => (typeof m === 'string' ? { id: m, name: m } : { id: m.id, name: m.name || m.id }));
    });
    /** 新增/编辑模型弹窗中实际使用的模型 ID：自定义输入优先，否则为下拉选择值 */
    const effectiveAddModelId = computed(() => {
      const custom = (addModelForm.value.customModelId || '').trim();
      if (custom) return custom;
      if (isOpenAiCustomProvider.value) return (addModelForm.value.modelId || '').trim();
      return (addModelForm.value.modelId || '').trim();
    });
    /** 通道配置-飞书：绑定当前通道的缺省智能体下拉选项（default + 智能体列表；若当前值不在列表中则追加一项） */
    const channelFeishuDefaultAgentOptions = computed(() => {
      const current = (localChannels.value?.feishu?.defaultAgentId || '').trim() || 'default';
      const list = [{ id: 'default', name: 'default' }, ...agentList.value];
      const hasCurrent = list.some((a) => a.id === current);
      if (!hasCurrent && current) return [...list, { id: current, name: current }];
      return list;
    });
    /** 通道配置-钉钉：默认智能体下拉选项 */
    const channelDingtalkDefaultAgentOptions = computed(() => {
      const current = (localChannels.value?.dingtalk?.defaultAgentId || '').trim() || 'default';
      const list = [{ id: 'default', name: 'default' }, ...agentList.value];
      const hasCurrent = list.some((a) => a.id === current);
      if (!hasCurrent && current) return [...list, { id: current, name: current }];
      return list;
    });
    /** 通道配置-Telegram：默认智能体下拉选项 */
    const channelTelegramDefaultAgentOptions = computed(() => {
      const current = (localChannels.value?.telegram?.defaultAgentId || '').trim() || 'default';
      const list = [{ id: 'default', name: 'default' }, ...agentList.value];
      const hasCurrent = list.some((a) => a.id === current);
      if (!hasCurrent && current) return [...list, { id: current, name: current }];
      return list;
    });
    /** 通道配置-微信：默认智能体下拉选项 */
    const channelWechatDefaultAgentOptions = computed(() => {
      const current = (localChannels.value?.wechat?.defaultAgentId || '').trim() || 'default';
      const list = [{ id: 'default', name: 'default' }, ...agentList.value];
      const hasCurrent = list.some((a) => a.id === current);
      if (!hasCurrent && current) return [...list, { id: current, name: current }];
      return list;
    });
    const platform = window.electronAPI?.platform || 'web';
    const appVersion = ref('');
    const electronVersion = ref('Unknown');

    const currentLocale = computed({
      get: () => localeStore.locale,
      set: (v) => localeStore.setLocale(v),
    });

    const setTheme = (theme) => {
      settingsStore.setTheme(theme);
    };

    const loadAgentConfig = () => {
      try {
        const cfg = settingsStore.config || {};
        const effectiveAgentId = cfg.defaultAgentId ?? 'default';
        const memoryCfg = cfg.memory || {};
        localConfig.value = { ...cfg, defaultAgentId: effectiveAgentId, loginPassword: '', memory: { ...memoryCfg } };
      } catch (err) {
        console.warn('[Settings] loadAgentConfig error', err);
        localConfig.value = { loginPassword: '', memory: {} };
      }
    };

    const loadAgentList = async () => {
      try {
        const res = await agentConfigAPI.listAgents();
        const raw = res?.data?.data ?? res?.data;
        agentList.value = Array.isArray(raw) ? raw : [];
      } catch (err) {
        console.warn('[Settings] loadAgentList error', err);
        agentList.value = [];
      }
    };

    /** 缺省智能体下拉选项：default + 现有智能体列表；若当前配置值不在列表中则追加一项以便正确显示 */
    const defaultAgentOptions = computed(() => {
      const current = localConfig.value?.defaultAgentId ?? 'default';
      const list = [{ id: 'default', name: 'default' }, ...agentList.value];
      const hasCurrent = list.some((a) => a.id === current);
      if (!hasCurrent && current && current !== 'default') {
        return [...list, { id: current, name: current }];
      }
      return list;
    });

    const saveAgentConfig = async () => {
      const payload = { ...localConfig.value };
      if (payload.loginPassword === '') delete payload.loginPassword;
      const agentId = payload.defaultAgentId ?? 'default';
      await settingsStore.updateConfig({ ...payload, defaultAgentId: agentId });
      const updatedCfg = settingsStore.config || {};
      const memoryCfg = updatedCfg.memory || {};
      localConfig.value = { ...updatedCfg, defaultAgentId: updatedCfg.defaultAgentId ?? 'default', loginPassword: '', memory: { ...memoryCfg } };
      alert(t('common.saved'));
    };

    const logout = () => {
      authStore.logout();
    };

    const resetAgentConfig = () => {
      loadAgentConfig();
    };

    function initKnowledgeTab() {
      const cfg = config.value || {};
      const rag = cfg.rag;
      const q = rag?.qdrant;
      let embeddingModelItemCode = (rag?.embeddingModelItemCode && typeof rag.embeddingModelItemCode === 'string' ? rag.embeddingModelItemCode : '').trim();
      const p = (rag?.embeddingProvider || '').trim();
      const m = (rag?.embeddingModel || '').trim();
      if (!embeddingModelItemCode && p && m && Array.isArray(cfg.configuredModels)) {
        const item = cfg.configuredModels.find((x) => x.type === 'embedding' && x.provider === p && x.modelId === m);
        if (item) embeddingModelItemCode = item.modelItemCode || `${item.provider}:${item.modelId}`;
      }
      localRag.value = {
        embeddingSource: rag?.embeddingSource === 'local' ? 'local' : 'online',
        embeddingProvider: p,
        embeddingModel: m,
        embeddingModelItemCode,
        localModelPath: (rag?.localModelPath && typeof rag.localModelPath === 'string' ? rag.localModelPath : '').trim(),
        vectorStore: rag?.vectorStore === 'qdrant' ? 'qdrant' : 'local',
        qdrant: {
          url: (q?.url && typeof q.url === 'string' ? q.url : '').trim(),
          apiKey: (q?.apiKey && typeof q.apiKey === 'string' ? q.apiKey : '').trim(),
          collection: (q?.collection && typeof q.collection === 'string' ? q.collection : '').trim(),
        },
      };
    }

    function onKnowledgeProviderChange() {
      localRag.value.embeddingModel = '';
    }

    async function saveKnowledgeConfig() {
      const v = localRag.value;
      const embeddingSource = v.embeddingSource === 'local' ? 'local' : 'online';
      const vectorStore = v.vectorStore === 'qdrant' ? 'qdrant' : 'local';
      let embeddingModelItemCode = (v.embeddingModelItemCode || '').trim();
      let embeddingProvider = (v.embeddingProvider || '').trim();
      let embeddingModel = (v.embeddingModel || '').trim();
      const localModelPath = (v.localModelPath || '').trim();
      const qdrantUrl = (v.qdrant?.url || '').trim();
      if (embeddingSource === 'online' && embeddingModelItemCode) {
        const list = configuredModelsList.value;
        const item = list.find((m) => (m.modelItemCode || m.provider + ':' + m.modelId) === embeddingModelItemCode);
        if (item) {
          embeddingProvider = item.provider;
          embeddingModel = item.modelId;
          if (item.modelItemCode) embeddingModelItemCode = item.modelItemCode;
        }
      }
      const rag = {
        embeddingSource,
        vectorStore,
        ...(embeddingSource === 'local' ? { localModelPath: localModelPath || undefined } : { embeddingModelItemCode: embeddingModelItemCode || undefined, embeddingProvider: embeddingProvider || undefined, embeddingModel: embeddingModel || undefined }),
        ...(vectorStore === 'qdrant' && qdrantUrl ? { qdrant: { url: qdrantUrl, apiKey: (v.qdrant?.apiKey || '').trim() || undefined, collection: (v.qdrant?.collection || '').trim() || undefined } } : { qdrant: undefined }),
      };
      await settingsStore.updateConfig({ rag });
      alert(t('common.saved'));
    }

    function initChannelsTab() {
      const ch = config.value?.channels;
      const feishu = ch?.feishu;
      const dingtalk = ch?.dingtalk;
      const telegram = ch?.telegram;
      const wechat = ch?.wechat;
      localChannels.value = {
        feishu: {
          enabled: !!feishu?.enabled,
          appId: typeof feishu?.appId === 'string' ? feishu.appId : '',
          appSecret: typeof feishu?.appSecret === 'string' ? feishu.appSecret : '',
          defaultAgentId: typeof feishu?.defaultAgentId === 'string' ? feishu.defaultAgentId : 'default',
        },
        dingtalk: {
          enabled: !!dingtalk?.enabled,
          clientId: typeof dingtalk?.clientId === 'string' ? dingtalk.clientId : '',
          clientSecret: typeof dingtalk?.clientSecret === 'string' ? dingtalk.clientSecret : '',
          defaultAgentId: typeof dingtalk?.defaultAgentId === 'string' ? dingtalk.defaultAgentId : 'default',
        },
        telegram: {
          enabled: !!telegram?.enabled,
          botToken: typeof telegram?.botToken === 'string' ? telegram.botToken : '',
          defaultAgentId: typeof telegram?.defaultAgentId === 'string' ? telegram.defaultAgentId : 'default',
        },
        wechat: {
          enabled: !!wechat?.enabled,
          puppet: typeof wechat?.puppet === 'string' ? wechat.puppet : '',
          defaultAgentId: typeof wechat?.defaultAgentId === 'string' ? wechat.defaultAgentId : 'default',
        },
      };
    }

    async function saveChannelsConfig() {
      await settingsStore.updateConfig({
        channels: {
          feishu: {
            enabled: !!localChannels.value.feishu.enabled,
            appId: (localChannels.value.feishu.appId || '').trim(),
            appSecret: (localChannels.value.feishu.appSecret || '').trim(),
            defaultAgentId: (localChannels.value.feishu.defaultAgentId || 'default').trim(),
          },
          dingtalk: {
            enabled: !!localChannels.value.dingtalk.enabled,
            clientId: (localChannels.value.dingtalk.clientId || '').trim(),
            clientSecret: (localChannels.value.dingtalk.clientSecret || '').trim(),
            defaultAgentId: (localChannels.value.dingtalk.defaultAgentId || 'default').trim(),
          },
          telegram: {
            enabled: !!localChannels.value.telegram.enabled,
            botToken: (localChannels.value.telegram.botToken || '').trim(),
            defaultAgentId: (localChannels.value.telegram.defaultAgentId || 'default').trim(),
          },
          wechat: {
            enabled: !!localChannels.value.wechat.enabled,
            puppet: (localChannels.value.wechat.puppet || '').trim() || undefined,
            defaultAgentId: (localChannels.value.wechat.defaultAgentId || 'default').trim(),
          },
        },
      });
      alert(t('common.saved'));
    }

    function initModelConfigTab() {
      try {
        const cfg = config.value || {};
        const prov = cfg.providers && typeof cfg.providers === 'object' ? cfg.providers : {};
        const next = {};
        for (const [p, entry] of Object.entries(prov)) {
          if (p && typeof p === 'string') {
            next[p] = {
              apiKey: entry && typeof entry.apiKey === 'string' ? entry.apiKey : '',
              baseUrl: entry && typeof entry.baseUrl === 'string' ? entry.baseUrl : '',
              alias: entry && typeof entry.alias === 'string' ? entry.alias : '',
            };
          }
        }
        localProviderConfig.value = next;
        const defProv = cfg.defaultProvider && typeof cfg.defaultProvider === 'string' ? cfg.defaultProvider : 'deepseek';
        const defModel = cfg.defaultModel && typeof cfg.defaultModel === 'string' ? cfg.defaultModel : 'deepseek-chat';
        const configured = Object.keys(next).filter((k) => (next[k].apiKey || '').trim() !== '');
        localDefaultProvider.value = configured.includes(defProv) ? defProv : (configured[0] || 'deepseek');
        localDefaultModel.value = defModel;
        const cm = Array.isArray(cfg.configuredModels) ? cfg.configuredModels : [];
        const defItem = cm.find((m) => m.provider === defProv && m.modelId === defModel);
        ensureModelsLoaded(localDefaultProvider.value).catch((err) => console.warn('[Settings] ensureModelsLoaded', err));
      } catch (err) {
        console.error('[Settings] initModelConfigTab error', err);
        localProviderConfig.value = {};
        localDefaultProvider.value = 'deepseek';
        localDefaultModel.value = 'deepseek-chat';
      }
    }

    async function ensureModelsLoaded(provider) {
      if (!provider || typeof provider !== 'string') return;
      if (settingsStore.models && settingsStore.models[provider]) return;
      try {
        await settingsStore.loadModels(provider);
      } catch (err) {
        console.warn('[Settings] loadModels failed', provider, err);
      }
    }

    function onDefaultProviderChange(provider) {
      ensureModelsLoaded(provider).catch(() => {});
    }

    function getModelDisplayName(provider, modelId) {
      const entry = providerSupport.value[provider];
      if (!entry?.models) return modelId || '—';
      const m = entry.models.find((x) => x.id === modelId);
      return m ? (m.name || m.id) : modelId;
    }

    function getModelAlias(item) {
      const name = item.alias?.trim();
      if (name) return name;
      return getModelDisplayName(item.provider, item.modelId);
    }

    function getProviderDisplayName(providerId) {
      const fromConfig = config.value?.providers?.[providerId]?.alias?.trim();
      if (fromConfig) return fromConfig;
      const fromLocal = localProviderConfig.value[providerId]?.alias?.trim();
      if (fromLocal) return fromLocal;
      const support = providerSupport.value[providerId];
      return support?.name || providerId;
    }

    function ensureUniqueModelAlias(baseAlias, existingList) {
      const existing = existingList.map((it) => getModelAlias(it));
      if (!existing.includes(baseAlias)) return baseAlias;
      let n = 2;
      while (existing.includes(`${baseAlias} (${n})`)) n++;
      return `${baseAlias} (${n})`;
    }

    function ensureUniqueProviderAlias(baseAlias, excludeProviderId) {
      const provs = configuredProviders.value.filter((p) => p !== excludeProviderId);
      const existing = provs.map((p) => getProviderDisplayName(p));
      if (!existing.includes(baseAlias)) return baseAlias;
      let n = 2;
      while (existing.includes(`${baseAlias} (${n})`)) n++;
      return `${baseAlias} (${n})`;
    }

    function openAddModelModal() {
      editingModelIndex.value = -1;
      addModelForm.value = {
        provider: configuredProviders.value[0] || '',
        type: 'llm',
        modelId: '',
        customModelId: '',
        alias: '',
        reasoning: false,
        cost: defaultCost(),
        contextWindow: 64000,
        maxTokens: 8192,
      };
      if (addModelForm.value.provider) {
        settingsStore.loadModels(addModelForm.value.provider, addModelForm.value.type).catch(() => {});
      }
      showAddModelModal.value = true;
    }

    function openEditModel(idx) {
      const list = configuredModelsList.value;
      const item = list[idx];
      if (!item) return;
      editingModelIndex.value = idx;
      const c = item.cost && typeof item.cost === 'object' ? item.cost : defaultCost();
      addModelForm.value = {
        provider: item.provider,
        type: item.type || 'llm',
        modelId: item.modelId,
        customModelId: '',
        alias: (item.alias || '').trim() || '',
        reasoning: !!item.reasoning,
        cost: {
          input: Number(c.input) || 0,
          output: Number(c.output) || 0,
          cacheRead: Number(c.cacheRead) || 0,
          cacheWrite: Number(c.cacheWrite) || 0,
        },
        contextWindow: Math.max(0, Math.floor(Number(item.contextWindow))) || 64000,
        maxTokens: Math.max(0, Math.floor(Number(item.maxTokens))) || 8192,
      };
      settingsStore.loadModels(item.provider, item.type || 'llm').catch(() => {});
      showAddModelModal.value = true;
    }

    function closeAddModelModal() {
      showAddModelModal.value = false;
      editingModelIndex.value = -1;
      addModelForm.value = { provider: '', type: 'llm', modelId: '', customModelId: '', alias: '', reasoning: false, cost: defaultCost(), contextWindow: 64000, maxTokens: 8192 };
    }

    function onAddModelProviderOrTypeChange() {
      const { provider, type } = addModelForm.value;
      addModelForm.value.modelId = '';
      addModelForm.value.customModelId = '';
      if (provider && type) settingsStore.loadModels(provider, type).catch(() => {});
    }

    function buildModelItemCode(provider, modelId) {
      return `${provider}_${modelId}`.replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    async function submitAddModel() {
      const { provider, type } = addModelForm.value;
      const modelId = effectiveAddModelId.value;
      if (!provider || !modelId) return;
      const baseAlias = (addModelForm.value.alias || '').trim() || getModelDisplayName(provider, modelId);
      const list = configuredModelsList.value;
      const isEdit = editingModelIndex.value >= 0;
      const excludeList = isEdit ? list.filter((_, i) => i !== editingModelIndex.value) : list;
      const alias = ensureUniqueModelAlias(baseAlias, excludeList);
      const c = addModelForm.value.cost || {};
      const existingItem = isEdit ? list[editingModelIndex.value] : null;
      const modelItemCode = (existingItem && existingItem.modelItemCode) ? existingItem.modelItemCode : buildModelItemCode(provider, modelId);
      const newItem = {
        provider,
        modelId,
        type,
        alias,
        modelItemCode,
        reasoning: !!addModelForm.value.reasoning,
        cost: {
          input: Number(c.input) || 0,
          output: Number(c.output) || 0,
          cacheRead: Number(c.cacheRead) || 0,
          cacheWrite: Number(c.cacheWrite) || 0,
        },
        contextWindow: Math.max(0, Math.floor(Number(addModelForm.value.contextWindow)) || 64000),
        maxTokens: Math.max(0, Math.floor(Number(addModelForm.value.maxTokens)) || 8192),
      };
      let nextList;
      if (isEdit) {
        nextList = list.map((it, i) => (i === editingModelIndex.value ? newItem : it));
        const wasDefault = list[editingModelIndex.value]?.provider === config.value?.defaultProvider && list[editingModelIndex.value]?.modelId === config.value?.defaultModel;
        if (wasDefault) {
          await settingsStore.updateConfig({ configuredModels: nextList, defaultProvider: provider, defaultModel: modelId, defaultModelItemCode: newItem.modelItemCode });
        } else {
          await settingsStore.updateConfig({ configuredModels: nextList });
        }
      } else {
        nextList = [...list, newItem];
        await settingsStore.updateConfig({ configuredModels: nextList });
        if (list.length === 0) {
          await settingsStore.updateConfig({ defaultProvider: provider, defaultModel: modelId, defaultModelItemCode: newItem.modelItemCode });
        }
      }
      closeAddModelModal();
    }

    function confirmRemoveConfiguredModel(idx) {
      if (!window.confirm(t('settings.confirmRemoveModel'))) return;
      removeConfiguredModel(idx);
    }

    function removeConfiguredModel(idx) {
      const list = configuredModelsList.value.filter((_, i) => i !== idx);
      if (!list.length) {
        settingsStore.updateConfig({ configuredModels: [], defaultProvider: 'deepseek', defaultModel: 'deepseek-chat', defaultModelItemCode: undefined });
        return;
      }
      const removed = configuredModelsList.value[idx];
      const wasDefault = removed.provider === config.value.defaultProvider && removed.modelId === config.value.defaultModel;
      settingsStore.updateConfig({ configuredModels: list });
      if (wasDefault && list.length) {
        const first = list[0];
        settingsStore.updateConfig({ defaultProvider: first.provider, defaultModel: first.modelId, defaultModelItemCode: first.modelItemCode || undefined });
      }
    }

    function isDefaultModel(item) {
      const code = config.value?.defaultModelItemCode;
      if (code) return item.modelItemCode === code;
      const p = config.value?.defaultProvider;
      const m = config.value?.defaultModel;
      return p === item.provider && m === item.modelId;
    }

    function setDefaultFromConfigured(item) {
      settingsStore.updateConfig({
        defaultProvider: item.provider,
        defaultModel: item.modelId,
        defaultModelItemCode: item.modelItemCode || undefined,
      });
    }

    async function saveProviderConfig() {
      const raw = localProviderConfig.value;
      const providers = {};
      for (const [p, entry] of Object.entries(raw)) {
        if (!p) continue;
        providers[p] = {
          apiKey: entry.apiKey,
          baseUrl: entry.baseUrl,
          alias: entry.alias ?? '',
        };
      }
      await settingsStore.updateConfig({ providers });
      alert(t('common.saved'));
    }

    function openAddProviderModal() {
      addProviderForm.value = { provider: '', alias: '', apiKey: '', baseUrl: '' };
      showAddProviderModal.value = true;
    }

    function onAddProviderSelect() {
      const p = addProviderForm.value.provider;
      const entry = providerSupport.value[p];
      addProviderForm.value.alias = p ? (entry?.name || p) : '';
      if (entry?.baseUrl != null && String(entry.baseUrl).trim() !== '') {
        addProviderForm.value.baseUrl = String(entry.baseUrl).trim();
      } else {
        addProviderForm.value.baseUrl = '';
      }
    }

    function submitAddProvider() {
      const { provider, alias, apiKey, baseUrl } = addProviderForm.value;
      if (!provider || !(apiKey && apiKey.trim())) return;
      const base = (alias || '').trim() || (providerSupport.value[provider]?.name || provider);
      const uniqueAlias = ensureUniqueProviderAlias(base, provider);
      localProviderConfig.value = {
        ...localProviderConfig.value,
        [provider]: {
          apiKey: apiKey.trim(),
          baseUrl: (baseUrl || '').trim(),
          alias: uniqueAlias,
        },
      };
      saveProviderConfig().then(() => {
        showAddProviderModal.value = false;
        addProviderForm.value = { provider: '', alias: '', apiKey: '', baseUrl: '' };
      }).catch(() => {});
    }


    function removeProvider(prov) {
      if (!prov) return;
      if (editingProvider.value === prov) editingProvider.value = null;
      const next = { ...localProviderConfig.value };
      delete next[prov];
      localProviderConfig.value = next;
      saveProviderConfig().catch(() => {});
    }

    function startEditProvider(prov) {
      editingProvider.value = prov;
      const cur = localProviderConfig.value[prov];
      const preset = providerSupport.value[prov]?.baseUrl != null && String(providerSupport.value[prov].baseUrl).trim() !== '' ? String(providerSupport.value[prov].baseUrl).trim() : '';
      if (cur && (!cur.baseUrl || !String(cur.baseUrl).trim()) && preset) {
        localProviderConfig.value = {
          ...localProviderConfig.value,
          [prov]: { ...cur, baseUrl: preset },
        };
      }
    }

    function cancelEditProvider() {
      const prov = editingProvider.value;
      if (!prov) return;
      const fromConfig = config.value?.providers?.[prov];
      if (fromConfig) {
        localProviderConfig.value = {
          ...localProviderConfig.value,
          [prov]: {
            apiKey: fromConfig.apiKey ?? '',
            baseUrl: fromConfig.baseUrl ?? '',
            alias: fromConfig.alias ?? '',
          },
        };
      }
      editingProvider.value = null;
    }

    async function saveEditProvider() {
      const prov = editingProvider.value;
      if (prov) {
        const rawAlias = localProviderConfig.value[prov]?.alias?.trim() || getProviderDisplayName(prov);
        const uniqueAlias = ensureUniqueProviderAlias(rawAlias, prov);
        localProviderConfig.value = {
          ...localProviderConfig.value,
          [prov]: { ...localProviderConfig.value[prov], alias: uniqueAlias },
        };
      }
      await saveProviderConfig();
      editingProvider.value = null;
    }

    async function setDefaultModel() {
      const prov = localDefaultProvider.value;
      const model = localDefaultModel.value;
      if (!configuredProviders.value.includes(prov)) {
        alert(t('settings.noConfiguredProvider'));
        return;
      }
      const list = configuredModelsList.value;
      const item = list.find((x) => x.provider === prov && x.modelId === model);
      await settingsStore.updateConfig({
        defaultProvider: prov,
        defaultModel: model,
        defaultModelItemCode: item?.modelItemCode || undefined,
      });
      alert(t('common.saved'));
    }

    async function loadUsers() {
      usersLoading.value = true;
      userFormError.value = '';
      try {
        const res = await usersAPI.list();
        usersList.value = res.data?.data ?? [];
      } catch (e) {
        usersList.value = [];
      } finally {
        usersLoading.value = false;
      }
    }

    function openAddUser() {
      addUserForm.value = { username: '', password: '' };
      userFormError.value = '';
      showAddUserModal.value = true;
    }

    function openEditUser(u) {
      editUserForm.value = { id: u.id, username: u.username, password: '' };
      userFormError.value = '';
      showEditUserModal.value = true;
    }

    function openChangePassword(u) {
      changePasswordUser.value = u;
      changePasswordForm.value = { password: '' };
      userFormError.value = '';
      showChangePasswordModal.value = true;
    }

    function confirmDeleteUser(u) {
      deleteUserTarget.value = u;
      userFormError.value = '';
    }

    function openChangeCurrentUserPassword() {
      currentUserPasswordForm.value = { password: '', confirm: '' };
      userFormError.value = '';
      showChangeCurrentPasswordModal.value = true;
    }

    async function submitChangeCurrentUserPassword() {
      const pwd = (currentUserPasswordForm.value.password || '').trim();
      const confirmPwd = (currentUserPasswordForm.value.confirm || '').trim();
      if (!pwd) {
        userFormError.value = t('settings.passwordRequired');
        return;
      }
      if (pwd !== confirmPwd) {
        userFormError.value = t('settings.passwordMismatch');
        return;
      }
      const cur = authStore.currentUser;
      if (!cur) return;
      userFormSaving.value = true;
      userFormError.value = '';
      try {
        await usersAPI.update(cur.id, { password: pwd });
        showChangeCurrentPasswordModal.value = false;
        currentUserPasswordForm.value = { password: '', confirm: '' };
      } catch (e) {
        userFormError.value = e.response?.data?.message ?? e.message ?? t('login.invalidCredentials');
      } finally {
        userFormSaving.value = false;
      }
    }

    async function submitAddUser() {
      const username = (addUserForm.value.username || '').trim();
      const password = (addUserForm.value.password || '').trim();
      if (!username) {
        userFormError.value = t('settings.usernameRequired');
        return;
      }
      if (!password) {
        userFormError.value = t('settings.passwordRequired');
        return;
      }
      userFormSaving.value = true;
      userFormError.value = '';
      try {
        await usersAPI.create(username, password);
        showAddUserModal.value = false;
        await loadUsers();
      } catch (e) {
        userFormError.value = e.response?.data?.message ?? e.message ?? t('login.invalidCredentials');
      } finally {
        userFormSaving.value = false;
      }
    }

    async function submitEditUser() {
      const username = (editUserForm.value.username || '').trim();
      if (!username) {
        userFormError.value = t('settings.usernameRequired');
        return;
      }
      userFormSaving.value = true;
      userFormError.value = '';
      try {
        const updates = { username };
        if (editUserForm.value.password.trim()) updates.password = editUserForm.value.password.trim();
        await usersAPI.update(editUserForm.value.id, updates);
        showEditUserModal.value = false;
        await loadUsers();
      } catch (e) {
        userFormError.value = e.response?.data?.message ?? e.message ?? t('login.invalidCredentials');
      } finally {
        userFormSaving.value = false;
      }
    }

    async function submitChangePassword() {
      const password = (changePasswordForm.value.password || '').trim();
      if (!password) {
        userFormError.value = t('settings.passwordRequired');
        return;
      }
      userFormSaving.value = true;
      userFormError.value = '';
      try {
        await usersAPI.update(changePasswordUser.value.id, { password });
        showChangePasswordModal.value = false;
        changePasswordUser.value = null;
      } catch (e) {
        userFormError.value = e.response?.data?.message ?? e.message ?? t('login.invalidCredentials');
      } finally {
        userFormSaving.value = false;
      }
    }

    async function submitDeleteUser() {
      if (!deleteUserTarget.value) return;
      userFormSaving.value = true;
      userFormError.value = '';
      try {
        await usersAPI.delete(deleteUserTarget.value.id);
        deleteUserTarget.value = null;
        await loadUsers();
      } catch (e) {
        userFormError.value = e.response?.data?.message ?? e.message ?? t('login.invalidCredentials');
      } finally {
        userFormSaving.value = false;
      }
    }

    onMounted(async () => {
      if (typeof window !== 'undefined' && window.electronAPI) {
        if (window.electronAPI.getAppVersion) {
          window.electronAPI.getAppVersion().then((v) => {
            appVersion.value = v ? `v${v}` : '';
          });
        }
        if (window.electronAPI.getElectronVersion) {
          window.electronAPI.getElectronVersion().then((v) => {
            electronVersion.value = v || 'Unknown';
          });
        }
      }
      try {
        activeTab.value = tabFromQuery();
        await settingsStore.loadProviderSupport();
        // 打开设置页时先刷新磁盘配置，再初始化各 Tab 数据，显示最新（含 CLI 写入）
        await settingsStore.loadConfig();
        loadAgentConfig();
        initModelConfigTab();
        if (activeTab.value === 'agent') await loadAgentList();
        if (activeTab.value === 'knowledge') initKnowledgeTab();
        if (activeTab.value === 'channels') {
          await loadAgentList();
          initChannelsTab();
        }
      } catch (err) {
        console.error('[Settings] onMounted error', err);
      }
    });

    return {
      t,
      showRagTab,
      activeTab,
      config,
      localConfig,
      providers,
      providerSupport,
      models,
      defaultModelOptions,
      configuredModelsList,
      defaultModelIndex,
      isOpenAiCustomProvider,
      addModelOptions,
      effectiveAddModelId,
      channelFeishuDefaultAgentOptions,
      channelDingtalkDefaultAgentOptions,
      channelTelegramDefaultAgentOptions,
      channelWechatDefaultAgentOptions,
      wechatQrCode,
      wechatStatus,
      wechatUserName,
      wechatQrLoading,
      wechatStatusClass,
      wechatStatusText,
      fetchWechatQrCode,
      getModelDisplayName,
      getModelAlias,
      getProviderDisplayName,
      isDefaultModel,
      openAddModelModal,
      openEditModel,
      closeAddModelModal,
      editingModelIndex,
      onAddModelProviderOrTypeChange,
      submitAddModel,
      confirmRemoveConfiguredModel,
      setDefaultFromConfigured,
      openAddProviderModal,
      onAddProviderSelect,
      submitAddProvider,
      showAddProviderModal,
      showAddModelModal,
      addModelForm,
      modelConfigSubTab,
      localProviderConfig,
      localDefaultProvider,
      localDefaultModel,
      addProviderForm,
      supportedProviders,
      configuredProviders,
      localRag,
      providersWithEmbedding,
      knowledgeEmbeddingModels,
      configuredEmbeddingModels,
      initKnowledgeTab,
      onKnowledgeProviderChange,
      saveKnowledgeConfig,
      removeProvider,
      editingProvider,
      startEditProvider,
      cancelEditProvider,
      saveEditProvider,
      ensureModelsLoaded,
      onDefaultProviderChange,
      saveProviderConfig,
      setDefaultModel,
      currentLocale,
      platform,
      appVersion,
      electronVersion,
      setTheme,
      defaultAgentOptions,
      saveAgentConfig,
      resetAgentConfig,
      logout,
      authStore,
      usersList,
      usersLoading,
      showAddUserModal,
      showEditUserModal,
      showChangePasswordModal,
      showChangeCurrentPasswordModal,
      addUserForm,
      editUserForm,
      changePasswordUser,
      changePasswordForm,
      currentUserPasswordForm,
      deleteUserTarget,
      userFormError,
      userFormSaving,
      openAddUser,
      openEditUser,
      openChangePassword,
      openChangeCurrentUserPassword,
      confirmDeleteUser,
      submitAddUser,
      submitEditUser,
      submitChangePassword,
      submitChangeCurrentUserPassword,
      submitDeleteUser,
      localChannels,
      initChannelsTab,
      saveChannelsConfig,
    };
  },
};
</script>

<style scoped>
.settings-view {
  width: 100%;
  height: 100%;
  padding: var(--spacing-lg);
}

.settings-layout {
  display: flex;
  height: 100%;
  overflow: hidden;
}

/* Sidebar Styling */
.settings-sidebar {
  width: 240px;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--glass-border);
  padding: var(--spacing-md) var(--spacing-sm);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: 12px 14px;
  margin: 0 2px;
  cursor: pointer;
  color: var(--color-text-secondary);
  font-size: 0.9375rem;
  border-radius: 10px;
  transition: background-color var(--transition-base), color var(--transition-base), transform var(--transition-fast);
}

.nav-item:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.nav-item.active {
  background: var(--color-bg-elevated);
  color: var(--color-accent-primary);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}

.nav-item.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  border-radius: 0 3px 3px 0;
  background: var(--color-accent-primary);
}

.nav-item:hover.active {
  background: var(--color-bg-elevated);
}

.nav-icon {
  font-size: 1.2rem;
  opacity: 0.9;
}

.nav-item.active .nav-icon {
  opacity: 1;
}

/* Content Area Styling */
.settings-content {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-2xl);
}

.tab-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  margin-bottom: var(--spacing-xl);
  color: var(--color-text-primary);
  letter-spacing: -0.02em;
}

/* 模型配置：子 Tab 与内容区文字层级 */
.model-config-tabs {
  display: flex;
  gap: 2px;
  margin-bottom: var(--spacing-xl);
  border-bottom: 1px solid var(--glass-border);
}
.model-config-tab {
  padding: 12px 20px;
  font-size: var(--font-size-base);
  font-weight: 500;
  color: var(--color-text-tertiary);
  background: none;
  border: none;
  border-bottom: 3px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  transition: color 0.2s ease, border-color 0.2s ease;
}
.model-config-tab:hover {
  color: var(--color-text-secondary);
}
.model-config-tab.active {
  color: var(--color-accent-primary);
  font-weight: 600;
  border-bottom-color: var(--color-accent-primary);
}
.model-config-tabs + .settings-group .form-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
  margin-bottom: var(--spacing-md);
}

/* 提示信息块：统一风格 */
.settings-hint-block {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  margin-bottom: var(--spacing-xl);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-lg);
  border-left: 4px solid var(--color-accent-primary);
}
.settings-hint-icon {
  font-size: 1.1rem;
  flex-shrink: 0;
}
.settings-hint-text {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.6;
}

.subsection-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-md);
}
.subsection-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
  letter-spacing: -0.01em;
}
.empty-hint {
  padding: var(--spacing-lg);
  text-align: center;
  color: var(--color-text-tertiary);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
}
.model-config-warn {
  padding: var(--spacing-md) var(--spacing-lg);
  background: rgba(230, 180, 50, 0.08);
  border-radius: var(--radius-md);
  border-left: 4px solid var(--color-warning, #b8860b);
}

.model-config-tabs ~ .settings-group .form-group label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-xs);
}
.form-row-flex {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  align-items: flex-end;
}
.form-row-flex .flex-1 {
  flex: 1;
  min-width: 140px;
}
.form-group-actions {
  margin-bottom: 0;
}

/* Provider 配置区域 */
.provider-config-group .provider-configured-list {
  margin-top: 0;
}
.provider-config-group .subsection-header {
  margin-bottom: var(--spacing-lg);
}
.btn-add-provider {
  flex-shrink: 0;
}
.provider-configured-list .subsection-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
  letter-spacing: -0.01em;
}
.provider-cards {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
.provider-card {
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-radius: 12px;
  border: 1px solid var(--glass-border);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}
.provider-card:hover {
  border-color: var(--color-bg-elevated);
}
.provider-card.is-editing {
  border-color: var(--color-accent-primary);
  box-shadow: 0 0 0 1px var(--color-accent-primary);
}
.provider-card-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
  flex-wrap: wrap;
}
.provider-card-body {
  padding-top: var(--spacing-sm);
  border-top: 1px solid var(--glass-border);
}
.provider-card-body .form-group {
  margin-bottom: var(--spacing-md);
}
.provider-card-body .form-group:last-of-type {
  margin-bottom: 0;
}
.provider-name {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
}
.provider-badge {
  font-size: 0.8125rem;
  font-weight: 500;
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
}
.provider-delete {
  margin-left: auto;
}
.provider-readonly {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  line-height: 1.5;
}
.provider-readonly-line {
  margin: 0 0 var(--spacing-xs);
}
.provider-readonly-line .label {
  font-weight: 500;
  color: var(--color-text-primary);
  margin-right: var(--spacing-sm);
}
.provider-card-actions {
  display: flex;
  gap: var(--spacing-md);
  margin-top: var(--spacing-md);
}

.modal-add-provider .modal-body .form-group {
  margin-bottom: var(--spacing-lg);
}
.modal-add-provider .modal-body .form-group:last-of-type {
  margin-bottom: 0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
}
.checkbox-label input[type="checkbox"] {
  width: auto;
  max-width: none;
}
.cost-fields .cost-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-xs);
}
.cost-item {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}
.cost-input {
  width: 72px;
  max-width: none;
  padding: var(--spacing-xs) var(--spacing-sm);
}

.model-config-group .subsection-header {
  margin-bottom: var(--spacing-md);
}
.model-config-actions {
  margin-top: var(--spacing-lg);
}

.current-default {
  margin-top: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
}

.configured-models-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-lg);
}
.configured-model-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-xs);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
}
.model-row-provider {
  font-weight: 600;
  color: var(--color-text-primary);
}
.model-row-sep {
  color: var(--color-text-tertiary);
}
.model-row-name {
  color: var(--color-text-primary);
}
.model-row-type {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  background: var(--color-bg-tertiary);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
}
.model-row-default-badge {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-accent-primary);
  background: var(--color-bg-tertiary);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-accent-primary);
}
.model-row-actions {
  margin-left: auto;
  display: flex;
  gap: var(--spacing-sm);
}
.form-hint-warn {
  font-size: var(--font-size-sm);
  color: var(--color-warning, #b8860b);
  font-weight: 500;
}
.actions .action-hint.form-hint {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.settings-group {
  margin-bottom: var(--spacing-2xl);
}

.settings-group h3 {
  font-size: var(--font-size-lg);
  font-weight: 600;
  margin-bottom: var(--spacing-lg);
  color: var(--color-text-primary);
  padding-bottom: var(--spacing-sm);
  border-bottom: 1px solid var(--glass-border);
}

.form-group {
  margin-bottom: var(--spacing-lg);
}

.form-group label {
  display: block;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-bottom: var(--spacing-sm);
}

.knowledge-radio-group {
  display: flex;
  gap: var(--spacing-xl);
  flex-wrap: wrap;
}
.knowledge-radio-group .radio-label {
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  font-weight: 500;
}
.knowledge-radio-group .radio-label input {
  width: 1rem;
  height: 1rem;
}

.form-hint {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  margin-top: var(--spacing-xs);
  margin-bottom: 0;
}
.form-hint-inline {
  margin-top: var(--spacing-xs);
}
.model-custom-input {
  margin-top: var(--spacing-sm);
  display: block;
}
.settings-group .form-hint:first-child {
  margin-top: 0;
}

.input {
  width: 100%;
  max-width: 400px;
  padding: var(--spacing-md);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  transition: all var(--transition-fast);
}
.input::placeholder {
  color: var(--color-text-tertiary);
  opacity: 1;
}

.input:focus {
  outline: none;
  border-color: var(--color-accent-primary);
  background: var(--color-bg-primary);
}

.select-input {
  appearance: none;
  background-image: url("data:image/svg+xml;charset=UTF-8,%3csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3e%3cpolyline points='6 9 12 15 18 9'%3e%3c/polyline%3e%3c/svg%3e");
  background-repeat: no-repeat;
  background-position: right 1rem center;
  background-size: 1em;
}

/* Theme Options */
.theme-options {
  display: flex;
  gap: var(--spacing-lg);
}

.theme-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-md);
  background: var(--color-bg-tertiary);
  border: 2px solid transparent;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.theme-card.active {
  border-color: var(--color-accent-primary);
  background: var(--color-bg-elevated);
}

.theme-preview {
  width: 100px;
  height: 60px;
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
}

.theme-preview.light {
  background: linear-gradient(145deg, #fefcf9 0%, #f5efe6 100%);
  border: 1px solid rgba(180, 168, 152, 0.3);
}

.theme-preview.dark {
  background: #1e293b;
}

.theme-preview.cosmic {
  background: #fdfdfd;
  border: 1px solid #e5e5e5;
}

.theme-preview.neon {
  background: linear-gradient(145deg, #1a0b2e 0%, #2d1b4e 50%, #0d0221 100%);
  border: 1px solid rgba(5, 217, 232, 0.4);
  box-shadow: inset 0 0 20px rgba(5, 217, 232, 0.1), 0 0 12px rgba(255, 42, 109, 0.15);
}

/* Actions */
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
}
.actions .action-hint {
  width: 100%;
  margin-bottom: 0;
}

.btn-primary, .btn-secondary {
  padding: var(--spacing-md) var(--spacing-xl);
  border-radius: var(--radius-md);
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-primary {
  background: var(--color-accent-primary);
  color: white;
  border: none;
}

.btn-primary:hover {
  background: var(--color-accent-secondary);
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--glass-border);
  color: var(--color-text-primary);
}

.btn-secondary:hover {
  background: var(--color-bg-tertiary);
}

/* About Section */
.about-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--spacing-2xl);
}

.logo-large {
  width: 80px;
  height: 80px;
  margin-bottom: var(--spacing-lg);
}

.logo-large img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.version {
  color: var(--color-text-secondary);
  font-family: var(--font-family-mono);
  margin-bottom: var(--spacing-xl);
}

.about-details {
  width: 100%;
  max-width: 400px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-lg);
  padding: var(--spacing-lg);
}

.detail-row {
  display: flex;
  justify-content: space-between;
  padding: var(--spacing-sm) 0;
  border-bottom: 1px solid var(--glass-border);
}

.detail-row:last-child {
  border-bottom: none;
}

/* 用户管理 */
.users-toolbar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-lg);
}

.users-toolbar .form-hint {
  flex: 1;
  min-width: 200px;
  margin: 0;
}

.users-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-lg);
  background: var(--color-bg-secondary);
}

.users-table {
  width: 100%;
  border-collapse: collapse;
}

.users-table th,
.users-table td {
  padding: var(--spacing-md) var(--spacing-lg);
  text-align: left;
  border-bottom: 1px solid var(--glass-border);
}

.users-table th {
  font-weight: 600;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.users-table tbody tr:last-child td {
  border-bottom: none;
}

.users-table tbody tr:hover {
  background: var(--color-bg-tertiary);
}

.th-actions,
.td-actions {
  width: 1%;
  white-space: nowrap;
}

.username-cell {
  font-weight: 500;
  color: var(--color-text-primary);
}

.link-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--color-accent-primary);
  cursor: pointer;
  font-size: var(--font-size-sm);
}

.link-btn:hover {
  text-decoration: underline;
}

.link-btn.danger {
  color: var(--color-error, #e53e3e);
}

.sep {
  color: var(--color-text-tertiary);
  margin: 0 var(--spacing-xs);
}

.loading-state,
.empty-state {
  padding: var(--spacing-2xl);
  text-align: center;
  color: var(--color-text-secondary);
}

.empty-state .btn-primary {
  margin-top: var(--spacing-md);
}

/* 弹窗 */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
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
  max-width: 440px;
  width: 100%;
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.modal-content.delete-confirm-modal {
  max-width: 400px;
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

.form-error {
  color: var(--color-error, #e53e3e);
  font-size: var(--font-size-sm);
  margin: 0 0 var(--spacing-md) 0;
}

.modal-footer-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
}

.delete-target-name {
  font-weight: 600;
  color: var(--color-text-primary);
  margin-top: var(--spacing-sm);
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

.btn-danger:hover:not(:disabled) {
  filter: brightness(1.1);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* ---------- WeChat QR Code Section ---------- */
.wechat-qrcode-section {
  margin-top: 8px;
}
.wechat-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: 14px;
}
.wechat-status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
}
.wechat-status-dot.status-scanning {
  background: #f5a623;
  animation: wechat-pulse 1.5s ease-in-out infinite;
}
.wechat-status-dot.status-logged-in {
  background: #4cd964;
}
.wechat-status-dot.status-logged-out {
  background: #8e8e93;
}
@keyframes wechat-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.wechat-username {
  color: var(--text-secondary, #888);
  font-size: 13px;
}
.wechat-qrcode-wrap {
  margin-top: 12px;
  text-align: center;
}
.wechat-qrcode-img {
  display: block;
  margin: 10px auto 0;
  width: 256px;
  height: 256px;
  border-radius: 8px;
  border: 1px solid var(--border-color, #e0e0e0);
  background: #fff;
}
</style>
