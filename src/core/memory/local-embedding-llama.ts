/**
 * 本地 embedding（Electron 主进程）：node-llama-cpp + GGUF。
 * 需在安装依赖后对 Electron 的 Node ABI 执行 electron-rebuild（见 apps/desktop 的 rebuild:native）。
 * 加载前会注册 ESM 钩子，将 "typescript" 解析为桩模块，避免依赖链加载 typescript.js（含 with 语句，ESM 下报错）。
 */
import type { IEmbeddingProvider } from "./embedding-types.js";
import { join } from "path";
import { homedir } from "os";

let cached: IEmbeddingProvider | null = null;
let initError: Error | null = null;
let lastQueryError: string | null = null;

export function getLocalEmbeddingLlamaUnavailableReason(): string | null {
    return initError?.message ?? lastQueryError ?? null;
}

function L2Normalize(vec: number[]): number[] {
    let sum = 0;
    for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
    const norm = Math.sqrt(sum) || 1;
    return vec.map((x) => x / norm);
}

/** 默认 GGUF embedding 模型（与 moltbot 一致），首次使用会按 node-llama-cpp 规则下载到缓存 */
const DEFAULT_GGUF_MODEL =
    "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf";

/**
 * 获取基于 node-llama-cpp + GGUF 的本地 embedding 提供方。
 * 仅在可解析到 node-llama-cpp 且模型可加载时返回，否则返回 null。
 * @param modelPath 配置的 GGUF 路径或 hf: URI，为空时使用 DEFAULT_GGUF_MODEL
 */
export async function getLocalEmbeddingLlamaProvider(
    modelPath: string | null,
): Promise<IEmbeddingProvider | null> {
    if (cached) return cached;
    if (initError) return null;
    const effectivePath = (modelPath?.trim() || DEFAULT_GGUF_MODEL).trim();
    try {
        // Node 20.10+ 才提供 node:module 的 register；Electron 内置 Node 较旧时无此导出，跳过钩子
        const nodeModule = await import("node:module") as { register?: (url: string, parent?: string) => void | Promise<void> };
        if (typeof nodeModule.register === "function") {
            const loaderUrl = new URL(
                "../../../scripts/ts-stub-loader.mjs",
                import.meta.url,
            ).href;
            await Promise.resolve(nodeModule.register(loaderUrl, import.meta.url));
        }

        const { getLlama, resolveModelFile, LlamaLogLevel } = await import(
            "node-llama-cpp"
        );
        const llama = await getLlama({ logLevel: LlamaLogLevel.error });
        const cacheDir = join(homedir(), ".cache", "llama");
        const resolved = await resolveModelFile(effectivePath, cacheDir);
        const model = await llama.loadModel({ modelPath: resolved });
        const embeddingCtx = await model.createEmbeddingContext();

        const provider: IEmbeddingProvider = {
            name: "llama-gguf",
            async embed(text: string): Promise<number[] | null> {
                try {
                    const embedding = await embeddingCtx.getEmbeddingFor(text);
                    const vec = Array.from(embedding.vector) as number[];
                    if (vec.length === 0) {
                        lastQueryError = "getEmbeddingFor 返回空向量";
                        return null;
                    }
                    return L2Normalize(vec);
                } catch (e) {
                    const err = e instanceof Error ? e : new Error(String(e));
                    lastQueryError = `llama embed 失败: ${err.message}`;
                    console.warn("[RAG embedding] node-llama-cpp embed 失败:", err.message);
                    return null;
                }
            },
        };
        cached = provider;
        return provider;
    } catch (e) {
        initError = e instanceof Error ? e : new Error(String(e));
        console.warn("[RAG embedding] node-llama-cpp (GGUF) 不可用，原因:", initError.message);
        if (initError.stack) {
            console.warn("[RAG embedding] GGUF 加载失败堆栈:\n", initError.stack);
        }
        if (initError.message.includes("Unexpected token 'with'")) {
            console.warn(
                "[RAG embedding] 提示: 依赖链中某包在 ESM 下使用了禁止的 with 语句（如 typescript.js）。可配置在线 RAG 或升级 Electron 至 Node 22+。",
            );
        }
        return null;
    }
}
