/**
 * 长记忆 metadata 中的信息类型
 * - experience: 对话结束时 Agent 调用 save_experience 工具存入的经验总结
 * - compaction: 关闭 session 时从 compaction 取出的会话摘要
 */
export type InfoType = "experience" | "compaction";

export interface MemoryMetadata {
    infotype: InfoType;
    sessionId: string;
    createdAt: string; // ISO string
}

export interface MemorySearchResult {
    document: string;
    metadata: MemoryMetadata;
    distance?: number;
}
