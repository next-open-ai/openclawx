/**
 * 本地 GGUF 模型管理服务。
 * 负责列出、下载（通过 node-llama-cpp resolveModelFile）、删除本地缓存的 GGUF 模型文件。
 * 推荐列表从 presets/recommended-local-models.json 加载，已安装的与推荐使用同一套展示名称且已安装的不再出现在「备下载」列表。
 * 模型缓存目录：~/.openbot/.cached_models/
 */
import { Injectable } from '@nestjs/common';
import { readdir, stat, unlink, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { modelUriToFilename, modelUriBasename, LOCAL_LLM_CACHE_DIR } from '../../core/local-llm-server/model-resolve.js';

export interface RecommendedModel {
    id: string;
    name: string;
    type: 'llm' | 'embedding';
    sizeHint: string;
}

export interface LocalModelInfo {
    filename: string;
    /** 文件大小（字节） */
    size: number;
    /** 最后修改时间 ISO 字符串 */
    updatedAt: string;
    /** 推断的模型类型：llm / embedding（根据文件名关键词） */
    inferredType: 'llm' | 'embedding' | 'unknown';
    /** 与推荐列表一致的展示名称（能匹配到预设时），否则为 filename */
    displayName: string;
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

const PRESET_FILENAME = 'recommended-local-models.json';
const DEFAULT_RECOMMENDED: RecommendedModel[] = [
    { id: 'hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q5_K_M.gguf', name: 'Qwen 3.5 4B Q5_K_M', type: 'llm', sizeHint: '~3.2GB' },
    { id: 'hf:unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q5_K_M.gguf', name: 'Qwen 3.5 9B Q5_K_M', type: 'llm', sizeHint: '~6.8GB' },
    { id: 'hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf', name: 'EmbeddingGemma 300M Q8 (768维)', type: 'embedding', sizeHint: '~300MB' },
    { id: 'hf:gpustack/bge-m3-GGUF/bge-m3-Q8_0.gguf', name: 'BGE-M3 Q8 多语言 (1024维)', type: 'embedding', sizeHint: '~1.2GB' },
    { id: 'hf:mixedbread-ai/mxbai-embed-large-v1-GGUF/mxbai-embed-large-v1-f16.gguf', name: 'MxBai Embed Large v1 (1024维)', type: 'embedding', sizeHint: '~670MB' },
];

function getPresetsDir(): string {
    return process.env.OPENBOT_PRESETS_DIR || join(process.cwd(), 'presets');
}

/** 推荐项是否对应已安装文件（精确预测名 或 安装文件名以 uri 末尾文件名结尾，兼容不同 node-llama-cpp 命名） */
function recommendedMatchesInstalled(rec: RecommendedModel, installedFilenames: Set<string>): boolean {
    const predicted = modelUriToFilename(rec.id);
    if (installedFilenames.has(predicted)) return true;
    const suffix = modelUriBasename(rec.id);
    return Array.from(installedFilenames).some((f) => f.endsWith(suffix) || f === suffix);
}

/** 已安装文件名在预设中对应的展示名，若无匹配则返回 filename */
function displayNameForFilename(filename: string, recommended: RecommendedModel[]): string {
    for (const rec of recommended) {
        const predicted = modelUriToFilename(rec.id);
        if (filename === predicted) return rec.name;
        const uriBase = modelUriBasename(rec.id);
        if (uriBase && filename.endsWith(uriBase)) return rec.name;
    }
    return filename;
}

@Injectable()
export class LocalModelsService {
    private readonly cacheDir: string;
    private recommendedCache: RecommendedModel[] | null = null;
    /** 正在下载的任务：modelUri → 进度 */
    private downloadingMap = new Map<string, DownloadProgress>();

    constructor() {
        this.cacheDir = LOCAL_LLM_CACHE_DIR;
        if (!existsSync(this.cacheDir)) {
            mkdirSync(this.cacheDir, { recursive: true });
        }
    }

    /** 从 presets/recommended-local-models.json 加载推荐列表，失败则用内置默认 */
    private async getRecommendedModelsFromPreset(): Promise<RecommendedModel[]> {
        if (this.recommendedCache) return this.recommendedCache;
        const presetPath = join(getPresetsDir(), PRESET_FILENAME);
        try {
            if (existsSync(presetPath)) {
                const raw = await readFile(presetPath, 'utf-8');
                const data = JSON.parse(raw) as { models?: RecommendedModel[] };
                if (Array.isArray(data.models) && data.models.length > 0) {
                    this.recommendedCache = data.models;
                    return this.recommendedCache;
                }
            }
        } catch {
            // ignore, fallback to default
        }
        this.recommendedCache = DEFAULT_RECOMMENDED;
        return this.recommendedCache;
    }

    /** 列出本地已缓存的 GGUF 模型文件，displayName 与推荐列表一致（来自 preset 匹配） */
    async listModels(): Promise<LocalModelInfo[]> {
        try {
            const recommended = await this.getRecommendedModelsFromPreset();
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
                        displayName: displayNameForFilename(f, recommended),
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

    /** 获取推荐模型列表（来自 preset，与已安装展示名称一致） */
    async getRecommendedModels(): Promise<RecommendedModel[]> {
        return this.getRecommendedModelsFromPreset();
    }

    /** 仅返回尚未安装的推荐模型；已安装的视为「推荐列表中的一员」不再出现在备下载区 */
    async getRecommendedToDownload(): Promise<RecommendedModel[]> {
        const [recommended, installed] = await Promise.all([
            this.getRecommendedModelsFromPreset(),
            this.listModels(),
        ]);
        const installedFilenames = new Set(installed.map((m) => m.filename));
        return recommended.filter((rec) => !recommendedMatchesInstalled(rec, installedFilenames));
    }

    /** 检查指定模型（uri 或文件名）是否已在缓存目录存在 */
    isModelFilePresent(modelIdOrUri: string): boolean {
        const filename = modelUriToFilename(modelIdOrUri);
        if (!filename || !filename.endsWith('.gguf')) return false;
        return existsSync(join(this.cacheDir, filename));
    }

    /** 正在下载任务的 AbortController，用于取消 */
    private abortControllerMap = new Map<string, AbortController>();

    /** 获取某个 modelUri 的下载进度（不存在则表示未在下载） */
    getDownloadProgress(modelUri: string): DownloadProgress | null {
        return this.downloadingMap.get(modelUri) ?? null;
    }

    /**
     * 取消指定 modelUri 的下载（若正在下载）。
     */
    cancelDownload(modelUri: string): void {
        const controller = this.abortControllerMap.get(modelUri);
        if (controller) {
            controller.abort();
            this.downloadingMap.set(modelUri, { status: '已取消' });
            this.abortControllerMap.delete(modelUri);
            setTimeout(() => this.downloadingMap.delete(modelUri), 3000);
        }
    }

    /**
     * 返回所有推荐模型及是否已安装，用于前端展示「已下载」或下载按钮。
     */
    async getRecommendedWithStatus(): Promise<Array<RecommendedModel & { isInstalled: boolean }>> {
        const [recommended, installed] = await Promise.all([
            this.getRecommendedModelsFromPreset(),
            this.listModels(),
        ]);
        const installedFilenames = new Set(installed.map((m) => m.filename));
        return recommended.map((rec) => ({
            ...rec,
            isInstalled: recommendedMatchesInstalled(rec, installedFilenames),
        }));
    }

    /**
     * 后台下载模型（通过 node-llama-cpp resolveModelFile）。
     * useMirror=true 使用国内镜像 hf-mirror.com，false 使用官方 huggingface.co。
     * 返回后立即响应，进度通过 getDownloadProgress 轮询获取。
     */
    async startDownload(modelUri: string, options?: { useMirror?: boolean }): Promise<{ filename: string }> {
        if (this.downloadingMap.has(modelUri)) {
            return { filename: modelUriToFilename(modelUri) };
        }

        const controller = new AbortController();
        this.abortControllerMap.set(modelUri, controller);
        this.downloadingMap.set(modelUri, { status: '准备下载...' });

        this.runDownload(modelUri, controller.signal, options?.useMirror === true).catch((e) => {
            if (e?.name === 'AbortError' || (typeof e?.message === 'string' && e.message.includes('abort'))) {
                this.downloadingMap.set(modelUri, { status: '已取消' });
            } else {
                const msg = e instanceof Error ? e.message : String(e);
                let errorMsg = `失败: ${msg}`;
                if (msg.includes('401') || msg.includes('Unauthorized')) {
                    errorMsg = '下载失败: 需要 Hugging Face Token。请设置环境变量 HF_TOKEN 或 HUGGING_FACE_TOKEN';
                }
                this.downloadingMap.set(modelUri, { status: errorMsg });
            }
            this.abortControllerMap.delete(modelUri);
            setTimeout(() => this.downloadingMap.delete(modelUri), 5000);
        });

        return { filename: modelUriToFilename(modelUri) };
    }

    private async runDownload(modelUri: string, signal: AbortSignal, useMirror: boolean): Promise<void> {
        const { resolveModelFile } = await import('node-llama-cpp');
        this.downloadingMap.set(modelUri, { status: '解析模型地址...' });

        const hfToken = process.env.HF_TOKEN || process.env.HUGGING_FACE_TOKEN;

        const options: {
            directory: string;
            onProgress: (p: { downloadedSize: number; totalSize: number }) => void;
            signal?: AbortSignal;
            headers?: Record<string, string>;
            endpoints?: { huggingFace: string };
        } = {
            directory: this.cacheDir,
            onProgress: ({ downloadedSize, totalSize }: { downloadedSize: number; totalSize: number }) => {
                if (signal?.aborted) return;
                const percent = totalSize ? Math.round((downloadedSize / totalSize) * 100) : 0;
                this.downloadingMap.set(modelUri, {
                    status: '下载中',
                    completed: downloadedSize,
                    total: totalSize,
                    percent,
                });
            },
            signal,
            endpoints: {
                huggingFace: useMirror ? 'https://hf-mirror.com/' : 'https://huggingface.co/',
            },
        };

        if (hfToken) {
            options.headers = { Authorization: `Bearer ${hfToken}` };
        }

        const resolved = await resolveModelFile(modelUri, options);

        const filename = basename(resolved);
        this.downloadingMap.set(modelUri, { status: `完成: ${filename}`, percent: 100 });
        this.abortControllerMap.delete(modelUri);
        setTimeout(() => this.downloadingMap.delete(modelUri), 5000);
    }
}
