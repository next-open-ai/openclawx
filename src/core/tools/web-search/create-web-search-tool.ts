import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getWebSearchProvider } from "./providers/index.js";
import { truncateTextToMaxTokens } from "../truncate-result.js";

const WebSearchSchema = Type.Object({
    query: Type.String({
        description: "搜索关键词或问题，例如：当前天气、最新新闻、某概念解释等",
    }),
    count: Type.Optional(
        Type.Number({
            description: "返回结果条数，1-10，默认 5",
            minimum: 1,
            maximum: 10,
        }),
    ),
    country: Type.Optional(
        Type.String({
            description: "可选，地区代码（如 us、cn），部分 Provider 支持",
        }),
    ),
    freshness: Type.Optional(
        Type.String({
            description: "可选，时间范围（如 pd、pw、pm），部分 Provider 支持",
        }),
    ),
});

type WebSearchParams = { query: string; count?: number; country?: string; freshness?: string };

export interface WebSearchToolOptions {
    enabled: boolean;
    provider: "brave" | "duck-duck-scrape";
    apiKey?: string;
    timeoutSeconds?: number;
    cacheTtlMinutes?: number;
    maxResults?: number;
    /** 单次搜索返回内容最大 token；超过则从尾部裁剪并打日志；不配置则不限制 */
    maxResultTokens?: number;
}

const WEB_SEARCH_NOOP_MESSAGE =
    "当前在线搜索不可用：所选 Provider 未配置或不可用（如选择了 Brave 但未配置 API Key）。请在设置中配置 Brave API Key，或将智能体在线搜索 Provider 改为 DuckDuckGo。";

/**
 * 创建 web_search 工具。
 * - enabled 为 false 时返回 null，调用方不应将工具加入 customTools。
 * - enabled 为 true 但当前 provider 不可用（如 Brave 无 Key）时仍返回工具，执行时空转，返回固定提示。
 */
export function createWebSearchTool(options: WebSearchToolOptions): ToolDefinition | null {
    if (!options || options.enabled !== true) return null;
    const provider = getWebSearchProvider(options.provider);
    const apiKey = options.provider === "brave" ? options.apiKey : undefined;
    const available = provider.isAvailable({ apiKey });
    const timeoutSeconds = options.timeoutSeconds ?? 15;
    const cacheTtlMinutes = options.cacheTtlMinutes ?? 5;
    const maxResults = options.maxResults ?? 5;

    return {
        name: "web_search",
        label: "Web Search",
        description:
            "联网搜索：根据查询词从互联网获取最新结果（标题、链接、摘要）。无 API Key 时使用 DuckDuckGo；配置 Brave API Key 后可选用 Brave。在回答需要实时信息、新闻、天气、概念解释等问题前可调用本工具。",
        parameters: WebSearchSchema,
        execute: async (
            _toolCallId: string,
            params: WebSearchParams,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            _ctx: unknown,
        ) => {
            if (!available) {
                return {
                    content: [{ type: "text" as const, text: WEB_SEARCH_NOOP_MESSAGE }],
                    details: undefined,
                };
            }
            const query = (params.query ?? "").trim();
            if (!query) {
                return {
                    content: [{ type: "text" as const, text: "请提供搜索关键词（query）。" }],
                    details: undefined,
                };
            }
            const count = Math.min(10, Math.max(1, params.count ?? maxResults));
            try {
                const result = await provider.search({
                    query,
                    count,
                    apiKey,
                    timeoutSeconds,
                    cacheTtlMinutes,
                    country: params.country,
                    freshness: params.freshness,
                });
                const lines = result.results.map(
                    (r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.description ? `\n   ${r.description}` : ""}`,
                );
                let text =
                    (result.cached ? "[缓存] " : "") +
                    `搜索「${result.query}」共 ${result.count} 条（${result.provider}${result.tookMs != null ? `, ${result.tookMs}ms` : ""}）：\n\n` +
                    (lines.length ? lines.join("\n\n") : "未找到结果。");
                const maxResultTokens = options.maxResultTokens;
                if (typeof maxResultTokens === "number" && maxResultTokens > 0) {
                    text = truncateTextToMaxTokens(text, maxResultTokens, "web_search");
                }
                return {
                    content: [{ type: "text" as const, text }],
                    details: { query: result.query, count: result.count, provider: result.provider },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `在线搜索失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}
