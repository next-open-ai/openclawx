/**
 * Claude Code CLI AgentProxy 适配器：通过 @instantlyeasy/claude-code-sdk-ts 调用本机 Claude Code CLI，
 * 将用户消息作为 prompt 提交，流式/一次性返回 CLI 输出（类似 Codea 的代理方式）。
 * 底层 CLI 按完整 message 返回，无 token 级流式；此处对收到的整段正文做分片推送，使前端能逐片渲染，避免长时间空白后一次性刷屏。
 * 需本机已安装并可用 `claude` 命令。
 */
import { join, resolve } from "path";
import { query } from "@instantlyeasy/claude-code-sdk-ts";
import { getOpenbotWorkspaceDir } from "../../agent-dir.js";
import type { DesktopAgentConfig } from "../../../config/desktop-config.js";
import type {
    IAgentProxyAdapter,
    RunAgentForChannelOptions,
    RunAgentStreamCallbacks,
} from "../types.js";

const DEFAULT_TIMEOUT_MS = 300_000;

function getCwd(config: DesktopAgentConfig): string | undefined {
    const custom = config.claudeCode?.workingDirectory;
    if (typeof custom === "string" && custom.trim()) {
        return resolve(custom.trim());
    }
    const w = config.workspace;
    if (typeof w !== "string" || !w.trim()) return undefined;
    const name = w.trim();
    return join(getOpenbotWorkspaceDir(), name);
}

/** 工具名到简短中文描述的映射，用于过程提示 */
const TOOL_LABELS: Record<string, string> = {
    Read: "读取文件",
    Write: "写入文件",
    Edit: "编辑",
    Bash: "执行命令",
    Grep: "搜索",
    Glob: "文件匹配",
    LS: "列出目录",
    MultiEdit: "多文件编辑",
    NotebookRead: "读取 Notebook",
    NotebookEdit: "编辑 Notebook",
    WebFetch: "网页抓取",
    TodoRead: "读取待办",
    TodoWrite: "写入待办",
    WebSearch: "网页搜索",
    Task: "任务",
    MCPTool: "MCP 工具",
};

/** 从 tool_use input 中取一行简短摘要（用于前端过程展示） */
function toolUseSummary(name: string, input: Record<string, unknown>): string {
    if (name === "Read" && typeof input.path === "string") return input.path;
    if (name === "Write" && typeof input.path === "string") return input.path;
    if (name === "Bash" && typeof input.command === "string") {
        const cmd = (input.command as string).trim().split(/\n/)[0] ?? "";
        return cmd.length > 60 ? cmd.slice(0, 57) + "…" : cmd;
    }
    if (name === "Grep" && typeof input.pattern === "string") return `"${(input.pattern as string).slice(0, 40)}"`;
    if (name === "Edit" && typeof input.path === "string") return input.path;
    return "";
}

/**
 * 处理单条 Message：提取可展示的正文，并通过 onChunk 推送过程信息（工具调用、系统消息等）。
 */
function processMessage(
    msg: { type: string; content?: unknown; subtype?: string; data?: unknown },
    callbacks: { onChunk(delta: string): void }
): string {
    if (msg.type === "result" && typeof (msg as { content?: string }).content === "string") {
        return (msg as { content: string }).content;
    }
    if (msg.type === "system") {
        const subtype = (msg as { subtype?: string }).subtype;
        const data = (msg as { data?: unknown }).data;
        const label = subtype === "init" ? "初始化" : subtype ? String(subtype) : "系统";
        const extra = data != null && typeof data === "object" && !Array.isArray(data)
            ? ""
            : typeof data === "string" ? ` ${(data as string).slice(0, 80)}` : "";
        callbacks.onChunk(`\n[Claude Code] ${label}${extra}\n`);
        return "";
    }
    if (msg.type === "assistant" && Array.isArray((msg as { content?: unknown[] }).content)) {
        const blocks = (msg as { content: Array<{ type?: string; text?: string; name?: string; input?: Record<string, unknown>; content?: string | unknown[] }> }).content;
        let text = "";
        for (const b of blocks) {
            if (b.type === "text" && typeof b.text === "string") {
                text += b.text;
            } else if (b.type === "tool_use" && b.name) {
                const label = TOOL_LABELS[b.name] ?? b.name;
                const summary = b.input && typeof b.input === "object" ? toolUseSummary(b.name, b.input) : "";
                const detail = summary ? `: ${summary}` : "";
                callbacks.onChunk(`\n\n---\n🔧 **使用工具**: ${label}${detail}\n---\n\n`);
            } else if (b.type === "tool_result") {
                callbacks.onChunk("\n✓ 工具返回\n");
            }
        }
        return text;
    }
    return "";
}

export const claudeCodeAdapter: IAgentProxyAdapter = {
    type: "claude_code",

    async runStream(options, config, callbacks): Promise<void> {
        const cwd = getCwd(config);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const userSignal = options.signal;
        if (userSignal) {
            if (userSignal.aborted) controller.abort();
            else userSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        try {
            callbacks.onChunk("⏳ Claude Code CLI 正在处理…\n\n");
            const generator = query(options.message, {
                cwd: cwd ?? process.cwd(),
                signal: controller.signal,
                timeout: Math.floor(DEFAULT_TIMEOUT_MS / 1000),
            });
            for await (const message of generator) {
                if (controller.signal.aborted) break;
                const text = processMessage(
                    message as { type: string; content?: unknown; subtype?: string; data?: unknown },
                    callbacks
                );
                if (text) callbacks.onChunk(text);
            }
            callbacks.onDone();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const name = err instanceof Error ? (err as Error & { name?: string }).name : "";
            const isUserOrTimeoutAbort =
                controller.signal.aborted ||
                name === "AbortError" ||
                (typeof msg === "string" && (msg === "Aborted" || msg === "The operation was aborted"));
            if (isUserOrTimeoutAbort) {
                callbacks.onChunk("\n\n[已中止]");
            } else {
                console.error("[Claude Code adapter] runStream error:", err);
                callbacks.onChunk(`\n\n[错误] ${msg}`);
            }
            callbacks.onDone();
        } finally {
            clearTimeout(timeoutId);
        }
    },

    async runCollect(options, config): Promise<string> {
        const cwd = getCwd(config);
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
        const userSignal = options.signal;
        if (userSignal) {
            if (userSignal.aborted) controller.abort();
            else userSignal.addEventListener("abort", () => controller.abort(), { once: true });
        }
        const parts: string[] = [];
        const collectChunk = (delta: string) => parts.push(delta);
        try {
            const generator = query(options.message, {
                cwd: cwd ?? process.cwd(),
                signal: controller.signal,
                timeout: Math.floor(DEFAULT_TIMEOUT_MS / 1000),
            });
            for await (const message of generator) {
                if (controller.signal.aborted) break;
                const text = processMessage(
                    message as { type: string; content?: unknown; subtype?: string; data?: unknown },
                    { onChunk: collectChunk }
                );
                if (text) parts.push(text);
            }
            return parts.join("").trim() || "(无文本回复)";
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const name = err instanceof Error ? (err as Error & { name?: string }).name : "";
            const isAbort =
                controller.signal.aborted ||
                name === "AbortError" ||
                (typeof msg === "string" && (msg === "Aborted" || msg === "The operation was aborted"));
            if (isAbort) return parts.join("").trim() + "\n\n[已中止]";
            console.error("[Claude Code adapter] runCollect error:", err);
            throw err;
        } finally {
            clearTimeout(timeoutId);
        }
    },
};
