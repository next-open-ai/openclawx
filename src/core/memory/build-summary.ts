import {
    getLatestCompactionEntry,
    type SessionEntry,
    type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { convertToLlm } from "@mariozechner/pi-coding-agent";

/**
 * 从 session entries 中提取可用于存入向量库的摘要文本：
 * 优先使用最新 compaction 的 summary，否则用最近若干条消息拼成短文。
 */
export function buildSessionSummaryFromEntries(entries: SessionEntry[]): string | null {
    const compaction = getLatestCompactionEntry(entries);
    if (compaction?.summary) {
        return compaction.summary;
    }
    const messageEntries = entries.filter(
        (e): e is SessionMessageEntry => e.type === "message",
    );
    if (messageEntries.length === 0) return null;
    const recent = messageEntries.slice(-20);
    const messages = recent.map((e) => e.message);
    const parts: string[] = [];
    for (const msg of convertToLlm(messages)) {
        const role = msg.role === "user" ? "User" : "Assistant";
        const content =
            typeof msg.content === "string"
                ? msg.content
                : (msg.content as any[])?.map((c: any) => c.text ?? "").join(" ") ?? "";
        if (content.trim()) parts.push(`${role}: ${content.trim()}`);
    }
    return parts.length > 0 ? parts.join("\n") : null;
}
