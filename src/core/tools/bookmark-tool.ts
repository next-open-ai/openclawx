import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { getBackendBaseUrl } from "../../gateway/backend-url.js";

const GetBookmarkTagsSchema = Type.Object({});
type GetBookmarkTagsParams = Record<string, never>;

const AddBookmarkTagSchema = Type.Object({
    tagName: Type.String({ description: "要新增的标签名称，如「技术」「待读」「美女」等" }),
});
type AddBookmarkTagParams = { tagName: string };

const SaveBookmarkSchema = Type.Object({
    url: Type.String({ description: "要收藏的 URL" }),
    title: Type.Optional(Type.String({ description: "可选标题" })),
    tagNames: Type.Optional(
        Type.Array(Type.String(), {
            description: "标签名称列表，须与系统中已维护的标签一致。保存前应先用 get_bookmark_tags 获取可用标签；若缺标签可先用 add_bookmark_tag 新增。",
        }),
    ),
});
type SaveBookmarkParams = { url: string; title?: string; tagNames?: string[] };

async function apiGet<T>(path: string): Promise<T> {
    const base = getBackendBaseUrl();
    if (!base) {
        throw new Error("收藏功能需要在前端/桌面环境中使用，当前无法访问后端。");
    }
    const res = await fetch(`${base.replace(/\/$/, "")}/server-api${path}`, {
        method: "GET",
        headers: { "Content-Type": "application/json" },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`请求失败: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
    const base = getBackendBaseUrl();
    if (!base) {
        throw new Error("收藏功能需要在前端/桌面环境中使用，当前无法访问后端。");
    }
    const res = await fetch(`${base.replace(/\/$/, "")}/server-api${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`请求失败: ${res.status} ${text}`);
    }
    return res.json() as Promise<T>;
}

/**
 * 新增一个收藏标签。当 get_bookmark_tags 返回的列表中缺少用户想要的标签时，可先调用本工具创建该标签，再使用 save_bookmark 保存收藏。
 */
export function createAddBookmarkTagTool(): ToolDefinition {
    return {
        name: "add_bookmark_tag",
        label: "Add Bookmark Tag",
        description:
            "在系统中新增一个收藏标签。当用户要保存链接到某个尚不存在的标签（如「美女」「技术」「待读」）时，先调用本工具创建该标签，再调用 get_bookmark_tags 获取最新列表并用 save_bookmark 保存。若标签已存在会提示无需重复创建。",
        parameters: AddBookmarkTagSchema,
        execute: async (
            _toolCallId: string,
            params: AddBookmarkTagParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const tagName = (params.tagName ?? "").trim();
            if (!tagName) {
                return {
                    content: [{ type: "text" as const, text: "请提供要新增的标签名称。" }],
                    details: undefined,
                };
            }
            try {
                const json = await apiPost<{ success: boolean; data: { id: string; name: string } }>("/tags", {
                    name: tagName,
                });
                const data = json.data;
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `已新增标签「${data?.name ?? tagName}」，可直接用于 save_bookmark 的 tagNames。`,
                        },
                    ],
                    details: data,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                if (msg.includes("409") || msg.includes("已存在") || msg.includes("Conflict")) {
                    return {
                        content: [
                            {
                                type: "text" as const,
                                text: `标签「${tagName}」已存在，无需重复创建。可直接在 save_bookmark 的 tagNames 中使用该名称。`,
                            },
                        ],
                        details: undefined,
                    };
                }
                return {
                    content: [{ type: "text" as const, text: `新增标签失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}

/**
 * 获取当前系统中已维护的标签列表，供保存 URL 时选择匹配的标签。
 */
export function createGetBookmarkTagsTool(): ToolDefinition {
    return {
        name: "get_bookmark_tags",
        label: "Get Bookmark Tags",
        description:
            "获取系统中已维护的收藏标签列表。在用户要求保存链接时，应先调用本工具获取可用标签，再根据用户意图匹配最合适的标签名，并用 save_bookmark 保存。",
        parameters: GetBookmarkTagsSchema,
        execute: async (
            _toolCallId: string,
            _params: GetBookmarkTagsParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            try {
                const json = await apiGet<{ success: boolean; data: Array<{ id: string; name: string }> }>("/tags");
                const data = json.data ?? [];
                const names = data.map((t) => t.name);
                const text =
                    names.length > 0
                        ? `当前可用标签：${names.join("、")}。请根据用户意图选择匹配的标签名用于 save_bookmark。`
                        : "当前暂无标签。可使用 add_bookmark_tag 新增标签，或 save_bookmark 时不传 tagNames。";
                return {
                    content: [{ type: "text" as const, text }],
                    details: { tags: data },
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `获取标签失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}

/**
 * 将 URL 保存为收藏，并关联指定标签（标签名须与 get_bookmark_tags 返回的一致）。
 */
export function createSaveBookmarkTool(): ToolDefinition {
    return {
        name: "save_bookmark",
        label: "Save Bookmark",
        description:
            "将用户提供的 URL 保存到收藏库，并可关联一个或多个标签。标签名须为系统已有标签（get_bookmark_tags 返回）；若缺少某标签可先用 add_bookmark_tag 新增。",
        parameters: SaveBookmarkSchema,
        execute: async (
            _toolCallId: string,
            params: SaveBookmarkParams,
            _signal: AbortSignal | undefined,
            _onUpdate: any,
            _ctx: any,
        ) => {
            const url = (params.url ?? "").trim();
            if (!url) {
                return {
                    content: [{ type: "text" as const, text: "请提供要收藏的 URL。" }],
                    details: undefined,
                };
            }
            try {
                const json = await apiPost<{ success: boolean; data: { id: string; url: string; tagNames?: string[] } }>(
                    "/saved-items",
                    {
                        url,
                        title: params.title?.trim() || undefined,
                        tagNames: params.tagNames?.length ? params.tagNames.map((n) => n.trim()).filter(Boolean) : undefined,
                    },
                );
                const data = json.data;
                const tagStr = data?.tagNames?.length ? `，标签：${data.tagNames.join("、")}` : "";
                return {
                    content: [
                        {
                            type: "text" as const,
                            text: `已收藏：${data?.url ?? url}${tagStr}`,
                        },
                    ],
                    details: data,
                };
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return {
                    content: [{ type: "text" as const, text: `保存失败: ${msg}` }],
                    details: undefined,
                };
            }
        },
    };
}
