/**
 * 本地模型下载（供 CLI 与 Nest LocalModelsService 复用）。
 * 使用 node-llama-cpp resolveModelFile，缓存目录 ~/.openbot/.cached_models/。
 */
import { basename } from "node:path";
import { LOCAL_LLM_CACHE_DIR } from "./model-resolve.js";

export const DEFAULT_LLM_MODEL_URI = "hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q5_K_M.gguf";

export interface DownloadModelOptions {
    useMirror?: boolean;
    signal?: AbortSignal;
    onProgress?: (p: { downloadedSize: number; totalSize: number; percent: number }) => void;
}

/**
 * 下载模型到本地缓存目录。
 * @returns 解析后的本地文件路径
 */
export async function downloadModel(
    modelUri: string,
    options: DownloadModelOptions = {},
): Promise<string> {
    const { resolveModelFile } = await import("node-llama-cpp");
    const { useMirror = false, signal, onProgress } = options;

    const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN;
    const opts: {
        directory: string;
        onProgress?: (p: { downloadedSize: number; totalSize: number }) => void;
        signal?: AbortSignal;
        headers?: Record<string, string>;
        endpoints?: { huggingFace: string };
    } = {
        directory: LOCAL_LLM_CACHE_DIR,
        endpoints: {
            huggingFace: useMirror ? "https://hf-mirror.com/" : "https://huggingface.co/",
        },
    };
    if (signal) opts.signal = signal;
    if (hfToken) opts.headers = { Authorization: `Bearer ${hfToken}` };
    if (onProgress) {
        opts.onProgress = ({ downloadedSize, totalSize }) => {
            const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
            onProgress({ downloadedSize, totalSize, percent });
        };
    }

    const resolved = await resolveModelFile(modelUri, opts);
    return resolved;
}

export function getResolvedBasename(modelUri: string): string {
    return basename(modelUri.replace(/^hf:[^/]+\//, "").replace(/\//g, "_"));
}
