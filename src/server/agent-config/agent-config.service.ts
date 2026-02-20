import { Injectable, ConflictException, BadRequestException, NotFoundException } from '@nestjs/common';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { existsSync } from 'fs';
import { homedir } from 'os';
import type { McpServerConfig } from '../../core/mcp/index.js';

/** 工作空间名仅允许英文、数字、下划线、连字符 */
const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/** 缺省智能体 ID / 工作空间名，不可删除；对应目录 ~/.openbot/workspace/default */
export const DEFAULT_AGENT_ID = 'default';

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
    /** MCP 服务器配置列表，创建 Session 时传入（与 Skill 类似） */
    mcpServers?: McpServerConfig[];
    /** 自定义系统提示词，会与技能等一起组成最终 systemPrompt */
    systemPrompt?: string;
    /** 智能体图标标识（前端预设图标 id，如 default、star、code 等） */
    icon?: string;
}

interface AgentsFile {
    agents: AgentConfigItem[];
}

/** 主智能体（default）的默认展示名 */
const DEFAULT_AGENT_NAME = '主智能体';

@Injectable()
export class AgentConfigService {
    private configDir: string;
    private agentsPath: string;

    constructor() {
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

    async updateAgent(id: string, updates: Partial<Pick<AgentConfigItem, 'name' | 'provider' | 'model' | 'modelItemCode' | 'mcpServers' | 'systemPrompt' | 'icon'>>): Promise<AgentConfigItem> {
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
        if (updates.systemPrompt !== undefined) agent.systemPrompt = updates.systemPrompt?.trim() || undefined;
        if (updates.icon !== undefined) agent.icon = updates.icon?.trim() || undefined;
        await this.writeAgentsFile(file);
        return { ...agent, isDefault: agent.id === DEFAULT_AGENT_ID };
    }

    async deleteAgent(id: string): Promise<void> {
        if (id === DEFAULT_AGENT_ID) {
            throw new BadRequestException('主智能体（default）不可删除');
        }
        const file = await this.readAgentsFile();
        const idx = file.agents.findIndex((a) => a.id === id);
        if (idx < 0) {
            throw new NotFoundException('智能体不存在');
        }
        file.agents.splice(idx, 1);
        await this.writeAgentsFile(file);
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
