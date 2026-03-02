import { Controller, Get, Put, Body, Param, Query, Delete, Post } from '@nestjs/common';
import { OPENCODE_FREE_MODELS } from '../../core/agent/proxy/adapters/opencode-free-models.js';
import { loadDesktopAgentConfig, setDefaultModel } from '../../core/config/desktop-config.js';
import { startLocalLlmServer, stopLocalLlmServer } from '../../core/local-llm-server/index.js';
import { toModelPathForStart, resolveModelPathInCache, LOCAL_LLM_CACHE_DIR } from '../../core/local-llm-server/model-resolve.js';
import { ConfigService, AppConfig } from './config.service.js';
import { LocalModelsService } from './local-models.service.js';

@Controller('config')
export class ConfigController {
    constructor(
        private readonly configService: ConfigService,
        private readonly localModelsService: LocalModelsService,
    ) { }

    @Get()
    async getConfig() {
        const config = await this.configService.getConfig();
        const { loginPassword, ...rest } = config as AppConfig & { loginPassword?: string };
        return {
            success: true,
            data: { ...rest, loginPasswordSet: !!loginPassword },
        };
    }

    @Put()
    async updateConfig(@Body() updates: Partial<AppConfig>) {
        const config = await this.configService.updateConfig(updates);
        const { loginPassword, ...rest } = config as AppConfig & { loginPassword?: string };
        return {
            success: true,
            data: { ...rest, loginPasswordSet: !!loginPassword },
        };
    }

    @Get('providers')
    async getProviders() {
        const providers = await this.configService.getProviders();
        return {
            success: true,
            data: providers,
        };
    }

    @Get('provider-support')
    async getProviderSupport() {
        const support = await this.configService.getProviderSupport();
        return {
            success: true,
            data: support,
        };
    }

    @Get('providers/:provider/models')
    async getModels(@Param('provider') provider: string, @Query('type') type?: string) {
        const models = await this.configService.getModels(provider, type);
        return {
            success: true,
            data: models,
        };
    }

    /** OpenCode 免费/推荐模型列表，供代理配置界面下拉选择（本地/远程模式默认模型） */
    @Get('opencode-free-models')
    getOpencodeFreeModels() {
        return {
            success: true,
            data: OPENCODE_FREE_MODELS,
        };
    }

    // ─── 本地模型管理（node-llama-cpp GGUF）────────────────────────────────────

    /** 列出本地已缓存的 GGUF 模型文件 */
    @Get('local-models')
    async listLocalModels() {
        return { success: true, data: await this.localModelsService.listModels() };
    }

    /** 推荐的 GGUF 模型列表（来自 preset，与已安装展示名称一致） */
    @Get('local-models/recommended')
    async getRecommendedModels() {
        const data = await this.localModelsService.getRecommendedModels();
        return { success: true, data };
    }

    /** 仅返回尚未安装的推荐模型（已安装的不显示在下载区） */
    @Get('local-models/recommended-to-download')
    async getRecommendedToDownload() {
        const data = await this.localModelsService.getRecommendedToDownload();
        return { success: true, data };
    }

    /** 本地模型服务状态：是否可用、不可用原因、当前 baseUrl */
    @Get('local-models/status')
    getLocalLlmStatus() {
        const baseUrl = process.env.LOCAL_LLM_BASE_URL;
        const error = process.env.LOCAL_LLM_START_FAILED;
        const available = !!baseUrl;
        return {
            success: true,
            data: { available, error: error || undefined, baseUrl: baseUrl || undefined },
        };
    }

    /** 启动本地模型服务：LLM/Embedding 任一已下载即可启动，只启动已存在的模型并提示；失败仅返回错误信息不抛错 */
    @Post('local-models/start')
    async startLocalLlm(@Body() body: { llmModelUri?: string; embeddingModelUri?: string }) {
        stopLocalLlmServer();
        delete process.env.LOCAL_LLM_BASE_URL;
        delete process.env.LOCAL_LLM_START_FAILED;
        const llmPath = body.llmModelUri?.trim();
        const embPath = body.embeddingModelUri?.trim();
        if (!llmPath && !embPath) {
            return { success: false, data: { error: '请至少选择 LLM 或 Embedding 模型之一' } };
        }
        const llmResolved = llmPath ? resolveModelPathInCache(llmPath, LOCAL_LLM_CACHE_DIR) : '';
        const embResolved = embPath ? resolveModelPathInCache(embPath, LOCAL_LLM_CACHE_DIR) : '';
        if (!llmResolved && !embResolved) {
            return { success: false, data: { error: '未找到已下载的模型文件，请先在「模型管理」中下载' } };
        }
        if (llmPath) {
            try {
                await setDefaultModel('local', llmPath);
            } catch {
                // 保存失败不阻断启动
            }
        }
        let contextSize: number | undefined;
        try {
            const defaultAgent = await loadDesktopAgentConfig('default');
            if (defaultAgent?.contextSize != null && defaultAgent.contextSize > 0) {
                contextSize = defaultAgent.contextSize;
            }
        } catch {
            // ignore
        }
        if (contextSize == null) {
            const envMax = process.env.LOCAL_LLM_CONTEXT_MAX;
            contextSize = envMax != null && String(envMax).trim() !== '' ? parseInt(envMax, 10) || 32768 : 32768;
        }
        const opts = {
            ...(llmResolved ? { llmModelPath: llmResolved } : {}),
            ...(embResolved ? { embeddingModelPath: embResolved } : {}),
            contextSize,
        };
        try {
            const handle = await startLocalLlmServer(opts);
            process.env.LOCAL_LLM_BASE_URL = handle.baseUrl;
            const message =
                llmResolved && embResolved
                    ? '已启动 LLM + Embedding'
                    : llmResolved
                      ? '已启动 LLM 模型（当前未使用 Embedding）'
                      : '已启动 Embedding 模型（当前未使用 LLM）';
            return { success: true, data: { baseUrl: handle.baseUrl, message } };
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            process.env.LOCAL_LLM_START_FAILED = msg;
            return { success: false, data: { error: msg } };
        }
    }

    /** 开始后台下载模型（立即返回，进度通过 GET local-models/progress 轮询）。useMirror=true 使用国内镜像。 */
    @Post('local-models/download')
    async startDownload(@Body() body: { modelUri: string; useMirror?: boolean }) {
        const result = await this.localModelsService.startDownload(body.modelUri, {
            useMirror: body.useMirror === true,
        });
        return { success: true, data: result };
    }

    /** 取消指定模型的下载 */
    @Post('local-models/cancel-download')
    cancelDownload(@Body() body: { modelUri: string }) {
        this.localModelsService.cancelDownload(body.modelUri);
        return { success: true };
    }

    /** 推荐模型列表（含是否已安装），用于展示「已下载」或中国/全球下载按钮 */
    @Get('local-models/recommended-with-status')
    async getRecommendedWithStatus() {
        const models = await this.localModelsService.getRecommendedWithStatus();
        return { success: true, data: models };
    }

    /** 查询下载进度 */
    @Get('local-models/progress')
    getDownloadProgress(@Query('uri') uri: string) {
        const progress = this.localModelsService.getDownloadProgress(uri);
        return { success: true, data: progress };
    }

    /** 删除本地缓存的 GGUF 模型文件 */
    @Delete('local-models/:filename')
    async deleteLocalModel(@Param('filename') filename: string) {
        await this.localModelsService.deleteModel(filename);
        return { success: true };
    }
}
