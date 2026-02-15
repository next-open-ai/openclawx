import {
    createAgentSession,
    AuthStorage,
    DefaultResourceLoader,
    ModelRegistry,
    SessionManager as CoreSessionManager,
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
import { getCompactionContextForSystemPrompt } from "../memory/index.js";
import { createBrowserTool, createSaveExperienceTool, createInstallSkillTool, createGetBookmarkTagsTool, createSaveBookmarkTool } from "../tools/index.js";
import { createMcpToolsForSession } from "../mcp/index.js";
import type { McpServerConfig } from "../mcp/index.js";
import { registerBuiltInApiProviders } from "@mariozechner/pi-ai/dist/providers/register-builtins.js";
import { getOpenbotAgentDir, getOpenbotWorkspaceDir, ensureDefaultAgentDir } from "./agent-dir.js";
import { formatSkillsForPrompt } from "./skills.js";
import type { Skill } from "./skills.js";

// Ensure all built-in providers are registered
registerBuiltInApiProviders();

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

        const parts = [
            "You are a helpful assistant. When users ask about skills, explain what skills are available.",
            browserToolDesc,
            skillsBlock,
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

    private createResourceLoader(workspaceDir: string, sessionId?: string, compactionBlock?: string): DefaultResourceLoader {
        const loader = new DefaultResourceLoader({
            cwd: workspaceDir,
            agentDir: this.agentDir,
            noSkills: true, // Disable SDK's built-in skills logic to take full control
            additionalSkillPaths: this.resolveSkillPaths(workspaceDir),
            extensionFactories: sessionId ? [createCompactionMemoryExtensionFactory(sessionId)] : [],
            systemPromptOverride: (base) => {
                const loadedSkills = loader.getSkills().skills;
                let customPrompt = this.buildSystemPrompt(loadedSkills);
                if (compactionBlock?.trim()) {
                    customPrompt = customPrompt + "\n\n" + compactionBlock.trim();
                }
                return customPrompt;
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
     * @param options.workspace 该会话绑定的工作区名（来自 agent 配置），不传则用 default，创建时 cwd/技能路径依此
     * @param options.provider / options.modelId 来自 agent 配置的大模型，不传则用环境变量默认
     * @param options.maxSessions 若提供且当前 session 数 >= 该值，会先淘汰最后调用时间最早的 session 再创建新的
     * @param options.targetAgentId 创建时绑定到 install_skill 工具，用于安装目标（具体 agentId 或 global）
     */
    public async getOrCreateSession(sessionId: string, options: {
        workspace?: string;
        provider?: string;
        modelId?: string;
        apiKey?: string;
        maxSessions?: number;
        targetAgentId?: string;
        /** MCP 服务器配置列表（与 Skill 类似，配到 Agent 后在创建 Session 时传入） */
        mcpServers?: McpServerConfig[];
    } = {}): Promise<AgentSession> {
        const now = Date.now();
        if (this.sessions.has(sessionId)) {
            this.sessionLastActiveAt.set(sessionId, now);
            return this.sessions.get(sessionId)!;
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
                this.deleteSession(oldestId);
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

        const compactionBlock = await getCompactionContextForSystemPrompt(sessionId);
        const loader = this.createResourceLoader(sessionWorkspaceDir, sessionId, compactionBlock);
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

        const mcpTools = await createMcpToolsForSession({ mcpServers: options.mcpServers });
        const customTools = [
            createBrowserTool(sessionWorkspaceDir),
            createSaveExperienceTool(sessionId),
            createInstallSkillTool(options.targetAgentId),
            createGetBookmarkTagsTool(),
            createSaveBookmarkTool(),
            ...mcpTools,
        ];

        const { session } = await createAgentSession({
            agentDir: this.agentDir,
            sessionManager: CoreSessionManager.inMemory(),
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

        this.sessions.set(sessionId, session);
        this.sessionLastActiveAt.set(sessionId, now);
        return session;
    }

    public getSession(sessionId: string): AgentSession | undefined {
        return this.sessions.get(sessionId);
    }

    public deleteSession(sessionId: string): boolean {
        this.sessionLastActiveAt.delete(sessionId);
        return this.sessions.delete(sessionId);
    }

    public clearAll(): void {
        this.sessions.clear();
        this.sessionLastActiveAt.clear();
    }
}

// Singleton for easy access (e.g., from Gateway)
export const agentManager = new AgentManager();
