<template>
  <div class="agent-chat">
    <!-- Left Panel: Chat Sessions -->
    <ChatSessionsPanel
      :visible="sessionsPanelVisible"
      :sessions="sessions"
      :current-session-id="currentSession?.id ?? routeSessionId"
      @create="createNewSession"
      @select="selectSession"
      @delete="onDeleteSession"
    />

    <!-- Right Panel: Chat Area -->
    <div class="chat-container">
      <!-- Messages Area -->
      <div class="messages-area" ref="messagesContainer">
        <!-- No session or system session: do not show history -->
        <div v-if="!currentSession || isSystemSession" class="empty-chat">
          <div class="empty-icon">💬</div>
          <h3>{{ t('chat.startConversation') }}</h3>
          <p class="text-secondary">{{ t('chat.startConversationHint') }}</p>
        </div>
        
        <!-- Normal session: show message list and streaming -->
        <template v-else>
          <!-- Empty Session History -->
          <div v-if="messages.length === 0" class="empty-chat">
            <div class="empty-icon">💬</div>
            <h3>{{ t('chat.startConversation') }}</h3>
            <p class="text-secondary">{{ t('chat.startConversationHint') }}</p>
          </div>
          
          <!-- Message List -->
          <ChatMessage
            v-for="message in messages"
            :key="message.id"
            :role="message.role"
            :content="message.content"
            :timestamp="message.timestamp"
            :tool-calls="message.toolCalls"
            :content-parts="message.contentParts"
          />

          <!-- Streaming Message: Only show if there is actual content or active tools to show -->
          <div v-if="(isStreaming || toolExecutions.length > 0) && (currentMessage || toolExecutions.length > 0)" class="streaming-message">
            <ChatMessage
              :role="'assistant'"
              :content="currentMessage || (toolExecutions.length > 0 ? t('chat.thinking') : '')"
              :timestamp="Date.now()"
              :tool-calls="toolExecutions"
              :content-parts="streamContentParts"
            />
          </div>
        </template>
      </div>

      <!-- Input Area -->
      <div class="input-area">
        <!-- 智能体列表：常驻展示，点击切换；发送首条消息时用当前选中智能体创建 Session -->
        <div class="agent-list-bar">
          <div
            v-for="a in agents"
            :key="a.id"
            class="agent-chip"
            :class="{ active: effectiveSelectedAgentId === String(a.id) }"
            @click="onAgentChipClick(a.id)"
          >
            <span class="agent-chip-icon" :class="{ default: a.id === 'default' }">
              <!-- 主智能体：星标 + 光晕 -->
              <svg v-if="a.id === 'default'" class="agent-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <defs><linearGradient :id="`agent-star-grad-${a.id}`" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="currentColor" stop-opacity="1"/><stop offset="100%" stop-color="currentColor" stop-opacity="0.6"/></linearGradient></defs>
                <path :fill="`url(#agent-star-grad-${a.id})`" d="M12 2l1.8 5.5H20l-4.5 3.3 1.7 5.5L12 13.2l-5.2 3.8 1.7-5.5L4 7.5h6.2L12 2z"/>
                <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"/>
              </svg>
              <!-- 自定义智能体：抽象 AI 节点 -->
              <svg v-else class="agent-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <defs><linearGradient :id="`agent-node-grad-${a.id}`" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="currentColor"/><stop offset="100%" stop-color="currentColor" stop-opacity="0.7"/></linearGradient></defs>
                <circle cx="12" cy="8" r="3" :fill="`url(#agent-node-grad-${a.id})`" opacity="0.95"/>
                <path fill="currentColor" opacity="0.85" d="M6 18.5c0-3.3 2.7-6 6-6s6 2.7 6 6v1H6v-1z"/>
                <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25"/>
              </svg>
            </span>
            <span class="agent-chip-name">{{ a.name || a.workspace || a.id }}</span>
            <span v-if="a.id === 'default'" class="agent-chip-badge">{{ t('agents.defaultBadge') }}</span>
          </div>
          <p v-if="agents.length === 0" class="agent-list-empty">{{ t('chat.selectAgent') }}</p>
        </div>
        <div class="input-container">
          <textarea
            v-model="inputMessage"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.enter.shift.exact="inputMessage += '\n'"
            :placeholder="t('chat.placeholder')"
            class="message-input"
            rows="3"
            :disabled="isStreaming"
          ></textarea>
          <!-- 非 streaming 时显示发送，streaming 时显示中止 -->
          <button
            v-if="!isStreaming"
            @click="sendMessage"
            :disabled="!inputMessage.trim()"
            class="send-button"
            :title="t('common.send')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
          </button>
          <button
            v-else
            @click="cancelCurrentTurn"
            type="button"
            class="send-button abort-button"
            :title="t('common.abort')"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="w-6 h-6"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, nextTick, onMounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAgentStore } from '@/store/modules/agent';
import { useUIStore } from '@/store/modules/ui';
import { useI18n } from '@/composables/useI18n';
import { agentConfigAPI } from '@/api';
import ChatMessage from '@/components/ChatMessage.vue';
import ChatSessionsPanel from '@/components/ChatSessionsPanel.vue';
import ToolExecutionCard from '@/components/ToolExecutionCard.vue';

const STORAGE_KEY_LAST_AGENT = 'openbot.lastSelectedAgentId';

export default {
  name: 'AgentChat',
  components: {
    ChatMessage,
    ChatSessionsPanel,
    ToolExecutionCard,
  },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const agentStore = useAgentStore();
    const uiStore = useUIStore();
    const { t } = useI18n();

    const sessionsPanelVisible = computed(() => uiStore.sessionsPanelVisible);
    const toggleSessionsPanel = () => uiStore.toggleSessionsPanel();

    const agents = ref([]);
    const selectedAgentId = ref('default');
    /** 通过 query.stay 表示「停留在 / 不跳转」；避免 router-view :key="fullPath" 导致组件重建后 ref 丢失 */
    const STAY_ON_ROOT_QUERY = { stay: '1' };

    /** 列表高亮：在根路径 / 或无会话时用 selectedAgentId；在会话页用当前会话的 agentId（统一转字符串） */
    const effectiveSelectedAgentId = computed(() => {
      const session = currentSession.value;
      const onRoot = route.path === '/';
      if (!session || onRoot) {
        const raw = selectedAgentId.value;
        return raw != null && raw !== '' ? String(raw) : 'default';
      }
      const raw = session.agentId;
      return raw != null ? String(raw) : 'default';
    });

    function loadAgents() {
      agentConfigAPI.listAgents().then((res) => {
        const list = res.data?.data ?? res.data ?? [];
        agents.value = Array.isArray(list) ? list : [];
      }).catch(() => { agents.value = []; });
    }
    function selectAgent(agentId) {
      const id = agentId != null ? String(agentId) : 'default';
      selectedAgentId.value = id;
      try {
        localStorage.setItem(STORAGE_KEY_LAST_AGENT, id);
      } catch (_) {}
    }
    /**
     * 切换智能体：
     * - 若该智能体已有 session：打开其最近一次会话（减少 session 数量）。
     * - 若该智能体没有 session：进入空白对话界面，用户发第一条消息时再创建 session（与新建对话一致）。
     */
    async function onAgentChipClick(agentId) {
      const id = agentId != null ? String(agentId) : 'default';
      if (currentSession.value) {
        const currentId = currentSession.value.agentId != null ? String(currentSession.value.agentId) : 'default';
        if (currentId === id) return;
        if (agentStore.isStreaming) await agentStore.cancelCurrentTurn();
        selectAgent(id);
        const list = (agentStore.sessions || []).filter(s => s.type !== 'system' && String(s.agentId ?? 'default') === id);
        const recentForAgent = list[0];
        if (recentForAgent) {
          agentStore.skipRedirectToRecentOnce = false;
          router.push(`/chat/${recentForAgent.id}`);
          return;
        }
        agentStore.skipRedirectToRecentOnce = true;
        agentStore.clearCurrentSession();
        router.push({ path: '/', query: STAY_ON_ROOT_QUERY });
        return;
      }
      selectAgent(id);
      const listNoSession = (agentStore.sessions || []).filter(s => s.type !== 'system' && String(s.agentId ?? 'default') === id);
      const recentNoSession = listNoSession[0];
      if (recentNoSession) {
        agentStore.skipRedirectToRecentOnce = false;
        router.push(`/chat/${recentNoSession.id}`);
      }
    }

    const inputMessage = ref('');
    const messagesContainer = ref(null);

    const routeSessionId = computed(() => route.params.sessionId || null);
    const currentSession = computed(() => agentStore.currentSession);
    /** 左侧列表：仅展示非 system 会话；若当前会话非 system 且不在列表中则补上 */
    const sessions = computed(() => {
      const list = (agentStore.sessions || []).filter(s => s.type !== 'system');
      const cur = agentStore.currentSession;
      if (cur && cur.type !== 'system' && !list.some(s => s.id === cur.id)) {
        return [cur, ...list];
      }
      return list;
    });
    /** 当前会话为 system 时不展示对话历史（仅左侧不展示、对话区也不展示） */
    const isSystemSession = computed(() => currentSession.value?.type === 'system');
    const messages = computed(() => agentStore.messages);
    const isStreaming = computed(() => agentStore.isStreaming);
    const currentMessage = computed(() => agentStore.currentMessage);
    const toolExecutions = computed(() => agentStore.toolExecutions);
    const streamContentParts = computed(() => {
      const parts = agentStore.currentStreamParts;
      if (parts && parts.length > 0) return parts;
      const msg = agentStore.currentMessage;
      const tools = agentStore.toolExecutions;
      if (!msg && (!tools || tools.length === 0)) return [];
      const synthetic = [];
      if (msg) synthetic.push({ type: 'text', content: msg });
      if (tools && tools.length) tools.forEach((t) => synthetic.push({ type: 'tool', toolId: t.id }));
      return synthetic;
    });

    /**
     * 新建对话：若上一对话还在进行中则先关闭，再清空并跳转到干净聊天界面（不创建 session）；
     * 用户输入并点击发送后，由 sendMessage 在首条消息时创建新 session 并正常对话。
     */
    const createNewSession = async () => {
        if (agentStore.isStreaming) await agentStore.cancelCurrentTurn();
        agentStore.skipRedirectToRecentOnce = true;
        agentStore.clearCurrentSession();
        router.push({ path: '/', query: STAY_ON_ROOT_QUERY });
    };

    const selectSession = (sessionId) => {
      agentStore.skipRedirectToRecentOnce = false;
      router.push(`/chat/${sessionId}`);
    };

    /** 删除该 session 及其聊天记录；若删除的是当前会话则跳转到空白页 */
    const onDeleteSession = async (sessionId) => {
      const wasCurrent = currentSession.value?.id === sessionId;
      try {
        await agentStore.deleteSession(sessionId);
        if (wasCurrent || routeSessionId.value === sessionId) {
          agentStore.skipRedirectToRecentOnce = true;
          router.push({ path: '/', query: STAY_ON_ROOT_QUERY });
        }
      } catch (e) {
        console.error('Delete session failed', e);
      }
    };

    /** 发送消息：无当前 session 时由 store 在首条发送时懒创建 session（使用当前选中的 selectedAgentId），再走后续对话逻辑 */
    const sendMessage = async () => {
      if (!inputMessage.value.trim() || isStreaming.value) return;

      const message = inputMessage.value;
      inputMessage.value = '';

      try {
        const options = currentSession.value ? {} : { agentId: selectedAgentId.value };
        const session = await agentStore.sendMessage(message, options);
        if (session && !routeSessionId.value) {
          agentStore.skipRedirectToRecentOnce = false;
          router.replace(`/chat/${session.id}`);
        }
        await scrollToBottom();
      } catch (e) {
        console.error('Send message failed', e);
      }
    };

    const scrollToBottom = async () => {
      await nextTick();
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
      }
    };

    watch(() => messages.value.length, scrollToBottom);
    watch(() => currentMessage.value, scrollToBottom);

    // 智能安装：从智能体配置跳转过来时预填输入框
    watch(
      () => currentSession.value,
      (session) => {
        if (session?.type === 'system') {
          try {
            const prompt = sessionStorage.getItem('openbot.smartInstallPrompt');
            if (prompt) {
              sessionStorage.removeItem('openbot.smartInstallPrompt');
              inputMessage.value = prompt;
            }
          } catch (_) {}
        }
      },
      { immediate: true },
    );

    // Sync Route -> Session
    watch(
      () => route.params.sessionId,
      async (sessionId) => {
        if (sessionId) {
          if (agentStore.currentSession?.id !== sessionId) {
            try {
              await agentStore.selectSession(sessionId);
            } catch (e) {
              console.error('Select session failed', e);
              router.replace('/');
            }
          }
        } else {
          agentStore.clearCurrentSession();
        }
      }
    );

    // 根路径 /：带 query.stay 表示「新建对话/切换智能体」，不重定向并去掉 query。
    // 注意：replace 后 fullPath 从 /?stay=1 变为 /，App.vue 的 router-view :key="fullPath" 会重建组件；
    // 新组件 onMounted 可能晚于 path watch 执行（含 await），故此处「消费」时不要将 skipRedirectToRecentOnce 置 false，
    // 否则 onMounted 里会误判并跳回最近会话。标志在 selectSession / sendMessage 离开 / 时再清除。
    watch(
      () => ({ path: route.path, stay: route.query?.stay }),
      ({ path, stay }) => {
        if (path !== '/') return;
        if (stay) {
          agentStore.skipRedirectToRecentOnce = true;
          router.replace({ path: '/', query: {} });
          return;
        }
        if (agentStore.skipRedirectToRecentOnce) {
          return;
        }
        const recent = agentStore.sessions[0];
        if (recent) {
          router.replace(`/chat/${recent.id}`);
        }
      },
      { immediate: true }
    );

    // Startup Logic
    onMounted(async () => {
      try {
        loadAgents();
        try {
          const last = localStorage.getItem(STORAGE_KEY_LAST_AGENT);
          if (last && last.trim()) selectedAgentId.value = last.trim();
        } catch (_) {}

        if (agentStore.sessions.length === 0) {
          await agentStore.fetchSessions();
        }

        const sessionId = route.params.sessionId;
        if (sessionId) {
          if (agentStore.currentSession?.id !== sessionId) {
            await agentStore.selectSession(sessionId);
          }
        } else if (route.path === '/' && !route.query?.stay && !agentStore.skipRedirectToRecentOnce) {
          const recent = agentStore.sessions[0];
          if (recent) {
            router.replace(`/chat/${recent.id}`);
          }
        }
      } catch (e) {
        console.error('AgentChat mount error', e);
      }
    });

    return {
      t,
      routeSessionId,
      sessionsPanelVisible,
      toggleSessionsPanel,
      currentSession,
      sessions,
      isSystemSession,
      messages,
      isStreaming,
      currentMessage,
      toolExecutions,
      streamContentParts,
      inputMessage,
      messagesContainer,
      agents,
      selectedAgentId,
      effectiveSelectedAgentId,
      onAgentChipClick,
      createNewSession,
      selectSession,
      onDeleteSession,
      sendMessage,
      cancelCurrentTurn: () => agentStore.cancelCurrentTurn(),
      Date,
    };
  },
};
</script>

<style scoped>
.agent-chat {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  width: 100%;
  max-width: 100%;
  height: 100%;
  display: flex;
  flex-direction: row;
  align-items: stretch;
  overflow: hidden;
}

.chat-container {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  max-width: 100%;
  background: var(--color-bg-primary);
}

.messages-area {
  flex: 1 1 0;
  min-height: 0;
  overflow-y: auto;
  padding: var(--spacing-lg) var(--spacing-xl);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-lg) var(--radius-lg) 0 0;
  display: flex;
  flex-direction: column;
}

.empty-chat {
  flex: 1;
  min-height: 200px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--spacing-2xl);
}

.empty-icon {
  font-size: 4rem;
  margin-bottom: var(--spacing-lg);
}

.streaming-message {
  opacity: 0.9;
}

.input-area {
  flex-shrink: 0;
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--glass-border);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

/* 智能体列表：输入框上方常驻，横向排列，点击切换 */
.agent-list-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: var(--spacing-md);
  min-height: 48px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 0;
  scrollbar-width: thin;
}
.agent-list-bar::-webkit-scrollbar {
  height: 4px;
}
.agent-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: 12px;
  border: 1.5px solid transparent;
  background: var(--color-bg-tertiary);
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease, transform 0.15s ease;
}
.agent-chip:hover {
  background: var(--color-bg-elevated);
  border-color: rgba(102, 126, 234, 0.3);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}
.agent-chip.active {
  border-color: var(--color-accent-primary);
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.14) 0%, rgba(118, 75, 162, 0.1) 100%);
  box-shadow: 0 2px 12px rgba(102, 126, 234, 0.2);
}
.agent-chip.active .agent-chip-name {
  color: var(--color-accent-primary);
  font-weight: 600;
}
.agent-chip-icon {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.2) 0%, rgba(118, 75, 162, 0.18) 100%);
  color: var(--color-accent-primary);
}
.agent-chip-icon.default {
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.25) 0%, rgba(245, 158, 11, 0.2) 100%);
  color: #d97706;
}
.agent-chip.active .agent-chip-icon.default {
  color: #b45309;
  box-shadow: 0 0 0 1px rgba(251, 191, 36, 0.3);
}
.agent-icon-svg {
  width: 16px;
  height: 16px;
}
.agent-chip-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
.agent-chip-badge {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  padding: 2px 6px;
  border-radius: 6px;
  background: var(--color-bg-tertiary);
  flex-shrink: 0;
}
.agent-chip.active .agent-chip-badge {
  background: rgba(102, 126, 234, 0.2);
  color: var(--color-accent-primary);
}
.agent-list-empty {
  margin: 0;
  padding: 8px 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}

.input-container {
  display: flex;
  position: relative;
  width: 100%;
}

.message-input {
  width: 100%;
  padding: var(--spacing-md);
  padding-right: 50px;
  font-size: var(--font-size-base);
  font-family: var(--font-family-base);
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  resize: none;
  outline: none;
  transition: all var(--transition-fast);
}

.message-input:focus {
  border-color: var(--color-accent-primary);
  box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
}

.message-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.send-button {
  position: absolute;
  right: var(--spacing-xs);
  bottom: var(--spacing-xs);
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--color-accent-primary);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  opacity: 0.8;
}

.send-button.abort-button {
  color: var(--color-error, #dc2626);
}

.send-button.abort-button:hover {
  opacity: 1;
  background: rgba(220, 38, 38, 0.1);
}

.send-button:hover:not(:disabled) {
  background: var(--color-bg-elevated);
  opacity: 1;
  transform: scale(1.05);
}

.send-button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  filter: grayscale(1);
}

.pulse {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
</style>
