import { defineStore } from 'pinia';
import { agentAPI, usageAPI } from '@/api';
import socketService from '@/api/socket';

export const useAgentStore = defineStore('agent', {
    state: () => ({
        sessions: [],
        currentSession: null,
        messages: [],
        currentMessage: '',
        currentStreamParts: [], // Array of {type: 'text'|'tool', content?: string, toolId?: string}
        isStreaming: false,
        toolExecutions: [],
        totalTokens: 0,
        /** 为 true 时根路径 / 不自动跳转最近会话（新建对话/切换智能体后清除 stay query 时用，跨组件实例生效） */
        skipRedirectToRecentOnce: false,
    }),

    getters: {
        activeSessions: (state) => state.sessions.filter(s => s.status !== 'error'),
        sessionById: (state) => (id) => state.sessions.find(s => s.id === id),
    },

    actions: {
        async fetchSessions() {
            try {
                const response = await agentAPI.getSessions();
                const list = response?.data?.data ?? response?.data;
                this.sessions = Array.isArray(list) ? list : [];
            } catch (error) {
                console.error('Failed to fetch sessions:', error);
                this.sessions = [];
            }
        },

        /**
         * 创建会话。options.agentId 决定会话归属的智能体；Gateway 会通过 sessionId 查 session 得到 agentId，再按该智能体的 provider/model 创建 Agent Session。
         */
        async createSession(options = {}) {
            try {
                const payload = { agentId: 'default', workspace: 'default', ...options };
                const response = await agentAPI.createSession(payload);
                const session = response.data.data;
                if (!this.sessions.find((s) => s.id === session.id)) {
                    this.sessions.push(session);
                }
                return session;
            } catch (error) {
                console.error('Failed to create session:', error);
                throw error;
            }
        },

        async deleteSession(sessionId) {
            try {
                await agentAPI.deleteSession(sessionId);
            } catch (error) {
                if (error?.response?.status === 404) {
                    // 后端未找到该 session（已删或未持久化），仍从本地列表移除以保持界面一致
                } else {
                    console.error('Failed to delete session:', error);
                    throw error;
                }
            }
            this.sessions = this.sessions.filter(s => s.id !== sessionId);
            if (this.currentSession?.id === sessionId) {
                this.currentSession = null;
                this.messages = [];
            }
        },

        async selectSession(sessionId) {
            const fallback = this.sessions.find(s => s.id === sessionId);
            try {
                const response = await agentAPI.getSession(sessionId);
                const session = response?.data?.data ?? response?.data;
                if (session) {
                    this.currentSession = session;
                } else if (fallback) {
                    this.currentSession = fallback;
                } else {
                    throw new Error('Session not found');
                }

                const historyResponse = await agentAPI.getHistory(sessionId);
                const list = historyResponse?.data?.data ?? historyResponse?.data;
                this.messages = Array.isArray(list) ? list : [];

                await socketService.connectToSession(sessionId, session.agentId, session.type);
            } catch (error) {
                console.error('Failed to select session:', error);
                if (fallback) {
                    this.currentSession = fallback;
                    this.messages = [];
                    await socketService.connectToSession(sessionId, fallback.agentId, fallback.type);
                } else {
                    throw error;
                }
            }
        },

        clearCurrentSession() {
            this.currentSession = null;
            this.messages = [];
        },

        async cancelCurrentTurn() {
            if (!this.currentSession?.id || !this.isStreaming) return;
            try {
                await socketService.cancelAgent(this.currentSession.id);
            } catch (error) {
                console.error('Failed to cancel agent turn:', error);
            }
        },

        /**
         * @param {string} message
         * @param {{ targetAgentId?: string, agentId?: string }} [options] - agentId: 新建会话时使用的智能体（无 currentSession 时）；targetAgentId: 发消息目标
         */
        async sendMessage(message, options = {}) {
            if (!message.trim()) return;

            // Lazy Session Creation: If no current session, create one now（使用传入的 agentId 或 default）
            if (!this.currentSession) {
                try {
                    const title = message.trim().substring(0, 50);
                    const agentId = options?.agentId ?? 'default';
                    const session = await this.createSession({ agentId, title });
                    this.currentSession = session;
                    await socketService.connectToSession(session.id, session.agentId, session.type);
                } catch (error) {
                    console.error('Failed to create lazy session:', error);
                    return;
                }
            }

            try {
                if (this.currentSession && socketService.currentSessionId !== this.currentSession.id) {
                    await socketService.connectToSession(
                        this.currentSession.id,
                        this.currentSession.agentId,
                        this.currentSession.type,
                    );
                }

                const userMessage = {
                    id: Date.now().toString(),
                    role: 'user',
                    content: message,
                    timestamp: Date.now(),
                };
                this.messages.push(userMessage);

                this.currentMessage = '';
                this.currentStreamParts = [];
                this.isStreaming = true;
                this.toolExecutions = [];

                // Persist user message to NestJS (for history)
                agentAPI.appendMessage(this.currentSession.id, 'user', message).catch(() => {});

                const targetAgentId = options?.targetAgentId ?? this.currentSession?.agentId ?? 'default';
                await socketService.sendMessage(
                    this.currentSession.id,
                    message,
                    targetAgentId,
                    this.currentSession.agentId,
                    this.currentSession.type,
                );
            } catch (error) {
                console.error('Failed to send message:', error);
                this.isStreaming = false;
            }

            return this.currentSession; // Return session so component can update route
        },

        handleAgentChunk(data) {
            // Safety: Ensure we have a session selected
            if (!this.currentSession) return;

            // Auto-start streaming if not active (handles multi-turn agent responses)
            if (!this.isStreaming) {
                this.isStreaming = true;
                this.currentMessage = '';
                this.currentStreamParts = [];
                this.toolExecutions = [];
            }

            const text = data.text || '';
            if (!text) return;
            this.currentMessage += text;

            const parts = this.currentStreamParts;
            const lastPart = parts[parts.length - 1];
            if (lastPart && lastPart.type === 'text') {
                this.currentStreamParts = [
                    ...parts.slice(0, -1),
                    { type: 'text', content: (lastPart.content || '') + text }
                ];
            } else {
                this.currentStreamParts = [...parts, { type: 'text', content: text }];
            }
        },

        handleToolExecution(data) {
            if (data.type === 'start') {
                // Auto-start streaming if not active
                if (!this.isStreaming) {
                    this.isStreaming = true;
                    this.currentMessage = '';
                    this.currentStreamParts = [];
                    // For tools, clear previous executions if we are starting fresh
                    this.toolExecutions = [];
                }

                // 同一 toolCallId 只添加一次，避免重复事件导致重复卡片
                if (this.toolExecutions.some(t => t.id === data.toolCallId)) return;
                const newTool = {
                    id: data.toolCallId,
                    name: data.toolName,
                    args: data.args,
                    status: 'running',
                    startTime: Date.now(),
                };
                this.toolExecutions = [...this.toolExecutions, newTool];
                this.currentStreamParts = [
                    ...this.currentStreamParts,
                    { type: 'tool', toolId: data.toolCallId }
                ];
            } else if (data.type === 'end') {
                const tool = this.toolExecutions.find(t => t.id === data.toolCallId);
                if (tool) {
                    tool.status = data.isError ? 'error' : 'completed';
                    tool.result = data.result;
                    tool.endTime = Date.now();
                    // 触发 toolExecutions 的响应式更新
                    this.toolExecutions = [...this.toolExecutions];
                }
            }
        },

        async fetchUsageTotal() {
            try {
                const res = await usageAPI.getTotal();
                if (res?.data?.success && res?.data?.data) {
                    this.totalTokens = res.data.data.totalTokens ?? 0;
                }
            } catch (e) {
                console.warn('Failed to fetch token usage:', e);
            }
        },

        /** turn_end：仅记录本轮 token 用量，不结束会话（多轮 tool+ 文本时会有多次）。 */
        handleMessageComplete(data) {
            if (data?.usage && (data.usage.promptTokens > 0 || data.usage.completionTokens > 0) && data.sessionId) {
                usageAPI
                    .record({
                        sessionId: data.sessionId,
                        source: 'chat',
                        promptTokens: data.usage.promptTokens ?? 0,
                        completionTokens: data.usage.completionTokens ?? 0,
                    })
                    .then(() => this.fetchUsageTotal())
                    .catch((e) => console.warn('Record usage failed:', e));
            }
        },
        /** agent_end：整轮对话真正结束，落库消息并允许再次输入。 */
        handleConversationEnd(data) {
            if (data?.sessionId !== this.currentSession?.id) return;
            const content = this.currentMessage || data.content || '';
            if (content || this.toolExecutions.length > 0) {
                const assistantMessage = {
                    id: Date.now().toString(),
                    role: 'assistant',
                    content,
                    timestamp: Date.now(),
                    toolCalls: [...this.toolExecutions],
                    contentParts: [...this.currentStreamParts],
                };
                this.messages.push(assistantMessage);
                agentAPI.appendMessage(this.currentSession.id, 'assistant', content, {
                    toolCalls: assistantMessage.toolCalls,
                    contentParts: assistantMessage.contentParts,
                }).catch(() => {});
            }
            this.currentMessage = '';
            this.currentStreamParts = [];
            this.isStreaming = false;
            this.toolExecutions = [];
        },
    },
});
