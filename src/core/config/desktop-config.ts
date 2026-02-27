/**
 * 桌面端配置单一入口（~/.openbot/desktop）。
 * 供 CLI、WebSocket Gateway 等读取与写入，与 Nest Desktop Backend 使用的 config.json / agents.json 一致。
 * provider-support.json 提供流行 provider 及模型目录，供配置时下拉备选；配置完成后可同步到 agent 目录 models.json 供 pi 使用。
 */
import { readFile, writeFile, cp, mkdir } from "fs/promises";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { getOpenbotAgentDir } from "../agent/agent-dir.js";
import {
    DEFAULT_PROVIDER_SUPPORT,
    type ProviderSupport,
    type ProviderSupportEntry,
    type ProviderSupportModel,
    type ModelSupportType,
} from "./provider-support-default.js";

export type { ProviderSupport, ProviderSupportEntry, ProviderSupportModel, ModelSupportType };

function getDesktopDir(): string {
    const home = process.env.HOME || process.env.USERPROFILE || homedir();
    return join(home, ".openbot", "desktop");
}

/** 获取预装资源目录（打包后在 Resources/presets，dev 时在仓库根 presets） */
function getPresetsDir(): string {
    return process.env.OPENBOT_PRESETS_DIR || join(process.cwd(), "presets");
}

/** 已配置模型项（与 Nest ConfiguredModelItem 一致），用于读取 config 并写入 models.json */
interface DesktopConfiguredModel {
    provider: string;
    modelId: string;
    type: string;
    alias?: string;
    /** 唯一编码，供界面与 agent.modelItemCode 匹配已设好的模型 */
    modelItemCode?: string;
    reasoning?: boolean;
    cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
    contextWindow?: number;
    maxTokens?: number;
}

/** 知识库 RAG 配置（config.json.rag） */
export interface RagConfig {
    /** 向量模型来源：local=本地 GGUF，online=在线 OpenAPI */
    embeddingSource?: "local" | "online";
    /** 在线时：从已配置模型中选的 embedding 项，对应 modelItemCode */
    embeddingModelItemCode?: string;
    /** 本地时：GGUF 模型路径；优先用 node-llama-cpp */
    localModelPath?: string;
    /** 兼容旧配置：在线时的 provider+model */
    embeddingProvider?: string;
    embeddingModel?: string;
    /** 向量库类型：local=本地 Vectra，qdrant=远程 Qdrant */
    vectorStore?: "local" | "qdrant";
    /** 远程 Qdrant 配置 */
    qdrant?: { url: string; apiKey?: string; collection?: string };
}

/** RAG 长记忆：使用远端 embedding 模型；未配置时基于 RAG 的长记忆空转 */
export interface RagEmbeddingConfig {
    provider: string;
    modelId: string;
    apiKey?: string;
    baseUrl?: string;
}

/** 通道配置：各 IM 通道的 token、key 等，与设置页「通道配置」一致 */
export interface ChannelsConfig {
    feishu?: { enabled?: boolean; appId?: string; appSecret?: string; defaultAgentId?: string };
    dingtalk?: { enabled?: boolean; clientId?: string; clientSecret?: string; defaultAgentId?: string };
    telegram?: { enabled?: boolean; botToken?: string; defaultAgentId?: string };
    wechat?: { enabled?: boolean; puppet?: string; defaultAgentId?: string };
}

/** 与 Nest ConfigService 使用的 config.json 结构一致 */
interface DesktopConfigJson {
    defaultProvider?: string;
    defaultModel?: string;
    /** 缺省模型在 configuredModels 中的唯一标识，与 defaultProvider/defaultModel 一起确定缺省模型 */
    defaultModelItemCode?: string;
    defaultAgentId?: string;
    maxAgentSessions?: number;
    providers?: Record<string, { apiKey?: string; baseUrl?: string; alias?: string }>;
    configuredModels?: DesktopConfiguredModel[];
    /** RAG 知识库：向量模型（本地/在线）+ 向量库（本地/远程 Qdrant）；未配置时长记忆空转 */
    rag?: RagConfig;
    /** Memory 记忆库：为 Agent 提供默认嵌入模型 */
    memory?: {
        embeddingModelItemCode?: string;
    };
    /** 通道配置：飞书、Telegram 等 */
    channels?: ChannelsConfig;
    /** 工具全局配置：在线搜索等 */
    tools?: {
        webSearch?: {
            defaultProvider?: "brave" | "duck-duck-scrape";
            timeoutSeconds?: number;
            cacheTtlMinutes?: number;
            maxResults?: number;
            providers?: { brave?: { apiKey?: string } };
        };
    };
}

/** MCP 服务器配置（与 core/mcp 类型一致，避免 core/config 依赖 core/mcp 实现） */
export type DesktopMcpServerConfig = import("../mcp/index.js").McpServerConfig;
/** MCP 标准 JSON 格式（key 为服务器名称），存储与 UI 可读写 */
export type DesktopMcpServersStandardFormat = import("../mcp/index.js").McpServersStandardFormat;

/** Agent 执行器类型：local=本机 pi-coding-agent，coze/openclawx/opencode=远程代理 */
export type AgentRunnerType = "local" | "coze" | "openclawx" | "opencode";

/** Coze 站点：国内站 api.coze.cn / 国际站 api.coze.com，凭证不通用 */
export type CozeRegion = "cn" | "com";

/** 某站点的 Bot 凭证（国内/国际各自独立） */
export interface CozeRegionCredentials {
    botId: string;
    apiKey: string;
}

/** Coze 代理配置（agents.json）：按站点分别存凭证，请求时用当前 region 对应的一套 */
export interface AgentCozeConfig {
    /** 当前使用的站点，未填默认 com */
    region?: CozeRegion;
    /** 国内站 (api.coze.cn) 凭证 */
    cn?: CozeRegionCredentials;
    /** 国际站 (api.coze.com) 凭证 */
    com?: CozeRegionCredentials;
    /** 可选：自定义 API 地址，覆盖当前站点的默认地址 */
    endpoint?: string;
}

/** 解析后的 Coze 配置（供适配器使用）：当前站点的 botId/apiKey + region/endpoint */
export interface CozeResolvedConfig {
    botId: string;
    apiKey: string;
    region?: CozeRegion;
    endpoint?: string;
}

/** OpenClawX 代理配置（代理到另一台 OpenClawX 实例） */
export interface AgentOpenClawXConfig {
    baseUrl: string;
    apiKey?: string;
}

/** OpenCode 启动模式：local=由本应用按需启动本机服务；remote=连接已运行的远端服务 */
export type OpenCodeServerMode = "local" | "remote";

/** OpenCode 代理配置：仅对接 [OpenCode 官方 Server API](https://opencode.ai/docs/server)（Session/Message + HTTP Basic） */
export interface AgentOpenCodeConfig {
    /** 启动模式：local=本应用控制启动并可选设置默认模型；remote=连接已有服务 */
    mode?: OpenCodeServerMode;
    /** 地址（仅 remote 必填；local 时固定为 127.0.0.1） */
    address?: string;
    /** 端口（opencode serve 默认 4096） */
    port: number;
    /** HTTP Basic 认证密码（见 OPENCODE_SERVER_PASSWORD） */
    password?: string;
    /** HTTP Basic 认证用户名（默认 opencode） */
    username?: string;
    /** @deprecated 仅保留向后兼容，产品仅支持官方 Server API */
    apiStyle?: "server" | "openai";
    /** @deprecated 仅保留向后兼容 */
    path?: string;
    /** @deprecated 仅保留向后兼容 */
    streamPath?: string;
    /**
     * 默认模型：local 时由本应用启动服务时写入 OpenCode 配置；remote 时作为请求 model 发送。
     * 不填则 local 使用本机已有 OpenCode 配置、remote 使用服务端默认。
     */
    model?: string;
    /** 工作目录（仅 local 模式生效）：启动 opencode serve 时使用的 cwd，留空则使用进程当前目录 */
    workingDirectory?: string;
}

interface AgentItem {
    id: string;
    name?: string;
    workspace: string;
    provider?: string;
    model?: string;
    /** 匹配 config.configuredModels 中的 modelItemCode，优先于 provider/model */
    modelItemCode?: string;
    /** MCP 配置：数组（含 transport）或标准 JSON 对象（key 为名称），创建 Session 时归一化使用 */
    mcpServers?: DesktopMcpServerConfig[] | DesktopMcpServersStandardFormat;
    /** MCP 单次返回最大 token；超过则从尾部裁剪；不配置则不限制 */
    mcpMaxResultTokens?: number;
    /** 自定义系统提示词，与技能等一起组成最终 systemPrompt */
    systemPrompt?: string;
    /** 执行器类型，缺省 local */
    runnerType?: AgentRunnerType;
    /** Coze 代理配置，当 runnerType 为 coze 时使用 */
    coze?: AgentCozeConfig;
    /** OpenClawX 代理配置，当 runnerType 为 openclawx 时使用 */
    openclawx?: AgentOpenClawXConfig;
    /** OpenCode 代理配置，当 runnerType 为 opencode 时使用 */
    opencode?: AgentOpenCodeConfig;
    /** 是否使用经验（长记忆）；默认 true */
    useLongMemory?: boolean;
    /** 在线搜索：是否启用 web_search 工具；启用时可指定 provider、maxResultTokens */
    webSearch?: {
        enabled?: boolean;
        provider?: "brave" | "duck-duck-scrape";
        /** 单次搜索返回最大 token；超过则从尾部裁剪；不配置则不限制；前端默认 64K */
        maxResultTokens?: number;
    };
}

interface AgentsFile {
    agents?: AgentItem[];
}

const DEFAULT_AGENT_ID = "default";
const DEFAULT_MAX_AGENT_SESSIONS = 5;

/** 同步读取桌面全局配置（Gateway 等需要同步读的场景） */
function getConfigPath(): string {
    return join(getDesktopDir(), "config.json");
}

const PROVIDER_SUPPORT_FILENAME = "provider-support.json";

function getProviderSupportPath(): string {
    return join(getDesktopDir(), PROVIDER_SUPPORT_FILENAME);
}

/**
 * 同步读取桌面全局配置中的 maxAgentSessions 等。
 * Gateway 进程内使用，用于会话上限等。
 */
export function getDesktopConfig(): { maxAgentSessions: number } {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) {
            return { maxAgentSessions: DEFAULT_MAX_AGENT_SESSIONS };
        }
        const content = readFileSync(configPath, "utf-8");
        const data = JSON.parse(content) as DesktopConfigJson;
        const max = data.maxAgentSessions;
        const maxAgentSessions =
            typeof max === "number" && max > 0 ? Math.floor(max) : DEFAULT_MAX_AGENT_SESSIONS;
        return { maxAgentSessions };
    } catch {
        return { maxAgentSessions: DEFAULT_MAX_AGENT_SESSIONS };
    }
}

/** 同步读取通道配置（Gateway 启动时用） */
export function getChannelsConfigSync(): ChannelsConfig {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) return {};
        const content = readFileSync(configPath, "utf-8");
        const data = JSON.parse(content) as DesktopConfigJson;
        return data.channels ?? {};
    } catch {
        return {};
    }
}

/** 同步读取 RAG embedding 配置；embeddingSource 为 local 或未配置在线模型时返回 null，长记忆将空转 */
export function getRagEmbeddingConfigSync(): RagEmbeddingConfig | null {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) return null;
        const content = readFileSync(configPath, "utf-8");
        const data = JSON.parse(content) as DesktopConfigJson;
        const rag = data.rag;
        if (rag?.embeddingSource === "local") return null;
        let provider: string | undefined;
        let modelId: string | undefined;
        if (rag?.embeddingModelItemCode && Array.isArray(data.configuredModels)) {
            const code = rag.embeddingModelItemCode;
            const item = data.configuredModels.find((m: { modelItemCode?: string; type?: string; provider?: string; modelId?: string }) => {
                if (m.type !== "embedding") return false;
                return m.modelItemCode === code || (m.provider && m.modelId && `${m.provider}:${m.modelId}` === code);
            });
            if (item && (item as { provider?: string; modelId?: string }).provider) {
                provider = (item as { provider: string }).provider;
                modelId = (item as { modelId: string }).modelId;
            }
        }
        if (!provider || !modelId) {
            provider = rag?.embeddingProvider?.trim();
            modelId = rag?.embeddingModel?.trim();
        }
        if (!provider || !modelId) return null;
        const prov = data.providers?.[provider];
        const apiKey = prov?.apiKey?.trim();
        if (!apiKey) return null;
        let baseUrl = prov?.baseUrl?.trim();
        if (!baseUrl) {
            const d = EMBEDDING_DEFAULT_BASE_URL[provider];
            baseUrl = d ?? "";
        }
        if (!baseUrl) return null;
        return { provider, modelId, apiKey, baseUrl: baseUrl.replace(/\/$/, "") };
    } catch {
        return null;
    }
}

/** 同步读取 RAG 本地 GGUF 模型路径；embeddingSource 非 local 或未填时返回 null，调用方使用默认模型（如 embeddinggemma）。 */
export function getRagLocalModelPathSync(): string | null {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) return null;
        const content = readFileSync(configPath, "utf-8");
        const data = JSON.parse(content) as DesktopConfigJson;
        if (data.rag?.embeddingSource !== "local") return null;
        const modelPath = data.rag?.localModelPath?.trim();
        return modelPath || null;
    } catch {
        return null;
    }
}

/** 同步读取 RAG 向量库配置；vectorStore 为 qdrant 且 url 有效时返回，否则为 null（使用本地向量库）。 */
export function getRagQdrantConfigSync(): { url: string; apiKey?: string; collection?: string } | null {
    try {
        const configPath = getConfigPath();
        if (!existsSync(configPath)) return null;
        const content = readFileSync(configPath, "utf-8");
        const data = JSON.parse(content) as DesktopConfigJson;
        if (data.rag?.vectorStore !== "qdrant" || !data.rag?.qdrant?.url?.trim()) return null;
        return {
            url: data.rag.qdrant.url.trim().replace(/\/$/, ""),
            apiKey: data.rag.qdrant.apiKey?.trim(),
            collection: data.rag.qdrant.collection?.trim(),
        };
    } catch {
        return null;
    }
}

const EMBEDDING_DEFAULT_BASE_URL: Record<string, string> = {
    openai: "https://api.openai.com/v1",
    "openai-custom": "",
    deepseek: "https://api.deepseek.com/v1",
    dashscope: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    nvidia: "https://integrate.api.nvidia.com/v1",
    kimi: "https://api.moonshot.cn/v1",
};

export interface DesktopAgentConfig {
    provider: string;
    model: string;
    apiKey?: string;
    /** 工作区名，来自 agents.json 的 agent.workspace 或 agent.id */
    workspace?: string;
    /** MCP 服务器配置（数组或标准对象格式），创建 Session 时传入并归一化 */
    mcpServers?: DesktopMcpServerConfig[] | DesktopMcpServersStandardFormat;
    /** MCP 单次返回最大 token；超过则从尾部裁剪；不配置则不限制 */
    mcpMaxResultTokens?: number;
    /** 自定义系统提示词，会与技能等一起组成最终 systemPrompt */
    systemPrompt?: string;
    /** 执行器类型，缺省 local */
    runnerType?: AgentRunnerType;
    /** Coze 代理配置（解析后：当前站点的凭证） */
    coze?: CozeResolvedConfig;
    /** OpenClawX 代理配置 */
    openclawx?: AgentOpenClawXConfig;
    /** OpenCode 代理配置 */
    opencode?: AgentOpenCodeConfig;
    /** 是否使用经验（长记忆）；默认 true */
    useLongMemory?: boolean;
    /** 在线搜索：解析后的运行时配置，仅当 runnerType 为 local 时用于注册 web_search 工具 */
    webSearch?: {
        enabled: boolean;
        provider: "brave" | "duck-duck-scrape";
        apiKey?: string;
        timeoutSeconds: number;
        cacheTtlMinutes: number;
        maxResults: number;
        /** 单次搜索返回最大 token；超过则从尾部裁剪；不配置则不限制 */
        maxResultTokens?: number;
    };
}

/**
 * 从 config.json 读取缺省智能体 id（defaultAgentId）。
 * 若未配置、或该 id 在 agents.json 中不存在，则返回 default。
 */
export async function getBoundAgentIdForCli(): Promise<string> {
    const desktopDir = getDesktopDir();
    const configPath = join(desktopDir, "config.json");
    const agentsPath = join(desktopDir, "agents.json");

    let boundId: string = DEFAULT_AGENT_ID;
    if (existsSync(configPath)) {
        try {
            const raw = await readFile(configPath, "utf-8");
            const config = JSON.parse(raw) as DesktopConfigJson;
            const id = config.defaultAgentId ? String(config.defaultAgentId).trim() : "";
            if (id) boundId = id;
        } catch {
            // ignore, use default
        }
    }

    if (boundId === DEFAULT_AGENT_ID) return DEFAULT_AGENT_ID;
    if (!existsSync(agentsPath)) return DEFAULT_AGENT_ID;
    try {
        const raw = await readFile(agentsPath, "utf-8");
        const data = JSON.parse(raw) as AgentsFile;
        const agents = Array.isArray(data.agents) ? data.agents : [];
        const found = agents.some((a) => a.id === boundId);
        return found ? boundId : DEFAULT_AGENT_ID;
    } catch {
        return DEFAULT_AGENT_ID;
    }
}

/**
 * 根据 agentId 从桌面配置中读取该 agent 的 provider、model 及 API Key。
 * 若文件不存在或解析失败返回 null，调用方使用环境变量或默认值。
 */
export async function loadDesktopAgentConfig(agentId: string): Promise<DesktopAgentConfig | null> {
    const desktopDir = getDesktopDir();
    const configPath = join(desktopDir, "config.json");
    const agentsPath = join(desktopDir, "agents.json");

    let config: DesktopConfigJson = {};
    if (existsSync(configPath)) {
        try {
            const raw = await readFile(configPath, "utf-8");
            config = JSON.parse(raw) as DesktopConfigJson;
        } catch {
            return null;
        }
    }

    const resolvedAgentId = agentId === "default" ? "default" : agentId;
    let provider = config.defaultProvider ?? "deepseek";
    let model = config.defaultModel ?? "deepseek-chat";
    if (config.defaultModelItemCode && Array.isArray(config.configuredModels)) {
        const configured = config.configuredModels.find((m) => m.modelItemCode === config.defaultModelItemCode);
        if (configured) {
            provider = configured.provider;
            model = configured.modelId;
        }
    }
    let workspaceName: string = resolvedAgentId;
    let mcpServers: DesktopMcpServerConfig[] | DesktopMcpServersStandardFormat | undefined;
    let mcpMaxResultTokens: number | undefined;
    let systemPrompt: string | undefined;
    let useLongMemory: boolean = true;

    if (existsSync(agentsPath)) {
        try {
            const raw = await readFile(agentsPath, "utf-8");
            const data = JSON.parse(raw) as AgentsFile;
            const agents = Array.isArray(data.agents) ? data.agents : [];
            const agent = agents.find((a) => a.id === resolvedAgentId);
            if (agent) {
                if (agent.workspace) workspaceName = agent.workspace;
                else if (agent.id) workspaceName = agent.id;
                if (agent.mcpMaxResultTokens != null && typeof agent.mcpMaxResultTokens === "number" && agent.mcpMaxResultTokens > 0) {
                    mcpMaxResultTokens = agent.mcpMaxResultTokens;
                }
                if (agent.mcpServers != null) {
                    if (Array.isArray(agent.mcpServers) || (typeof agent.mcpServers === "object" && !Array.isArray(agent.mcpServers))) {
                        mcpServers = agent.mcpServers;
                    }
                }
                if (agent.systemPrompt && typeof agent.systemPrompt === "string") {
                    systemPrompt = agent.systemPrompt.trim();
                }
                if (agent.useLongMemory !== undefined) useLongMemory = !!agent.useLongMemory;
                if (agent.modelItemCode && Array.isArray(config.configuredModels)) {
                    const configured = config.configuredModels.find((m) => m.modelItemCode === agent.modelItemCode);
                    if (configured) {
                        provider = configured.provider;
                        model = configured.modelId;
                    } else {
                        if (agent.provider) provider = agent.provider;
                        if (agent.model) model = agent.model;
                    }
                } else {
                    if (agent.provider) provider = agent.provider;
                    if (agent.model) model = agent.model;
                }
            }
        } catch {
            // ignore
        }
    }

    const provConfig = config.providers?.[provider];
    const apiKey =
        provConfig?.apiKey && typeof provConfig.apiKey === "string" && provConfig.apiKey.trim()
            ? provConfig.apiKey.trim()
            : undefined;

    let runnerType: AgentRunnerType = "local";
    let coze: CozeResolvedConfig | undefined;
    let openclawx: AgentOpenClawXConfig | undefined;
    let opencode: AgentOpenCodeConfig | undefined;
    const tw = config.tools?.webSearch;
    const timeoutSeconds = typeof tw?.timeoutSeconds === "number" && tw.timeoutSeconds > 0 ? tw.timeoutSeconds : 15;
    const cacheTtlMinutes = typeof tw?.cacheTtlMinutes === "number" && tw.cacheTtlMinutes >= 0 ? tw.cacheTtlMinutes : 5;
    const maxResultsRaw = typeof tw?.maxResults === "number" ? tw.maxResults : 5;
    const maxResults = Math.min(10, Math.max(1, maxResultsRaw));
    let webSearch: DesktopAgentConfig["webSearch"] = {
        enabled: false,
        provider: "duck-duck-scrape",
        timeoutSeconds,
        cacheTtlMinutes,
        maxResults,
    };
    if (existsSync(agentsPath)) {
        try {
            const rawAgents = await readFile(agentsPath, "utf-8");
            const dataAgents = JSON.parse(rawAgents) as AgentsFile;
            const agentsList = Array.isArray(dataAgents.agents) ? dataAgents.agents : [];
            const agentRow = agentsList.find((a) => a.id === resolvedAgentId);
            if (agentRow) {
                if (
                    agentRow.runnerType === "coze" ||
                    agentRow.runnerType === "openclawx" ||
                    agentRow.runnerType === "opencode"
                ) {
                    runnerType = agentRow.runnerType;
                }
                if (agentRow.coze) {
                    const row = agentRow.coze as AgentCozeConfig & { botId?: string; apiKey?: string };
                    const region: CozeRegion =
                        row.region === "cn" || row.region === "com" ? row.region : "com";
                    const credsCn = row.cn;
                    const credsCom = row.com;
                    const legacyBotId = row.botId != null ? String(row.botId).trim() : "";
                    const legacyKey = row.apiKey != null ? String(row.apiKey).trim() : "";
                    const fromRegion =
                        region === "cn"
                            ? credsCn && String(credsCn.botId || "").trim() && String(credsCn.apiKey || "").trim()
                                ? { botId: String(credsCn.botId).trim(), apiKey: String(credsCn.apiKey).trim() }
                                : null
                            : credsCom && String(credsCom.botId || "").trim() && String(credsCom.apiKey || "").trim()
                                ? { botId: String(credsCom.botId).trim(), apiKey: String(credsCom.apiKey).trim() }
                                : null;
                    const fromLegacy = legacyBotId && legacyKey ? { botId: legacyBotId, apiKey: legacyKey } : null;
                    const creds = fromRegion ?? fromLegacy;
                    if (creds) {
                        coze = {
                            botId: creds.botId,
                            apiKey: creds.apiKey,
                            region,
                            endpoint: row.endpoint?.trim(),
                        };
                    } else if (runnerType === "coze") {
                        console.warn(
                            `[loadDesktopAgentConfig] agentId=${resolvedAgentId} runnerType=coze but no credentials for region=${region} (configure 国内/国际 in proxy settings)`
                        );
                    }
                }
                if (agentRow.openclawx?.baseUrl) {
                    openclawx = {
                        baseUrl: String(agentRow.openclawx.baseUrl).replace(/\/$/, ""),
                        apiKey: agentRow.openclawx.apiKey?.trim(),
                    };
                }
                if (agentRow.opencode?.port != null) {
                    const raw = agentRow.opencode;
                    const port = Number(raw.port);
                    if (!Number.isNaN(port) && port > 0) {
                        const mode: OpenCodeServerMode =
                            raw.mode === "local" || raw.mode === "remote"
                                ? raw.mode
                                : raw.address != null && String(raw.address).trim()
                                    ? "remote"
                                    : "local";
                        const address =
                            mode === "remote" && raw.address != null
                                ? String(raw.address).trim()
                                : "127.0.0.1";
                        if (mode === "local" || address) {
                            const apiStyle = raw.apiStyle === "openai" ? "openai" : "server";
                            opencode = {
                                mode,
                                address: mode === "remote" ? address : "127.0.0.1",
                                port,
                                password:
                                    raw.password != null ? String(raw.password).trim() : undefined,
                                username:
                                    raw.username != null ? String(raw.username).trim() || undefined : undefined,
                                apiStyle,
                                path: raw.path != null ? String(raw.path).trim() || undefined : undefined,
                                streamPath:
                                    raw.streamPath != null
                                        ? String(raw.streamPath).trim() || undefined
                                        : undefined,
                                model: raw.model != null ? String(raw.model).trim() || undefined : undefined,
                                workingDirectory:
                                    raw.workingDirectory != null ? String(raw.workingDirectory).trim() || undefined : undefined,
                            };
                        }
                    }
                }
                if (agentRow.webSearch?.enabled === true) {
                    let preferredProvider: "brave" | "duck-duck-scrape" =
                        agentRow.webSearch?.provider === "brave" || agentRow.webSearch?.provider === "duck-duck-scrape"
                            ? agentRow.webSearch.provider
                            : tw?.defaultProvider === "brave" || tw?.defaultProvider === "duck-duck-scrape"
                                ? tw.defaultProvider!
                                : "duck-duck-scrape";
                    let braveKey: string | undefined;
                    if (preferredProvider === "brave") {
                        braveKey =
                            (typeof tw?.providers?.brave?.apiKey === "string" && tw.providers.brave.apiKey.trim()
                                ? tw.providers.brave.apiKey.trim()
                                : undefined) ??
                            (process.env.BRAVE_API_KEY && process.env.BRAVE_API_KEY.trim() ? process.env.BRAVE_API_KEY.trim() : undefined);
                        if (!braveKey) preferredProvider = "duck-duck-scrape";
                    }
                    const maxResultTokens =
                        agentRow.webSearch?.maxResultTokens != null && typeof agentRow.webSearch?.maxResultTokens === "number" && agentRow.webSearch.maxResultTokens > 0
                            ? agentRow.webSearch.maxResultTokens
                            : undefined;
                    webSearch = {
                        enabled: true,
                        provider: preferredProvider,
                        apiKey: preferredProvider === "brave" ? braveKey : undefined,
                        timeoutSeconds,
                        cacheTtlMinutes,
                        maxResults,
                        maxResultTokens,
                    };
                }
            }
        } catch {
            // ignore
        }
    }

    return {
        provider,
        model,
        apiKey: apiKey ?? undefined,
        workspace: workspaceName,
        mcpServers,
        mcpMaxResultTokens,
        systemPrompt,
        runnerType,
        coze,
        openclawx,
        opencode,
        useLongMemory,
        webSearch,
    };
}

/** 供 CLI config list 使用：从桌面 config 读出的配置列表项 */
export interface DesktopConfigListEntry {
    provider: string;
    defaultModel: string;
    hasKey: boolean;
}

/** 供 CLI config list 使用：桌面配置列表（中心化配置源） */
export interface DesktopConfigList {
    defaultProvider: string;
    defaultModel: string;
    defaultModelItemCode?: string;
    providers: DesktopConfigListEntry[];
}

function ensureDesktopDir(): string {
    const desktopDir = getDesktopDir();
    if (!existsSync(desktopDir)) {
        mkdirSync(desktopDir, { recursive: true });
    }
    return desktopDir;
}

async function readDesktopConfigJson(): Promise<DesktopConfigJson> {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return {};
    try {
        const raw = await readFile(configPath, "utf-8");
        return JSON.parse(raw) as DesktopConfigJson;
    } catch {
        return {};
    }
}

async function writeDesktopConfigJson(config: DesktopConfigJson): Promise<void> {
    ensureDesktopDir();
    const configPath = getConfigPath();
    await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
}

/**
 * 将某 provider 的 API Key 写入桌面 config（中心化配置源）。
 * openbot login 使用：缺省 alias 与 provider 同名；若有 baseUrl 则一并写入。
 * 若传入 modelId 或未传则取该 provider 第一个模型，会补齐 defaultProvider/defaultModel、configuredModels、agents 默认智能体，后续可直接运行。
 */
export async function setProviderApiKey(provider: string, apiKey: string, modelId?: string): Promise<void> {
    const config = await readDesktopConfigJson();
    if (!config.providers) config.providers = {};
    if (!config.providers[provider]) config.providers[provider] = {};
    const entry = config.providers[provider];
    entry.apiKey = apiKey.trim();
    if (entry.alias === undefined || entry.alias === "") entry.alias = provider;
    const support = await getProviderSupport();
    const supportEntry = support[provider];
    if (supportEntry?.baseUrl != null && String(supportEntry.baseUrl).trim() !== "" && !(entry.baseUrl != null && String(entry.baseUrl).trim() !== "")) {
        entry.baseUrl = supportEntry.baseUrl.trim();
    }
    await writeDesktopConfigJson(config);

    const effectiveModelId = (modelId != null && String(modelId).trim() !== "")
        ? String(modelId).trim()
        : await getFirstModelForProvider(provider);
    if (effectiveModelId) {
        await setDefaultModel(provider, effectiveModelId);
    } else {
        await syncDesktopConfigToModelsJson();
    }
}

/** 生成 configuredModels 项的 modelItemCode，与界面约定一致 */
function buildModelItemCode(provider: string, modelId: string): string {
    return `${provider}_${modelId}`.replace(/[^a-zA-Z0-9_-]/g, "_");
}

/**
 * 将全局默认 provider/model 写入桌面 config，并在 configuredModels 中增加/更新对应项，agents.json 中缺省智能体写入 modelItemCode。
 * openbot config set-model 使用此方法。
 */
export async function setDefaultModel(provider: string, modelId: string): Promise<void> {
    const modelIdTrim = modelId.trim();
    const modelItemCode = buildModelItemCode(provider, modelIdTrim);
    const config = await readDesktopConfigJson();
    config.defaultProvider = provider;
    config.defaultModel = modelIdTrim;
    config.defaultModelItemCode = modelItemCode;
    if (!Array.isArray(config.configuredModels)) config.configuredModels = [];
    const list = config.configuredModels;
    const existing = list.find(
        (m) => m.modelItemCode === modelItemCode || (m.provider === provider && m.modelId === modelIdTrim),
    );
    const item = {
        provider,
        modelId: modelIdTrim,
        type: "llm" as const,
        alias: `${modelIdTrim} item`,
        modelItemCode,
        reasoning: false,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 64000,
        maxTokens: 8192,
    };
    if (existing) {
        Object.assign(existing, item);
    } else {
        list.push(item);
    }
    await writeDesktopConfigJson(config);

    const agentsPath = join(getDesktopDir(), "agents.json");
    if (existsSync(agentsPath)) {
        try {
            const raw = await readFile(agentsPath, "utf-8");
            const data = JSON.parse(raw) as AgentsFile;
            const agents = Array.isArray(data.agents) ? data.agents : [];
            const defaultAgent = agents.find((a) => a.id === DEFAULT_AGENT_ID);
            if (defaultAgent) {
                (defaultAgent as AgentItem).provider = provider;
                (defaultAgent as AgentItem).model = modelIdTrim;
                (defaultAgent as AgentItem).modelItemCode = modelItemCode;
            } else {
                agents.unshift({
                    id: DEFAULT_AGENT_ID,
                    name: "主智能体",
                    workspace: DEFAULT_AGENT_ID,
                    provider,
                    model: modelIdTrim,
                    modelItemCode,
                });
            }
            await writeFile(agentsPath, JSON.stringify({ agents }, null, 2), "utf-8");
        } catch {
            // ignore
        }
    }
    await syncDesktopConfigToModelsJson();
}

/**
 * 供 CLI config list 使用，从桌面 config 读出配置列表。
 */
export async function getDesktopConfigList(): Promise<DesktopConfigList> {
    const config = await readDesktopConfigJson();
    const defaultProvider = config.defaultProvider ?? "deepseek";
    const defaultModel = config.defaultModel ?? "deepseek-chat";
    const providers = config.providers ?? {};
    const entries: DesktopConfigListEntry[] = Object.entries(providers).map(([name, p]) => ({
        provider: name,
        defaultModel: name === defaultProvider ? defaultModel : "—",
        hasKey: !!(p?.apiKey && String(p.apiKey).trim()),
    }));
    if (entries.length === 0) {
        entries.push({
            provider: defaultProvider,
            defaultModel,
            hasKey: false,
        });
    }
    return { defaultProvider, defaultModel, defaultModelItemCode: config.defaultModelItemCode, providers: entries };
}

/**
 * 确保桌面目录下存在 provider-support.json（不存在则写入默认内容）。
 * 供配置供应商时作备选下拉列表项。
 */
/**
 * 确保桌面目录下存在 provider-support.json，并与预装的最新供应商列表合并。
 */
export async function ensureProviderSupportFile(): Promise<void> {
    const presetPath = join(getPresetsDir(), "preset-providers.json");
    let presetData: any = { providers: DEFAULT_PROVIDER_SUPPORT };
    if (existsSync(presetPath)) {
        try {
            presetData = JSON.parse(await readFile(presetPath, "utf-8"));
        } catch { }
    }
    const presetProviders: ProviderSupport = presetData.providers || DEFAULT_PROVIDER_SUPPORT;

    const path = getProviderSupportPath();
    ensureDesktopDir();
    if (!existsSync(path)) {
        await writeFile(path, JSON.stringify(presetProviders, null, 2), "utf-8");
        return;
    }

    try {
        const userContent = await readFile(path, "utf-8");
        const userProviders: ProviderSupport = JSON.parse(userContent);
        let changed = false;

        for (const [providerId, presetEntry] of Object.entries(presetProviders)) {
            if (!userProviders[providerId]) {
                userProviders[providerId] = presetEntry;
                changed = true;
            } else {
                const userModels = userProviders[providerId].models || [];
                for (const presetModel of presetEntry.models) {
                    if (!userModels.some((m) => m.id === presetModel.id)) {
                        userModels.push(presetModel);
                        changed = true;
                    }
                }
                userProviders[providerId].models = userModels;
            }
        }
        if (changed) {
            await writeFile(path, JSON.stringify(userProviders, null, 2), "utf-8");
        }
    } catch {
        await writeFile(path, JSON.stringify(presetProviders, null, 2), "utf-8");
    }
}

/** 若 config.json 不存在则用 preset-config.json 初始化，若存在则浅合并补充新基础键值 */
async function ensureConfigJsonInitialized(): Promise<void> {
    const presetPath = join(getPresetsDir(), "preset-config.json");
    let presetConfig: DesktopConfigJson = {
        defaultProvider: "deepseek",
        defaultModel: "deepseek-chat",
        defaultAgentId: DEFAULT_AGENT_ID,
        maxAgentSessions: DEFAULT_MAX_AGENT_SESSIONS,
        providers: {},
        configuredModels: [],
    };
    if (existsSync(presetPath)) {
        try {
            const data = JSON.parse(await readFile(presetPath, "utf-8"));
            if (data.config) presetConfig = data.config;
        } catch { }
    }

    const configPath = getConfigPath();
    ensureDesktopDir();
    if (!existsSync(configPath)) {
        await writeFile(configPath, JSON.stringify(presetConfig, null, 2), "utf-8");
        return;
    }

    try {
        const userConfig: DesktopConfigJson = JSON.parse(await readFile(configPath, "utf-8"));
        let changed = false;
        for (const [key, value] of Object.entries(presetConfig)) {
            if ((userConfig as any)[key] === undefined) {
                (userConfig as any)[key] = value;
                changed = true;
            }
        }
        if (changed) {
            await writeFile(configPath, JSON.stringify(userConfig, null, 2), "utf-8");
        }
    } catch { }
}

/** 合并 preset-agents.json 中的预置智能体，并随之释放对应的工作区技能 */
async function ensureAgentsJsonInitialized(): Promise<void> {
    const presetPath = join(getPresetsDir(), "preset-agents.json");
    let presetAgents: any[] = [];
    if (existsSync(presetPath)) {
        try {
            const data = JSON.parse(await readFile(presetPath, "utf-8"));
            if (Array.isArray(data.agents)) presetAgents = data.agents;
        } catch { }
    }

    const agentsPath = join(getDesktopDir(), "agents.json");
    ensureDesktopDir();

    let currentData = { agents: [] as any[] };
    if (existsSync(agentsPath)) {
        try {
            currentData = JSON.parse(await readFile(agentsPath, "utf-8"));
            if (!Array.isArray(currentData.agents)) currentData.agents = [];
        } catch { }
    }

    let changed = false;

    for (const pa of presetAgents) {
        if (!currentData.agents.some((a: any) => a.id === pa.id)) {
            currentData.agents.push(pa);
            changed = true;

            try {
                const srcSkillsDir = join(getPresetsDir(), "workspaces", pa.id, "skills");
                const homeDir = process.env.HOME || process.env.USERPROFILE || homedir();
                const destSkillsDir = join(homeDir, ".openbot", "workspace", pa.id, "skills");
                if (existsSync(srcSkillsDir)) {
                    if (!existsSync(destSkillsDir)) {
                        await mkdir(destSkillsDir, { recursive: true });
                    }
                    await cp(srcSkillsDir, destSkillsDir, { recursive: true, force: false, errorOnExist: false });
                }
            } catch (err) {
                console.error(`Failed to copy preset skills for agent ${pa.id}:`, err);
            }
        }
    }

    if (changed || !existsSync(agentsPath)) {
        await writeFile(agentsPath, JSON.stringify(currentData, null, 2), "utf-8");
    }
}

/**
 * CLI / Gateway 运行时调用，确保 config.json、provider-support.json、agents.json 均完成初始化。
 */
export async function ensureDesktopConfigInitialized(): Promise<void> {
    ensureDesktopDir();
    await ensureProviderSupportFile();
    await ensureConfigJsonInitialized();
    await ensureAgentsJsonInitialized();
}

/**
 * 取某 provider 在 provider-support 中的第一个 llm 模型 id；若无则返回第一个模型 id。
 */
export async function getFirstModelForProvider(provider: string): Promise<string | null> {
    const support = await getProviderSupport();
    const entry = support[provider];
    if (!entry?.models?.length) return null;
    const llm = entry.models.find((m) => m.types?.includes("llm"));
    if (llm) return llm.id;
    return entry.models[0].id;
}

/**
 * 读取桌面 provider-support.json（流行 provider 及模型目录）。
 * 若文件不存在则先写入默认内容再返回；若存在则与默认合并，补全默认中已有而文件中缺失的 provider（如新增的 openai-custom）。
 */
export async function getProviderSupport(): Promise<ProviderSupport> {
    await ensureProviderSupportFile();
    const path = getProviderSupportPath();
    try {
        const raw = await readFile(path, "utf-8");
        const fromFile = JSON.parse(raw) as ProviderSupport;
        const merged = { ...fromFile };
        let hasNew = false;
        for (const [id, entry] of Object.entries(DEFAULT_PROVIDER_SUPPORT)) {
            if (!(id in merged)) {
                merged[id] = entry;
                hasNew = true;
            }
        }
        if (hasNew) {
            await writeFile(path, JSON.stringify(merged, null, 2), "utf-8");
        }
        return merged;
    } catch {
        return DEFAULT_PROVIDER_SUPPORT;
    }
}

/** Pi ModelRegistry / models.json 中单个 model 的格式（含 reasoning、cost 等） */
interface PiModelEntry {
    id: string;
    name: string;
    reasoning: boolean;
    input: string[];
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
    contextWindow: number;
    maxTokens: number;
    supportsTools?: boolean;
}

/** Pi ModelRegistry 使用的 models.json 中单个 provider 的格式 */
interface PiProviderEntry {
    name: string;
    apiKey: string;
    api: string;
    baseUrl: string;
    authHeader?: boolean;
    models: PiModelEntry[];
}

/** 同步到 pi models.json 时使用的默认 baseUrl / apiKey 环境变量名 / api，provider-support 中不再存储 */
const SYNC_DEFAULTS: Record<string, { baseUrl: string; apiKey: string; api: string }> = {
    deepseek: { baseUrl: "https://api.deepseek.com", apiKey: "OPENAI_API_KEY", api: "openai-completions" },
    dashscope: { baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", apiKey: "DASHSCOPE_API_KEY", api: "openai-completions" },
    openai: { baseUrl: "https://api.openai.com/v1", apiKey: "OPENAI_API_KEY", api: "openai-completions" },
    /** 自定义端点，baseUrl 由用户填写，兼容所有 OpenAI 接口 */
    "openai-custom": { baseUrl: "", apiKey: "OPENAI_API_KEY", api: "openai-completions" },
    nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "NVIDIA_API_KEY", api: "openai-completions" },
    kimi: { baseUrl: "https://api.moonshot.cn/v1", apiKey: "MOONSHOT_API_KEY", api: "openai-completions" },
};

const DEFAULT_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const DEFAULT_CONTEXT_WINDOW = 64000;
const DEFAULT_MAX_TOKENS = 8192;

function configuredModelToPi(item: DesktopConfiguredModel, displayName: string): PiModelEntry {
    const cost = item.cost ?? {};
    return {
        id: item.modelId,
        name: displayName,
        reasoning: item.reasoning ?? false,
        input: ["text"],
        cost: {
            input: cost.input ?? 0,
            output: cost.output ?? 0,
            cacheRead: cost.cacheRead ?? 0,
            cacheWrite: cost.cacheWrite ?? 0,
        },
        contextWindow: item.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
        maxTokens: item.maxTokens ?? DEFAULT_MAX_TOKENS,
        supportsTools: true,
    };
}

/**
 * 根据桌面 config（已配置的 providers + configuredModels）与 provider-support，生成并写入 agent 目录的 models.json。
 * 仅包含在 config 的 providers 中已配置的 provider；每个 provider 的 models 来自 configuredModels，结构含 reasoning、cost 等。
 */
export async function syncDesktopConfigToModelsJson(): Promise<void> {
    const config = await readDesktopConfigJson();
    const configured = config.providers ?? {};
    const configuredModels = Array.isArray(config.configuredModels) ? config.configuredModels : [];
    if (Object.keys(configured).length === 0) {
        return;
    }
    const support = await getProviderSupport();
    const piProviders: Record<string, PiProviderEntry> = {};
    for (const [providerId, userConfig] of Object.entries(configured)) {
        if (!userConfig?.apiKey?.trim()) continue;
        const defaults = SYNC_DEFAULTS[providerId] ?? { baseUrl: "", apiKey: "OPENAI_API_KEY", api: "openai-completions" };
        const baseUrl = userConfig.baseUrl?.trim() || (support[providerId]?.baseUrl ?? "").trim() || defaults.baseUrl;
        if (!baseUrl) continue;
        const def = support[providerId];
        const items = configuredModels.filter((m) => m.provider === providerId);
        let models: PiModelEntry[];
        if (items.length > 0) {
            models = items.map((item) => {
                const displayName =
                    (item.alias && item.alias.trim()) ||
                    (def?.models?.find((m) => m.id === item.modelId)?.name) ||
                    item.modelId;
                return configuredModelToPi(item, displayName);
            });
        } else if (def?.models?.length) {
            models = def.models.map((m) =>
                configuredModelToPi(
                    {
                        provider: providerId,
                        modelId: m.id,
                        type: "llm",
                        alias: m.name,
                        reasoning: false,
                        cost: DEFAULT_COST,
                        contextWindow: DEFAULT_CONTEXT_WINDOW,
                        maxTokens: DEFAULT_MAX_TOKENS,
                    },
                    m.name || m.id,
                ),
            );
        } else {
            continue;
        }
        piProviders[providerId] = {
            name: (userConfig.alias?.trim() || def?.name) || providerId,
            apiKey: defaults.apiKey,
            api: defaults.api,
            baseUrl: baseUrl.replace(/\/$/, ""),
            authHeader: true,
            models,
        };
    }
    if (Object.keys(piProviders).length === 0) return;
    const agentDir = getOpenbotAgentDir();
    if (!existsSync(agentDir)) {
        mkdirSync(agentDir, { recursive: true });
    }
    const modelsPath = join(agentDir, "models.json");
    await writeFile(modelsPath, JSON.stringify({ providers: piProviders }, null, 2), "utf-8");
}
