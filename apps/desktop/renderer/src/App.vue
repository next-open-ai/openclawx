<template>
  <div id="app" class="app-container">
    <Login v-if="!authStore.isLoggedIn" />
    <template v-else>
      <Sidebar />
      <div class="main-content">
        <Header />
        <div class="content-area" :class="{ 'chat-full-height': isChatRoute }">
          <router-view v-slot="{ Component }">
            <transition name="fade" mode="out-in">
              <component v-if="Component" :is="Component" :key="route.fullPath" />
              <div v-else class="view-fallback">加载中…</div>
            </transition>
          </router-view>
        </div>
      </div>
      <!-- 登录进入后若未配置供应商/模型，弹窗提醒 -->
      <div v-if="showConfigPromptDialog" class="config-prompt-backdrop" @click.self="dismissConfigPrompt">
        <div class="config-prompt-card">
          <h3 class="config-prompt-title">{{ t('app.configPromptTitle') }}</h3>
          <p class="config-prompt-desc">{{ t('app.configPromptDesc') }}</p>
          <div class="config-prompt-actions">
            <button type="button" class="btn-primary" @click="goToConfig">{{ t('app.configPromptConfirm') }}</button>
            <button type="button" class="btn-secondary" @click="dismissConfigPrompt">{{ t('app.configPromptSkip') }}</button>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script>
import { onMounted, computed, watch, ref, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import Sidebar from './components/Sidebar.vue';
import Header from './components/Header.vue';
import Login from './views/Login.vue';
import { useSettingsStore } from './store/modules/settings';
import { useAgentStore } from './store/modules/agent';
import { useAuthStore } from './store/modules/auth';
import { useI18n } from './composables/useI18n';

async function loadAppData(settingsStore, agentStore) {
  await settingsStore.loadConfig();
  await settingsStore.loadProviders();
  await agentStore.fetchSessions();
}

function needsConfigPrompt(config) {
  if (!config || typeof config !== 'object') return true;
  const providers = config.providers || {};
  const hasProvider = Object.values(providers).some((p) => p && typeof p.apiKey === 'string' && String(p.apiKey).trim() !== '');
  const hasDefault = (config.defaultProvider && config.defaultModel) || (config.defaultModelItemCode && Array.isArray(config.configuredModels) && config.configuredModels.length > 0);
  return !hasProvider || !hasDefault;
}

export default {
  name: 'App',
  components: {
    Sidebar,
    Header,
    Login,
  },
  errorCaptured(err, instance, info) {
    console.error('[App] errorCaptured', err, info);
    return true;
  },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const { t } = useI18n();
    const settingsStore = useSettingsStore();
    const agentStore = useAgentStore();
    const authStore = useAuthStore();
    const showConfigPromptDialog = ref(false);
    const hasShownConfigPromptThisSession = ref(false);

    const isChatRoute = computed(
      () => route.name === 'AgentChat' || route.path === '/'
    );

    function checkAndShowConfigPrompt() {
      if (hasShownConfigPromptThisSession.value) return;
      if (needsConfigPrompt(settingsStore.config)) {
        showConfigPromptDialog.value = true;
        hasShownConfigPromptThisSession.value = true;
      }
    }

    function goToConfig() {
      showConfigPromptDialog.value = false;
      router.push({ path: '/settings', query: { tab: 'models' } });
    }

    function dismissConfigPrompt() {
      showConfigPromptDialog.value = false;
      hasShownConfigPromptThisSession.value = true;
    }

    async function onLoggedIn() {
      await loadAppData(settingsStore, agentStore);
      await nextTick();
      checkAndShowConfigPrompt();
    }

    onMounted(() => {
      authStore.initFromStorage();
      if (authStore.isLoggedIn) {
        onLoggedIn();
      }
    });
    watch(
      () => authStore.isLoggedIn,
      (v) => {
        if (v) onLoggedIn();
      },
    );

    return { route, isChatRoute, authStore, showConfigPromptDialog, t, goToConfig, dismissConfigPrompt };
  },
};
</script>

<style scoped>
.app-container {
  display: flex;
  width: 100%;
  height: 100%;
  overflow: hidden;
}

.main-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.content-area {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: var(--spacing-lg);
  background: var(--color-bg-primary);
}

/* 保证任意路由下，主内容区子节点都能占满可用高度，避免白屏 */
.content-area > * {
  flex: 1;
  min-height: 0;
  min-width: 0;
}

.view-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
}

/* 聊天页：只传递尺寸，不设 flex-direction，避免覆盖 AgentChat 的 row 布局（会话列 | 对话区 左右排列） */
.content-area.chat-full-height {
  padding: var(--spacing-md);
  height: 100%;
  min-width: 0;
}
.content-area.chat-full-height > * {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.content-area.chat-full-height > * > * {
  flex: 1;
  min-height: 0;
  min-width: 0;
  width: 100%;
  height: 100%;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--transition-base);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.config-prompt-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}
.config-prompt-card {
  background: var(--color-bg-primary);
  border-radius: 16px;
  padding: 1.5rem 2rem;
  max-width: 400px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.15);
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.1));
}
.config-prompt-title {
  margin: 0 0 0.75rem;
  font-size: 1.125rem;
}
.config-prompt-desc {
  margin: 0 0 1.25rem;
  color: var(--color-text-secondary);
  font-size: 0.9375rem;
  line-height: 1.5;
}
.config-prompt-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
}
</style>
