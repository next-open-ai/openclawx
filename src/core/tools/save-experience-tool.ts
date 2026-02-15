import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { addMemory } from "../memory/index.js";

const SaveExperienceSchema = Type.Object({
    summary: Type.String({
        description: "本轮对话中总结出的经验、要点或可复用的结论，用于存入长期记忆",
    }),
});

type SaveExperienceParams = { summary: string };

/**
 * 创建 save_experience 工具：对话结束时由 Agent 调用，将经验总结存入向量库（infotype: experience）
 */
export function createSaveExperienceTool(sessionId: string): ToolDefinition {
    return {
        name: "save_experience",
        label: "Save Experience",
        description:
            "在对话结束时调用，将本轮对话中总结出的经验、要点或可复用的结论存入长期记忆，便于后续会话检索。",
        parameters: SaveExperienceSchema,
        execute: async (
            _toolCallId: string,
            params: SaveExperienceParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const text = (params.summary ?? "").trim();
            if (!text) {
                return {
                    content: [{ type: "text" as const, text: "未提供总结内容，未写入记忆。" }],
                    details: undefined,
                };
            }
            try {
                const id = await addMemory(text, {
                    infotype: "experience",
                    sessionId,
                });
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `经验已存入长期记忆（id: ${id}）。`,
                        },
                    ],
                    details: { id },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `存入记忆失败: ${msg}`,
                        },
                    ],
                    details: undefined,
                };
            }
        },
    };
}
