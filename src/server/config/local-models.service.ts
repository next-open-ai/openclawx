/**
 * 本地 GGUF 模型管理服务。
 * 负责列出、下载（通过 node-llama-cpp resolveModelFile）、删除本地缓存的 GGUF 模型文件。
 * 模型缓存目录：~/.cache/llama
 */
import { Injectable } from '@nestjs/common';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, mkdirSync } from 'node:fs';
import { modelUriToFilename, LOCAL_LLM_CACHE_DIR } from '../../core/local-llm-server/model-resolve.js';

export interface LocalModelInfo {
    filename: string;
    /** 文件大小（字节） */
    size: number;
    /** 最后修改时间 ISO 字符串 */
    updatedAt: string;
    /** 推断的模型类型：llm / embedding（根据文件名关键词） */
    inferredType: 'llm' | 'embedding' | 'unknown';
}

export interface DownloadProgress {
    status: string;
    completed?: number;
    total?: number;
    percent?: number;
}

/** 根据文件名推断模型类型 */
function inferModelType(filename: string): LocalModelInfo['inferredType'] {
    const lower = filename.toLowerCase();
    if (lower.includes('embed') || lower.includes('bge') || lower.includes('e5-')) return 'embedding';
    return 'llm';
}

/** 推荐的 GGUF 模型列表，供前端下拉选择 */
export const RECOMMENDED_MODELS = [
    // LLM - 使用官方 Qwen3 GGUF 仓库（无需 token）
    { id: 'hf:Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf', name: 'Qwen3 4B Q4_K_M', type: 'llm', sizeHint: '~2.5GB' },
    { id: 'hf:Qwen/Qwen3-7B-GGUF/Qwen3-7B-Q4_K_M.gguf', name: 'Qwen3 7B Q4_K_M', type: 'llm', sizeHint: '~4.5GB' },
    { id: 'hf:Qwen/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M.gguf', name: 'Qwen3 14B Q4_K_M', type: 'llm', sizeHint: '~8.5GB' },
    // Embedding
    { id: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf', name: 'EmbeddingGemma 300M Q8 (768维)', type: 'embedding', sizeHint: '~300MB' },
    { id: 'hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf', name: 'BGE-M3 Q8 多语言 (1024维)', type: 'embedding', sizeHint: '~1.2GB' },
    { id: 'hf:mixedbread-ai/mxbai-embed-large-v1-GGUF/mxbai-embed-large-v1-f16.gguf', name: 'MxBai Embed Large v1 (1024维)', type: 'embedding', sizeHint: '~670MB' },
];

@Injectable()
export class LocalModelsService {
    private readonly cacheDir: string;
    /** 正在下载的任务：modelUri → 进度 */
    private downloadingMap = new Map<string, DownloadProgress>();

    constructor() {
        this.cacheDir = join(homedir(), '.cache', 'llama');
        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /** 列出本地已缓存的 GGUF 模型文件 */
    async listModels(): Promise<LocalModelInfo[]> {
        try {
            const files = await readdir(this.cacheDir);
            const ggufFiles = files.filter((f) => f.endsWith('.gguf'));
            const infos = await Promise.all(
                ggufFiles.map(async (f) => {
                    const filePath = join(this.cacheDir, f);
                    const s = await stat(filePath);
                    return {
                        filename: f,
                        size: s.size,
                        updatedAt: s.mtime.toISOString(),
                        inferredType: inferModelType(f),
                    } satisfies LocalModelInfo;
                }),
            );
            return infos.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        } catch {
            return [];
        }
    }

    /** 删除本地缓存的 GGUF 模型文件 */
    async deleteModel(filename: string): Promise<void> {
        // 安全检查：只允许删除 .gguf 文件，且不含路径分隔符
        if (!filename.endsWith('.gguf') || filename.includes('/') || filename.includes('\\')) {
            throw new Error('非法文件名');
        }
        const filePath = join(this.cacheDir, filename);
        if (!existsSync(filePath)) throw new Error(`文件不存在: ${filename}`);
        await unlink(filePath);
    }

    /** 获取推荐模型列表 */
    getRecommendedModels() {
        return RECOMMENDED_MODELS;
    }

    /** 仅返回尚未安装的推荐模型（用于「推荐下载」区，已安装的不显示下载项） */
    async getRecommendedToDownload(): Promise<typeof RECOMMENDED_MODELS> {
        const installed = await this.listModels();
        const installedFilenames = new Set(installed.map((m) => m.filename));
        return RECOMMENDED_MODELS.filter((rec) => !installedFilenames.has(modelUriToFilename(rec.id)));
    }

    /** 检查指定模型（uri 或文件名）是否已在缓存目录存在 */
    isModelFilePresent(modelIdOrUri: string): boolean {
        const filename = modelUriToFilename(modelIdOrUri);
        if (!filename || !filename.endsWith('.gguf')) return false;
        return existsSync(join(this.cacheDir, filename));
    }

    /** 获取某个 modelUri 的下载进度（不存在则表示未在下载） */
    getDownloadProgress(modelUri: string): DownloadProgress | null {
        return this.downloadingMap.get(modelUri) ?? null;
    }

    /**
     * 后台下载模型（通过 node-llama-cpp resolveModelFile）。
     * 返回后立即响应，进度通过 getDownloadProgress 轮询获取。
     */
    async startDownload(modelUri: string): Promise<{ filename: string }> {
        if (this.downloadingMap.has(modelUri)) {
            // 已在下载中，返回预期文件名
            return { filename: this.predictFilename(modelUri) };
        }

        this.downloadingMap.set(modelUri, { status: '准备下载...' });

        // 后台异步执行，不 await
        this.runDownload(modelUri).catch((e) => {
            this.downloadingMap.set(modelUri, { status: `下载失败: ${e?.message ?? e}` });
        });

        return { filename: this.predictFilename(modelUri) };
    }

    private async runDownload(modelUri: string): Promise<void> {
        try {
            const { resolveModelFile } = await import('node-llama-cpp');
            this.downloadingMap.set(modelUri, { status: '解析模型地址...' });

            // 从环境变量读取 Hugging Face token（可选）
            const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN;

            const options: any = {
                directory: this.cacheDir,
                onProgress: ({ downloadedSize, totalSize }: { downloadedSize: number; totalSize: number }) => {
                    const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
                    this.downloadingMap.set(modelUri, {
                        status: '下载中',
                        completed: downloadedSize,
                        total: totalSize,
                        percent,
                    });
                },
            };

            // 如果有 token，添加到请求头
            if (hfToken) {
                options.headers = { Authorization: `Bearer ${hfToken}` };
            }

            const resolved = await resolveModelFile(modelUri, options);

            const filename = basename(resolved);
            this.downloadingMap.set(modelUri, { status: `完成: ${filename}`, percent: 100 });
            // 5 秒后清除进度记录
            setTimeout(() => this.downloadingMap.delete(modelUri), 5000);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            let errorMsg = `失败: ${msg}`;

            // 如果是 401 错误，提供更友好的提示
            if (msg.includes('401') || msg.includes('Unauthorized')) {
                errorMsg = '下载失败: 需要 Hugging Face Token。请设置环境变量 HF_TOKEN 或 HUGGING_FACE_TOKEN';
            }

            this.downloadingMap.set(modelUri, { status: errorMsg });
            throw e;
        }
    }

    /** 根据 hf: URI 预测本地文件名（node-llama-cpp 的命名规则） */
    private predictFilename(modelUri: string): string {
        return modelUriToFilename(modelUri) || basename(modelUri);
    }
}
