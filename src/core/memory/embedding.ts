/**
 * 文本 embedding 统一入口（供 memory 向量库等使用）。
 *
 * 使用逻辑：
 * - 未配置在线 embedding：直接使用本地 embedding（GGUF）。
 * - 已配置在线 embedding：先尝试在线；若请求失败（无法连接、超时、返回错误等），则回退到本地 embedding。
 * - 本地也不可用时返回 null，长记忆空转。
 */
import { getRagEmbeddingConfigSync } from "../config/desktop-config.js";
import { embedRemote } from "./remote-embedding.js";
import { getLocalEmbeddingProvider, getLocalEmbeddingUnavailableReason } from "./local-embedding.js";

let fallbackLogged = false;
let unavailableLogged = false;

/**
 * 对单条文本做 embedding。
 * 未配置在线或在线连接失败时使用本地 embedding；均不可用时返回 null（仅首次打日志）。
 */
export async function embed(text: string): Promise<number[] | null> {
    const config = getRagEmbeddingConfigSync();

    if (config) {
        try {
            const vec = await embedRemote(text, config);
            if (Array.isArray(vec) && vec.length > 0) return vec;
        } catch {
            // 配置了在线但请求失败（无法连接等），下面使用本地
        }
        if (!fallbackLogged) {
            fallbackLogged = true;
            console.warn("[RAG embedding] 在线模型不可用，已切换至本地模型（GGUF）");
        }
    }

    const local = await getLocalEmbeddingProvider();
    if (local) {
        const vec = await local.embed(text);
        if (Array.isArray(vec) && vec.length > 0) return vec;
    }

    if (!unavailableLogged) {
        unavailableLogged = true;
        const reason = getLocalEmbeddingUnavailableReason();
        const reasonSuffix = reason ? ` 原因: ${reason}` : "（若为首次加载，请先执行 npm run build 后重启桌面端以查看具体原因）";
        console.warn("[RAG embedding] 本地模型也不可用，长记忆将空转。" + reasonSuffix);
    }
    return null;
}
