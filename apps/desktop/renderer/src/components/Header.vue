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
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useUIStore } from '@/store/modules/ui';
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

    const { t } = useI18n();

    const isChatRoute = computed(() => route.name === 'AgentChat');
    const sessionsPanelVisible = computed(() => uiStore.sessionsPanelVisible);
    const toggleSessionsPanel = () => uiStore.toggleSessionsPanel();

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
        Settings: () => t('nav.settings'),
      };
      const fn = nameToTitle[name];
      if (fn) return fn();
      if (route.path.startsWith('/chat')) return t('nav.agentChat');
      if (route.path.startsWith('/agents')) return t('nav.agents');
      if (route.path === '/settings' || route.path.startsWith('/settings')) return t('nav.settings');
      return t('app.name');
    });

    return {
      pageTitle,
      isChatRoute,
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
