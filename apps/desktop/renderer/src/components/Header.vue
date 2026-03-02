<template>
  <header class="header draggable">
    <div class="header-left">
      <button
        v-if="isChatRoute"
        type="button"
        class="header-btn-sessions"
        :title="sessionsPanelVisible ? t('chat.hideSessions') : t('chat.showSessions')"
        @click="toggleSessionsPanel"
      >
        {{ sessionsPanelVisible ? '‹' : '›' }}
      </button>
      <!-- 对话页：清除当前会话对话记录（放在顶部左侧，仅图标） -->
      <button
        v-if="isChatRoute && hasCurrentChatSession"
        type="button"
        class="header-btn clear-conversation-btn"
        :title="t('sessions.clearConversation')"
        :disabled="clearMessagesLoading"
        @click="onClearConversation"
      >
        <span class="clear-conversation-icon" aria-hidden="true">
          <svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6h14Z"/>
            <path d="M10 11v6M14 11v6"/>
          </svg>
        </span>
      </button>
      <!-- 跳转会话管理页入口：暂时不显示，可从侧栏「日志」进入 -->
      <button
        v-if="false && isChatRoute"
        type="button"
        class="header-btn-sessions"
        :title="t('sessions.manage')"
        @click="router.push('/sessions')"
      >
        ❖
      </button>
      <h1 class="page-title">{{ pageTitle }}</h1>
    </div>
    <div class="header-right">
      <div class="header-actions">
        <!-- Dashboard Button -->
        <router-link to="/dashboard" class="header-btn dashboard-btn" :title="t('nav.dashboard')" active-class="active">
          <span class="btn-icon">📊</span>
        </router-link>

        <!-- Theme Toggle -->
        <ThemeToggle />
      </div>
    </div>
  </header>
</template>

<script>
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUIStore } from '@/store/modules/ui';
import { useAgentStore } from '@/store/modules/agent';
import { useI18n } from '@/composables/useI18n';
import ThemeToggle from './ThemeToggle.vue';

export default {
  name: 'Header',
  components: {
    ThemeToggle,
  },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const uiStore = useUIStore();
    const agentStore = useAgentStore();

    const { t } = useI18n();

    const isChatRoute = computed(() => route.name === 'AgentChat');
    const sessionsPanelVisible = computed(() => uiStore.sessionsPanelVisible);
    const toggleSessionsPanel = () => uiStore.toggleSessionsPanel();

    const hasCurrentChatSession = computed(
      () => agentStore.currentSession && agentStore.currentSession.type !== 'system',
    );
    const clearMessagesLoading = ref(false);
    const onClearConversation = async () => {
      if (!agentStore.currentSession?.id) return;
      if (!confirm(t('sessions.clearHistoryConfirm'))) return;
      clearMessagesLoading.value = true;
      try {
        await agentStore.clearCurrentSessionMessages();
      } catch (e) {
        console.error('Clear conversation failed', e);
      } finally {
        clearMessagesLoading.value = false;
      }
    };

    const pageTitle = computed(() => {
      const name = route.name;
      const nameToTitle = {
        Dashboard: () => t('nav.dashboard'),
        AgentChat: () => t('nav.agentChat'),
        Root: () => t('nav.agentChat'),
        Sessions: () => t('nav.sessions'),
        Agents: () => t('nav.agents'),
        AgentDetail: () => t('nav.agents'),
        Tasks: () => t('nav.tasks'),
        Workspace: () => t('nav.workspace'),
        WorkResults: () => t('nav.workResults'),
        Channels: () => t('nav.channels'),
        Settings: () => t('nav.settings'),
      };
      const fn = nameToTitle[name];
      if (fn) return fn();
      if (route.path.startsWith('/chat')) return t('nav.agentChat');
      if (route.path.startsWith('/agents')) return t('nav.agents');
      if (route.path === '/channels' || route.path.startsWith('/channels')) return t('nav.channels');
      if (route.path === '/settings' || route.path.startsWith('/settings')) return t('nav.settings');
      return t('app.name');
    });

    return {
      pageTitle,
      isChatRoute,
      hasCurrentChatSession,
      clearMessagesLoading,
      onClearConversation,
      sessionsPanelVisible,
      toggleSessionsPanel,
      router,

      t,
    };
  },
};
</script>

<style scoped>
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm) var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-bottom: 1px solid var(--glass-border);
  min-height: 56px; /* Slightly taller for better touch target */
}

.header.draggable {
  -webkit-app-region: drag;
  -webkit-user-select: none;
  user-select: none;
}

.header-right,
.header-left {
  -webkit-app-region: no-drag;
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.header-btn-sessions {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.header-btn-sessions:hover {
  background: var(--color-bg-elevated);
  border-color: var(--color-accent-primary);
}

.page-title {
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  white-space: nowrap;
  pointer-events: none;
}

.header-btn {
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  text-decoration: none;
  transition: all var(--transition-fast);
}

.header-btn:hover,
.header-btn.active {
  background: var(--color-bg-tertiary);
  color: var(--color-accent-primary);
}

.btn-icon {
  font-size: 1.25rem;
  line-height: 1;
}

/* 与右侧仪表盘、主题图标统一：无边框无底，默认态与 header 融为一体 */
.clear-conversation-btn {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
}
.clear-conversation-btn:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-accent-primary);
}
.clear-conversation-btn:hover:not(:disabled) .clear-conversation-icon {
  color: var(--color-danger, #e57373);
}
.clear-conversation-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.clear-conversation-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  color: inherit;
}
.clear-conversation-icon svg {
  width: 100%;
  height: 100%;
}

/* ... inside <style scoped> ... */

.header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.language-switch,
.theme-toggle-wrapper {
  display: flex;
  align-items: center;
  justify-content: center;
}

</style>
