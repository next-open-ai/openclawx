/**
 * 本地模型路径解析与文件存在性检查。
 * 缓存目录：~/.openbot/.cached_models/，与 openbot 配置同目录便于管理。
 * 与「已安装的本地模型」展示一致：支持精确文件名 或 以末尾 .gguf 文件名结尾的灵活匹配（兼容 node-llama-cpp 不同命名）。
 */
import { join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";

export const LOCAL_LLM_CACHE_DIR = join(homedir(), ".openbot", ".cached_models");

/**
 * 取 modelUri 的末尾文件名（用于与已安装文件灵活匹配：不同 node-llama-cpp 版本可能生成不同前缀）。
 * 例：hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q5_K_M.gguf → Qwen3.5-4B-Q5_K_M.gguf
 * 例：hf_unsloth_Qwen3.5-4B-GGUF_Qwen3.5-4B-Q5_K_M.gguf → Qwen3.5-4B-Q5_K_M.gguf（文件名形式取最后一段 _ 之后）
 */
export function modelUriBasename(modelUri: string): string {
    const s = (modelUri || "").trim();
    if (!s) return "";
    const parts = s.replace(/\\/g, "/").split("/");
    const last = parts[parts.length - 1] || s;
    // 仅对无 "/" 的文件名形式（如 hf_X_Y_Z.gguf）取最后 _ 之后一段，以匹配 node-llama-cpp 可能生成的短文件名
    if (!s.includes("/") && last.includes("_") && last.endsWith(".gguf")) {
        const fromUnderscore = last.slice(last.lastIndexOf("_") + 1);
        if (fromUnderscore.endsWith(".gguf")) return fromUnderscore;
    }
    return last;
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
 * 在缓存目录中解析出实际存在的模型文件路径。
 * 先尝试精确文件名，若无则按「以 modelUri 的末尾文件名结尾」匹配（与「已安装的本地模型」逻辑一致）。
 */
export function resolveModelPathInCache(
    modelIdOrUri: string,
    cacheDir: string = LOCAL_LLM_CACHE_DIR,
): string {
    const filename = modelUriToFilename(modelIdOrUri);
    if (!filename || !filename.endsWith(".gguf")) return "";
    const exactPath = join(cacheDir, filename);
    if (existsSync(exactPath)) return exactPath;
    const suffix = modelUriBasename(modelIdOrUri);
    if (!suffix) return "";
    try {
        const files = readdirSync(cacheDir);
        const found = files.find((f) => f.endsWith(".gguf") && (f === suffix || f.endsWith(suffix)));
        return found ? join(cacheDir, found) : "";
    } catch {
        return "";
    }
}

/**
 * 检查指定模型（uri 或文件名）是否已存在于本地缓存目录。
 * 支持精确文件名 或 以末尾 .gguf 文件名结尾的灵活匹配，与「已安装的本地模型」展示一致。
 */
export function isModelFileInCache(modelIdOrUri: string, cacheDir: string = LOCAL_LLM_CACHE_DIR): boolean {
    return resolveModelPathInCache(modelIdOrUri, cacheDir) !== "";
}

/**
 * 将前端传入的模型标识（hf: URI 或已安装文件名）转为可传给 node-llama-cpp 的路径或 URI。
 * 若为纯文件名（如 hf_xxx.gguf），则返回缓存目录下的绝对路径；若实际磁盘文件名与配置不一致（如 node-llama-cpp 命名），则解析为真实路径。
 */
export function toModelPathForStart(uriOrFilename: string, cacheDir: string = LOCAL_LLM_CACHE_DIR): string {
    const s = (uriOrFilename || "").trim();
    if (!s) return "";
    if (s.startsWith("hf:")) return s;
    const resolved = resolveModelPathInCache(s, cacheDir);
    if (resolved) return resolved;
    const filename = modelUriToFilename(s);
    return filename ? join(cacheDir, filename) : s;
}
