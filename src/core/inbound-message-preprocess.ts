/**
 * 入站消息统一预处理：所有通道（Web/Gateway/Desktop、飞书等）在跑 Agent 前经此管道，
 * 可做 //智能体切换、指令解析等统一扩展，避免各入口重复逻辑。
 */
import { getAgentListProvider } from "./session-current-agent.js";

/** 预处理输入：会话与当前消息、当前智能体 */
export interface InboundMessageContext {
    /** 会话 ID（桌面 session 或 channel:platform:threadId） */
    sessionId: string;
    /** 用户原始消息（已 trim） */
    message: string;
    /** 当前会话使用的 agentId，未解析 // 时的值 */
    currentAgentId: string;
}

/** 预处理输出：后续链路使用的消息与智能体 */
export interface InboundMessagePreprocessResult {
    /** 预处理后的消息（如去掉 //智能体名称 后的内容） */
    message: string;
    /** 本轮应使用的 agentId（可能因 // 切换而变更） */
    agentId: string;
    /** 若存在，调用方应直接返回此内容、不跑 Agent（用于 //select 等内置指令） */
    directResponse?: string;
}

/** 单个预处理步骤：可异步，返回新的 message + agentId，供下一步或最终使用 */
export type InboundPreprocessor = (
    ctx: InboundMessageContext
) => Promise<InboundMessagePreprocessResult> | InboundMessagePreprocessResult;

const DEFAULT_AGENT_ID = "default";

const SLASH_SLASH = "//";

/**
 * 解析 "//" 前缀：//智能体名称(id) 切换为该智能体；仅 "//" 或 "// " 切到 default；//select 显示所有智能体、不跑 Agent。
 * 所有命中 // 的分支返回的 message 均不包含 "//" 及指令词，仅包含要传递给智能体的正文，避免智能体误解。
 */
async function slashSlashAgent(ctx: InboundMessageContext): Promise<InboundMessagePreprocessResult> {
    const { message, currentAgentId } = ctx;
    const trimmed = message.trim();
    if (!trimmed.startsWith(SLASH_SLASH)) {
        return { message: trimmed, agentId: currentAgentId };
    }
    const afterPrefix = trimmed.slice(SLASH_SLASH.length).trimStart();
    const nameEnd = /[\s\n]/.exec(afterPrefix);
    const token = nameEnd ? afterPrefix.slice(0, nameEnd.index) : afterPrefix;
    const restMessage = (nameEnd ? afterPrefix.slice(nameEnd.index).trimStart() : "").trim();

    if (!token) {
        return {
            message: "",
            agentId: DEFAULT_AGENT_ID,
            directResponse: "已切换到主智能体。",
        };
    }
    const provider = getAgentListProvider();
    const list = provider ? await provider() : [];

    if (token.toLowerCase() === "select") {
        const lines = list.length
            ? list.map((a, i) => `${i + 1}. **${a.name ?? a.id}**（id: \`${a.id}\`）`).join("\n")
            : "暂无配置的智能体";
        const directResponse = [
            "**当前可用的智能体**",
            "",
            lines,
            "",
            "切换方式：输入 `//名称` 或 `//id` 即可切换到对应智能体，输入 `//` 切回主智能体。",
        ].join("\n");
        return { message: "", agentId: DEFAULT_AGENT_ID, directResponse };
    }

    const tokenLower = token.toLowerCase();
    let found = list.find(
        (a) => (a.name ?? "").trim().toLowerCase() === tokenLower || (a.id ?? "").toLowerCase() === tokenLower
    );
    if (!found && /\([^)]+\)$/.test(token)) {
        const paren = token.indexOf("(");
        const namePart = token.slice(0, paren).trim();
        const idPart = token.slice(paren + 1, token.length - 1).trim();
        found = list.find(
            (a) =>
                (a.id ?? "").toLowerCase() === idPart.toLowerCase() ||
                (a.name ?? "").trim().toLowerCase() === namePart.toLowerCase()
        );
    }
    const forAgent = toAgentMessage(restMessage);
    const displayName = (a: { id: string; name?: string }) => (a.name && a.name.trim() ? a.name.trim() : a.id);

    if (found) {
        if (!forAgent) {
            return {
                message: "",
                agentId: found.id,
                directResponse: `已切换到「${displayName(found)}」。`,
            };
        }
        return { message: forAgent, agentId: found.id };
    }
    if (!forAgent) {
        return {
            message: "",
            agentId: DEFAULT_AGENT_ID,
            directResponse: "未找到该智能体，已切回主智能体。",
        };
    }
    return { message: forAgent, agentId: DEFAULT_AGENT_ID };
}

/** 确保传给智能体的内容不含 "//" 前缀，避免误解析 */
function toAgentMessage(s: string): string {
    return s.startsWith(SLASH_SLASH) ? s.slice(SLASH_SLASH.length).trimStart() : s;
}

/** 默认预处理管道：按顺序执行；扩展时可传入 [...defaultPipeline, myStep] */
export const defaultPipeline: InboundPreprocessor[] = [slashSlashAgent];

/**
 * 对所有通道统一的入站消息预处理入口。
 * 先跑完管道（当前为 //智能体 解析），返回最终 message 与 agentId，供 Gateway agent.chat 与 Channel handleChannelMessage 使用。
 */
export async function preprocessInboundMessage(
    ctx: InboundMessageContext,
    pipeline: InboundPreprocessor[] = defaultPipeline
): Promise<InboundMessagePreprocessResult> {
    let message = ctx.message.trim();
    let agentId = ctx.currentAgentId;
    let directResponse: string | undefined;
    for (const step of pipeline) {
        const result = await step({ sessionId: ctx.sessionId, message, currentAgentId: agentId });
        message = result.message;
        agentId = result.agentId;
        if (result.directResponse !== undefined) directResponse = result.directResponse;
    }
    return { message, agentId, directResponse };
}
