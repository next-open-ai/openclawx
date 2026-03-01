/**
 * 本地 embedding：优先走本地 LLM 子进程服务（/v1/embeddings），
 * 不可用时回退到 node-llama-cpp 直接加载（GGUF）。
 */
import type { IEmbeddingProvider } from "./embedding-types.js";
import { getRagLocalModelPathSync } from "../config/desktop-config.js";
import {
    getLocalEmbeddingLlamaProvider,
    getLocalEmbeddingLlamaUnavailableReason,
} from "./local-embedding-llama.js";

let cached: IEmbeddingProvider | null = null;
let envLogged = false;

export function getLocalEmbeddingUnavailableReason(): string | null {
    return getLocalEmbeddingLlamaUnavailableReason();
}

/** 通过本地 LLM 子进程服务的 /v1/embeddings 接口获取向量 */
function createLocalServerEmbeddingProvider(baseUrl: string): IEmbeddingProvider {
    return {
        name: "local-llm-server",
        async embed(text: string): Promise<number[] | null> {
            try {
                const res = await fetch(`${baseUrl}/embeddings`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json", Authorization: "Bearer local" },
                    body: JSON.stringify({ input: text }),
                    signal: AbortSignal.timeout(30_000),
                });
                if (!res.ok) return null;
                const data = await res.json() as { data?: { embedding?: number[] }[] };
                const vec = data?.data?.[0]?.embedding;
                return Array.isArray(vec) && vec.length > 0 ? vec : null;
            } catch {
                return null;
            }
        },
    };
}

/**
 * 获取本地 embedding 提供方（懒加载）。
 * 优先使用本地 LLM 子进程服务；不可用时回退到 node-llama-cpp 直接加载。
 */
export async function getLocalEmbeddingProvider(): Promise<IEmbeddingProvider | null> {
    if (cached) return cached;

    // 优先：本地 LLM 子进程服务
    const localBaseUrl = process.env.LOCAL_LLM_BASE_URL;
    if (localBaseUrl) {
        const serverProvider = createLocalServerEmbeddingProvider(localBaseUrl);
        // 快速探测服务是否可用
        const testVec = await serverProvider.embed("test");
        if (testVec !== null) {
            cached = serverProvider;
            if (!envLogged) {
                envLogged = true;
                console.log("[RAG embedding] 使用本地 LLM 子进程服务");
            }
            return cached;
        }
    }

    // 回退：node-llama-cpp 直接加载
    const provider = await getLocalEmbeddingLlamaProvider(getRagLocalModelPathSync());
    if (provider) {
        cached = provider;
        if (!envLogged) {
            envLogged = true;
            console.log("[RAG embedding] 使用 node-llama-cpp (GGUF) 直接加载");
        }
        return cached;
    }

    if (!envLogged) {
        envLogged = true;
        console.warn("[RAG embedding] 本地模型不可用，长记忆将空转。可配置 RAG 在线模型或检查 GGUF 报错。");
    }
    return null;
}

