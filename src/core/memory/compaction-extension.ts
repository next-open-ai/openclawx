import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { addMemory } from "./index.js";

/**
 * 创建用于在 session_compact 事件时把 compaction summary 写入向量库的 extension factory。
 * 在 AgentSession 发生 compaction（自动或手动）后触发，无需等到关闭会话。
 */
export function createCompactionMemoryExtensionFactory(sessionId: string): ExtensionFactory {
    return (pi) => {
        pi.on("session_compact", async (event) => {
            const summary = event.compactionEntry?.summary?.trim();
            if (!summary) return;
            try {
                await addMemory(summary, {
                    infotype: "compaction",
                    sessionId,
                });
            } catch (_) {
                // 写入失败不打断会话
            }
        });
    };
}
