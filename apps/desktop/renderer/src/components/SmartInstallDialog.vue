<template>
  <transition name="fade">
    <div
      class="smart-install-dialog-backdrop"
      :class="{ 'smart-install-expanded': expanded }"
      role="dialog"
      aria-modal="true"
      aria-labelledby="smart-install-title"
    >
      <div class="smart-install-dialog card-glass" :class="{ expanded }" @click.stop>
        <div class="smart-install-header">
          <h2 id="smart-install-title" class="smart-install-title">{{ dialogTitle }}</h2>
          <div class="smart-install-header-actions">
            <button
              v-if="messages.length > 0 && !streaming"
              type="button"
              class="btn-icon-header"
              :title="t('chat.clearConversation')"
              @click="clearSession"
            >
              <span class="btn-icon-text">{{ t('chat.clearConversation') }}</span>
            </button>
            <button
              type="button"
              class="btn-icon-header"
              :title="expanded ? t('agents.restoreSize') : t('agents.expandWindow')"
              @click="expanded = !expanded"
            >
              <span class="btn-icon-text">{{ expanded ? t('agents.restoreSize') : t('agents.expandWindow') }}</span>
            </button>
            <button type="button" class="smart-install-close-btn" :title="t('common.close')" @click="close">✕</button>
          </div>
        </div>
        <div v-if="opening" class="smart-install-body loading-inline">
          <div class="spinner"></div>
          <p>{{ t('common.loading') }}</p>
        </div>
        <template v-else>
          <div class="smart-install-body">
            <div class="smart-install-messages" ref="messagesRef">
              <div v-if="messages.length === 0 && !streaming" class="empty-chat-inline">
                <p class="text-secondary">{{ t('agents.installSmartHint') }}</p>
              </div>
              <ChatMessage
                v-for="msg in messages"
                :key="msg.id"
                :role="msg.role"
                :content="msg.content"
                :timestamp="msg.timestamp"
                :tool-calls="msg.toolCalls"
                :content-parts="msg.contentParts"
              />
              <div v-if="streaming && (currentMessage || toolExecutions.length > 0)" class="streaming-message">
                <ChatMessage
                  role="assistant"
                  :content="currentMessage || t('chat.thinking')"
                  :timestamp="Date.now()"
                  :tool-calls="toolExecutions"
                  :content-parts="streamParts"
                />
              </div>
            </div>
            <div class="smart-install-input-row">
              <div class="smart-install-input-wrap">
                <textarea
                  v-model="input"
                  :placeholder="t('chat.placeholder')"
                  class="smart-install-input"
                  rows="2"
                  :disabled="streaming"
                  @keydown.enter.exact.prevent="send"
                  @keydown.enter.shift.exact.prevent="input += '\n'"
                />
                <button
                  v-if="!streaming"
                  type="button"
                  class="smart-install-btn smart-install-btn-send"
                  :disabled="!input.trim()"
                  :title="t('common.send')"
                  @click="send"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon-svg"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
                </button>
                <button
                  v-else
                  type="button"
                  class="smart-install-btn smart-install-btn-abort"
                  :title="t('common.abort')"
                  @click="cancelTurn"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="btn-icon-svg"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>
                </button>
              </div>
            </div>
          </div>
        </template>
        <p v-if="error" class="form-error smart-install-error">{{ error }}</p>
      </div>
    </div>
  </transition>
</template>

<script>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from '@/composables/useI18n';
import { useAgentStore } from '@/store/modules/agent';
import ChatMessage from '@/components/ChatMessage.vue';

export default {
  name: 'SmartInstallDialog',
  components: { ChatMessage },
  props: {
    /** 安装目标：具体 agentId 安装到该智能体工作区；'global' 安装到全局 skills 目录 */
    targetAgentId: { type: String, required: true },
    /** 会话 ID，用于与其它智能安装会话隔离（如 agent 用 skill-install，全局用 skill-install-global） */
    sessionId: { type: String, default: 'skill-install' },
    /** 弹窗标题，默认使用 agents.installSmart */
    dialogTitle: { type: String, default: '' },
  },
  emits: ['close', 'installed'],
  setup(props, { emit }) {
    const { t } = useI18n();
    const agentStore = useAgentStore();

    const expanded = ref(false);
    const opening = ref(false);
    const input = ref('');
    const messagesRef = ref(null);
    const error = ref('');

    const messages = computed(() => agentStore.messages);
    const currentMessage = computed(() => agentStore.currentMessage);
    const streaming = computed(() => agentStore.isStreaming);
    const toolExecutions = computed(() => agentStore.toolExecutions);
    const streamParts = computed(() => {
      const parts = agentStore.currentStreamParts;
      if (parts && parts.length > 0) return parts;
      const msg = agentStore.currentMessage;
      const tools = agentStore.toolExecutions;
      if (!msg && (!tools || tools.length === 0)) return [];
      const out = [];
      if (msg) out.push({ type: 'text', content: msg });
      if (tools?.length) tools.forEach((t) => out.push({ type: 'tool', toolId: t.id }));
      return out;
    });

    const dialogTitleResolved = computed(() => (props.dialogTitle || t('agents.installSmart')));

    function close() {
      agentStore.clearCurrentSession();
      emit('close');
      expanded.value = false;
      error.value = '';
      input.value = '';
    }

    async function ensureSession() {
      if (agentStore.currentSession?.id === props.sessionId) return;
      opening.value = true;
      try {
        await agentStore.selectSession(props.sessionId);
      } catch (e) {
        if (e.response?.status === 404 || (e.message && e.message.includes('not found'))) {
          const agentIdForSession = props.targetAgentId === 'global' ? 'default' : props.targetAgentId;
          await agentStore.createSession({
            id: props.sessionId,
            agentId: agentIdForSession,
            type: 'system',
            title: 'Skill 搜索安装',
          });
          await agentStore.selectSession(props.sessionId);
        } else {
          throw e;
        }
      } finally {
        opening.value = false;
      }
    }

    async function clearSession() {
      try {
        await agentStore.deleteSession(props.sessionId);
      } catch (_) {}
      const agentIdForSession = props.targetAgentId === 'global' ? 'default' : props.targetAgentId;
      await agentStore.createSession({
        id: props.sessionId,
        agentId: agentIdForSession,
        type: 'system',
        title: 'Skill 搜索安装',
      });
      await agentStore.selectSession(props.sessionId);
      error.value = '';
      input.value = '';
    }

    function cancelTurn() {
      agentStore.cancelCurrentTurn();
    }

    async function send() {
      const text = (input.value || '').trim();
      if (!text || streaming.value) return;
      input.value = '';
      error.value = '';
      try {
        await ensureSession();
        await agentStore.sendMessage(text, { targetAgentId: props.targetAgentId });
        await nextTick();
        if (messagesRef.value) messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
      } catch (e) {
        console.error('Smart install send failed', e);
        error.value = e.response?.data?.message || e.message || 'Failed';
      }
    }

    watch([messages, currentMessage], async () => {
      if (messagesRef.value) {
        await nextTick();
        messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
      }
    });

    onMounted(() => {
      document.body.style.overflow = 'hidden';
    });
    onBeforeUnmount(() => {
      document.body.style.overflow = '';
    });

    return {
      t,
      dialogTitle: dialogTitleResolved,
      expanded,
      opening,
      input,
      messagesRef,
      error,
      messages,
      currentMessage,
      streaming,
      toolExecutions,
      streamParts,
      close,
      clearSession,
      cancelTurn,
      send,
    };
  },
};
</script>

<style scoped>
.smart-install-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: var(--z-modal-backdrop, 1040);
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xl);
  box-sizing: border-box;
}

.smart-install-dialog-backdrop.smart-install-expanded {
  padding: 0;
}

.smart-install-dialog {
  position: relative;
  z-index: var(--z-modal, 1050);
  max-width: 680px;
  width: 100%;
  min-width: 360px;
  max-height: 82vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-xl);
  border: 1px solid var(--glass-border);
  box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
  background: var(--color-bg-primary);
}

.smart-install-dialog.expanded {
  max-width: none;
  width: 100%;
  height: 100%;
  max-height: none;
  border-radius: 0;
}

.smart-install-header {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-lg) var(--spacing-xl);
  border-bottom: 1px solid var(--glass-border);
  background: var(--color-bg-secondary);
}

.smart-install-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: 600;
  color: var(--color-text-primary);
}

.smart-install-header-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.btn-icon-header {
  padding: var(--spacing-xs) var(--spacing-md);
  font-size: var(--font-size-sm);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 0.15s, color 0.15s, border-color 0.15s;
}

.btn-icon-header:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  border-color: var(--color-accent-primary);
}

.btn-icon-text {
  white-space: nowrap;
}

.smart-install-close-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: 1.1rem;
  cursor: pointer;
  transition: background 0.15s, color 0.15s;
}

.smart-install-close-btn:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.smart-install-dialog.expanded .smart-install-messages {
  max-height: none;
  flex: 1;
}

.smart-install-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.smart-install-body.loading-inline {
  align-items: center;
  justify-content: center;
  padding: var(--spacing-2xl);
  color: var(--color-text-secondary);
}

.smart-install-messages {
  flex: 1;
  min-height: 280px;
  max-height: 52vh;
  overflow-y: auto;
  padding: var(--spacing-lg) var(--spacing-xl);
  background: var(--color-bg-primary);
}

.smart-install-dialog.expanded .smart-install-messages {
  max-height: none;
}

.empty-chat-inline {
  padding: var(--spacing-xl);
  text-align: center;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.smart-install-messages .chat-message {
  margin-bottom: var(--spacing-md);
}

.smart-install-messages .streaming-message {
  margin-bottom: var(--spacing-md);
}

.smart-install-input-row {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--glass-border);
}

.smart-install-input-wrap {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: 8px 10px;
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-primary);
  transition: border-color 0.15s, box-shadow 0.15s;
}

.smart-install-input-wrap:focus-within {
  border-color: var(--color-accent-primary);
  box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.15);
}

.smart-install-input {
  flex: 1;
  width: 100%;
  min-width: 0;
  padding: var(--spacing-sm) var(--spacing-md);
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: var(--font-size-base);
  font-family: var(--font-family-base);
  resize: none;
  min-height: 44px;
  outline: none;
}

.smart-install-input::placeholder {
  color: var(--color-text-tertiary);
}

.smart-install-input:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.smart-install-btn {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: opacity 0.15s, background 0.15s, transform 0.1s;
}

.smart-install-btn .btn-icon-svg {
  width: 20px;
  height: 20px;
}

.smart-install-btn-send {
  background: var(--color-accent-primary);
  color: white;
}

.smart-install-btn-send:hover:not(:disabled) {
  opacity: 0.95;
  transform: scale(1.02);
}

.smart-install-btn-send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.smart-install-btn-abort {
  background: var(--color-bg-elevated);
  color: var(--color-text-secondary);
}

.smart-install-btn-abort:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.smart-install-error {
  margin: 0;
  padding: var(--spacing-sm) var(--spacing-xl);
  flex-shrink: 0;
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--glass-border);
}
</style>
