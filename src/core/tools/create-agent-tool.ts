import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getCreateAgentProvider } from "../session-current-agent.js";

const CreateAgentSchema = Type.Object({
    name: Type.String({
        description: "智能体显示名称，如用户说的「美妆助手」「代码审查助手」",
    }),
    workspace: Type.Optional(
        Type.String({
            description:
                "工作空间英文标识，仅允许字母、数字、下划线、连字符。不传则根据 name 自动生成（如 My Assistant → my-assistant）",
        }),
    ),
    system_prompt: Type.Optional(
        Type.String({
            description:
                "系统提示词/角色描述。不传则根据 language 生成一句最简短的角色描述。",
        }),
    ),
    language: Type.Optional(
        Type.Union([Type.Literal("zh"), Type.Literal("en")], {
            description: "用户语言，用于生成缺省 system_prompt。不传默认 en。",
        }),
    ),
});

type CreateAgentParams = {
    name: string;
    workspace?: string;
    system_prompt?: string;
    language?: "zh" | "en";
};

const WORKSPACE_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;
const RESERVED_WORKSPACE = "default";

function slugifyFromName(name: string): string {
    const trimmed = (name || "").trim();
    if (!trimmed) return "agent-" + Date.now().toString(36);
    const asciiOnly = trimmed
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9_-]/g, "")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .toLowerCase();
    if (asciiOnly && WORKSPACE_NAME_REGEX.test(asciiOnly) && asciiOnly !== RESERVED_WORKSPACE)
        return asciiOnly;
    return "agent-" + Date.now().toString(36);
}

function getDefaultSystemPrompt(lang: "zh" | "en"): string {
    if (lang === "zh") return "你是根据用户需求定制的助手，请按用户描述的角色与能力提供帮助。";
    return "You are a helpful assistant customized as requested by the user.";
}

/**
 * 创建 create_agent 工具：根据用户意图创建新智能体配置，供用户在对话中选择使用。
 * 缺省：未提供 workspace 时根据 name 生成英文标识；未提供 system_prompt 时根据 language 生成简短描述；模型使用全局缺省。
 */
export function createCreateAgentTool(): ToolDefinition {
    return {
        name: "create_agent",
        label: "Create Agent",
        description:
            "根据用户意图创建一个新的智能体配置。用户可在对话中通过 list_agents 与 switch_agent 选择使用。需提供智能体名称；工作空间名与系统提示词可选，未提供时自动生成。",
        parameters: CreateAgentSchema,
        execute: async (
            _toolCallId: string,
            params: CreateAgentParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const provider = getCreateAgentProvider();
            if (!provider) {
                return {
                    content: [{ type: "text" as const, text: "当前环境不支持创建智能体。" }],
                    details: undefined,
                };
            }
            const name = (params.name ?? "").trim();
            if (!name) {
                return {
                    content: [{ type: "text" as const, text: "请提供智能体名称（name）。" }],
                    details: undefined,
                };
            }
            let workspace =
                (params.workspace ?? "").trim() && WORKSPACE_NAME_REGEX.test((params.workspace ?? "").trim())
                    ? (params.workspace ?? "").trim()
                    : slugifyFromName(name);
            if (workspace === RESERVED_WORKSPACE) workspace = "agent-" + Date.now().toString(36);
            const systemPrompt =
                (params.system_prompt ?? "").trim() ||
                getDefaultSystemPrompt(params.language === "zh" ? "zh" : "en");
            try {
                const result = await provider({
                    name,
                    workspace,
                    systemPrompt,
                });
                if ("error" in result) {
                    return {
                        content: [{ type: "text" as const, text: `创建失败: ${result.error}` }],
                        details: undefined,
                    };
                }
                const text = `已创建智能体「${result.name}」（ID: ${result.id}）。用户可通过 list_agents 查看、并调用 switch_agent 切换到该智能体使用。`;
                return {
                    content: [{ type: "text" as const, text }],
                    details: result,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `创建失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}
