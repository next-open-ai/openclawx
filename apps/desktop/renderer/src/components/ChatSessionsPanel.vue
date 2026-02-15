<template>
  <div class="chat-sessions-panel" :class="{ collapsed: !visible }">
    <div v-show="visible" class="panel-content">

      <div class="panel-header-actions">
        <button class="btn-new-session" @click="$emit('create')" :title="t('chat.newSession')">
          + {{ t('chat.newSession') }}
        </button>
      </div>
      <div class="sessions-list">
        <div
          v-for="session in sessions"
          :key="session.id"
          class="session-item-wrap"
          :class="{ active: currentSessionId === session.id }"
        >
          <button
            type="button"
            class="session-item"
            @click="$emit('select', session.id)"
          >
            <span class="session-title">{{ sessionTitle(session) }}</span>
            <span class="session-badge" :class="`badge-${session.status}`">{{ session.status }}</span>
          </button>
          <button
            type="button"
            class="session-item-delete"
            :title="t('common.delete') || '删除'"
            @click.stop="$emit('delete', session.id)"
          >
            <svg class="icon-delete" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
              <line x1="10" y1="11" x2="10" y2="17"/>
              <line x1="14" y1="11" x2="14" y2="17"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { useRouter } from 'vue-router';
import { useI18n } from '@/composables/useI18n';

export default {
  name: 'ChatSessionsPanel',
  props: {
    visible: { type: Boolean, required: true },
    sessions: { type: Array, default: () => [] },
    currentSessionId: { type: String, default: null },
  },
  emits: ['create', 'select', 'delete'],
  setup() {
    const router = useRouter();
    const { t } = useI18n();
    const sessionTitle = (session) => {
      if (session.title) return session.title;
      const id = session.id || '';
      return id.length > 16 ? id.substring(0, 16) + '…' : id || 'Session';
    };

    return { t, sessionTitle };
  },
};
</script>

<style scoped>
.chat-sessions-panel {
  display: flex;
  flex: 0 0 200px;
  width: 200px;
  min-width: 200px;
  max-width: 200px;
  height: 100%;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--glass-border);
  will-change: width, min-width, flex-basis;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.chat-sessions-panel.collapsed {
  width: 0 !important;
  min-width: 0 !important;
  max-width: 0 !important;
  flex: 0 0 0 !important;
  border-right: none !important;
  opacity: 0;
  overflow: hidden;
  margin: 0;
  padding: 0;
}

.panel-content {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
  overflow: hidden;
}



.panel-header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: var(--spacing-md);
  border-bottom: 1px solid var(--glass-border);
}

.btn-new-session {
  flex: 1;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  white-space: nowrap;
  cursor: pointer;
  transition: all var(--transition-fast);
  text-align: center;
}

.btn-new-session:hover {
  background: var(--color-bg-elevated);
  border-color: var(--color-accent-primary);
}

.sessions-list {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-sm);
}

.session-item-wrap {
  display: flex;
  align-items: center;
  margin-bottom: var(--spacing-xs);
  border-radius: var(--radius-md);
  transition: background var(--transition-fast);
}

.session-item-wrap:hover {
  background: var(--color-bg-tertiary);
}

.session-item-wrap.active .session-item {
  background: var(--color-bg-tertiary);
  border-left: 3px solid var(--color-accent-primary);
  padding-left: calc(var(--spacing-md) - 3px);
}

.session-item {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-width: 0;
  padding: var(--spacing-md);
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.session-item:hover {
  background: var(--color-bg-tertiary);
}

.session-item-delete {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: color var(--transition-fast), background var(--transition-fast);
}

.session-item-delete:hover {
  color: var(--color-error, #e53e3e);
  background: var(--color-bg-elevated);
}

.icon-delete {
  width: 14px;
  height: 14px;
}

.session-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-badge {
  flex-shrink: 0;
  font-size: 10px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  margin-left: var(--spacing-sm);
}

.badge-idle {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
}

.badge-active {
  background: var(--color-status-active);
  color: var(--color-bg-primary);
}

.badge-error {
  background: var(--color-error);
  color: white;
}

</style>
