import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { agentManager } from '../../core/agent/agent-manager.js';
import { DatabaseService } from '../database/database.service.js';

export type SessionType = 'scheduled' | 'chat' | 'system';

export interface AgentSession {
    id: string;
    createdAt: number;
    lastActiveAt: number;
    messageCount: number;
    status: 'idle' | 'active' | 'error';
    /** 绑定的智能体 ID，不选则为 default（主智能体） */
    agentId?: string;
    workspace?: string;
    provider?: string;
    model?: string;
    title?: string;
    preview?: string;
    type?: SessionType;
}

export interface ChatMessage {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    content: string;
    timestamp: number;
    toolCalls?: any[];
}

interface SessionRow {
    id: string;
    created_at: number;
    last_active_at: number;
    message_count: number;
    status: string;
    agent_id: string | null;
    workspace: string | null;
    provider: string | null;
    model: string | null;
    title: string | null;
    preview: string | null;
    type?: string | null;
}

interface MessageRow {
    id: string;
    session_id: string;
    role: string;
    content: string;
    timestamp: number;
    tool_calls_json: string | null;
}

/**
 * Agents service: session + history storage in SQLite.
 * Conversation is done via frontend -> Gateway (WebSocket) -> agent; NestJS is not in the chat path.
 */
@Injectable()
export class AgentsService {
    private eventListeners = new Map<string, Set<(data: any) => void>>();

    constructor(private readonly db: DatabaseService) {}

    addEventListener(event: string, listener: (data: any) => void): () => void {
        if (!this.eventListeners.has(event)) {
            this.eventListeners.set(event, new Set());
        }
        this.eventListeners.get(event)!.add(listener);
        return () => {
            const listeners = this.eventListeners.get(event);
            if (listeners) listeners.delete(listener);
        };
    }

    private emitEvent(event: string, payload: any) {
        const listeners = this.eventListeners.get(event);
        if (listeners) listeners.forEach((l) => l(payload));
    }

    private rowToSession(r: SessionRow): AgentSession {
        return {
            id: r.id,
            createdAt: r.created_at,
            lastActiveAt: r.last_active_at,
            messageCount: r.message_count,
            status: r.status as AgentSession['status'],
            agentId: r.agent_id ?? undefined,
            workspace: r.workspace ?? undefined,
            provider: r.provider ?? undefined,
            model: r.model ?? undefined,
            title: r.title ?? undefined,
            preview: r.preview ?? undefined,
            type: (r.type === 'scheduled' || r.type === 'chat' || r.type === 'system' ? r.type : 'chat') as SessionType,
        };
    }

    private rowToMessage(r: MessageRow): ChatMessage {
        const msg: ChatMessage = {
            id: r.id,
            sessionId: r.session_id,
            role: r.role as ChatMessage['role'],
            content: r.content,
            timestamp: r.timestamp,
        };
        if (r.tool_calls_json) {
            try {
                msg.toolCalls = JSON.parse(r.tool_calls_json);
            } catch (_) {}
        }
        return msg;
    }

    async createSession(options?: {
        id?: string;
        agentId?: string;
        workspace?: string;
        provider?: string;
        model?: string;
        title?: string;
        type?: SessionType;
    }): Promise<AgentSession> {
        const sessionId = options?.id ?? randomUUID();
        const sessionType = options?.type ?? 'chat';
        const existing = this.getSession(sessionId);
        if (existing) return existing;

        const now = Date.now();
        const agentId = options?.agentId ?? 'default';
        const workspace = options?.workspace ?? 'default';
        const session: AgentSession = {
            id: sessionId,
            createdAt: now,
            lastActiveAt: now,
            messageCount: 0,
            status: 'idle',
            agentId,
            workspace,
            provider: options?.provider,
            model: options?.model,
            title: options?.title ?? undefined,
            preview: '',
            type: sessionType,
        };
        this.db.run(
            `INSERT INTO sessions (id, created_at, last_active_at, message_count, status, agent_id, workspace, provider, model, title, preview, type)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                session.id,
                session.createdAt,
                session.lastActiveAt,
                session.messageCount,
                session.status,
                agentId,
                workspace,
                session.provider ?? null,
                session.model ?? null,
                session.title ?? null,
                session.preview ?? null,
                sessionType,
            ],
        );
        return session;
    }

    /** 获取或创建会话（指定 id 时复用同一会话，用于定时任务固定 sessionId） */
    async getOrCreateSession(
        sessionId: string,
        options?: { agentId?: string; workspace?: string; title?: string; type?: SessionType },
    ): Promise<AgentSession> {
        const existing = this.getSession(sessionId);
        if (existing) {
            const now = Date.now();
            const title = options?.title ?? existing.title;
            this.db.run(
                'UPDATE sessions SET last_active_at = ?, title = ? WHERE id = ?',
                [now, title ?? null, sessionId],
            );
            return { ...existing, lastActiveAt: now, title };
        }
        return this.createSession({
            id: sessionId,
            agentId: options?.agentId ?? 'default',
            workspace: options?.workspace ?? 'default',
            title: options?.title,
            type: options?.type ?? 'chat',
        });
    }

    getSessions(): AgentSession[] {
        const rows = this.db.all<SessionRow>('SELECT * FROM sessions ORDER BY last_active_at DESC');
        return rows.map((r) => this.rowToSession(r));
    }

    getSession(sessionId: string): AgentSession | undefined {
        const r = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', [sessionId]);
        return r ? this.rowToSession(r) : undefined;
    }

    /** 更新会话的当前 agent（同一 session 内切换 agent 时调用） */
    updateSessionAgentId(sessionId: string, agentId: string): void {
        const session = this.getSession(sessionId);
        if (!session) return;
        this.db.run('UPDATE sessions SET agent_id = ? WHERE id = ?', [agentId, sessionId]);
    }

    async deleteSession(sessionId: string): Promise<void> {
        const result = this.db.run('DELETE FROM sessions WHERE id = ?', [sessionId]);
        if (result.changes > 0) {
            this.db.persist();
        }
        agentManager.deleteSessionsByBusinessId(sessionId);
    }

    getMessageHistory(sessionId: string): ChatMessage[] {
        const rows = this.db.all<MessageRow>(
            'SELECT * FROM chat_messages WHERE session_id = ? ORDER BY timestamp ASC',
            [sessionId],
        );
        return rows.map((r) => this.rowToMessage(r));
    }

    addAssistantMessage(sessionId: string, content: string): void {
        const id = randomUUID();
        const now = Date.now();
        this.db.run(
            `INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls_json) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, sessionId, 'assistant', content, now, null],
        );
        this.db.run(
            'UPDATE sessions SET last_active_at = ?, status = ?, message_count = message_count + 1 WHERE id = ?',
            [now, 'idle', sessionId],
        );
    }

    appendMessage(
        sessionId: string,
        role: 'user' | 'assistant',
        content: string,
        options?: { toolCalls?: any[]; contentParts?: any[] },
    ): void {
        const session = this.getSession(sessionId);
        if (!session) return;

        const id = randomUUID();
        const now = Date.now();
        const toolCallsJson = role === 'assistant' && options?.toolCalls ? JSON.stringify(options.toolCalls) : null;
        this.db.run(
            `INSERT INTO chat_messages (id, session_id, role, content, timestamp, tool_calls_json) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, sessionId, role, content, now, toolCallsJson],
        );
        this.db.run(
            'UPDATE sessions SET last_active_at = ?, status = ?, message_count = message_count + 1 WHERE id = ?',
            [now, role === 'assistant' ? 'idle' : session.status, sessionId],
        );
    }

    /** 清除会话的所有对话消息（保留会话本身，message_count 置 0） */
    clearSessionMessages(sessionId: string): void {
        const session = this.getSession(sessionId);
        if (!session) return;
        this.db.run('DELETE FROM chat_messages WHERE session_id = ?', [sessionId]);
        this.db.run('UPDATE sessions SET message_count = 0 WHERE id = ?', [sessionId]);
        this.db.persist();
    }
}

