/**
 * 会话关闭时将内存中缓存的 compaction summary 写入向量库的纯逻辑，便于单测且与 AgentManager 解耦。
 */
const COMPOSITE_KEY_SEP = "::";

export type AddMemoryCompaction = (
    text: string,
    meta: { infotype: "compaction"; sessionId: string },
) => Promise<unknown>;

/**
 * 将 map 中指定 compositeKey 的 summary 写入 addMemory 并从 map 删除；用于 Session 关闭前。
 * 写入采用 fire-and-forget，不阻塞调用方，避免 agent.chat 等请求被 addMemory/embed 拖住导致无回复。
 */
export async function persistStoredCompactionForSession(
    sessionLatestCompactionSummary: Map<string, string>,
    compositeKey: string,
    addMemory: AddMemoryCompaction,
): Promise<void> {
    const summary = sessionLatestCompactionSummary.get(compositeKey);
    sessionLatestCompactionSummary.delete(compositeKey);
    if (summary?.trim()) {
        const sessionId = compositeKey.split(COMPOSITE_KEY_SEP)[0];
        void addMemory(summary.trim(), { infotype: "compaction", sessionId }).catch(() => {});
    }
}

/**
 * 将 map 中所有给定 keys（需以 sessionId + "::" 为前缀）的 summary 依次写入 addMemory 并删除；用于按业务 sessionId 关闭时。
 * 写入采用 fire-and-forget，不阻塞调用方。
 */
export async function persistStoredCompactionForBusinessSession(
    sessionLatestCompactionSummary: Map<string, string>,
    keysToProcess: string[],
    sessionId: string,
    addMemory: AddMemoryCompaction,
): Promise<void> {
    const prefix = sessionId + COMPOSITE_KEY_SEP;
    for (const key of keysToProcess) {
        if (!key.startsWith(prefix)) continue;
        const summary = sessionLatestCompactionSummary.get(key);
        sessionLatestCompactionSummary.delete(key);
        if (summary?.trim()) {
            void addMemory(summary.trim(), { infotype: "compaction", sessionId }).catch(() => {});
        }
    }
}
