import { Injectable, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { McpServerConfig, McpServersStandardFormat } from '../../core/mcp/index.js';
import { addPendingAgentReload } from '../../core/config/agent-reload-pending.js';
import { DatabaseService } from '../database/database.service.js';
import { WorkspaceService } from '../workspace/workspace.service.js';

/** 工作空间名仅允许英文、数字、下划线、连字符 */
const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/** 缺省智能体 ID / 工作空间名，不可删除；对应目录 ~/.openbot/workspace/default */
export const DEFAULT_AGENT_ID = 'default';

/** 执行器类型：local=本机，coze/openclawx/opencode=远程代理 */
export type AgentRunnerType = 'local' | 'coze' | 'openclawx' | 'opencode';

/** Coze 站点：cn=国内 api.coze.cn，com=国际 api.coze.com，凭证不通用 */
export type CozeRegion = 'cn' | 'com';

/** 某站点的 Bot 凭证 */
export interface CozeRegionCredentials {
    botId: string;
    apiKey: string;
}

/** Coze 代理配置（存储）：按站点分别存凭证，请求时用 region 对应的一套 */
export interface AgentCozeConfig {
    region?: CozeRegion;
    cn?: CozeRegionCredentials;
    com?: CozeRegionCredentials;
    endpoint?: string;
}

export interface AgentOpenClawXConfig {
    baseUrl: string;
    apiKey?: string;
}

/** OpenCode 启动模式：local=本应用启动本机服务；remote=连接已运行的服务 */
export type OpenCodeServerMode = "local" | "remote";

/** OpenCode 代理配置：按官方 Server API 或 OpenAI 兼容端点 */
export interface AgentOpenCodeConfig {
    /** 启动模式：local=本应用按需启动；remote=连接已有服务 */
    mode?: OpenCodeServerMode;
    /** 地址（仅 remote 必填；local 时由适配器使用 127.0.0.1） */
    address?: string;
    port: number;
    password?: string;
    /** Basic 认证用户名（默认 opencode） */
    username?: string;
    /** @deprecated 仅保留向后兼容，产品仅支持官方 Server API */
    apiStyle?: "server" | "openai";
    path?: string;
    streamPath?: string;
    /** 默认模型（local 时写入启动配置；remote 时作为请求 model） */
    model?: string;
    /** 工作目录（仅 local 模式）：启动 opencode serve 时的 cwd，留空则使用进程当前目录 */
    workingDirectory?: string;
}

/**
 * 智能体列表与配置使用文件存储（~/.openbot/desktop/agents.json），不使用 SQLite。
 * 会话与消息历史使用 SQLite；Skills、工作空间文档为目录文件管理。
 */
export interface AgentConfigItem {
    id: string;
    name: string;
    workspace: string;
    provider?: string;
    model?: string;
    /** 匹配 config.configuredModels 中的 modelItemCode，优先于 provider/model */
    modelItemCode?: string;
    /** 是否为系统缺省智能体（主智能体），不可删除 */
    isDefault?: boolean;
    /** MCP 配置：数组（含 transport）或标准 JSON 对象（key 为服务器名称），创建 Session 时归一化使用 */
    mcpServers?: McpServerConfig[] | McpServersStandardFormat;
    /** MCP 单次返回最大 token；不配置则不限制 */
    mcpMaxResultTokens?: number;
    /** 自定义系统提示词，会与技能等一起组成最终 systemPrompt */
    systemPrompt?: string;
    /** 智能体图标标识（前端预设图标 id，如 default、star、code 等） */
    icon?: string;
    /** 执行器类型：local=本机，coze/openclawx/opencode=远程代理 */
    runnerType?: AgentRunnerType;
    /** Coze 代理配置（runnerType 为 coze 时使用） */
    coze?: AgentCozeConfig;
    /** OpenClawX 代理配置（runnerType 为 openclawx 时使用） */
    openclawx?: AgentOpenClawXConfig;
    /** OpenCode 代理配置（runnerType 为 opencode 时使用） */
    opencode?: AgentOpenCodeConfig;
    /** 是否使用经验（长记忆）：memory_recall / save_experience；默认 true */
    useLongMemory?: boolean;
    /** 在线搜索：启用后该智能体拥有 web_search 工具；可选默认 provider、maxResultTokens（前端默认 64K） */
    webSearch?: {
        enabled?: boolean;
        provider?: 'brave' | 'duck-duck-scrape';
        maxResultTokens?: number;
    };
}

interface AgentsFile {
    agents: AgentConfigItem[];
}

/** 主智能体（default）的默认展示名 */
const DEFAULT_AGENT_NAME = '主智能体';

export interface DeleteAgentOptions {
    /** 是否同时删除该工作区在磁盘上的目录及文件；默认 false（仅删数据库中的工作区相关数据，保留目录） */
    deleteWorkspaceDir?: boolean;
}

@Injectable()
export class AgentConfigService {
    private configDir: string;
    private agentsPath: string;

    constructor(
        private readonly db: DatabaseService,
        private readonly workspaceService: WorkspaceService,
    ) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
        this.configDir = join(homeDir, '.openbot', 'desktop');
        this.agentsPath = join(this.configDir, 'agents.json');
    }

    private async ensureConfigDir(): Promise<void> {
        if (!existsSync(this.configDir)) {
            await mkdir(this.configDir, { recursive: true });
        }
    }

    private async readAgentsFile(): Promise<AgentsFile> {
        await this.ensureConfigDir();
        if (!existsSync(this.agentsPath)) {
            return { agents: [] };
        }
        const content = await readFile(this.agentsPath, 'utf-8');
        try {
            const data = JSON.parse(content);
            return Array.isArray(data.agents) ? data : { agents: [] };
        } catch {
            return { agents: [] };
        }
    }

    private async writeAgentsFile(data: AgentsFile): Promise<void> {
        await this.ensureConfigDir();
        await writeFile(this.agentsPath, JSON.stringify(data, null, 2), 'utf-8');
    }

    /** 确保 default 工作空间目录存在 */
    private async ensureDefaultWorkspace(): Promise<void> {
        const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
        const workspaceRoot = join(homeDir, '.openbot', 'workspace', DEFAULT_AGENT_ID);
        const skillsDir = join(workspaceRoot, 'skills');
        if (!existsSync(workspaceRoot)) {
            await mkdir(skillsDir, { recursive: true });
        } else if (!existsSync(skillsDir)) {
            await mkdir(skillsDir, { recursive: true });
        }
    }

    private defaultAgent(overrides?: Partial<AgentConfigItem>): AgentConfigItem {
        return {
            id: DEFAULT_AGENT_ID,
            name: DEFAULT_AGENT_NAME,
            workspace: DEFAULT_AGENT_ID,
            isDefault: true,
            ...overrides,
        };
    }

    async listAgents(): Promise<AgentConfigItem[]> {
        await this.ensureDefaultWorkspace();
        const file = await this.readAgentsFile();
        const others = file.agents.filter((a) => a.id !== DEFAULT_AGENT_ID);
        const defaultEntry = file.agents.find((a) => a.id === DEFAULT_AGENT_ID);
        const mainAgent = defaultEntry
            ? { ...defaultEntry, isDefault: true }
            : this.defaultAgent();
        return [mainAgent, ...others].map((a) => (a.id === DEFAULT_AGENT_ID ? { ...a, isDefault: true } : a));
    }

    async getAgent(id: string): Promise<AgentConfigItem | null> {
        if (id === DEFAULT_AGENT_ID) {
            await this.ensureDefaultWorkspace();
        }
        const file = await this.readAgentsFile();
        const found = file.agents.find((a) => a.id === id);
        if (found) return { ...found, isDefault: found.id === DEFAULT_AGENT_ID };
        if (id === DEFAULT_AGENT_ID) return this.defaultAgent();
        return null;
    }

    async createAgent(params: {
        name: string;
        workspace: string;
        provider?: string;
        model?: string;
        modelItemCode?: string;
        /** 自定义系统提示词；可由用户描述生成，创建后可在详情页修改 */
        systemPrompt?: string;
        /** 智能体图标标识 */
        icon?: string;
    }): Promise<AgentConfigItem> {
        const { name, workspace, provider, model, modelItemCode, systemPrompt, icon } = params;
        if (workspace === DEFAULT_AGENT_ID) {
            throw new BadRequestException('工作空间名 default 为系统保留（主智能体），请使用其他名称');
        }
        if (!workspace || !WORKSPACE_NAME_REGEX.test(workspace)) {
            throw new BadRequestException('工作空间名必须为英文、数字、下划线或连字符');
        }
        const trimmedName = (name || workspace).trim() || workspace;

        const file = await this.readAgentsFile();
        if (file.agents.some((a) => a.workspace === workspace || a.id === workspace)) {
            throw new ConflictException('该工作空间名已存在');
        }

        const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
        const workspaceRoot = join(homeDir, '.openbot', 'workspace', workspace);
        const skillsDir = join(workspaceRoot, 'skills');
        if (!existsSync(workspaceRoot)) {
            await mkdir(skillsDir, { recursive: true });
        } else if (!existsSync(skillsDir)) {
            await mkdir(skillsDir, { recursive: true });
        }

        const agent: AgentConfigItem = {
            id: workspace,
            name: trimmedName,
            workspace,
            provider: provider?.trim() || undefined,
            model: model?.trim() || undefined,
            modelItemCode: modelItemCode?.trim() || undefined,
            systemPrompt: systemPrompt?.trim() || undefined,
            icon: icon?.trim() || undefined,
        };
        file.agents.push(agent);
        await this.writeAgentsFile(file);
        return agent;
    }

    async updateAgent(
        id: string,
        updates: Partial<
            Pick<
                AgentConfigItem,
                | 'name'
                | 'provider'
                | 'model'
                | 'modelItemCode'
                | 'mcpServers'
                | 'mcpMaxResultTokens'
                | 'systemPrompt'
                | 'icon'
                | 'runnerType'
                | 'coze'
                | 'openclawx'
                | 'opencode'
                | 'useLongMemory'
                | 'webSearch'
            >
        >,
    ): Promise<AgentConfigItem> {
        if (id === DEFAULT_AGENT_ID) {
            await this.ensureDefaultWorkspace();
        }
        const file = await this.readAgentsFile();
        let idx = file.agents.findIndex((a) => a.id === id);
        if (idx < 0) {
            if (id === DEFAULT_AGENT_ID) {
                file.agents.unshift(this.defaultAgent());
                idx = 0;
            } else {
                throw new NotFoundException('智能体不存在');
            }
        }
        const agent = file.agents[idx];
        if (agent.id !== DEFAULT_AGENT_ID && updates.name !== undefined) {
            agent.name = (updates.name || agent.workspace).trim() || agent.workspace;
        }
        if (updates.provider !== undefined) agent.provider = updates.provider;
        if (updates.model !== undefined) agent.model = updates.model;
        if (updates.modelItemCode !== undefined) agent.modelItemCode = updates.modelItemCode;
        if (updates.mcpServers !== undefined) agent.mcpServers = updates.mcpServers;
        if (updates.mcpMaxResultTokens !== undefined) agent.mcpMaxResultTokens = updates.mcpMaxResultTokens;
        if (updates.systemPrompt !== undefined) agent.systemPrompt = updates.systemPrompt?.trim() || undefined;
        if (updates.icon !== undefined) agent.icon = updates.icon?.trim() || undefined;
        if (updates.runnerType !== undefined) agent.runnerType = updates.runnerType;
        if (updates.coze !== undefined) {
            const incoming = updates.coze as Partial<AgentCozeConfig> & {
                botId?: string;
                apiKey?: string;
            };
            const endpointVal = incoming.endpoint != null ? String(incoming.endpoint).trim() : '';
            const region: CozeRegion =
                incoming.region === 'cn' || incoming.region === 'com' ? incoming.region : agent.coze?.region || 'com';
            const mergeOne = (
                inCreds: CozeRegionCredentials | undefined,
                existing: CozeRegionCredentials | undefined,
            ): CozeRegionCredentials | undefined => {
                const botId = String((inCreds?.botId ?? existing?.botId) ?? '').trim();
                if (!botId) return existing;
                const apiKey =
                    (inCreds?.apiKey != null && String(inCreds.apiKey).trim()) ||
                    (existing?.apiKey != null ? String(existing.apiKey).trim() : '') ||
                    '';
                return { botId, apiKey };
            };
            const cn =
                incoming.cn !== undefined ? mergeOne(incoming.cn, agent.coze?.cn) : agent.coze?.cn;
            const com =
                incoming.com !== undefined ? mergeOne(incoming.com, agent.coze?.com) : agent.coze?.com;
            if (
                (incoming.botId != null || incoming.apiKey != null) &&
                (agent.coze?.cn == null || agent.coze?.com == null)
            ) {
                const flatBotId = String(incoming.botId ?? agent.coze?.cn?.botId ?? agent.coze?.com?.botId ?? '').trim();
                const flatKey =
                    (incoming.apiKey != null && String(incoming.apiKey).trim()) ||
                    (agent.coze?.cn?.apiKey && String(agent.coze.cn.apiKey).trim()) ||
                    (agent.coze?.com?.apiKey && String(agent.coze.com.apiKey).trim()) ||
                    '';
                const flat = flatBotId ? { botId: flatBotId, apiKey: flatKey } : undefined;
                agent.coze = {
                    region,
                    cn: cn ?? flat ?? undefined,
                    com: com ?? flat ?? undefined,
                    endpoint: endpointVal || undefined,
                };
            } else {
                agent.coze = {
                    region,
                    cn: cn ?? undefined,
                    com: com ?? undefined,
                    endpoint: endpointVal || undefined,
                };
            }
        }
        if (updates.openclawx !== undefined) agent.openclawx = updates.openclawx;
        if (updates.opencode !== undefined) agent.opencode = updates.opencode;
        if (updates.useLongMemory !== undefined) agent.useLongMemory = updates.useLongMemory;
        if (updates.webSearch !== undefined) {
            agent.webSearch =
                updates.webSearch && (updates.webSearch.enabled || updates.webSearch.provider)
                    ? {
                          enabled: !!updates.webSearch.enabled,
                          provider:
                              updates.webSearch.provider === 'brave' || updates.webSearch.provider === 'duck-duck-scrape'
                                  ? updates.webSearch.provider
                                  : 'duck-duck-scrape',
                          maxResultTokens:
                              updates.webSearch.maxResultTokens != null && typeof updates.webSearch.maxResultTokens === 'number' && updates.webSearch.maxResultTokens > 0
                                  ? updates.webSearch.maxResultTokens
                                  : undefined,
                      }
                    : undefined;
        }
        await this.writeAgentsFile(file);
        await addPendingAgentReload(id).catch(() => {});
        return { ...agent, isDefault: agent.id === DEFAULT_AGENT_ID };
    }

    async deleteAgent(id: string, options?: DeleteAgentOptions): Promise<void> {
        if (id === DEFAULT_AGENT_ID) {
            throw new BadRequestException('主智能体（default）不可删除');
        }
        const file = await this.readAgentsFile();
        const idx = file.agents.findIndex((a) => a.id === id);
        if (idx < 0) {
            throw new NotFoundException('智能体不存在');
        }
        const agent = file.agents[idx];
        const workspace = (agent.workspace || agent.id || '').trim();
        file.agents.splice(idx, 1);
        await this.writeAgentsFile(file);

        if (workspace && workspace !== DEFAULT_AGENT_ID) {
            this.deleteWorkspaceDataFromDb(workspace);
        }
        if (options?.deleteWorkspaceDir && workspace && workspace !== DEFAULT_AGENT_ID) {
            await this.workspaceService.deleteWorkspaceDirectory(workspace);
        }
    }

    /** 仅删除数据库中与该工作区相关的数据（会话、定时任务、收藏等），不删磁盘目录 */
    private deleteWorkspaceDataFromDb(workspace: string): void {
        this.db.run('DELETE FROM token_usage WHERE session_id IN (SELECT id FROM sessions WHERE workspace = ?)', [workspace]);
        this.db.run('DELETE FROM sessions WHERE workspace = ?', [workspace]);
        this.db.run('DELETE FROM scheduled_tasks WHERE workspace = ?', [workspace]);
        this.db.run('DELETE FROM saved_items WHERE workspace = ?', [workspace]);
        this.db.persist();
    }

    /**
     * 根据 config 的 defaultProvider / defaultModel / defaultModelItemCode 及 configuredModels 同步 agents.json 中缺省智能体的 provider、model、modelItemCode。
     * 在桌面保存配置（如修改默认模型）后调用，保证 agents 与 config 一致。
     */
    async syncDefaultAgentFromConfig(config: {
        defaultProvider?: string;
        defaultModel?: string;
        defaultModelItemCode?: string;
        configuredModels?: Array<{ provider: string; modelId: string; modelItemCode?: string }>;
    }): Promise<void> {
        const list = config.configuredModels ?? [];
        let provider = config.defaultProvider?.trim();
        let model = config.defaultModel?.trim();
        let modelItemCode = config.defaultModelItemCode?.trim();
        if (modelItemCode && list.length) {
            const item = list.find((m) => m.modelItemCode === modelItemCode);
            if (item) {
                provider = item.provider;
                model = item.modelId;
            }
        }
        if (!provider || !model) return;
        if (!modelItemCode && list.length) {
            const item = list.find((m) => m.provider === provider && m.modelId === model);
            if (item?.modelItemCode) modelItemCode = item.modelItemCode;
        }
        await this.ensureDefaultWorkspace();
        const file = await this.readAgentsFile();
        let idx = file.agents.findIndex((a) => a.id === DEFAULT_AGENT_ID);
        if (idx < 0) {
            file.agents.unshift(this.defaultAgent({ provider, model, modelItemCode }));
            idx = 0;
        } else {
            const agent = file.agents[idx];
            agent.provider = provider;
            agent.model = model;
            agent.modelItemCode = modelItemCode;
        }
        await this.writeAgentsFile(file);
    }
}
