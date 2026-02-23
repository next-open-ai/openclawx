import { Injectable } from '@nestjs/common';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { getProviderSupport, syncDesktopConfigToModelsJson, type ChannelsConfig } from '../../core/config/desktop-config.js';
import { AgentConfigService } from '../agent-config/agent-config.service.js';

/** 模型 cost 配置，写入 models.json；缺省均为 0 */
export interface ModelCost {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
}

/** 已配置的模型项（备用模型列表中的一条），新增时需选类型 */
export interface ConfiguredModelItem {
    provider: string;
    modelId: string;
    /** 模型类型：llm / embedding / image 等，用于在不同场景筛选 */
    type: 'llm' | 'embedding' | 'image';
    /** 显示用别名，缺省用模型名；重名时自动加后缀区分 */
    alias?: string;
    /** 唯一编码，供界面与 agent.modelItemCode 匹配已设好的模型 */
    modelItemCode?: string;
    /** 是否推理模型，缺省 false；写入 models.json */
    reasoning?: boolean;
    /** 成本配置，缺省均为 0；写入 models.json */
    cost?: ModelCost;
    /** 上下文窗口，缺省 64000；写入 models.json */
    contextWindow?: number;
    /** 最大 token，缺省 8192；写入 models.json */
    maxTokens?: number;
}

export interface AppConfig {
    gatewayUrl: string;
    defaultProvider: string;
    defaultModel: string;
    /** 缺省模型在 configuredModels 中的唯一标识（defaultModelItemCode），与 defaultProvider/defaultModel 一起确定缺省模型 */
    defaultModelItemCode?: string;
    /** 缺省智能体 id */
    defaultAgentId?: string;
    theme: 'light' | 'dark';
    /** 同时存在的聊天 AgentSession 上限，超过时淘汰最久未用的 */
    maxAgentSessions?: number;
    /** 登录用户名，未配置时使用缺省（与缺省密码 123456 搭配） */
    loginUsername?: string;
    /** 登录密码，未配置时使用缺省 123456 */
    loginPassword?: string;
    providers: {
        [key: string]: {
            apiKey?: string;
            baseUrl?: string;
            /** 显示用别名，缺省用 provider 名；重名时自动加后缀区分 */
            alias?: string;
        };
    };
    /** 已配置的模型列表（备用），从该列表中选一个为缺省模型 */
    configuredModels?: ConfiguredModelItem[];
    /** RAG 知识库：向量模型（本地/在线）+ 向量库（本地/远程 Qdrant） */
    rag?: {
        embeddingSource?: 'local' | 'online';
        embeddingModelItemCode?: string;
        localModelPath?: string;
        embeddingProvider?: string;
        embeddingModel?: string;
        vectorStore?: 'local' | 'qdrant';
        qdrant?: { url: string; apiKey?: string; collection?: string };
    };
    /** Memory 记忆库：为 Agent 提供默认嵌入模型 */
    memory?: {
        embeddingModelItemCode?: string;
    };
    /** 通道配置：飞书、Telegram 等 token/key */
    channels?: ChannelsConfig;
}

@Injectable()
export class ConfigService {
    private configPath: string;
    private config: AppConfig;

    constructor(private readonly agentConfigService: AgentConfigService) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
        const configDir = join(homeDir, '.openbot', 'desktop');
        this.configPath = join(configDir, 'config.json');

        // Ensure config directory exists
        if (!existsSync(configDir)) {
            mkdir(configDir, { recursive: true });
        }

        this.config = this.getDefaultConfig();
        this.loadConfig();
    }

    private getDefaultConfig(): AppConfig {
        return {
            gatewayUrl: 'ws://localhost:38080',
            defaultProvider: 'deepseek',
            defaultModel: 'deepseek-chat',
            defaultAgentId: 'default',
            theme: 'dark',
            maxAgentSessions: 5,
            providers: {},
            configuredModels: [],
            rag: undefined,
            memory: {},
            channels: {},
        };
    }

    /** 当前缺省智能体 id */
    getDefaultAgentId(config?: AppConfig): string {
        const c = config ?? this.config;
        return (c.defaultAgentId ?? 'default').trim() || 'default';
    }

    private async loadConfig(): Promise<void> {
        try {
            if (existsSync(this.configPath)) {
                const content = await readFile(this.configPath, 'utf-8');
                this.config = { ...this.getDefaultConfig(), ...JSON.parse(content) };
                this.config.defaultAgentId = this.getDefaultAgentId(this.config);
            }
        } catch (error) {
            console.error('Error loading config:', error);
        }
    }

    /** 每次获取前从磁盘重新读取，保证打开配置界面时显示最新（含 CLI 写入的配置） */
    async getConfig(): Promise<AppConfig> {
        await this.loadConfig();
        return this.config;
    }

    async updateConfig(updates: Partial<AppConfig>): Promise<AppConfig> {
        this.config = { ...this.config, ...updates };
        this.config.defaultAgentId = this.getDefaultAgentId(this.config);
        const p = this.config.defaultProvider;
        const m = this.config.defaultModel;
        const list = this.config.configuredModels ?? [];
        if (p && m && list.length) {
            const item = list.find((x) => x.provider === p && x.modelId === m);
            if (item?.modelItemCode) this.config.defaultModelItemCode = item.modelItemCode;
        }
        await this.saveConfig();
        await this.agentConfigService.syncDefaultAgentFromConfig(this.config).catch((err) =>
            console.warn('[ConfigService] syncDefaultAgentFromConfig failed', err),
        );
        await syncDesktopConfigToModelsJson().catch((err) =>
            console.warn('[ConfigService] syncDesktopConfigToModelsJson failed', err),
        );
        return this.config;
    }

    private async saveConfig(): Promise<void> {
        try {
            await writeFile(this.configPath, JSON.stringify(this.config, null, 2));
        } catch (error) {
            console.error('Error saving config:', error);
            throw error;
        }
    }

    /** 支持的 provider 列表（来自 provider-support.json，供配置时下拉） */
    async getProviders(): Promise<string[]> {
        const support = await getProviderSupport();
        return Object.keys(support);
    }

    /** 某 provider 下的可用模型（来自 provider-support）；可按 type 筛选（llm/embedding/image/audio/video） */
    async getModels(provider: string, type?: string): Promise<{ id: string; name: string; types?: string[] }[]> {
        const support = await getProviderSupport();
        const entry = support[provider];
        if (!entry?.models?.length) return [];
        let list = entry.models.map((m) => ({
            id: m.id,
            name: m.name || m.id,
            types: m.types && m.types.length > 0 ? m.types : ["llm"],
        }));
        if (type && type.trim()) {
            const t = type.trim().toLowerCase();
            list = list.filter((m) => m.types?.includes(t));
        }
        return list;
    }

    /** 完整 provider 目录（支持列表 + 各 provider 的模型），供前端一次拉取 */
    async getProviderSupport() {
        return getProviderSupport();
    }
}
