/**
 * 文本 embedding：使用 config.json 中配置的远端 RAG embedding 模型。
 * 未配置时返回 null，调用方（长记忆）空转。
 */
import { getRagEmbeddingConfigSync } from "../config/desktop-config.js";
import { embedRemote } from "./remote-embedding.js";

/**
 * 对单条文本做 embedding。未配置 RAG embedding 时返回 null。
 */
export async function embed(text: string): Promise<number[] | null> {
    const config = getRagEmbeddingConfigSync();
    if (!config) return null;
    return embedRemote(text, config);
}
