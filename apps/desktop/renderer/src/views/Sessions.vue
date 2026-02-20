<template>
  <div class="sessions-view">
    <div class="sessions-header">
      <div class="header-info">
        <h2 class="view-title">{{ t('nav.sessions') }}</h2>
        <p class="view-subtitle">{{ sessions.length }} {{ t('sessions.totalSessions') }}</p>
      </div>
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
        @click="openDetail(session)"
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
          <div class="session-source-row">
            <span class="source-tag" :class="sourceTagClass(session)">{{ getSessionSourceLabel(session) }}</span>
            <span v-if="session.type" class="type-tag">{{ getSessionTypeLabel(session) }}</span>
          </div>
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
          <button
            v-if="isWebDesktopSession(session)"
            @click="goToChat(session)"
            class="btn-action continue-btn"
            :title="t('common.continue')"
          >
            <span>{{ t('common.continue') }}</span>
          </button>
          <button @click="openDetail(session)" class="btn-action details-btn" :title="t('common.details')">
            <span>{{ t('common.details') }}</span>
          </button>
          <button @click="openHistory(session)" class="btn-action history-btn" :title="t('sessions.chatHistory')">
            <span>{{ t('sessions.chatHistory') }}</span>
          </button>
          <button @click="deleteSession(session.id)" class="btn-action delete-btn" :title="t('common.delete')">
            <span class="icon-trash">🗑️</span>
          </button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗：显示当前 Session 的所有属性 -->
    <transition name="fade">
      <div v-if="detailSession" class="modal-backdrop" @click.self="detailSession = null">
        <div class="modal-content card-glass detail-modal">
          <div class="modal-header">
            <h2>{{ t('common.details') }} — {{ getSessionTitle(detailSession) }}</h2>
            <button type="button" class="close-btn" @click="detailSession = null">✕</button>
          </div>
          <div class="modal-body detail-body">
            <dl class="detail-list">
              <div class="detail-item">
                <dt>ID</dt>
                <dd>{{ detailSession.id }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.source') }}</dt>
                <dd><span class="source-tag" :class="sourceTagClass(detailSession)">{{ getSessionSourceLabel(detailSession) }}</span></dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.type') }}</dt>
                <dd>{{ getSessionTypeLabel(detailSession) }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.status') }}</dt>
                <dd>{{ detailSession.status }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.agentId') }}</dt>
                <dd>{{ detailSession.agentId ?? 'default' }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.workspace') }}</dt>
                <dd>{{ detailSession.workspace ?? '—' }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.messageCount') }}</dt>
                <dd>{{ detailSession.messageCount }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.createdAt') }}</dt>
                <dd>{{ formatDateTime(detailSession.createdAt) }}</dd>
              </div>
              <div class="detail-item">
                <dt>{{ t('sessions.lastActiveAt') }}</dt>
                <dd>{{ formatDateTime(detailSession.lastActiveAt) }}</dd>
              </div>
              <div class="detail-item" v-if="detailSession.provider">
                <dt>Provider</dt>
                <dd>{{ detailSession.provider }}</dd>
              </div>
              <div class="detail-item" v-if="detailSession.model">
                <dt>Model</dt>
                <dd>{{ detailSession.model }}</dd>
              </div>
              <div class="detail-item" v-if="detailSession.title">
                <dt>Title</dt>
                <dd>{{ detailSession.title }}</dd>
              </div>
              <div class="detail-item" v-if="detailSession.preview">
                <dt>Preview</dt>
                <dd class="preview-text">{{ detailSession.preview }}</dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </transition>

    <!-- 对话记录弹窗 -->
    <transition name="fade">
      <div v-if="historySession" class="modal-backdrop" @click.self="historySession = null">
        <div class="modal-content card-glass history-modal">
          <div class="modal-header">
            <h2>{{ t('sessions.chatHistory') }} — {{ getSessionTitle(historySession) }}</h2>
            <div class="modal-header-actions">
              <button type="button" class="btn-danger btn-sm" @click="clearHistoryConfirm" :disabled="historyLoading || (historyMessages && historyMessages.length === 0)">
                {{ t('sessions.clearHistory') }}
              </button>
              <button type="button" class="close-btn" @click="historySession = null">✕</button>
            </div>
          </div>
          <div class="modal-body history-body">
            <div v-if="historyLoading" class="loading-state">
              <div class="spinner"></div>
              <p>{{ t('common.loading') }}</p>
            </div>
            <div v-else-if="!historyMessages || historyMessages.length === 0" class="empty-state small">
              <p>{{ t('sessions.noMessages') }}</p>
            </div>
            <div v-else class="history-list">
              <div
                v-for="msg in historyMessages"
                :key="msg.id"
                class="history-item"
                :class="`role-${msg.role}`"
              >
                <span class="history-role">{{ msg.role === 'user' ? t('sessions.roleUser') : t('sessions.roleAssistant') }}</span>
                <div class="history-content">{{ msg.content || '—' }}</div>
                <span class="history-time">{{ formatDateTime(msg.timestamp) }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script>
import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';
import { useAgentStore } from '@/store/modules/agent';
import { useI18n } from '@/composables/useI18n';
import { agentAPI } from '@/api';

export default {
  name: 'Sessions',
  setup() {
    const router = useRouter();
    const agentStore = useAgentStore();
    const { t } = useI18n();

    const detailSession = ref(null);
    const historySession = ref(null);
    const historyMessages = ref(null);
    const historyLoading = ref(false);

    const sessions = computed(() => agentStore.sessions);
    const sortedSessions = computed(() => {
      return [...sessions.value].sort((a, b) => (b.lastActiveAt || b.createdAt) - (a.lastActiveAt || a.createdAt));
    });

    /** 会话来源：channel:feishu:xxx -> 飞书通道；channel:xxx:yyy -> 通道: xxx；否则 Web/Desktop */
    function getSessionSourceLabel(session) {
      const id = session?.id || '';
      if (id.startsWith('channel:feishu:')) return t('sessions.sourceFeishu');
      if (id.startsWith('channel:')) {
        const parts = id.split(':');
        return t('sessions.sourceChannel', { name: parts[1] || 'unknown' });
      }
      return t('sessions.sourceWebDesktop');
    }

    function sourceTagClass(session) {
      const id = session?.id || '';
      if (id.startsWith('channel:feishu:')) return 'source-feishu';
      if (id.startsWith('channel:')) return 'source-channel';
      return 'source-web';
    }

    /** 仅 Web/Desktop 会话可点「继续」跳转对话页 */
    function isWebDesktopSession(session) {
      const id = session?.id || '';
      return !id.startsWith('channel:');
    }

    function getSessionTypeLabel(session) {
      const type = session?.type || 'chat';
      return t('sessions.type' + type.charAt(0).toUpperCase() + type.slice(1)) || type;
    }

    const formatDate = (timestamp, type) => {
      const date = new Date(timestamp);
      if (type === 'date') {
        return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      }
      return date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    };

    const formatDateTime = (timestamp) => {
      if (timestamp == null) return '—';
      return new Date(timestamp).toLocaleString(undefined, {
        dateStyle: 'short',
        timeStyle: 'short',
      });
    };

    const getSessionTitle = (session) => {
      if (session.title) return session.title;
      return session.id.substring(0, 12) + '...';
    };

    const getSessionPreview = (session) => {
      if (session.preview) return session.preview;
      if (session.workspace) return `Workspace: ${session.workspace}`;
      return 'No preview available';
    };

    /** 仅 Web/Desktop 时跳转到对话页 */
    const goToChat = (session) => {
      const id = typeof session === 'string' ? session : session?.id;
      if (!id) return;
      if (session?.type === 'system') {
        router.push({ path: '/agents/default', query: { smartInstallSession: id } });
      } else {
        router.push(`/chat/${id}`);
      }
    };

    const openDetail = (session) => {
      detailSession.value = session;
    };

    const openHistory = async (session) => {
      historySession.value = session;
      historyMessages.value = null;
      historyLoading.value = true;
      try {
        const res = await agentAPI.getHistory(session.id);
        historyMessages.value = res?.data?.data ?? res?.data ?? [];
      } catch (e) {
        historyMessages.value = [];
      } finally {
        historyLoading.value = false;
      }
    };

    const clearHistoryConfirm = async () => {
      if (!historySession.value) return;
      if (!confirm(t('sessions.clearHistoryConfirm'))) return;
      try {
        await agentAPI.clearSessionMessages(historySession.value.id);
        historyMessages.value = [];
        await agentStore.fetchSessions();
        if (historySession.value) {
          const updated = agentStore.sessions.find((s) => s.id === historySession.value.id);
          if (updated) historySession.value = updated;
        }
      } catch (e) {
        console.error(e);
      }
    };

    const deleteSession = async (sessionId) => {
      if (confirm(t('sessions.deleteConfirm') || 'Are you sure you want to delete this session?')) {
        await agentStore.deleteSession(sessionId);
        if (detailSession.value?.id === sessionId) detailSession.value = null;
        if (historySession.value?.id === sessionId) historySession.value = null;
      }
    };

    return {
      t,
      sessions,
      sortedSessions,
      formatDate,
      formatDateTime,
      getSessionTitle,
      getSessionPreview,
      getSessionSourceLabel,
      getSessionTypeLabel,
      sourceTagClass,
      isWebDesktopSession,
      goToChat,
      openDetail,
      openHistory,
      deleteSession,
      clearHistoryConfirm,
      detailSession,
      historySession,
      historyMessages,
      historyLoading,
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

.session-source-row {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  margin-top: var(--spacing-xs);
  flex-wrap: wrap;
}

.source-tag,
.type-tag {
  font-size: var(--font-size-xs);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--glass-border);
}

.source-tag.source-feishu {
  background: rgba(0, 127, 255, 0.12);
  color: #0077ff;
  border-color: rgba(0, 127, 255, 0.3);
}

.source-tag.source-channel {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.source-tag.source-web {
  background: rgba(34, 197, 94, 0.12);
  color: #16a34a;
  border-color: rgba(34, 197, 94, 0.3);
}

.type-tag {
  background: var(--color-bg-tertiary);
  color: var(--color-text-tertiary);
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

.details-btn:hover,
.history-btn:hover {
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

/* Modals */
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
  max-width: 560px;
  width: 100%;
  max-height: 85vh;
  display: flex;
  flex-direction: column;
  border-radius: var(--radius-lg);
  overflow: hidden;
}

.detail-modal .modal-body,
.history-modal .modal-body {
  overflow-y: auto;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-lg) var(--spacing-xl);
  border-bottom: 1px solid var(--glass-border);
  flex-shrink: 0;
}

.modal-header h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
  min-width: 0;
}

.modal-header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-left: var(--spacing-md);
}

.close-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-radius: var(--radius-md);
  font-size: 1.1rem;
}

.close-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.modal-body {
  padding: var(--spacing-xl);
}

.detail-body .detail-list {
  margin: 0;
  display: grid;
  gap: var(--spacing-sm);
}

.detail-item {
  display: grid;
  grid-template-columns: 120px 1fr;
  gap: var(--spacing-md);
  align-items: start;
}

.detail-item dt {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  font-weight: 500;
}

.detail-item dd {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  word-break: break-word;
}

.detail-item dd.preview-text {
  white-space: pre-wrap;
  max-height: 120px;
  overflow-y: auto;
}

.history-modal {
  max-width: 640px;
}

.history-body {
  max-height: 60vh;
  min-height: 200px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-2xl);
  color: var(--color-text-secondary);
}

.loading-state .spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--glass-border);
  border-top-color: var(--color-accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-bottom: var(--spacing-md);
}

.empty-state.small {
  padding: var(--spacing-xl);
  margin: 0;
}

.empty-state.small .empty-icon {
  display: none;
}

.history-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.history-item {
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  border: 1px solid var(--glass-border);
  background: var(--color-bg-secondary);
}

.history-item.role-user {
  border-left: 3px solid var(--color-accent-primary);
}

.history-item.role-assistant {
  border-left: 3px solid #64748b;
}

.history-role {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-tertiary);
  display: block;
  margin-bottom: var(--spacing-xs);
}

.history-content {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
}

.history-time {
  font-size: var(--font-size-xs);
  color: var(--color-text-tertiary);
  display: block;
  margin-top: var(--spacing-xs);
}

.btn-danger {
  background: rgba(239, 68, 68, 0.15);
  color: var(--color-error, #dc2626);
  border: 1px solid rgba(239, 68, 68, 0.3);
}

.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.25);
}

.btn-sm {
  padding: 6px 12px;
  font-size: var(--font-size-xs);
}

.btn-danger:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes pulse {
  0% { opacity: 1; }
  50% { opacity: 0.5; }
  100% { opacity: 1; }
}
</style>
