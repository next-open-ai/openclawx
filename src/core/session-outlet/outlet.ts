/**
 * 会话消息出口实现：按 sessionId 维护消费者集合，emit 时扇出到该会话所有消费者。
 */

import type { SessionMessage, SessionMessageConsumer } from "./types.js";

export class SessionOutlet {
    private readonly consumersBySession = new Map<string, Set<SessionMessageConsumer>>();

    /**
     * 向指定会话注册消费者；返回取消注册函数。
     */
    registerConsumer(sessionId: string, consumer: SessionMessageConsumer): () => void {
        let set = this.consumersBySession.get(sessionId);
        if (!set) {
            set = new Set();
            this.consumersBySession.set(sessionId, set);
        }
        set.add(consumer);
        return () => {
            const s = this.consumersBySession.get(sessionId);
            if (s) {
                s.delete(consumer);
                if (s.size === 0) this.consumersBySession.delete(sessionId);
            }
        };
    }

    /**
     * 向指定会话发送消息；将 sessionId、timestamp 注入后扇出到该会话所有消费者。
     */
    emit(sessionId: string, message: Omit<SessionMessage, "sessionId" | "timestamp">): void {
        const full: SessionMessage = {
            ...message,
            sessionId,
            timestamp: Date.now(),
        };
        const set = this.consumersBySession.get(sessionId);
        if (!set || set.size === 0) return;
        for (const consumer of set) {
            try {
                const result = consumer.send(full);
                if (result && typeof (result as Promise<unknown>).catch === "function") {
                    (result as Promise<void>).catch((err) =>
                        console.warn("[SessionOutlet] consumer.send rejected:", err)
                    );
                }
            } catch (err) {
                console.warn("[SessionOutlet] consumer.send threw:", err);
            }
        }
    }
}
