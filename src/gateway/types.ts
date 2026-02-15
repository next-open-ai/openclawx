import type { WebSocket } from "ws";

/** 会话类型：chat 普通对话，scheduled 定时任务，system 系统/临时 */
export type SessionType = "chat" | "scheduled" | "system";

/**
 * Gateway client connection
 */
export interface GatewayClient {
    id: string;
    ws: WebSocket;
    authenticated: boolean;
    sessionId?: string;
    /** 建连时客户端传入的 session 绑定 agentId，用于取配置，不再请求 Nest */
    agentId?: string;
    /** 建连时客户端传入的 session 类型 */
    sessionType?: SessionType;
    connectedAt: number;
}

/**
 * Gateway message types
 */
export type GatewayMessageType = "request" | "response" | "event";

/**
 * Base gateway message
 */
export interface GatewayMessage {
    type: GatewayMessageType;
    id?: string;
    method?: string;
    params?: any;
    result?: any;
    error?: { message: string; code?: string };
    event?: string;
    payload?: any;
}

/**
 * Request message
 */
export interface GatewayRequest extends GatewayMessage {
    type: "request";
    id: string;
    method: string;
    params?: any;
}

/**
 * Response message
 */
export interface GatewayResponse extends GatewayMessage {
    type: "response";
    id: string;
    result?: any;
    error?: { message: string; code?: string };
}

/**
 * Event message
 */
export interface GatewayEvent extends GatewayMessage {
    type: "event";
    event: string;
    payload?: any;
}

/**
 * Connect params
 */
export interface ConnectParams {
    sessionId?: string;
    /** 当前 session 绑定的 agentId，Gateway 用其本地取配置，不请求 Nest */
    agentId?: string;
    /** 当前 session 类型：chat | scheduled | system */
    sessionType?: SessionType;
    nonce?: string;
}

/**
 * Agent chat params
 */
export interface AgentChatParams {
    message: string;
    sessionId?: string;
    /** 当前 session 绑定的 agentId，不传则用 connect 时存的 client.agentId，再缺省 default */
    agentId?: string;
    /** 当前 session 类型，不传则用 connect 时存的 client.sessionType，再缺省 chat */
    sessionType?: SessionType;
    /** 对话/安装目标：具体 agentId，或 "global"|"all" 表示全局；用于 install_skill 等隔离 */
    targetAgentId?: string;
}
