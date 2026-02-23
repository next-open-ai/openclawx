import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { searchMemory } from "../memory/index.js";

const MemoryRecallSchema = Type.Object({
    query: Type.String({
        description: "语义检索查询，例如：过往决定、用户偏好、某日讨论、待办、历史经验、任务总结等",
    }),
    topK: Type.Optional(
        Type.Number({
            description: "返回条数，默认 6",
            minimum: 1,
            maximum: 20,
        }),
    ),
});

type MemoryRecallParams = { query: string; topK?: number };

/**
 * 创建 memory_recall 工具：按需从向量库检索经验与对话摘要，供回答「过往工作、决定、日期、人、偏好、待办、复杂任务、定时任务、历史经验」等问题时使用。
 * @param useLongMemory 当前智能体是否启用长记忆；为 false 时执行空转（不检索，直接返回未启用提示）。
 */
export function createMemoryRecallTool(useLongMemory: boolean): ToolDefinition {
    return {
        name: "memory_recall",
        label: "Memory Recall",
        description:
            "从长期记忆中语义检索与查询相关的经验总结和对话摘要。在回答与过往工作、决定、日期、人、偏好、待办、复杂任务、定时任务或需要历史经验相关的问题前，应先调用本工具获取相关记忆再作答。",
        parameters: MemoryRecallSchema,
        execute: async (
            _toolCallId: string,
            params: MemoryRecallParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            if (!useLongMemory) {
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: "当前智能体未启用长记忆（经验），无法检索。",
                        },
                    ],
                    details: undefined,
                };
            }
            const query = (params.query ?? "").trim();
            if (!query) {
                return {
                    content: [{ type: "text" as const, text: "请提供检索查询（query）。" }],
                    details: undefined,
                };
            }
            const topK = Math.min(20, Math.max(1, params.topK ?? 6));
            try {
                const results = await searchMemory(query, topK);
                if (results.length === 0) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: "未找到与查询相关的记忆。",
                            },
                        ],
                        details: { results: [], query, topK },
                    };
                }
                const lines = results.map(
                    (r, i) =>
                        `${i + 1}. [${r.metadata?.infotype ?? "memory"}]\n${(r.document ?? "").trim()}`,
                );
                const text = "以下为检索到的相关记忆：\n\n" + lines.join("\n\n");
                return {
                    content: [{ type: "text" as const, text }],
                    details: { results: results.length, query, topK },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `记忆检索失败: ${msg}`,
                        },
                    ],
                    details: undefined,
                };
            }
        },
    };
}
