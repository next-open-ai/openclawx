<template>
  <button @click="toggleTheme" class="theme-toggle btn-ghost" title="Toggle theme">
    <span class="theme-icon">{{ themeIcon }}</span>
  </button>
</template>

<script>
import { computed } from 'vue';
import { useSettingsStore } from '@/store/modules/settings';

export default {
  name: 'ThemeToggle',
  setup() {
    const settingsStore = useSettingsStore();

    const themeIcon = computed(() => {
      const theme = settingsStore.config.theme;
      if (theme === 'light') return '☀️';
      if (theme === 'cosmic') return '🪐';
      if (theme === 'neon') return '✨';
      return '🌙';
    });

    const toggleTheme = () => {
      settingsStore.toggleTheme();
    };

    return {
      themeIcon,
      toggleTheme,
    };
  },
};
</script>

<style scoped>
.theme-toggle {
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  color: var(--color-text-primary);
  transition: all var(--transition-fast);
}

.theme-toggle:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--glass-border);
}

.theme-icon {
  font-size: 1.5rem;
  line-height: 1;
}
</style>
