/**
 * 远端 embedding：调用 OpenAI 兼容的 /embeddings 接口。
 * 配置来自 ~/.openbot/desktop/config.json 的 rag.embeddingProvider + rag.embeddingModel；
 * 未配置时由调用方（embedding.ts）返回 null，长记忆空转。
 */
import type { RagEmbeddingConfig } from "../config/desktop-config.js";

const EMBEDDINGS_PATH = "/embeddings";

/**
 * 单条文本请求远端 embedding，返回归一化向量；失败抛错。
 */
export async function embedRemote(text: string, config: RagEmbeddingConfig): Promise<number[]> {
    const base = config.baseUrl!.replace(/\/$/, "");
    const url = base + (base.endsWith("/v1") ? EMBEDDINGS_PATH : "/v1" + EMBEDDINGS_PATH);
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
            model: config.modelId,
            input: text,
        }),
    });
    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Embedding API error ${res.status}: ${errText}`);
    }
    const data = (await res.json()) as { data?: { embedding?: number[] }[] };
    const embedding = data?.data?.[0]?.embedding;
    if (!Array.isArray(embedding) || embedding.length === 0) {
        throw new Error("Embedding API returned empty embedding");
    }
    return L2Normalize(embedding.map(Number));
}

function L2Normalize(vec: number[]): number[] {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    const norm = Math.sqrt(sum) || 1;
    return vec.map((x) => x / norm);
}
