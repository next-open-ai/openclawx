import {
    createAgentSession,
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager as CoreSessionManager,
    SettingsManager,
    createReadTool,
    createWriteTool,
    createEditTool,
    createBashTool,
    createFindTool,
    createGrepTool,
    createLsTool
} from "@mariozechner/pi-coding-agent";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { createCompactionMemoryExtensionFactory } from "../memory/compaction-extension.js";
import { loadExtensionFactories } from "../extensions/index.js";
import { addMemory } from "../memory/index.js";
import {
    persistStoredCompactionForSession,
    persistStoredCompactionForBusinessSession,
} from "../memory/persist-compaction-on-close.js";
import { createBrowserTool, createSaveExperienceTool, createMemoryRecallTool, createInstallSkillTool, createSwitchAgentTool, createListAgentsTool, createCreateAgentTool, createGetBookmarkTagsTool, createSaveBookmarkTool, createAddBookmarkTagTool, createWebSearchTool } from "../tools/index.js";

/** Agent Session 缓存 key：sessionId + "::" + agentId，同一业务 session 下不同 agent 各自一个 Core Session */
const COMPOSITE_KEY_SEP = "::";
function toCompositeKey(sessionId: string, agentId: string): string {
    return sessionId + COMPOSITE_KEY_SEP + agentId;
}
import { createMcpToolsForSession } from "../mcp/index.js";
import type { McpServerConfig, McpServersStandardFormat } from "../mcp/index.js";
import { registerBuiltInApiProviders } from "@mariozechner/pi-ai/dist/providers/register-builtins.js";
import { getOpenbotAgentDir, getOpenbotWorkspaceDir, ensureDefaultAgentDir } from "./agent-dir.js";
import { formatSkillsForPrompt } from "./skills.js";
import type { Skill } from "./skills.js";
import {
    createTokenUsageLogExtensionFactory,
    setTokenUsageInitialStats,
} from "./token-usage-log-extension.js";

// Ensure all built-in providers are registered
registerBuiltInApiProviders();

/** 粗略按字符估算 token（中英混合约 1/3，纯英文约 1/4） */
function estTokensFromChars(chars: number): number {
    return Math.ceil(chars / 3);
}

const TOKEN_USAGE_LOG_PREFIX = "[token-usage]";

export interface AgentManagerOptions {
    agentDir?: string;
    workspace?: string; // Workspace name (e.g. "default", "my-project")
    skillPaths?: string[]; // Additional skill paths from CLI/Config
    skills?: Skill[]; // Pre-loaded skills (optional)
}

/** system prompt 中每个技能描述最大字符数，超出截断以省 token */
const MAX_SKILL_DESC_IN_PROMPT = 250;

/**
 * Unified Agent Manager for both CLI and Gateway
 */
export class AgentManager {
    private sessions = new Map<string, AgentSession>();
    /** 每个 session 最后被使用的时间戳，用于 LRU 淘汰 */
    private sessionLastActiveAt = new Map<string, number>();
    /** 每个 SessionAgent 当前最新的 compaction summary，关闭会话时写入向量库（infotype: compaction） */
    private sessionLatestCompactionSummary = new Map<string, string>();
    private agentDir: string;
    private workspaceDir: string;
    private skillPaths: string[] = [];
    private preLoadedSkills: Skill[] = [];

    constructor(options: AgentManagerOptions = {}) {
        this.agentDir = options.agentDir || getOpenbotAgentDir();

        // Centralized workspace root: ~/.openbot/workspace/
        const workspaceRoot = getOpenbotWorkspaceDir();
        const workspaceName = options.workspace || "default";
        this.workspaceDir = join(workspaceRoot, workspaceName);

        this.skillPaths = options.skillPaths || [];
        this.preLoadedSkills = options.skills || [];

        // Ensure workspace directory exists
        if (!existsSync(this.workspaceDir)) {
            mkdirSync(this.workspaceDir, { recursive: true });
        }
    }

    /**
     * Re-configure the manager
     */
    public configure(options: AgentManagerOptions): void {
        if (options.agentDir) this.agentDir = options.agentDir;
        if (options.workspace) {
            const workspaceRoot = getOpenbotWorkspaceDir();
            this.workspaceDir = join(workspaceRoot, options.workspace);
            if (!existsSync(this.workspaceDir)) {
                mkdirSync(this.workspaceDir, { recursive: true });
            }
        }
        if (options.skillPaths) this.skillPaths = options.skillPaths;
        if (options.skills) this.preLoadedSkills = options.skills;
    }

    /**
     * Build system prompt with skills and browser tool description
     */
    public buildSystemPrompt(skills: Skill[]): string {
        const shortSkills = skills.map((s) => ({
            ...s,
            description:
                s.description.length <= MAX_SKILL_DESC_IN_PROMPT
                    ? s.description
                    : s.description.slice(0, MAX_SKILL_DESC_IN_PROMPT) + "…",
        }));
        const skillsBlock = formatSkillsForPrompt(shortSkills);

        const browserToolDesc = `
## Browser Tool

You have access to a \`browser\` tool for web automation:
- **navigate**: Navigate to a URL
- **snapshot**: Get page content with element refs (@e1, @e2, etc.)
- **screenshot**: Capture page image
- **click**: Click element (use selector or ref from snapshot)
- **type**: Type text into element
- **fill**: Clear and fill input field
- **scroll**: Scroll page (up/down/left/right)
- **extract**: Get text from element
- **wait**: Wait for element to appear
- **download**: Download file from URL or by clicking download button/link
- **back/forward**: Navigate browser history
- **close**: Close browser

Use refs from snapshots (e.g., @e1) for reliable element selection.
For downloads, provide either a direct URL or a selector to click.`;

        const experienceMemoryDesc = `
## Long-term memory

- **save_experience**: Store summaries in long-term memory. **Call at most once per conversation**, and **only after all tasks are fully completed** (as the last step before ending your reply). **Do not call it for very simple dialogue tasks** (e.g. single-turn Q&A, greetings, trivial questions). When you do call it, briefly summarize the main outcomes, conclusions, or reusable points in one \`save_experience\` call.
- **memory_recall**: Retrieve relevant memories by semantic search. **When the user asks about past work, decisions, dates, people, preferences, todos, complex tasks, scheduled tasks, or anything that may need past experience**, call \`memory_recall\` first with a suitable query, then answer using the recalled content. Do not inject any history or memory into your replies unless you have just retrieved it via \`memory_recall\` for that question.`;

        const terminologyNote =
            "【术语】本系统中「智能体」「助手」「专家」均指同一概念（Agent），可互换使用。用户说切换助手/专家或提到某个助手/专家时，即指切换或使用对应智能体。";
        const parts = [
            terminologyNote,
            "You are a helpful assistant. When users ask about skills, explain what skills are available.",
            browserToolDesc,
            skillsBlock,
            experienceMemoryDesc,
        ].filter(Boolean);
        return parts.join("\n\n");
    }

    /**
     * Get the initial context (prompt and skills)
     */
    public async getContext(): Promise<{ systemPrompt: string; skills: Skill[] }> {
        const loader = this.createResourceLoader(this.workspaceDir);
        await loader.reload();
        const loadedSkills = loader.getSkills().skills;
        const systemPrompt = this.buildSystemPrompt(loadedSkills);
        return { systemPrompt, skills: loadedSkills };
    }

    private createResourceLoader(
        workspaceDir: string,
        sessionId?: string,
        customAgentPrompt?: string,
        identity?: { agentId: string; workspace: string },
        onUpdateLatestCompaction?: (summary: string) => void,
    ): DefaultResourceLoader {
        const loader = new DefaultResourceLoader({
            cwd: workspaceDir,
            agentDir: this.agentDir,
            noSkills: true, // Disable SDK's built-in skills logic to take full control
            additionalSkillPaths: this.resolveSkillPaths(workspaceDir),
            extensionFactories: (() => {
                const compositeKeyForLoader =
                    sessionId && identity?.agentId
                        ? sessionId + COMPOSITE_KEY_SEP + identity.agentId
                        : "";
                const tokenLog = createTokenUsageLogExtensionFactory(compositeKeyForLoader);
                const base =
                    sessionId && onUpdateLatestCompaction
                        ? [createCompactionMemoryExtensionFactory(sessionId, onUpdateLatestCompaction)]
                        : [];
                const pluginFactories = loadExtensionFactories();
                return [tokenLog, ...base, ...pluginFactories];
            })(),
            systemPromptOverride: (base) => {
                const loadedSkills = loader.getSkills().skills;
                const basePrompt = this.buildSystemPrompt(loadedSkills);
                const withCustom =
                    customAgentPrompt && customAgentPrompt.trim()
                        ? customAgentPrompt.trim() + "\n\n" + basePrompt
                        : basePrompt;
                return identity && identity.agentId
                    ? `[Session identity] You are the agent with ID: ${identity.agentId}, workspace: ${identity.workspace || identity.agentId}. When asked which agent you are, answer according to this identity.\n\n` +
                          withCustom
                    : withCustom;
            },
        });
        return loader;
    }

    /**
     * Resolve all relevant skill paths (Global, Project, Workspace)
     * @param workspaceDir 当前会话使用的工作区目录，不传则用 manager 默认
     */
    private resolveSkillPaths(workspaceDir?: string): string[] {
        const paths = new Set<string>();
        const wsDir = workspaceDir ?? this.workspaceDir;

        // 1. Managed skills (Global: ~/.openbot/agent/skills)
        const managedSkillsDir = join(this.agentDir, "skills");
        if (existsSync(managedSkillsDir)) paths.add(managedSkillsDir);

        // 2. Extra paths (CLI -s / Config)
        this.skillPaths.forEach(p => paths.add(p));

        // 3. Project skills (./skills)
        const projectSkillsDir = join(process.cwd(), "skills");
        if (existsSync(projectSkillsDir)) paths.add(projectSkillsDir);

        // 4. Workspace skills (./workspace/<name>/skills)
        const workspaceSkillsDir = join(wsDir, "skills");
        if (existsSync(workspaceSkillsDir)) paths.add(workspaceSkillsDir);

        return Array.from(paths);
    }

    /**
     * Get or create an agent session.
     * 缓存 key 为 sessionId + "::" + agentId，同一业务 session 下可切换 agent 且各自保留上下文。
     * @param sessionId 业务会话 ID（桌面 UUID 或 channel:feishu:threadId 等）
     * @param options.agentId 当前使用的 agent，与 sessionId 组成复合 key，必传或默认 "default"
     * @param options.workspace 该会话绑定的工作区名（来自 agent 配置）
     * @param options.maxSessions 若提供且当前 session 数 >= 该值，按 LRU 淘汰
     * @param options.targetAgentId 创建时绑定到 install_skill 工具
     */
    public async getOrCreateSession(sessionId: string, options: {
        agentId?: string;
        workspace?: string;
        provider?: string;
        modelId?: string;
        apiKey?: string;
        maxSessions?: number;
        targetAgentId?: string;
        mcpServers?: McpServerConfig[] | McpServersStandardFormat;
        /** MCP 单次返回最大 token；不配置则不限制 */
        mcpMaxResultTokens?: number;
        /** 自定义系统提示词（来自 agent 配置），会与技能等一起组成最终 systemPrompt */
        systemPrompt?: string;
        /** 是否使用长记忆（memory_recall/save_experience）；默认 true */
        useLongMemory?: boolean;
        /** 在线搜索：启用时注册 web_search 工具 */
        webSearch?: {
            enabled: boolean;
            provider: "brave" | "duck-duck-scrape";
            apiKey?: string;
            timeoutSeconds?: number;
            cacheTtlMinutes?: number;
            maxResults?: number;
            /** 单次搜索返回最大 token；不配置则不限制；前端默认 64K */
            maxResultTokens?: number;
        };
    } = {}): Promise<AgentSession> {
        const agentId = options.agentId ?? "default";
        const compositeKey = toCompositeKey(sessionId, agentId);
        const now = Date.now();
        if (this.sessions.has(compositeKey)) {
            this.sessionLastActiveAt.set(compositeKey, now);
            return this.sessions.get(compositeKey)!;
        }

        const { maxSessions } = options;
        if (typeof maxSessions === "number" && maxSessions > 0 && this.sessions.size >= maxSessions) {
            let oldestId: string | null = null;
            let oldestAt = Infinity;
            for (const [id, at] of this.sessionLastActiveAt) {
                if (this.sessions.has(id) && at < oldestAt) {
                    oldestAt = at;
                    oldestId = id;
                }
            }
            if (oldestId != null) {
                await this.deleteSession(oldestId);
            }
        }

        const workspaceRoot = getOpenbotWorkspaceDir();
        const workspaceName = options.workspace ?? "default";
        const sessionWorkspaceDir = join(workspaceRoot, workspaceName);
        if (!existsSync(sessionWorkspaceDir)) {
            mkdirSync(sessionWorkspaceDir, { recursive: true });
        }

        const provider = options.provider ?? process.env.OPENBOT_PROVIDER ?? "deepseek";
        const modelId = options.modelId ?? process.env.OPENBOT_MODEL ?? "deepseek-chat";
        const apiKey = options.apiKey;

        ensureDefaultAgentDir(this.agentDir);
        const authPath = join(this.agentDir, "auth.json");
        const modelsPath = join(this.agentDir, "models.json");
        const authStorage = new AuthStorage(authPath);

        if (apiKey) {
            authStorage.setRuntimeApiKey(provider, apiKey);
        }

        if (await authStorage.hasAuth(provider)) {
            const key = await authStorage.getApiKey(provider);
            if (key) {
                if (provider === "deepseek") {
                    process.env.OPENAI_API_KEY = key;
                } else if (provider === "dashscope") {
                    process.env.DASHSCOPE_API_KEY = key;
                } else if (provider === "nvidia") {
                    process.env.NVIDIA_API_KEY = key;
                } else if (provider === "kimi") {
                    process.env.MOONSHOT_API_KEY = key;
                } else if (provider === "openai" || provider === "openai-custom") {
                    process.env.OPENAI_API_KEY = key;
                }
                if (!process.env.OPENAI_API_KEY) {
                    process.env.OPENAI_API_KEY = key;
                }
            }
        }

        const modelRegistry = new ModelRegistry(authStorage, modelsPath);
        authStorage.setFallbackResolver((p: string) => {
            if (p === "deepseek") return process.env.OPENAI_API_KEY || process.env.DEEPSEEK_API_KEY;
            if (p === "dashscope") return process.env.DASHSCOPE_API_KEY || process.env.OPENAI_API_KEY;
            if (p === "nvidia") return process.env.NVIDIA_API_KEY || process.env.OPENAI_API_KEY;
            if (p === "kimi") return process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY || process.env.OPENAI_API_KEY;
            if (p === "openai" || p === "openai-custom") return process.env.OPENAI_API_KEY;
            return process.env.OPENAI_API_KEY;
        });

        const loader = this.createResourceLoader(
            sessionWorkspaceDir,
            sessionId,
            options.systemPrompt,
            { agentId, workspace: workspaceName },
            (summary) => this.sessionLatestCompactionSummary.set(compositeKey, summary),
        );
        await loader.reload();

        const coreTools: Record<string, any> = {
            read: createReadTool(sessionWorkspaceDir),
            write: createWriteTool(sessionWorkspaceDir),
            edit: createEditTool(sessionWorkspaceDir),
            bash: createBashTool(sessionWorkspaceDir),
            find: createFindTool(sessionWorkspaceDir),
            grep: createGrepTool(sessionWorkspaceDir),
            ls: createLsTool(sessionWorkspaceDir),
        };

        const useLongMemory = options.useLongMemory !== false;
        const mcpTools = await createMcpToolsForSession({
            mcpServers: options.mcpServers,
            sessionId,
            mcpMaxResultTokens: options.mcpMaxResultTokens,
        });
        const webSearchTool =
            options.webSearch?.enabled === true ? createWebSearchTool(options.webSearch) : null;
        const customTools = [
            createBrowserTool(sessionWorkspaceDir),
            createSaveExperienceTool(sessionId),
            createMemoryRecallTool(useLongMemory),
            createInstallSkillTool(options.targetAgentId ?? agentId),
            createSwitchAgentTool(sessionId),
            createListAgentsTool(),
            createCreateAgentTool(),
            createGetBookmarkTagsTool(),
            createSaveBookmarkTool(),
            createAddBookmarkTagTool(),
            ...(webSearchTool ? [webSearchTool] : []),
            ...mcpTools,
        ];

        // 分类打印 token 占用估算（字符数 + 估算 token），便于分析超长请求来源
        try {
            const loadedSkills = loader.getSkills().skills;
            const shortSkills = loadedSkills.map((s) => ({
                ...s,
                description:
                    s.description.length <= MAX_SKILL_DESC_IN_PROMPT
                        ? s.description
                        : s.description.slice(0, MAX_SKILL_DESC_IN_PROMPT) + "…",
            }));
            const skillsBlock = formatSkillsForPrompt(shortSkills);
            const basePrompt = this.buildSystemPrompt(loadedSkills);
            const withCustom =
                options.systemPrompt?.trim()
                    ? options.systemPrompt.trim() + "\n\n" + basePrompt
                    : basePrompt;
            const sessionIdentity = { agentId, workspace: workspaceName };
            const withIdentity =
                sessionIdentity?.agentId
                    ? `[Session identity] You are the agent with ID: ${sessionIdentity.agentId}, workspace: ${sessionIdentity.workspace || sessionIdentity.agentId}. When asked which agent you are, answer according to this identity.\n\n` + withCustom
                    : withCustom;
            const systemPromptChars = withIdentity.length;
            const toolsDefs = [
                ...Object.values(coreTools),
                ...customTools,
            ].map((t: { name?: string; description?: string; parameters?: unknown }) => ({
                name: t?.name ?? "",
                description: typeof t?.description === "string" ? t.description : "",
                parameters: t?.parameters ?? {},
            }));
            const toolsJsonChars = JSON.stringify(toolsDefs).length;
            const systemPromptEstTokens = estTokensFromChars(systemPromptChars);
            const skillsBlockEstTokens = estTokensFromChars(skillsBlock.length);
            const toolsDefsEstTokens = estTokensFromChars(toolsJsonChars);
            console.log(
                `${TOKEN_USAGE_LOG_PREFIX} session create (${compositeKey}) | systemPrompt chars=${systemPromptChars} estTokens=${systemPromptEstTokens} | skillsBlock chars=${skillsBlock.length} estTokens=${skillsBlockEstTokens} | toolsDefs chars=${toolsJsonChars} estTokens=${toolsDefsEstTokens}`
            );
            setTokenUsageInitialStats(compositeKey, {
                systemPromptEstTokens,
                skillsBlockEstTokens,
                toolsDefsEstTokens,
            });
            console.log(
                `${TOKEN_USAGE_LOG_PREFIX} compaction (SDK): 触发条件 contextTokens > contextWindow - reserveTokens (默认 16384)；保留最近 keepRecentTokens (默认 20000)。配置见 pi 文档 settings.json 或传入 settingsManager。`
            );
        } catch (e) {
            console.warn(`${TOKEN_USAGE_LOG_PREFIX} session create log failed:`, e);
        }

        const { session } = await createAgentSession({
            agentDir: this.agentDir,
            sessionManager: CoreSessionManager.inMemory(),
            settingsManager: SettingsManager.inMemory({
                compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
            }),
            authStorage,
            modelRegistry,
            cwd: sessionWorkspaceDir,
            resourceLoader: loader,
            customTools,
            baseToolsOverride: coreTools,
        } as any);

        const model = modelRegistry.find(provider, modelId);
        if (model) {
            console.log(`Setting model to ${model.provider}/${model.id} (workspace: ${workspaceName})`);
            await session.setModel(model);
        }

        this.sessions.set(compositeKey, session);
        this.sessionLastActiveAt.set(compositeKey, now);
        return session;
    }

    /** 按复合 key 获取（key = sessionId + "::" + agentId） */
    public getSession(compositeKey: string): AgentSession | undefined {
        return this.sessions.get(compositeKey);
    }

    /** 按业务 sessionId 查找一个 Session（取最近活跃的），用于 agent.cancel 等 */
    public getSessionBySessionId(sessionId: string): AgentSession | undefined {
        const prefix = sessionId + COMPOSITE_KEY_SEP;
        let bestKey: string | undefined;
        let bestAt = 0;
        for (const key of this.sessions.keys()) {
            if (!key.startsWith(prefix)) continue;
            const at = this.sessionLastActiveAt.get(key) ?? 0;
            if (at >= bestAt) {
                bestAt = at;
                bestKey = key;
            }
        }
        return bestKey != null ? this.sessions.get(bestKey) : undefined;
    }

    /** 删除一个 Agent Session（传入复合 key）；关闭前将本 session 最新 compaction summary 写入向量库 */
    public async deleteSession(compositeKey: string): Promise<boolean> {
        await persistStoredCompactionForSession(
            this.sessionLatestCompactionSummary,
            compositeKey,
            addMemory,
        );
        this.sessionLastActiveAt.delete(compositeKey);
        return this.sessions.delete(compositeKey);
    }

    /** 按业务 sessionId 删除该会话下所有 agent 的 Core Session（如删除会话时）；关闭前将各 session 最新 compaction 写入向量库 */
    public async deleteSessionsByBusinessId(sessionId: string): Promise<void> {
        const prefix = sessionId + COMPOSITE_KEY_SEP;
        const keysToProcess = Array.from(this.sessions.keys()).filter((k) => k.startsWith(prefix));
        await persistStoredCompactionForBusinessSession(
            this.sessionLatestCompactionSummary,
            keysToProcess,
            sessionId,
            addMemory,
        );
        for (const key of keysToProcess) {
            this.sessionLastActiveAt.delete(key);
            this.sessions.delete(key);
        }
    }

    /** 按 agentId 删除该智能体下所有 Session（配置更新后使旧会话失效，下次请求会用新配置建新会话） */
    public async deleteSessionsByAgentId(agentId: string): Promise<void> {
        const suffix = COMPOSITE_KEY_SEP + agentId;
        const keysToProcess = Array.from(this.sessions.keys()).filter((k) => k.endsWith(suffix));
        for (const key of keysToProcess) {
            await this.deleteSession(key);
        }
    }

    public clearAll(): void {
        this.sessions.clear();
        this.sessionLastActiveAt.clear();
        this.sessionLatestCompactionSummary.clear();
    }
}

// Singleton for easy access (e.g., from Gateway)
export const agentManager = new AgentManager();
