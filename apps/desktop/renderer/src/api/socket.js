/**
 * WebSocket service: full-duplex connection to Gateway.
 * All agent conversation (send message + receive stream) goes through this single connection.
 */

/** UUID v4: use crypto.randomUUID when available, else fallback for older browsers / non-HTTPS */
function randomRequestId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class SocketService {
    constructor() {
        this.socket = null;
        this.listeners = new Map();
        this.currentSessionId = null;
        this.currentAgentId = null;
        this.currentSessionType = null;
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 5;
        this.pendingRequests = new Map(); // Map<id, {resolve, reject}>
    }

    /**
     * Send request and wait for response (used for connect, subscribe_session, agent.chat).
     */
    call(method, params, timeoutMs = 10000) {
        return new Promise((resolve, reject) => {
            if (this.socket?.readyState !== WebSocket.OPEN) {
                reject(new Error('WebSocket not connected'));
                return;
            }

            const id = randomRequestId();
            const request = {
                type: 'request',
                id,
                method,
                params,
            };

            this.pendingRequests.set(id, { resolve, reject });

            try {
                this.socket.send(JSON.stringify(request));

                const timer = setTimeout(() => {
                    if (this.pendingRequests.has(id)) {
                        this.pendingRequests.delete(id);
                        reject(new Error('Request timeout'));
                    }
                }, timeoutMs);
                this.pendingRequests.get(id).timer = timer;
            } catch (err) {
                this.pendingRequests.delete(id);
                reject(err);
            }
        });
    }

    handleMessage(message) {
        // Response to a previous request
        if (message.type === 'response' && message.id) {
            const pending = this.pendingRequests.get(message.id);
            if (pending) {
                this.pendingRequests.delete(message.id);
                if (pending.timer) clearTimeout(pending.timer);
                if (message.error) {
                    pending.reject(new Error(message.error.message || 'Request failed'));
                } else {
                    pending.resolve(message.result);
                }
            }
            return;
        }

        // Event from Gateway：turn_end / agent_end 均可收到，前端按交互需求处理；message_complete / conversation_end 保留兼容。
        if (message.type === 'event') {
            const { event, payload } = message;
            const eventMap = {
                'agent.chunk': 'agent_chunk',
                'agent.tool': 'agent_tool',
                'message_complete': 'message_complete',
                'conversation_end': 'conversation_end',
                'turn_end': 'turn_end',
                'agent_end': 'agent_end',
            };
            const mappedEvent = eventMap[event] || event;
            this.emit(mappedEvent, payload);
        }
    }

    /**
     * Connect to Gateway and authenticate with sessionId, agentId, sessionType.
     * Gateway 用 agentId/sessionType 本地取配置，不再请求 Nest。
     */
    async connectToSession(sessionId, agentId, sessionType) {
        this.currentSessionId = sessionId;
        this.currentAgentId = agentId !== undefined ? agentId : (this.currentAgentId ?? 'default');
        this.currentSessionType = sessionType !== undefined ? sessionType : (this.currentSessionType ?? 'chat');
        await this.whenReady();
        if (this.socket?.readyState !== WebSocket.OPEN) {
            throw new Error('WebSocket not connected');
        }
        await this.call('connect', {
            sessionId,
            agentId: this.currentAgentId,
            sessionType: this.currentSessionType,
        });
        await this.call('subscribe_session', { sessionId });
    }

    /**
     * Send user message to agent via Gateway (full-duplex: no NestJS in path).
     * @param {string} sessionId
     * @param {string} message
     * @param {string} [targetAgentId] - 对话/安装目标：具体 agentId，或 "global"|"all" 表示全局
     * @param {string} [agentId] - 当前 session 绑定的 agentId，不传则用 connect 时存的
     * @param {string} [sessionType] - 当前 session 类型 chat|scheduled|system
     */
    async sendMessage(sessionId, message, targetAgentId, agentId, sessionType) {
        const params = {
            sessionId,
            message,
            agentId: agentId ?? this.currentAgentId,
            sessionType: sessionType ?? this.currentSessionType,
        };
        if (targetAgentId !== undefined && targetAgentId !== null) {
            params.targetAgentId = targetAgentId;
        }
        return this.call('agent.chat', params, 120000);
    }

    /**
     * Abort the current agent turn for the given session.
     */
    async cancelAgent(sessionId) {
        return this.call('agent.cancel', { sessionId }, 10000);
    }

    async unsubscribeFromSession() {
        if (this.socket?.readyState === WebSocket.OPEN) {
            await this.call('unsubscribe_session');
        }
        this.currentSessionId = null;
        this.currentAgentId = null;
        this.currentSessionType = null;
    }

    /**
     * Resolve when WebSocket is open (for use before connectToSession / sendMessage).
     */
    whenReady() {
        if (this.socket?.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            const check = () => {
                if (this.socket?.readyState === WebSocket.OPEN) {
                    resolve();
                    return;
                }
                if (this.socket?.readyState === WebSocket.CLOSED || this.socket?.readyState === WebSocket.CLOSING) {
                    resolve(); // will reject in call() anyway
                    return;
                }
                setTimeout(check, 50);
            };
            check();
        });
    }

    connect() {
        if (this.socket?.readyState === WebSocket.OPEN) return;

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let host = window.location.host;
        if (window.location.port === '5173' && (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')) {
            host = window.location.hostname + ':38080';
        }
        const base = `${protocol}//${host}`;
        const url = base.replace(/\/$/, '') + '/ws';
        console.log('Connecting to Gateway WebSocket:', url);

        try {
            this.socket = new WebSocket(url);

            this.socket.onopen = () => {
                console.log('✅ Connected to Gateway');
                this.reconnectAttempts = 0;
                if (this.currentSessionId) {
                    this.connectToSession(this.currentSessionId).catch((e) =>
                        console.warn('Re-subscribe after reconnect failed', e)
                    );
                }
            };

            this.socket.onclose = () => {
                console.log('❌ Disconnected from Gateway');
                this.scheduleReconnect();
            };

            this.socket.onerror = (err) => {
                console.error('WebSocket error:', err);
            };

            this.socket.onmessage = (event) => {
                try {
                    const message = JSON.parse(event.data);
                    this.handleMessage(message);
                } catch (error) {
                    console.error('Failed to parse WebSocket message:', error);
                }
            };
        } catch (error) {
            console.error('Failed to create WebSocket:', error);
            this.scheduleReconnect();
        }
    }

    scheduleReconnect() {
        if (this.reconnectAttempts < this.maxReconnectAttempts) {
            this.reconnectAttempts++;
            setTimeout(() => this.connect(), 1000 * this.reconnectAttempts);
        }
    }

    disconnect() {
        if (this.socket) {
            this.socket.close();
        this.socket = null;
        this.currentSessionId = null;
        this.currentAgentId = null;
        this.currentSessionType = null;
    }
        this.pendingRequests.forEach((p) => {
            if (p.timer) clearTimeout(p.timer);
            p.reject(new Error('Disconnected'));
        });
        this.pendingRequests.clear();
    }

    on(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, new Set());
        }
        this.listeners.get(event).add(callback);
        return () => {
            const callbacks = this.listeners.get(event);
            if (callbacks) callbacks.delete(callback);
        };
    }

    emit(event, data) {
        const callbacks = this.listeners.get(event);
        if (callbacks) callbacks.forEach((cb) => cb(data));
    }
}

export default new SocketService();
