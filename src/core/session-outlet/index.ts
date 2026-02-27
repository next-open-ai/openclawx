/**
 * 会话消息统一出口：各模块仅需 sessionId + 消息即可通过统一出口准确送达当前会话对应的 Web/Desktop 或通道。
 */

import type { SessionMessage, SessionMessageInput, ISessionOutlet } from "./types.js";
import { SessionOutlet } from "./outlet.js";

export type { SessionMessage, SessionMessageInput, SessionMessageConsumer, ISessionOutlet } from "./types.js";
export { SessionOutlet } from "./outlet.js";

let defaultOutlet: ISessionOutlet | null = null;

/**
 * 获取当前使用的出口实例（Gateway 启动时通过 setSessionOutlet 注入）。
 */
export function getSessionOutlet(): ISessionOutlet | null {
    return defaultOutlet;
}

/**
 * 设置全局出口实例；传 null 可清空（测试用）。
 */
export function setSessionOutlet(outlet: ISessionOutlet | null): void {
    defaultOutlet = outlet;
}

/**
 * 解耦 API：任意模块携带 sessionId 即可发送会话消息，由统一出口路由到正确端。
 * 若未设置出口或 sessionId 为空，则静默忽略。
 */
export function sendSessionMessage(sessionId: string, message: Omit<SessionMessageInput, "sessionId">): void {
    if (!sessionId || !message) return;
    const outlet = getSessionOutlet();
    if (!outlet) return;
    outlet.emit(sessionId, {
        type: message.type,
        code: message.code,
        payload: message.payload ?? {},
    });
}
