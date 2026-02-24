<template>
  <div class="sidebar">
    <div class="sidebar-header">
      <div class="logo" :title="t('app.name')">
        <img src="@/assets/logo.svg" :alt="t('app.name')" class="logo-image" />
      </div>
    </div>

    <nav class="sidebar-nav">
      <router-link
        v-for="item in navItems"
        :key="item.path"
        :to="item.path"
        class="nav-item"
        :class="{ active: isActive(item.path) }"
        :title="item.label"
      >
        <span class="nav-icon" aria-hidden="true">
          <component :is="item.iconComponent" />
        </span>
        <span class="nav-label">{{ item.label }}</span>
      </router-link>
    </nav>

    <div class="sidebar-footer">
      <router-link
        to="/sessions"
        class="nav-item"
        :class="{ active: isLogsActive }"
        :title="t('settings.logsTitle')"
      >
        <span class="nav-icon" aria-hidden="true">
          <IconLogs />
        </span>
        <span class="nav-label">{{ t('settings.logs') }}</span>
      </router-link>
      <router-link
        to="/settings"
        class="nav-item"
        :class="{ active: isActive('/settings') }"
        :title="t('nav.settings')"
      >
        <span class="nav-icon" aria-hidden="true">
          <IconSettings />
        </span>
        <span class="nav-label">{{ t('nav.settings') }}</span>
      </router-link>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import { useI18n } from '@/composables/useI18n';
import IconChat from '@/components/icons/IconChat.vue';
import IconAgents from '@/components/icons/IconAgents.vue';
import IconTasks from '@/components/icons/IconTasks.vue';
import IconWorkResults from '@/components/icons/IconWorkResults.vue';
import IconSettings from '@/components/icons/IconSettings.vue';
import IconLogs from '@/components/icons/IconLogs.vue';

export default {
  name: 'Sidebar',
  components: { IconChat, IconAgents, IconTasks, IconWorkResults, IconSettings, IconLogs },
  setup() {
    const route = useRoute();
    const { t } = useI18n();

    const navItems = computed(() => [
      { path: '/chat', label: t('nav.agentChat'), iconComponent: IconChat },
      { path: '/agents', label: t('nav.agents'), iconComponent: IconAgents },
      { path: '/tasks', label: t('nav.tasks'), iconComponent: IconTasks },
      { path: '/work-results', label: t('nav.workResults'), iconComponent: IconWorkResults },
    ]);

    const isActive = (path) => {
      if (path === '/') return route.path === '/';
      return route.path.startsWith(path);
    };

    const isLogsActive = computed(() => route.path === '/sessions');

    return {
      navItems,
      isActive,
      isLogsActive,
      t,
    };
  },
};
</script>

<style scoped>
/* 放宽以容纳顶部窗口控制按钮（如 macOS 红黄绿） */
.sidebar {
  width: 80px;
  min-width: 80px;
  height: 100%;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--glass-border);
  display: flex;
  flex-direction: column;
  padding: 40px var(--spacing-sm) var(--spacing-md); /* Top padding for window controls */
  align-items: center;
  gap: var(--spacing-xl);
}

.sidebar-header {
  margin-bottom: var(--spacing-sm);
  display: flex;
  justify-content: center;
  width: 100%;
}

.logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  overflow: hidden;
  transition: opacity 0.2s ease;
}

.logo:hover {
  opacity: 0.9;
}

.logo-image {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.sidebar-nav {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  width: 100%;
  align-items: center;
}

.nav-item {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  padding: 0;
  border-radius: 12px;
  color: var(--color-text-secondary);
  text-decoration: none;
  transition: background-color var(--transition-base), color var(--transition-base), box-shadow var(--transition-fast);
  position: relative;
}

.nav-item:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-accent-primary);
}

.nav-item.active {
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.22) 0%, rgba(118, 75, 162, 0.16) 100%);
  color: var(--color-accent-primary);
  box-shadow: 0 2px 12px rgba(102, 126, 234, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(102, 126, 234, 0.4);
}

.nav-item.active:hover {
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.28) 0%, rgba(118, 75, 162, 0.2) 100%);
  box-shadow: 0 4px 16px rgba(102, 126, 234, 0.28), inset 0 1px 0 rgba(255, 255, 255, 0.1);
  border-color: rgba(102, 126, 234, 0.5);
}

.nav-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 1.25rem;
  height: 1.25rem;
  line-height: 0;
}

.nav-label {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.sidebar-footer {
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--glass-border);
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--spacing-sm);
}
</style>
