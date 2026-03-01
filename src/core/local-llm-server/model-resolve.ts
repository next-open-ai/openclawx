/**
 * 本地模型路径解析与文件存在性检查（与 ~/.cache/llama 及 node-llama-cpp 命名一致）。
 */
import { join } from "node:path";
import { existsSync } from "node:fs";
import { homedir } from "node:os";

export const LOCAL_LLM_CACHE_DIR = join(homedir(), ".cache", "llama");

/**
 * 取 modelUri 的末尾文件名（用于与已安装文件灵活匹配：不同 node-llama-cpp 版本可能生成不同前缀）。
 * 例：hf:Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf → Qwen3-4B-Q4_K_M.gguf
 */
export function modelUriBasename(modelUri: string): string {
    const s = (modelUri || "").trim();
    if (!s) return "";
    const parts = s.replace(/\\/g, "/").split("/");
    return parts[parts.length - 1] || s;
}

/**
 * 将 modelUri（hf:owner/repo/file.gguf）或文件名转为缓存目录下的文件名。
 * 与 LocalModelsService.predictFilename 逻辑一致。
 */
export function modelUriToFilename(modelUri: string): string {
    const s = (modelUri || "").trim();
    if (!s) return "";
    if (s.startsWith("hf:")) {
        const parts = s.slice(3).split("/");
        return "hf_" + parts.slice(0, -1).join("_") + "_" + parts[parts.length - 1];
    }
    // 已是文件名或路径，只取 basename
    const last = s.replace(/\\/g, "/").split("/").pop();
    return last ?? s;
}

/**
 * 检查指定模型（uri 或文件名）是否已存在于本地缓存目录。
 */
export function isModelFileInCache(modelIdOrUri: string, cacheDir: string = LOCAL_LLM_CACHE_DIR): boolean {
    const filename = modelUriToFilename(modelIdOrUri);
    if (!filename || !filename.endsWith(".gguf")) return false;
    return existsSync(join(cacheDir, filename));
}

/**
 * 将前端传入的模型标识（hf: URI 或已安装文件名）转为可传给 node-llama-cpp 的路径或 URI。
 * 若为纯文件名（如 hf_xxx.gguf），则返回缓存目录下的绝对路径。
 */
export function toModelPathForStart(uriOrFilename: string, cacheDir: string = LOCAL_LLM_CACHE_DIR): string {
    const s = (uriOrFilename || "").trim();
    if (!s) return "";
    if (s.startsWith("hf:")) return s;
    const filename = modelUriToFilename(s);
    if (!filename) return s;
    return join(cacheDir, filename);
}
