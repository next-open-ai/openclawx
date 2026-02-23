import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";

/**
 * 创建用于在 session_compact 事件时更新「当前 session 最新 compaction」的 extension factory。
 * 发生 compaction 时只回调 onUpdateLatestCompaction(summary)，由调用方保存；
 * 向量库写入推迟到 SessionAgent 关闭时由 AgentManager 统一执行。
 */
export function createCompactionMemoryExtensionFactory(
    _sessionId: string,
    onUpdateLatestCompaction: (summary: string) => void,
): ExtensionFactory {
    return (pi) => {
        pi.on("session_compact", (event) => {
            const summary = event.compactionEntry?.summary?.trim();
            if (!summary) return;
            onUpdateLatestCompaction(summary);
        });
    };
}
