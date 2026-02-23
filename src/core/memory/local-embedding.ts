/**
 * 本地 embedding：仅 node-llama-cpp (GGUF)。不可用时返回 null，由上层决定是否使用在线 RAG。
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

/**
 * 获取本地 embedding 提供方（懒加载，失败后不再重试）。
 * 仅使用 node-llama-cpp (GGUF)。不可用时返回 null。
 */
export async function getLocalEmbeddingProvider(): Promise<IEmbeddingProvider | null> {
    if (cached) return cached;
    const provider = await getLocalEmbeddingLlamaProvider(getRagLocalModelPathSync());
    if (provider) {
        cached = provider;
        if (!envLogged) {
            envLogged = true;
            console.warn("[RAG embedding] 本地模型使用 node-llama-cpp (GGUF)");
        }
        return cached;
    }
    if (!envLogged) {
        envLogged = true;
        console.warn(
            "[RAG embedding] 本地模型不可用，长记忆将空转。可配置 RAG 在线模型或检查 GGUF 报错。",
        );
    }
    return null;
}
