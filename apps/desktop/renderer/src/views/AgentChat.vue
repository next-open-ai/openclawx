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
            :is-error="!!message.isError"
          />

          <!-- 系统消息：中间展示，有正式回复或 agent_end 后消失，不进 session 记录 -->
          <div v-if="currentSystemMessage" class="system-message-banner">
            <span class="system-message-label">{{ t('chat.systemMessage') }}</span>
            <span class="system-message-text">{{ currentSystemMessage }}</span>
          </div>

          <!-- Executing placeholder: show as soon as streaming starts, before any content -->
          <div v-if="isStreaming && !currentMessage && toolExecutions.length === 0" class="streaming-placeholder">
            <div class="message-avatar">
              <span class="avatar-icon">
                <IconAssistantAvatar />
              </span>
            </div>
            <div class="message-content">
              <div class="message-header">
                <span class="message-role">{{ t('chat.assistant') }}</span>
                <span class="typing-label">{{ t('chat.thinking') }} {{ waitingElapsedSec }}s</span>
              </div>
              <div class="typing-indicator">
                <span class="dot" aria-hidden="true"></span>
                <span class="dot" aria-hidden="true"></span>
                <span class="dot" aria-hidden="true"></span>
              </div>
            </div>
          </div>

          <!-- Streaming Message: 仅当流式内容尚未并入列表时显示（有 streamingMessageId 时已在 v-for 中展示，避免完成时 DOM 先删后增导致闪烁） -->
          <div v-else-if="(isStreaming || toolExecutions.length > 0) && (currentMessage || toolExecutions.length > 0) && !streamingMessageId" class="streaming-message">
            <p v-if="firstReplyElapsedSec != null" class="first-reply-duration">{{ t('chat.firstReplyDuration', { sec: firstReplyElapsedSec }) }}</p>
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
        <!-- 智能体选择区：可收起以留出对话空间，右下角浮动按钮切换 -->
        <transition name="agent-bar-slide">
          <div v-show="agentBarVisible" class="agent-bar-wrap">
          <div class="agent-bar-inner">
            <div class="agent-bar-label" :title="t('chat.selectAgent')">
              <span class="agent-bar-label-icon" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 11h6m-3-3v6"/></svg>
              </span>
              <span class="agent-bar-label-text">{{ t('chat.selectAgent') }}</span>
            </div>
            <div class="agent-list-scroll-wrap">
            <button
              type="button"
              class="agent-scroll-trigger agent-scroll-left"
              :class="{ visible: canScrollAgentLeft }"
              aria-label="向左滑动"
              @click="scrollAgentList(-1)"
            >
              <svg class="agent-scroll-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>
            </button>
            <div
              ref="agentListBarRef"
              class="agent-list-bar"
              @scroll="onAgentListScroll"
            >
              <div
                v-for="a in agents"
                :key="a.id"
                class="agent-chip"
                :class="{ active: effectiveSelectedAgentId === String(a.id), 'is-default': a.id === 'default' }"
                @click="onAgentChipClick(a.id)"
              >
                <span class="agent-chip-icon" :class="{ default: a.id === 'default' }">
                  <svg v-if="a.id === 'default'" class="agent-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs><linearGradient :id="`agent-star-grad-${a.id}`" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="currentColor" stop-opacity="1"/><stop offset="100%" stop-color="currentColor" stop-opacity="0.6"/></linearGradient></defs>
                    <path :fill="`url(#agent-star-grad-${a.id})`" d="M12 2l1.8 5.5H20l-4.5 3.3 1.7 5.5L12 13.2l-5.2 3.8 1.7-5.5L4 7.5h6.2L12 2z"/>
                    <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.35"/>
                  </svg>
                  <svg v-else class="agent-icon-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                    <defs><linearGradient :id="`agent-node-grad-${a.id}`" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="currentColor"/><stop offset="100%" stop-color="currentColor" stop-opacity="0.7"/></linearGradient></defs>
                    <circle cx="12" cy="8" r="3" :fill="`url(#agent-node-grad-${a.id})`" opacity="0.95"/>
                    <path fill="currentColor" opacity="0.85" d="M6 18.5c0-3.3 2.7-6 6-6s6 2.7 6 6v1H6v-1z"/>
                    <circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1" opacity="0.25"/>
                  </svg>
                </span>
                <span class="agent-chip-name">{{ a.name || a.workspace || a.id }}</span>
                <span v-if="a.id === 'default'" class="agent-chip-badge">{{ t('agents.defaultBadge') }}</span>
                <span v-if="effectiveSelectedAgentId === String(a.id)" class="agent-chip-check" aria-hidden="true">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>
                </span>
              </div>
              <p v-if="agents.length === 0" class="agent-list-empty">{{ t('chat.selectAgent') }}</p>
            </div>
            <button
              type="button"
              class="agent-scroll-trigger agent-scroll-right"
              :class="{ visible: canScrollAgentRight }"
              aria-label="向右滑动"
              @click="scrollAgentList(1)"
            >
              <svg class="agent-scroll-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"/></svg>
            </button>
          </div>
          </div>
          </div>
        </transition>
        <div class="input-container">
          <textarea
            v-model="inputMessage"
            @keydown.enter.exact.prevent="sendMessage"
            @keydown.enter.shift.exact="inputMessage += '\n'"
            :placeholder="messagePlaceholder"
            class="message-input"
            rows="5"
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
      <!-- 右下角浮动按钮：展开/收起智能体选择区 -->
      <button
        v-if="!isSystemSession"
        type="button"
        class="agent-bar-float-btn"
        :class="{ collapsed: !agentBarVisible }"
        :title="agentBarVisible ? t('chat.hideAgentBar') : t('chat.showAgentBar')"
        aria-label="展开/收起智能体选择"
        @click="toggleAgentBar"
      >
        <svg v-if="agentBarVisible" class="float-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 9l-7 7-7-7"/></svg>
        <svg v-else class="float-btn-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="7" r="4"/><path d="M3 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2"/><path d="M16 11h6m-3-3v6"/></svg>
      </button>
    </div>
  </div>
</template>

<script>
import { ref, computed, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAgentStore } from '@/store/modules/agent';
import { useUIStore } from '@/store/modules/ui';
import { useI18n } from '@/composables/useI18n';
import { agentConfigAPI } from '@/api';
import ChatMessage from '@/components/ChatMessage.vue';
import ChatSessionsPanel from '@/components/ChatSessionsPanel.vue';
import ToolExecutionCard from '@/components/ToolExecutionCard.vue';
import IconAssistantAvatar from '@/components/icons/IconAssistantAvatar.vue';

const STORAGE_KEY_LAST_AGENT = 'openbot.lastSelectedAgentId';

export default {
  name: 'AgentChat',
  components: {
    ChatMessage,
    ChatSessionsPanel,
    ToolExecutionCard,
    IconAssistantAvatar,
  },
  setup() {
    const route = useRoute();
    const router = useRouter();
    const agentStore = useAgentStore();
    const uiStore = useUIStore();
    const { t } = useI18n();

    const sessionsPanelVisible = computed(() => uiStore.sessionsPanelVisible);
    const toggleSessionsPanel = () => uiStore.toggleSessionsPanel();
    const agentBarVisible = computed(() => uiStore.agentBarVisible);
    const toggleAgentBar = () => uiStore.toggleAgentBar();

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

    /** 当前选中的智能体为 OpenCode 代理时，显示指令占位提示 */
    const messagePlaceholder = computed(() => {
      const id = effectiveSelectedAgentId.value;
      const agent = (agents.value || []).find((a) => String(a.id) === id);
      if (agent?.runnerType === 'opencode') return t('chat.placeholderOpenCode');
      return t('chat.placeholder');
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
     * - 若当前已有会话：在当前 session 内切换 agent（更新后端 + 本地，发消息时带新 agentId），不跳转。
     * - 若当前无会话：仅更新选中 agent；若有该 agent 的最近会话则进入，否则停留（首条消息时用该 agent 建新 session）。
     */
    async function onAgentChipClick(agentId) {
      const id = agentId != null ? String(agentId) : 'default';
      if (currentSession.value) {
        const currentId = currentSession.value.agentId != null ? String(currentSession.value.agentId) : 'default';
        if (currentId === id) return;
        if (agentStore.isStreaming) await agentStore.cancelCurrentTurn();
        selectAgent(id);
        try {
          await agentStore.updateSessionAgentId(currentSession.value.id, id);
        } catch (e) {
          console.error('Update session agent failed', e);
        }
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
    const agentListBarRef = ref(null);
    const canScrollAgentLeft = ref(false);
    const canScrollAgentRight = ref(false);

    function updateScrollTriggers() {
      const el = agentListBarRef.value;
      if (!el) {
        canScrollAgentLeft.value = false;
        canScrollAgentRight.value = false;
        return;
      }
      const { scrollLeft, scrollWidth, clientWidth } = el;
      canScrollAgentLeft.value = scrollLeft > 2;
      canScrollAgentRight.value = scrollLeft < scrollWidth - clientWidth - 2;
    }
    function onAgentListScroll() {
      updateScrollTriggers();
    }
    function scrollAgentList(direction) {
      const el = agentListBarRef.value;
      if (!el) return;
      const step = 220;
      el.scrollBy({ left: direction * step, behavior: 'smooth' });
    }

    const routeSessionId = computed(() => route.params.sessionId || null);
    const currentSession = computed(() => agentStore.currentSession);
    /** 是否为桌面/Web 会话（非通道会话）。约定：id 以 channel: 开头为通道会话，否则为桌面会话 */
    const isDesktopSessionId = (id) => id != null && !String(id).startsWith('channel:');
    /** 左侧列表：仅展示桌面会话且非 system；若当前会话为桌面且不在列表中则补上（不展示通道会话） */
    const sessions = computed(() => {
      const list = (agentStore.sessions || []).filter(
        (s) => s.type !== 'system' && isDesktopSessionId(s.id)
      );
      const cur = agentStore.currentSession;
      if (cur && cur.type !== 'system' && isDesktopSessionId(cur.id) && !list.some((s) => s.id === cur.id)) {
        return [cur, ...list];
      }
      return list;
    });
    /** 用于「最近会话」重定向：取最近活跃的桌面会话（非 system） */
    const recentDesktopSession = computed(() => {
      const desktop = (agentStore.sessions || []).filter(
        (s) => s.type !== 'system' && isDesktopSessionId(s.id)
      );
      if (desktop.length === 0) return null;
      const sorted = [...desktop].sort(
        (a, b) => (b.lastActiveAt || b.createdAt || 0) - (a.lastActiveAt || a.createdAt || 0)
      );
      return sorted[0];
    });
    /** 当前会话为 system 时不展示对话历史（仅左侧不展示、对话区也不展示） */
    const isSystemSession = computed(() => currentSession.value?.type === 'system');
    const messages = computed(() => agentStore.messages);
    const isStreaming = computed(() => agentStore.isStreaming);
    const streamingMessageId = computed(() => agentStore.streamingMessageId);
    const currentMessage = computed(() => agentStore.currentMessage);
    const currentSystemMessage = computed(() => agentStore.currentSystemMessage);
    const toolExecutions = computed(() => agentStore.toolExecutions);
    /** 等待首字回复时的动态计时（秒），每秒更新 */
    const waitingElapsedSec = ref(0);
    /** 首字回复到达后记录的耗时（秒），在流式块中展示「等第一个回复所用时长」 */
    const firstReplyElapsedSec = ref(null);
    const firstReplyWaitStartedAt = ref(null);
    let waitTimerId = null;
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

    /** 发送消息：始终传入选中的智能体（与底部栏勾选一致），无 session 时懒创建使用 selectedAgentId */
    const sendMessage = async () => {
      if (!inputMessage.value.trim() || isStreaming.value) return;

      const message = inputMessage.value;
      inputMessage.value = '';

      try {
        const selectedId = currentSession.value ? effectiveSelectedAgentId.value : selectedAgentId.value;
        const options = { agentId: selectedId || 'default' };
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

    // 防抖 + 布局稳定后再滚；始终滚到最新一条（打开会话、发消息、流式回复均能看到最新）；二次对齐仅当高度确实增加时再滚，避免收尾抖动
    let scrollToBottomTimer = null;
    const scrollToBottom = () => {
      if (scrollToBottomTimer) clearTimeout(scrollToBottomTimer);
      scrollToBottomTimer = setTimeout(() => {
        scrollToBottomTimer = null;
        nextTick().then(() => {
          return new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          });
        }).then(() => {
          const el = messagesContainer.value;
          if (!el) return;
          el.scrollTop = el.scrollHeight;
          const heightAfterFirst = el.scrollHeight;
          // 仅当晚布局导致高度增加时再滚一次，避免无谓的收尾抖动
          setTimeout(() => {
            if (el.scrollHeight > heightAfterFirst) {
              el.scrollTop = el.scrollHeight;
            }
          }, 150);
        });
      }, 50);
    };

    watch(() => messages.value.length, scrollToBottom);
    watch(() => currentMessage.value, scrollToBottom);
    watch(isStreaming, (streaming) => {
      if (streaming) scrollToBottom();
    });

    // 等待首字回复：动态按秒计时；首字到达后记录时长并在流式块中展示
    function clearWaitTimer() {
      if (waitTimerId != null) {
        clearInterval(waitTimerId);
        waitTimerId = null;
      }
      firstReplyWaitStartedAt.value = null;
    }
    watch(
      () => ({ streaming: isStreaming.value, msg: currentMessage.value, toolsLen: toolExecutions.value.length }),
      ({ streaming, msg, toolsLen }) => {
        const isWaiting = streaming && !msg && toolsLen === 0;
        const hasFirstContent = !!(msg && msg.trim()) || toolsLen > 0;
        if (isWaiting) {
          if (firstReplyWaitStartedAt.value == null) {
            firstReplyElapsedSec.value = null;
            firstReplyWaitStartedAt.value = Date.now();
            waitingElapsedSec.value = 0;
            waitTimerId = setInterval(() => {
              if (firstReplyWaitStartedAt.value == null) return;
              waitingElapsedSec.value = Math.floor((Date.now() - firstReplyWaitStartedAt.value) / 1000);
            }, 1000);
          }
        } else {
          const startedAt = firstReplyWaitStartedAt.value;
          clearWaitTimer();
          waitingElapsedSec.value = 0;
          if (hasFirstContent && startedAt != null && firstReplyElapsedSec.value == null) {
            firstReplyElapsedSec.value = Math.floor((Date.now() - startedAt) / 1000);
          }
          if (!streaming) firstReplyElapsedSec.value = null;
        }
      },
    );

    // 切换会话时也要滚到底部（仅 length 可能不变，需依赖 session id）
    watch(() => currentSession.value?.id, () => {
      if (messages.value.length) scrollToBottom();
    });

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

    // Sync Route -> Session（禁止用通道会话做桌面对话：channel:* 时重定向到首页）
    watch(
      () => route.params.sessionId,
      async (sessionId) => {
        if (sessionId) {
          if (!isDesktopSessionId(sessionId)) {
            if (agentStore.currentSession?.id === sessionId) agentStore.clearCurrentSession();
            router.replace({ path: '/', query: STAY_ON_ROOT_QUERY });
            return;
          }
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
        const recent = recentDesktopSession.value;
        if (recent) {
          router.replace(`/chat/${recent.id}`);
        }
      },
      { immediate: true }
    );

    watch(agents, () => {
      nextTick(updateScrollTriggers);
    }, { deep: true });

    watch(() => agentStore.agentListRefreshTrigger, () => {
      loadAgents();
    }, { immediate: false });

    // Startup Logic
    onMounted(async () => {
      uiStore.setSessionsPanelVisible(false);
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
          if (!isDesktopSessionId(sessionId)) {
            if (agentStore.currentSession?.id === sessionId) agentStore.clearCurrentSession();
            router.replace({ path: '/', query: STAY_ON_ROOT_QUERY });
          } else if (agentStore.currentSession?.id !== sessionId) {
            await agentStore.selectSession(sessionId);
          }
        } else if (route.path === '/' && !route.query?.stay && !agentStore.skipRedirectToRecentOnce) {
          const recent = recentDesktopSession.value;
          if (recent) {
            router.replace(`/chat/${recent.id}`);
          }
        }

        await nextTick();
        updateScrollTriggers();
        if (typeof ResizeObserver !== 'undefined' && agentListBarRef.value) {
          const ro = new ResizeObserver(() => updateScrollTriggers());
          ro.observe(agentListBarRef.value);
        }
      } catch (e) {
        console.error('AgentChat mount error', e);
      }
    });

    onBeforeUnmount(() => {
      if (waitTimerId != null) {
        clearInterval(waitTimerId);
        waitTimerId = null;
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
      streamingMessageId,
      currentMessage,
      currentSystemMessage,
      toolExecutions,
      streamContentParts,
      waitingElapsedSec,
      firstReplyElapsedSec,
      inputMessage,
      messagePlaceholder,
      messagesContainer,
      agentListBarRef,
      canScrollAgentLeft,
      canScrollAgentRight,
      onAgentListScroll,
      scrollAgentList,
      agents,
      selectedAgentId,
      effectiveSelectedAgentId,
      onAgentChipClick,
      agentBarVisible,
      toggleAgentBar,
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
  position: relative;
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

.streaming-message .first-reply-duration {
  margin: 0 0 6px 0;
  font-size: var(--font-size-xs, 0.75rem);
  color: var(--color-text-muted);
}

/* 系统消息：中间展示，不进会话记录 */
.system-message-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  margin: 0 var(--spacing-lg);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--color-text-secondary);
}
.system-message-label {
  flex-shrink: 0;
  font-weight: 600;
}
.system-message-text {
  flex: 1;
  min-width: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 发送后、首包前：助手位「正在执行」占位 + 动画 */
.streaming-placeholder {
  display: flex;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  align-items: flex-start;
  animation: slideInUp 0.35s ease-out;
}

.streaming-placeholder .message-avatar {
  flex-shrink: 0;
}

.streaming-placeholder .avatar-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--gradient-primary);
  color: #fff;
}

.streaming-placeholder .message-content {
  flex: 1;
  max-width: 80%;
  min-width: 0;
  padding-left: var(--spacing-sm);
}

.streaming-placeholder .message-header {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-sm);
}

.streaming-placeholder .message-role {
  font-weight: 600;
  color: var(--color-text-primary);
}

.streaming-placeholder .typing-label {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.streaming-placeholder .typing-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: var(--spacing-md) var(--spacing-lg);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-lg);
  min-height: 48px;
  width: fit-content;
}

.streaming-placeholder .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-accent-primary);
  opacity: 0.85;
  animation: typingBounce 1.4s ease-in-out infinite both;
}

.streaming-placeholder .dot:nth-child(1) { animation-delay: 0s; }
.streaming-placeholder .dot:nth-child(2) { animation-delay: 0.16s; }
.streaming-placeholder .dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes slideInUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes typingBounce {
  0%, 60%, 100% {
    transform: translateY(0);
    opacity: 0.85;
  }
  30% {
    transform: translateY(-6px);
    opacity: 1;
  }
}

.input-area {
  flex-shrink: 0;
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--glass-border);
  border-radius: 0 0 var(--radius-lg) var(--radius-lg);
}

/* 智能体选择区：紧凑高度 + 可收起 */
.agent-bar-slide-enter-active,
.agent-bar-slide-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease, margin 0.2s ease;
}
.agent-bar-slide-enter-from,
.agent-bar-slide-leave-to {
  opacity: 0;
  transform: translateY(-8px);
  margin-bottom: 0 !important;
}
.agent-bar-wrap {
  margin-bottom: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: linear-gradient(145deg, rgba(102, 126, 234, 0.06) 0%, var(--color-bg-tertiary) 50%, rgba(118, 75, 162, 0.04) 100%);
  border: 1px solid rgba(102, 126, 234, 0.12);
  border-radius: var(--radius-xl);
  box-shadow: 0 4px 20px rgba(102, 126, 234, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.06);
  position: relative;
}
.agent-bar-wrap::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: inherit;
  padding: 1px;
  background: linear-gradient(135deg, rgba(255,255,255,0.2) 0%, transparent 40%, transparent 60%, rgba(102, 126, 234, 0.15) 100%);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
/* 单行布局：标签与芯片同一行，减少占高 */
.agent-bar-inner {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
}
.agent-bar-label {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--color-text-secondary);
  white-space: nowrap;
}
.agent-bar-label-text {
  opacity: 0.95;
}
.agent-bar-label-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  color: var(--color-accent-primary);
  opacity: 0.95;
}
.agent-bar-label-icon svg {
  width: 14px;
  height: 14px;
}
.agent-list-scroll-wrap {
  flex: 1 1 0;
  min-width: 0;
  position: relative;
  display: flex;
  align-items: center;
  min-height: 40px;
  gap: 2px;
}
.agent-scroll-trigger {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  cursor: pointer;
  z-index: 2;
  opacity: 0;
  pointer-events: none;
  border-radius: 50%;
  color: var(--color-text-muted);
  background: var(--color-bg-secondary);
  border: 1px solid var(--glass-border);
  transition: opacity 0.25s ease, color 0.2s ease, background 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
}
.agent-scroll-trigger .agent-scroll-icon {
  width: 16px;
  height: 16px;
}
.agent-scroll-trigger.agent-scroll-right {
  margin-left: 0;
}
.agent-scroll-trigger.visible {
  opacity: 1;
  pointer-events: auto;
}
.agent-scroll-trigger.visible:hover {
  color: var(--color-accent-primary);
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.18) 0%, rgba(118, 75, 162, 0.12) 100%);
  border-color: rgba(102, 126, 234, 0.35);
  box-shadow: 0 4px 14px rgba(102, 126, 234, 0.25);
  transform: scale(1.06);
}
.agent-scroll-trigger.visible:active {
  transform: scale(0.98);
}
.agent-list-bar {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 4px 4px;
  scroll-behavior: smooth;
  /* 隐藏横向滚动条，保持界面简洁；仍可鼠标滚轮或左右箭头滚动 */
  scrollbar-width: none;
  -ms-overflow-style: none;
}
/* 隐藏横向滚动条（仍可滚轮/箭头滚动），界面更简洁 */
.agent-list-bar::-webkit-scrollbar {
  display: none;
}
/* 智能体芯片：紧凑尺寸 */
.agent-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 12px;
  border: 1px solid rgba(102, 126, 234, 0.12);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.7) 0%, rgba(255, 255, 255, 0.4) 100%);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  cursor: pointer;
  transition: border-color 0.25s ease, background 0.25s ease, box-shadow 0.25s ease, transform 0.2s ease;
  position: relative;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06), 0 1px 0 rgba(255, 255, 255, 0.5) inset;
}
.agent-chip::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 12px;
  padding: 1px;
  background: linear-gradient(135deg, rgba(255,255,255,0.5) 0%, transparent 50%, rgba(102, 126, 234, 0.08) 100%);
  -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  pointer-events: none;
}
.agent-chip:hover {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.85) 0%, rgba(102, 126, 234, 0.08) 100%);
  border-color: rgba(102, 126, 234, 0.28);
  box-shadow: 0 8px 24px rgba(102, 126, 234, 0.15), 0 1px 0 rgba(255, 255, 255, 0.6) inset;
  transform: translateY(-2px);
}
.agent-chip.active {
  border-color: rgba(102, 126, 234, 0.5);
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.18) 0%, rgba(118, 75, 162, 0.12) 100%);
  box-shadow: 0 8px 28px rgba(102, 126, 234, 0.28), 0 0 0 1px rgba(102, 126, 234, 0.2), 0 1px 0 rgba(255, 255, 255, 0.4) inset;
  transform: translateY(-2px);
}
.agent-chip.active.is-default {
  border-color: rgba(251, 191, 36, 0.55);
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.2) 0%, rgba(245, 158, 11, 0.12) 100%);
  box-shadow: 0 8px 28px rgba(251, 191, 36, 0.22), 0 0 0 1px rgba(251, 191, 36, 0.25), 0 1px 0 rgba(255, 255, 255, 0.35) inset;
}
.agent-chip.active .agent-chip-name {
  color: var(--color-accent-primary);
  font-weight: 700;
}
.agent-chip.active.is-default .agent-chip-name {
  color: #b45309;
}
.agent-chip-icon {
  flex-shrink: 0;
  width: 26px;
  height: 26px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.25) 0%, rgba(118, 75, 162, 0.18) 100%);
  color: var(--color-accent-primary);
  transition: box-shadow 0.25s ease, transform 0.2s ease;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.2);
}
.agent-chip:hover .agent-chip-icon {
  box-shadow: 0 0 0 1px rgba(102, 126, 234, 0.3), 0 4px 12px rgba(102, 126, 234, 0.25);
}
.agent-chip-icon.default {
  background: linear-gradient(135deg, rgba(251, 191, 36, 0.35) 0%, rgba(245, 158, 11, 0.25) 100%);
  color: #d97706;
  box-shadow: 0 2px 8px rgba(251, 191, 36, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.25);
}
.agent-chip.active .agent-chip-icon {
  box-shadow: 0 0 0 2px rgba(102, 126, 234, 0.4), 0 4px 16px rgba(102, 126, 234, 0.3);
}
.agent-chip.active .agent-chip-icon.default {
  color: #b45309;
  box-shadow: 0 0 0 2px rgba(251, 191, 36, 0.5), 0 4px 16px rgba(251, 191, 36, 0.28);
}
.agent-icon-svg {
  width: 14px;
  height: 14px;
}
.agent-chip-name {
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 120px;
  transition: color 0.2s ease;
}
.agent-chip-badge {
  font-size: 9px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--color-text-secondary);
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.06);
  flex-shrink: 0;
}
.agent-chip.active .agent-chip-badge {
  background: rgba(102, 126, 234, 0.2);
  color: var(--color-accent-primary);
}
.agent-chip.active.is-default .agent-chip-badge {
  background: rgba(251, 191, 36, 0.25);
  color: #b45309;
}
.agent-chip-check {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--color-accent-primary) 0%, var(--color-accent-secondary) 100%);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: 2px;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.4);
}
.agent-chip-check svg {
  width: 10px;
  height: 10px;
}

/* 输入框上方居中浮动按钮：展开/收起智能体选择区 */
.agent-bar-float-btn {
  position: absolute;
  left: 50%;
  bottom: 8.5rem;
  transform: translateX(-50%);
  z-index: 10;
  width: 44px;
  height: 44px;
  border-radius: 50%;
  border: 1px solid rgba(102, 126, 234, 0.25);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.9) 0%, rgba(255, 255, 255, 0.6) 100%);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  color: var(--color-accent-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 20px rgba(102, 126, 234, 0.2), 0 1px 0 rgba(255, 255, 255, 0.5) inset;
  transition: transform 0.2s ease, box-shadow 0.2s ease, background 0.2s ease, color 0.2s ease;
}
.agent-bar-float-btn:hover {
  background: linear-gradient(145deg, rgba(102, 126, 234, 0.15) 0%, rgba(118, 75, 162, 0.1) 100%);
  box-shadow: 0 6px 24px rgba(102, 126, 234, 0.3), 0 1px 0 rgba(255, 255, 255, 0.4) inset;
  transform: translateX(-50%) scale(1.06);
}
.agent-bar-float-btn:active {
  transform: translateX(-50%) scale(0.98);
}
.agent-bar-float-btn.collapsed {
  color: var(--color-text-secondary);
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.7) 0%, rgba(255, 255, 255, 0.45) 100%);
}
.agent-bar-float-btn.collapsed:hover {
  color: var(--color-accent-primary);
  background: linear-gradient(145deg, rgba(102, 126, 234, 0.12) 0%, rgba(118, 75, 162, 0.08) 100%);
}
.float-btn-icon {
  width: 22px;
  height: 22px;
}
.agent-chip.active.is-default .agent-chip-check {
  background: linear-gradient(135deg, #f59e0b 0%, #d97706 100%);
  box-shadow: 0 2px 8px rgba(251, 191, 36, 0.45);
}
.agent-list-empty {
  margin: 0;
  padding: 8px 0;
  font-size: var(--font-size-sm);
  color: var(--color-text-tertiary);
}

/* 暗色主题下 agent 栏与芯片适配 */
html[data-theme="dark"] .agent-bar-wrap,
html:not([data-theme]) .agent-bar-wrap {
  background: linear-gradient(145deg, rgba(102, 126, 234, 0.12) 0%, var(--color-bg-tertiary) 50%, rgba(118, 75, 162, 0.08) 100%);
  border-color: rgba(102, 126, 234, 0.2);
  box-shadow: 0 4px 24px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
html[data-theme="dark"] .agent-chip,
html:not([data-theme]) .agent-chip {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.03) 100%);
  border-color: rgba(102, 126, 234, 0.2);
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.2), 0 1px 0 rgba(255, 255, 255, 0.06) inset;
}
html[data-theme="dark"] .agent-chip:hover,
html:not([data-theme]) .agent-chip:hover {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.1) 0%, rgba(102, 126, 234, 0.1) 100%);
}
html[data-theme="dark"] .agent-scroll-trigger.visible,
html:not([data-theme]) .agent-scroll-trigger.visible {
  background: var(--color-bg-secondary);
  border-color: rgba(102, 126, 234, 0.25);
}
html[data-theme="dark"] .agent-scroll-trigger.visible:hover,
html:not([data-theme]) .agent-scroll-trigger.visible:hover {
  background: linear-gradient(135deg, rgba(102, 126, 234, 0.25) 0%, rgba(118, 75, 162, 0.18) 100%);
  box-shadow: 0 4px 16px rgba(102, 126, 234, 0.35);
}
html[data-theme="dark"] .agent-bar-float-btn,
html:not([data-theme]) .agent-bar-float-btn {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.1) 0%, rgba(255, 255, 255, 0.05) 100%);
  border-color: rgba(102, 126, 234, 0.3);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25), 0 1px 0 rgba(255, 255, 255, 0.08) inset;
}
html[data-theme="dark"] .agent-bar-float-btn.collapsed,
html:not([data-theme]) .agent-bar-float-btn.collapsed {
  background: linear-gradient(145deg, rgba(255, 255, 255, 0.08) 0%, rgba(255, 255, 255, 0.03) 100%);
}

.input-container {
  display: flex;
  position: relative;
  width: 100%;
}

.message-input {
  width: 100%;
  min-height: 120px;
  padding: var(--spacing-md);
  padding-right: 50px;
  font-size: var(--font-size-base);
  font-family: var(--font-family-base);
  color: var(--color-text-primary);
  -webkit-text-fill-color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
  border: 1px solid var(--glass-border);
  border-radius: var(--radius-md);
  resize: none;
  outline: none;
  transition: all var(--transition-fast);
}
/* 确保输入框内文字在各主题下均清晰可见（主题在 html 上） */
html[data-theme="dark"] .message-input,
html:not([data-theme]) .message-input {
  color: #e2e8f0;
  -webkit-text-fill-color: #e2e8f0;
}
html[data-theme="light"] .message-input,
html[data-theme="cosmic"] .message-input {
  color: #1e293b;
  -webkit-text-fill-color: #1e293b;
}
html[data-theme="neon"] .message-input {
  color: #e0f2fe;
  -webkit-text-fill-color: #e0f2fe;
}
.message-input::placeholder {
  color: var(--color-text-tertiary);
  opacity: 0.9;
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
