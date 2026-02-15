import { randomUUID } from "node:crypto";
import { embed } from "./embedding.js";
import { addToStore, queryStore } from "./vector-store.js";
import type { InfoType, MemoryMetadata, MemorySearchResult } from "./types.js";
export { buildSessionSummaryFromEntries } from "./build-summary.js";
export type { InfoType, MemoryMetadata, MemorySearchResult } from "./types.js";

let initialized = false;

export async function initMemory(): Promise<void> {
    if (initialized) return;
    const { getChroma } = await import("./vector-store.js");
    await getChroma();
    initialized = true;
}

/**
 * 将一条文本写入向量库。未配置 RAG embedding 时跳过写入并返回占位 id（长记忆空转）。
 * @param text 内容
 * @param metadata.infotype 经验总结(experience) 或 compaction 摘要(compaction)
 * @param metadata.sessionId 会话 id
 */
export async function addMemory(
    text: string,
    metadata: { infotype: InfoType; sessionId: string },
): Promise<string> {
    const id = randomUUID();
    const vec = await embed(text);
    if (vec === null) return id;
    const meta: MemoryMetadata = {
        ...metadata,
        createdAt: new Date().toISOString(),
    };
    await addToStore(id, vec, text, meta);
    return id;
}

export interface SearchMemoryOptions {
    topK?: number;
    infotype?: import("./types.js").InfoType;
    sessionId?: string;
}

/**
 * 按语义搜索记忆，可按 infotype、sessionId 过滤。未配置 RAG embedding 时返回空数组（空转）。
 */
export async function searchMemory(
    query: string,
    topK: number = 10,
    options?: SearchMemoryOptions,
): Promise<MemorySearchResult[]> {
    const vec = await embed(query);
    if (vec === null) return [];
    const opts = typeof options === "object" && options != null ? options : {};
    const k = opts.topK ?? topK;
    const filter =
        opts.infotype != null || opts.sessionId != null
            ? { infotype: opts.infotype, sessionId: opts.sessionId }
            : undefined;
    const rows = await queryStore(vec, k, filter);
    return rows.map((r) => ({
        document: r.document,
        metadata: r.metadata,
        distance: r.distance,
    }));
}

/** 拉取 3 条经验，格式化为「经验内容」文本（用于拼入用户消息） */
export async function getExperienceContextForUserMessage(): Promise<string> {
    const results = await searchMemory("经验 总结 技巧 方法", 3, { infotype: "experience" });
    if (results.length === 0) return "";
    const lines = results.map((r, i) => `${i + 1}. ${(r.document || "").trim()}`).filter(Boolean);
    if (lines.length === 0) return "";
    return "以下为相关经验：\n\n" + lines.join("\n\n");
}

/**
 * 拉取 1 条 compaction 摘要，用于拼入 system prompt（新建 AgentSession 时调用，可选 sessionId）
 */
export async function getCompactionContextForSystemPrompt(sessionId?: string): Promise<string> {
    const filter =
        sessionId != null ? { infotype: "compaction" as const, sessionId } : { infotype: "compaction" as const };
    const results = await searchMemory("对话 摘要 历史 上下文", 1, { ...filter, topK: 1 });
    const doc = results[0]?.document?.trim();
    if (!doc) return "";
    return "## 历史对话摘要\n\n" + doc;
}
