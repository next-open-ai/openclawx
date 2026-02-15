<template>
  <div class="sessions-view">
    <div class="sessions-header">
      <div class="header-info">
        <h2 class="view-title">{{ t('nav.sessions') }}</h2>
        <p class="view-subtitle">{{ sessions.length }} {{ t('common.totalSessions') || 'Total Sessions' }}</p>
      </div>
      <button @click="createNewSession" class="btn-primary create-btn">
        <span class="btn-icon">＋</span>
        <span>{{ t('chat.newSession') }}</span>
      </button>
    </div>

    <div v-if="sessions.length === 0" class="empty-state card-glass">
      <div class="empty-icon">📝</div>
      <h3>{{ t('sessions.noSessions') || 'No Sessions Yet' }}</h3>
      <p class="text-secondary">{{ t('sessions.noSessionsHint') || 'Create your first session to get started' }}</p>
    </div>

    <div v-else class="sessions-list">
      <div
        v-for="session in sortedSessions"
        :key="session.id"
        class="session-row card-glass"
        @click="openSession(session)"
      >
        <!-- Status & Time Col -->
        <div class="row-prefix">
          <div class="status-indicator" :class="`status-${session.status}`"></div>
          <div class="time-info">
            <span class="date">{{ formatDate(session.lastActiveAt || session.createdAt, 'date') }}</span>
            <span class="time">{{ formatDate(session.lastActiveAt || session.createdAt, 'time') }}</span>
          </div>
        </div>

        <!-- Content Col -->
        <div class="row-content">
          <h3 class="session-title">{{ getSessionTitle(session) }}</h3>
          <p class="session-preview">{{ getSessionPreview(session) }}</p>
        </div>

        <!-- Meta Col (Optional/Secondary) -->
        <div class="row-meta">
          <span class="message-count">
            <span class="meta-icon">💬</span>
            {{ session.messageCount }}
          </span>
          <span v-if="session.workspace" class="workspace-tag">
             {{ session.workspace.split('/').pop() }}
          </span>
        </div>

        <!-- Actions Col -->
        <div class="row-actions" @click.stop>
          <button @click="openSession(session)" class="btn-action continue-btn" :title="t('common.continue') || 'Continue'">
            <span>{{ t('common.continue') || 'Continue' }}</span>
          </button>
          <button @click="openSession(session)" class="btn-action details-btn" :title="t('common.details') || 'Details'">
             <span>{{ t('common.details') || 'Details' }}</span>
          </button>
          <button @click="deleteSession(session.id)" class="btn-action delete-btn" :title="t('common.delete') || 'Delete'">
            <span class="icon-trash">🗑️</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAgentStore } from '@/store/modules/agent';
import { useI18n } from '@/composables/useI18n';

export default {
  name: 'Sessions',
  setup() {
    const router = useRouter();
    const agentStore = useAgentStore();
    const { t } = useI18n();

    const sessions = computed(() => agentStore.sessions);
    const sortedSessions = computed(() => {
      return [...sessions.value].sort((a, b) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt));
    });

    const formatDate = (timestamp, type) => {
      const date = new Date(timestamp);
      if (type === 'date') {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    };

    const getSessionTitle = (session) => {
      if (session.title) return session.title;
      // Fallback for older sessions
      return session.id.substring(0, 12) + '...';
    };

    const getSessionPreview = (session) => {
      if (session.preview) return session.preview;
      if (session.workspace) return `Workspace: ${session.workspace}`;
      return 'No preview available';
    };

    const createNewSession = async () => {
      // Create and navigate immediately
      router.push('/');
      agentStore.clearCurrentSession();
    };

    const openSession = (session) => {
      const id = typeof session === 'string' ? session : session?.id;
      if (!id) return;
      if (session?.type === 'system') {
        router.push({ path: '/agents/default', query: { smartInstallSession: id } });
      } else {
        router.push(`/chat/${id}`);
      }
    };

    const deleteSession = async (sessionId) => {
      if (confirm(t('sessions.deleteConfirm') || 'Are you sure you want to delete this session?')) {
        await agentStore.deleteSession(sessionId);
      }
    };

    return {
      t,
      sessions,
      sortedSessions,
      formatDate,
      getSessionTitle,
      getSessionPreview,
      createNewSession,
      openSession,
      deleteSession,
    };
  },
};
</script>

<style scoped>
.sessions-view {
  width: 100%;
  max-width: 1400px;
  margin: 0 auto;
  padding: var(--spacing-md) var(--spacing-xl);
  height: 100%;
  display: flex;
  flex-direction: column;
}

.sessions-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-xl);
}

.view-title {
  font-size: var(--font-size-2xl);
  font-weight: 700;
  color: var(--color-text-primary);
  margin: 0;
}

.view-subtitle {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin-top: var(--spacing-xs);
}

.create-btn {
  height: 42px;
  padding: 0 var(--spacing-lg);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-weight: 600;
}

.sessions-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  overflow-y: auto;
  padding-right: var(--spacing-xs);
}

.session-row {
  display: flex;
  align-items: center;
  padding: var(--spacing-lg) var(--spacing-xl);
  gap: var(--spacing-lg);
  cursor: pointer;
  transition: all var(--transition-base);
  background: var(--color-bg-secondary);
  border: 1px solid var(--glass-border);
  box-shadow: var(--shadow-sm);
}

.session-row:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-accent-primary);
  box-shadow: var(--shadow-md);
  transform: translateX(4px);
}

/* Enhancing contrast for non-dark themes */

[data-theme="light"] .session-row,
[data-theme="cosmic"] .session-row {
  background: white;
  border-color: rgba(0, 0, 0, 0.12);
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
}

[data-theme="light"] .session-row:hover,
[data-theme="cosmic"] .session-row:hover {
  border-color: var(--color-accent-primary);
  background: #f8fafc;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1), 0 4px 6px -2px rgba(0, 0, 0, 0.05);
  transform: translateY(-1px) translateX(4px);
}

/* Prefix: Status & Time */
.row-prefix {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  min-width: 120px;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-idle { background: var(--color-status-idle); box-shadow: 0 0 8px var(--color-status-idle); }
.status-active { background: var(--color-status-active); box-shadow: 0 0 8px var(--color-status-active); animation: pulse 2s infinite; }
.status-error { background: var(--color-status-error); }

.time-info {
  display: flex;
  flex-direction: column;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
}

.time-info .time {
  font-weight: 600;
  color: var(--color-text-secondary);
}

/* Content: Title & Preview */
.row-content {
  flex: 1;
  min-width: 0;
}

.session-title {
  font-size: var(--font-size-base);
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0 0 var(--spacing-xs) 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-preview {
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
  margin: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 0.8;
}

/* Meta info */
.row-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  color: var(--color-text-tertiary);
  font-size: var(--font-size-sm);
}

.message-count {
  display: flex;
  align-items: center;
  gap: 4px;
}

.workspace-tag {
  background: var(--color-bg-tertiary);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-size: var(--font-size-xs);
  border: 1px solid var(--glass-border);
}

/* Actions */
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.session-row:hover .row-actions {
  opacity: 1;
}

.btn-action {
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--spacing-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.continue-btn {
  background: var(--color-accent-primary);
  color: white;
  border: none;
}

.continue-btn:hover {
  filter: brightness(1.1);
  transform: translateY(-1px);
}

.details-btn:hover {
  background: var(--color-bg-elevated);
  border-color: var(--color-accent-primary);
}

.delete-btn {
  width: 32px;
  padding: 0;
  color: var(--color-text-tertiary);
}

.delete-btn:hover {
  background: rgba(245, 87, 108, 0.1);
  color: var(--color-error);
  border-color: var(--color-error);
}

.empty-state {
  max-width: 500px;
  margin: var(--spacing-2xl) auto;
  padding: var(--spacing-2xl);
  text-align: center;
}

.empty-icon {
  font-size: 4rem;
  margin-bottom: var(--spacing-lg);
}

@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 1; }
}
</style>
